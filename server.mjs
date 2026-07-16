import { createServer } from 'node:http';
import { readFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';

try { process.loadEnvFile?.('.env'); } catch { /* .env is optional for local development */ }

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.PORTAL_DATA_DIR ? resolve(process.env.PORTAL_DATA_DIR) : join(root, 'data');
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'portal.db'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    phone_number TEXT NOT NULL, address TEXT NOT NULL, password_hash TEXT NOT NULL,
    is_verified INTEGER NOT NULL DEFAULT 0, verification_token TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateways (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
    location TEXT, model TEXT, created_at TEXT NOT NULL, last_seen_at TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );
  CREATE TABLE IF NOT EXISTS access_logs (
    id TEXT PRIMARY KEY, user_id TEXT, mac_address TEXT, client_ip TEXT,
    access_type TEXT NOT NULL CHECK(access_type IN ('high_speed','limited')),
    ssid TEXT, gateway_id TEXT NOT NULL DEFAULT 'unassigned', timestamp TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS clients (
    gateway_id TEXT NOT NULL DEFAULT 'unassigned', mac_address TEXT NOT NULL,
    client_ip TEXT, ssid TEXT,
    user_id TEXT, access_type TEXT CHECK(access_type IN ('high_speed','limited')),
    auth_status TEXT NOT NULL DEFAULT 'pending' CHECK(auth_status IN ('pending','authorized')),
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, authorized_until TEXT,
    PRIMARY KEY(gateway_id,mac_address),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(gateway_id) REFERENCES gateways(id)
  );
  CREATE TABLE IF NOT EXISTS captive_sessions (
    token_hash TEXT PRIMARY KEY, mac_address TEXT NOT NULL, client_ip TEXT,
    gateway_id TEXT, user_id TEXT,
    access_type TEXT NOT NULL CHECK(access_type IN ('high_speed','limited')),
    created_at TEXT NOT NULL, login_expires_at TEXT NOT NULL,
    authorized_at TEXT, authorized_until TEXT, revoked_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_captive_sessions_mac ON captive_sessions(mac_address);
  CREATE TABLE IF NOT EXISTS revoked_clients (
    mac_hash TEXT PRIMARY KEY, revoked_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS revoked_gateway_clients (
    gateway_id TEXT NOT NULL, mac_hash TEXT NOT NULL,
    revoked_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY(gateway_id,mac_hash)
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('client_login','client_offline')),
    client_mac TEXT, gateway_id TEXT NOT NULL DEFAULT 'unassigned', user_id TEXT,
    title TEXT NOT NULL, message TEXT NOT NULL,
    created_at TEXT NOT NULL, read_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
  CREATE TABLE IF NOT EXISTS portal_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1), welcome_title TEXT NOT NULL,
    welcome_text TEXT NOT NULL, limited_bandwidth_kbps INTEGER NOT NULL DEFAULT 512,
    terms_text TEXT NOT NULL, google_sheet_id TEXT, updated_at TEXT NOT NULL
  );
`);
try { db.exec("ALTER TABLE portal_settings ADD COLUMN default_ssid TEXT NOT NULL DEFAULT 'PerumNet Guest'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec("ALTER TABLE portal_settings ADD COLUMN account_ssid TEXT NOT NULL DEFAULT '@PERUMNET_WiFi'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec("ALTER TABLE portal_settings ADD COLUMN free_ssid TEXT NOT NULL DEFAULT '@PERUMNET_FreeWiFi'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE clients ADD COLUMN authorized_until TEXT'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec("ALTER TABLE access_logs ADD COLUMN gateway_id TEXT NOT NULL DEFAULT 'unassigned'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec("ALTER TABLE notifications ADD COLUMN gateway_id TEXT NOT NULL DEFAULT 'unassigned'"); } catch { /* The column already exists after an upgrade. */ }

// Versions before multi-gateway support used MAC as the only primary key.
// Rebuild the table once so the same device can be tracked independently on
// multiple Reyee gateways without losing any existing production data.
const clientPrimaryKey = db.prepare('PRAGMA table_info(clients)').all().filter(column => column.pk > 0);
if (clientPrimaryKey.length !== 2 || !clientPrimaryKey.some(column => column.name === 'gateway_id') || !clientPrimaryKey.some(column => column.name === 'mac_address')) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE clients RENAME TO clients_single_gateway;
      CREATE TABLE clients (
        gateway_id TEXT NOT NULL DEFAULT 'unassigned', mac_address TEXT NOT NULL,
        client_ip TEXT, ssid TEXT, user_id TEXT,
        access_type TEXT CHECK(access_type IN ('high_speed','limited')),
        auth_status TEXT NOT NULL DEFAULT 'pending' CHECK(auth_status IN ('pending','authorized')),
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, authorized_until TEXT,
        PRIMARY KEY(gateway_id,mac_address),
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(gateway_id) REFERENCES gateways(id)
      );
      INSERT INTO clients (gateway_id,mac_address,client_ip,ssid,user_id,access_type,auth_status,first_seen_at,last_seen_at,authorized_until)
      SELECT COALESCE(NULLIF(TRIM(gateway_id),''),'unassigned'),LOWER(mac_address),client_ip,ssid,user_id,access_type,auth_status,first_seen_at,last_seen_at,authorized_until
      FROM clients_single_gateway;
      DROP TABLE clients_single_gateway;
      COMMIT;
    `);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Transaction may already be closed. */ }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const migratedAt = new Date().toISOString();
db.prepare('INSERT OR IGNORE INTO projects (id,name,location,created_at) VALUES (?,?,?,?)')
  .run('default-project', 'PerumNet', null, migratedAt);
db.prepare('INSERT OR IGNORE INTO gateways (id,project_id,name,location,model,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)')
  .run('unassigned', 'default-project', 'Gateway belum teridentifikasi', null, null, migratedAt, null);
db.exec(`
  INSERT OR IGNORE INTO gateways (id,project_id,name,created_at,last_seen_at)
  SELECT gateway_id,'default-project','Gateway ' || gateway_id,MIN(first_seen_at),MAX(last_seen_at)
  FROM clients WHERE gateway_id<>'unassigned' GROUP BY gateway_id;
  UPDATE gateways SET last_seen_at=(
    SELECT MAX(c.last_seen_at) FROM clients c WHERE c.gateway_id=gateways.id
  ) WHERE EXISTS (SELECT 1 FROM clients c WHERE c.gateway_id=gateways.id);
  UPDATE access_logs SET gateway_id=COALESCE((
    SELECT c.gateway_id FROM clients c WHERE c.mac_address=LOWER(access_logs.mac_address)
    ORDER BY c.last_seen_at DESC LIMIT 1
  ),'unassigned') WHERE gateway_id='unassigned' AND mac_address IS NOT NULL;
  UPDATE notifications SET gateway_id=COALESCE((
    SELECT c.gateway_id FROM clients c WHERE c.mac_address=LOWER(notifications.client_mac)
    ORDER BY c.last_seen_at DESC LIMIT 1
  ),'unassigned') WHERE gateway_id='unassigned' AND client_mac IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_clients_gateway_seen ON clients(gateway_id,last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_access_logs_gateway ON access_logs(gateway_id,timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_gateway ON notifications(gateway_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_gateways_project ON gateways(project_id,last_seen_at DESC);
`);
db.prepare(`INSERT OR IGNORE INTO portal_settings (id,welcome_title,welcome_text,limited_bandwidth_kbps,terms_text,updated_at) VALUES (1,?,?,?,?,?)`)
  .run('Masuk ke internet cepat.', 'Gunakan akun PerumNet yang sudah terverifikasi atau daftar untuk mendapatkan akses High Speed.', 512, 'Dengan melanjutkan, Anda menyetujui ketentuan penggunaan jaringan.', new Date().toISOString());
db.prepare(`UPDATE portal_settings SET welcome_title=?,welcome_text=?,updated_at=?
  WHERE id=1 AND welcome_title='Internet sesuai kebutuhan Anda.' AND welcome_text='Pilih akses cepat atau langsung terhubung dengan kecepatan terbatas.'`)
  .run('Masuk ke internet cepat.', 'Gunakan akun PerumNet yang sudah terverifikasi atau daftar untuk mendapatkan akses High Speed.', new Date().toISOString());

const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@kopipagi.id',
  adminPassword: process.env.ADMIN_PASSWORD || 'password',
  sessionSecret: process.env.SESSION_SECRET || 'development-only-change-me',
  nodeEnv: process.env.NODE_ENV || 'development',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpSecure: String(process.env.SMTP_SECURE || 'true') === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  emailFrom: process.env.EMAIL_FROM || process.env.SMTP_USER || '',
  reyeeMode: process.env.REYEE_AUTH_MODE || 'mock', // mock | redirect
  reyeeUserParam: process.env.REYEE_USERNAME_PARAM || 'username',
  reyeePasswordParam: process.env.REYEE_PASSWORD_PARAM || 'password',
  reyeePostUrlParam: process.env.REYEE_POST_URL_PARAM || 'post_url',
  wifiDogTokenTtlSeconds: Number(process.env.WIFIDOG_TOKEN_TTL_SECONDS || 300),
  wifiDogSessionHours: Number(process.env.WIFIDOG_SESSION_HOURS || 12),
  wifiDogLimitedSessionHours: Number(process.env.WIFIDOG_LIMITED_SESSION_HOURS || 2),
  clientOfflineMinutes: Number(process.env.CLIENT_OFFLINE_MINUTES || 20),
  passwordResetMinutes: Number(process.env.PASSWORD_RESET_MINUTES || 30)
};
const mailTransport = config.smtpHost && config.smtpUser && config.smtpPassword ? nodemailer.createTransport({ host:config.smtpHost, port:config.smtpPort, secure:config.smtpSecure, auth:{ user:config.smtpUser, pass:config.smtpPassword } }) : null;
const id = () => randomBytes(16).toString('hex');
const json = (res, status, value, headers = {}) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(value));
const text = (res, status, value, headers = {}) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }).end(value);
const hashPassword = (password) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const verifyPassword = (password, stored) => { const [salt, key] = stored.split(':'); const actual = scryptSync(password, salt, 64).toString('hex'); return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(key, 'hex')); };
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
function sessionHoursFor(accessType) {
  const configured = accessType === 'limited' ? config.wifiDogLimitedSessionHours : config.wifiDogSessionHours;
  const fallback = accessType === 'limited' ? 2 : 12;
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}
const cookie = (req, name) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => v.trim().split('=')))[name];
function adminSession(req) { const value = cookie(req, 'perumnet_admin'); if (!value) return false; const [encodedEmail, signature] = value.split('.'); const email = Buffer.from(encodedEmail || '', 'base64url').toString(); return email === config.adminEmail && signature === createHash('sha256').update(`${email}:${config.sessionSecret}`).digest('hex'); }
function adminCookie(value, maxAge = 60 * 60 * 24 * 7) { return `perumnet_admin=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.baseUrl.startsWith('https:') ? '; Secure' : ''}`; }
function requireAdmin(req, res) { if (!adminSession(req)) { json(res, 401, { error: 'Sesi admin diperlukan.' }); return false; } return true; }
async function body(req) { let value = ''; for await (const part of req) value += part; try { return value ? JSON.parse(value) : {}; } catch { throw new Error('JSON tidak valid.'); } }
const networkAliasPattern = /^(?:vlan|network|lan)[\s_-]*\d+$/i;
function ssidFromGateway(value = {}) {
  const candidates = [value.wlan_name, value.ssid_name, value.essid, value.wifi_name, value.ap_ssid, value.ssid, value.SSID];
  for (const candidate of candidates) {
    const ssid = String(candidate || '').trim();
    if (ssid && !networkAliasPattern.test(ssid)) return ssid.slice(0, 128);
  }
  return null;
}
function contextFrom(value = {}) {
  return {
    client_mac: value.client_mac || value.mac || null,
    client_ip: value.client_ip || value.ip || null,
    // Reyee Gateway may populate `ssid` with a network alias such as VLAN10.
    // Prefer explicit WLAN parameters and never persist that alias as the SSID.
    ssid: ssidFromGateway(value),
    login_url: value.login_url || null,
    logout_url: value.logout_url || null,
    orig_url: value.orig_url || value.url || null,
    // WiFiDog context is forwarded by Reyee when opening an external portal.
    gw_address: value.gw_address || null,
    gw_port: value.gw_port || null,
    gw_id: value.gw_id || null,
    gateway_name: value.gateway_name || value.gw_name || value.device_name || null,
    gateway_model: value.gateway_model || value.gw_model || value.device_model || null,
    token: value.token || null
  };
}
function gatewayKey(value) {
  const candidate = typeof value === 'object' && value ? value.gw_id : value;
  return String(candidate || '').trim().slice(0, 191) || 'unassigned';
}
function ensureGateway(context = {}) {
  const gatewayId = gatewayKey(context);
  const now = new Date().toISOString();
  const suppliedName = String(context.gateway_name || '').trim().slice(0, 120);
  const suppliedModel = String(context.gateway_model || '').trim().slice(0, 120) || null;
  const defaultName = gatewayId === 'unassigned' ? 'Gateway belum teridentifikasi' : `Gateway ${gatewayId}`;
  db.prepare(`INSERT INTO gateways (id,project_id,name,location,model,created_at,last_seen_at)
    VALUES (?,'default-project',?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,
      model=COALESCE(gateways.model,excluded.model)`).run(gatewayId, suppliedName || defaultName, null, suppliedModel, now, now);
  return gatewayId;
}
function trackClient(context) {
  const mac = String(context.client_mac || '').trim().toLowerCase();
  const gatewayId = ensureGateway(context);
  if (!mac) return { gatewayId, mac:null };
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO clients (mac_address,client_ip,ssid,gateway_id,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(gateway_id,mac_address) DO UPDATE SET
      client_ip=COALESCE(excluded.client_ip,clients.client_ip),
      ssid=COALESCE(excluded.ssid,clients.ssid),
      last_seen_at=excluded.last_seen_at`).run(mac, context.client_ip, context.ssid, gatewayId, now, now);
  return { gatewayId, mac };
}
function clientIdentity(userId, macAddress) {
  const user = userId ? db.prepare('SELECT full_name,email FROM users WHERE id=?').get(userId) : null;
  const mac = String(macAddress || '').trim().toLowerCase();
  return {
    name:user?.full_name || `Perangkat ${mac ? mac.slice(-8).toUpperCase() : 'tamu'}`,
    detail:user?.email || mac || 'Pelanggan WiFi'
  };
}
function createClientNotification(type, { gatewayId = 'unassigned', macAddress, userId = null, accessType = null, eventKey, reason = '' }) {
  if (!eventKey) return;
  const identity = clientIdentity(userId, macAddress);
  const accessLabel = accessType === 'high_speed' ? 'High Speed' : accessType === 'limited' ? 'Limited' : 'WiFi';
  const title = type === 'client_login' ? 'Pelanggan terhubung' : 'Pelanggan offline';
  const message = type === 'client_login'
    ? `${identity.name} login dan terhubung dengan akses ${accessLabel}.`
    : `${identity.name} sudah offline${reason === 'session-expired' ? ' karena masa akses berakhir' : ''}.`;
  db.prepare(`INSERT OR IGNORE INTO notifications
    (id,event_key,type,client_mac,gateway_id,user_id,title,message,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id(), eventKey, type, macAddress || null, gatewayKey(gatewayId), userId, title, message, new Date().toISOString());
}
function markClientOffline(gatewayId, macAddress, reason = 'heartbeat-missing') {
  const scopedGatewayId = gatewayKey(gatewayId);
  const mac = String(macAddress || '').trim().toLowerCase();
  if (!mac) return false;
  const client = db.prepare('SELECT user_id,access_type,auth_status,authorized_until FROM clients WHERE gateway_id=? AND mac_address=?').get(scopedGatewayId, mac);
  if (!client || client.auth_status !== 'authorized') return false;
  db.prepare("UPDATE clients SET auth_status='pending' WHERE gateway_id=? AND mac_address=?").run(scopedGatewayId, mac);
  createClientNotification('client_offline', {
    gatewayId:scopedGatewayId, macAddress:mac, userId:client.user_id, accessType:client.access_type,
    eventKey:`offline:${scopedGatewayId}:${mac}:${client.authorized_until || new Date().toISOString()}`, reason
  });
  return true;
}
function sweepOfflineClients(now = new Date()) {
  const nowIso = now.toISOString();
  const configured = Number.isFinite(config.clientOfflineMinutes) && config.clientOfflineMinutes > 0 ? config.clientOfflineMinutes : 20;
  const heartbeatDeadline = new Date(now.getTime() - configured * 60 * 1000).toISOString();
  const staleClients = db.prepare(`SELECT gateway_id,mac_address,authorized_until,last_seen_at FROM clients
    WHERE auth_status='authorized' AND (authorized_until<=? OR last_seen_at<?)`).all(nowIso, heartbeatDeadline);
  for (const client of staleClients) {
    markClientOffline(client.gateway_id, client.mac_address, client.authorized_until <= nowIso ? 'session-expired' : 'heartbeat-missing');
  }
  return staleClients.length;
}
function clearClientRevocation(gatewayId, macAddress) {
  const scopedGatewayId = gatewayKey(gatewayId);
  const mac = String(macAddress || '').trim().toLowerCase();
  if (!mac) return;
  const macHash = hashToken(mac);
  db.prepare('DELETE FROM revoked_gateway_clients WHERE gateway_id=? AND mac_hash=?').run(scopedGatewayId, macHash);
  db.prepare('DELETE FROM revoked_clients WHERE mac_hash=?').run(macHash);
}
function isClientRevoked(gatewayId, macAddress, nowIso = new Date().toISOString()) {
  const scopedGatewayId = gatewayKey(gatewayId);
  const mac = String(macAddress || '').trim().toLowerCase();
  if (!mac) return false;
  const macHash = hashToken(mac);
  const revoked = db.prepare(`SELECT expires_at,'scoped' AS source FROM revoked_gateway_clients WHERE gateway_id=? AND mac_hash=?
    UNION ALL SELECT expires_at,'legacy' AS source FROM revoked_clients WHERE mac_hash=? LIMIT 1`).get(scopedGatewayId, macHash, macHash);
  if (revoked && revoked.expires_at <= nowIso) {
    if (revoked.source === 'scoped') db.prepare('DELETE FROM revoked_gateway_clients WHERE gateway_id=? AND mac_hash=?').run(scopedGatewayId, macHash);
    else db.prepare('DELETE FROM revoked_clients WHERE mac_hash=?').run(macHash);
    return false;
  }
  return !!revoked;
}
function wifiDogAuthorization(context, profile, userId) {
  if (!context.gw_address || !context.gw_port) return null;
  const port = Number(context.gw_port);
  const gateway = String(context.gw_address).trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-zA-Z0-9.:[\]-]+$/.test(gateway)) return null;
  const mac = String(context.client_mac || '').trim().toLowerCase();
  if (!mac) return null;
  const gatewayId = ensureGateway(context);
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const nowIso = now.toISOString();
  const tokenTtl = Number.isFinite(config.wifiDogTokenTtlSeconds) && config.wifiDogTokenTtlSeconds > 0 ? config.wifiDogTokenTtlSeconds : 300;
  const loginExpiresAt = new Date(now.getTime() + tokenTtl * 1000).toISOString();
  const revokedRetention = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM captive_sessions WHERE
    (authorized_at IS NULL AND login_expires_at < ?) OR
    (authorized_at IS NOT NULL AND authorized_until < ?) OR
    (revoked_at IS NOT NULL AND revoked_at < ?)`).run(nowIso, nowIso, revokedRetention);
  db.prepare('UPDATE captive_sessions SET revoked_at=? WHERE gateway_id=? AND mac_address=? AND revoked_at IS NULL').run(nowIso, gatewayId, mac);
  db.prepare(`INSERT INTO captive_sessions
    (token_hash,mac_address,client_ip,gateway_id,user_id,access_type,created_at,login_expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(hashToken(token), mac, context.client_ip, gatewayId, userId, profile, nowIso, loginExpiresAt);
  const host = gateway.includes(':') && !gateway.startsWith('[') ? `[${gateway}]` : gateway;
  const url = new URL(`http://${host}:${port}/wifidog/auth`);
  url.searchParams.set('token', token);
  return { mode: 'redirect', protocol: 'wifidog', url: url.toString(), profile, sessionHours:sessionHoursFor(profile), tokenExpiresAt: loginExpiresAt };
}
function authorize(context, profile, username, userId = null) {
  if (config.reyeeMode !== 'redirect') return { mode: 'mock', profile, message: `Otorisasi ${profile} disimulasikan. Atur REYEE_AUTH_MODE=redirect untuk gateway.` };
  const wifiDog = wifiDogAuthorization(context, profile, userId);
  if (wifiDog) return wifiDog;
  if (!context.login_url) return { mode: 'mock', profile, message: 'Data redirect dari gateway belum diterima.' };
  const url = new URL(context.login_url);
  url.searchParams.set(config.reyeeUserParam, username);
  url.searchParams.set(config.reyeePasswordParam, profile === 'limited' ? 'limited-guest' : `portal-${username}`);
  if (context.orig_url) url.searchParams.set(config.reyeePostUrlParam, context.orig_url);
  return { mode: 'redirect', url: url.toString(), profile };
}
function writeLog(userId, context, accessType) {
  const tracked = trackClient(context);
  const gatewayId = tracked?.gatewayId || ensureGateway(context);
  const mac = tracked?.mac || String(context.client_mac || '').trim().toLowerCase() || null;
  clearClientRevocation(gatewayId, mac);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO access_logs (id,user_id,mac_address,client_ip,access_type,ssid,gateway_id,timestamp) VALUES (?,?,?,?,?,?,?,?)').run(id(), userId, mac, context.client_ip, accessType, context.ssid, gatewayId, now);
  if (mac) db.prepare('UPDATE clients SET user_id=?, access_type=?, auth_status=?, last_seen_at=?, authorized_until=NULL WHERE gateway_id=? AND mac_address=?').run(userId, accessType, 'pending', now, gatewayId, mac);
}

function confirmWifiDogSession(url) {
  const stage = String(url.searchParams.get('stage') || '').toLowerCase();
  const context = contextFrom(Object.fromEntries(url.searchParams.entries()));
  const mac = String(context.client_mac || '').trim().toLowerCase();
  const rawToken = String(url.searchParams.get('token') || '');
  const tokenSession = rawToken ? db.prepare('SELECT * FROM captive_sessions WHERE token_hash=?').get(hashToken(rawToken)) : null;
  const requestGatewayId = gatewayKey(context.gw_id || tokenSession?.gateway_id);
  const now = new Date();
  const nowIso = now.toISOString();

  if (isClientRevoked(requestGatewayId, mac, nowIso)) return false;
  trackClient({ ...context, gw_id:requestGatewayId });

  if (stage === 'logout') {
    if (rawToken) db.prepare('UPDATE captive_sessions SET revoked_at=? WHERE token_hash=?').run(nowIso, hashToken(rawToken));
    markClientOffline(requestGatewayId, mac, 'logout');
    return false;
  }

  if (stage === 'login') {
    if (!rawToken || !mac) return false;
    const session = tokenSession;
    const sessionGatewayId = gatewayKey(session?.gateway_id || requestGatewayId);
    if (isClientRevoked(sessionGatewayId, mac, nowIso)) return false;
    const gatewayMatches = !context.gw_id || sessionGatewayId === requestGatewayId;
    const canLogin = session && !session.revoked_at && session.mac_address === mac && gatewayMatches &&
      ((session.authorized_at && session.authorized_until > nowIso) || (!session.authorized_at && session.login_expires_at > nowIso));
    if (!canLogin) return false;
    const sessionHours = sessionHoursFor(session.access_type);
    const firstAuthorization = !session.authorized_at;
    const authorizedAt = session.authorized_at || nowIso;
    const authorizedUntil = session.authorized_until || new Date(now.getTime() + sessionHours * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE captive_sessions SET authorized_at=?,authorized_until=? WHERE token_hash=?').run(authorizedAt, authorizedUntil, hashToken(rawToken));
    db.prepare(`UPDATE clients SET user_id=?,access_type=?,auth_status='authorized',last_seen_at=?,authorized_until=? WHERE gateway_id=? AND mac_address=?`)
      .run(session.user_id, session.access_type, nowIso, authorizedUntil, sessionGatewayId, mac);
    if (firstAuthorization) createClientNotification('client_login', {
      gatewayId:sessionGatewayId, macAddress:mac, userId:session.user_id, accessType:session.access_type,
      eventKey:`login:${hashToken(rawToken)}`
    });
    return true;
  }

  if (rawToken) {
    const session = tokenSession;
    const valid = !!(session && !session.revoked_at && session.authorized_at && session.authorized_until > nowIso && (!mac || session.mac_address === mac));
    if (session?.authorized_at && !valid && session.mac_address === mac) markClientOffline(session.gateway_id, mac, 'session-expired');
    return valid;
  }

  if (!mac) return false;
  const client = db.prepare('SELECT auth_status,authorized_until FROM clients WHERE gateway_id=? AND mac_address=?').get(requestGatewayId, mac);
  const valid = client?.auth_status === 'authorized' && client.authorized_until && client.authorized_until > nowIso;
  if (client?.auth_status === 'authorized' && !valid) markClientOffline(requestGatewayId, mac, 'session-expired');
  return !!valid;
}

function deleteClientRecords(gatewayId, macAddress) {
  const scopedGatewayId = gatewayKey(gatewayId);
  const mac = String(macAddress || '').trim().toLowerCase();
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return { error:'MAC address tidak valid.', status:400 };
  const client = db.prepare('SELECT user_id FROM clients WHERE gateway_id=? AND mac_address=?').get(scopedGatewayId, mac);
  if (!client) return { error:'Data perangkat tidak ditemukan.', status:404 };
  const userId = client.user_id || null;
  const relatedClients = userId
    ? db.prepare('SELECT gateway_id,mac_address FROM clients WHERE user_id=?').all(userId)
    : [{ gateway_id:scopedGatewayId, mac_address:mac }];
  const deviceCount = relatedClients.length;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (userId) {
      db.prepare('DELETE FROM notifications WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM captive_sessions WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM access_logs WHERE user_id=?').run(userId);
      for (const relatedClient of relatedClients) {
        db.prepare('DELETE FROM notifications WHERE gateway_id=? AND client_mac=?').run(relatedClient.gateway_id, relatedClient.mac_address);
        db.prepare('DELETE FROM captive_sessions WHERE gateway_id=? AND mac_address=?').run(relatedClient.gateway_id, relatedClient.mac_address);
        db.prepare('DELETE FROM access_logs WHERE gateway_id=? AND mac_address=?').run(relatedClient.gateway_id, relatedClient.mac_address);
      }
      db.prepare('DELETE FROM clients WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM users WHERE id=?').run(userId);
    } else {
      db.prepare('DELETE FROM notifications WHERE gateway_id=? AND client_mac=?').run(scopedGatewayId, mac);
      db.prepare('DELETE FROM captive_sessions WHERE gateway_id=? AND mac_address=?').run(scopedGatewayId, mac);
      db.prepare('DELETE FROM access_logs WHERE gateway_id=? AND mac_address=?').run(scopedGatewayId, mac);
      db.prepare('DELETE FROM clients WHERE gateway_id=? AND mac_address=?').run(scopedGatewayId, mac);
    }
    const revokedAt = new Date();
    const expiresAt = new Date(revokedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const revoke = db.prepare('INSERT OR REPLACE INTO revoked_gateway_clients (gateway_id,mac_hash,revoked_at,expires_at) VALUES (?,?,?,?)');
    for (const relatedClient of relatedClients) revoke.run(relatedClient.gateway_id, hashToken(relatedClient.mac_address), revokedAt.toISOString(), expiresAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok:true, gatewayId:scopedGatewayId, macAddress:mac, deletedAccount:!!userId, deletedDevices:deviceCount, gatewayAuthorizationRevoked:true };
}
async function sendVerification(email, token) {
  const link = `${config.baseUrl}/?verify=${token}`;
  if (!mailTransport) {
    if (config.nodeEnv === 'production') throw new Error('SMTP_NOT_CONFIGURED');
    await appendFile(join(dataDir, 'email-outbox.ndjson'), JSON.stringify({ to: email, type: 'verify-email', link, createdAt: new Date().toISOString() }) + '\n');
    return link;
  }
  await mailTransport.sendMail({
    from:`PerumNet WiFi <${config.emailFrom}>`, to:email, subject:'Verifikasi akun WiFi PerumNet',
    text:`Verifikasi akun PerumNet Anda melalui tautan berikut: ${link}`,
    html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px"><h2 style="color:#008d85">Verifikasi akun PerumNet</h2><p>Klik tombol berikut untuk memverifikasi email dan mengaktifkan login High Speed.</p><p><a href="${link}" style="display:inline-block;padding:12px 20px;color:#fff;background:#04a99f;border-radius:8px;text-decoration:none;font-weight:700">Verifikasi Email</a></p><p style="color:#71828b;font-size:12px">Jika Anda tidak mendaftar, abaikan email ini.</p></div>`
  });
  return link;
}
async function sendPasswordReset(email, token) {
  const link = `${config.baseUrl}/?reset=${token}`;
  if (!mailTransport) {
    if (config.nodeEnv === 'production') throw new Error('SMTP_NOT_CONFIGURED');
    await appendFile(join(dataDir, 'email-outbox.ndjson'), JSON.stringify({ to:email, type:'reset-password', link, createdAt:new Date().toISOString() }) + '\n');
    return link;
  }
  await mailTransport.sendMail({
    from:`PerumNet WiFi <${config.emailFrom}>`, to:email, subject:'Reset kata sandi WiFi PerumNet',
    text:`Atur ulang kata sandi akun PerumNet Anda melalui tautan berikut: ${link}. Tautan ini hanya berlaku sementara.`,
    html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px"><h2 style="color:#008d85">Reset kata sandi PerumNet</h2><p>Klik tombol berikut untuk membuat kata sandi baru. Tautan ini berlaku selama ${config.passwordResetMinutes} menit dan hanya dapat digunakan satu kali.</p><p><a href="${link}" style="display:inline-block;padding:12px 20px;color:#fff;background:#04a99f;border-radius:8px;text-decoration:none;font-weight:700">Buat Kata Sandi Baru</a></p><p style="color:#71828b;font-size:12px">Jika Anda tidak meminta reset kata sandi, abaikan email ini.</p></div>`
  });
  return link;
}

async function api(req, res, url) {
  const route = url.pathname;
  if (route === '/api/settings' && req.method === 'GET') {
    const settings = db.prepare('SELECT welcome_title,welcome_text,limited_bandwidth_kbps,terms_text,default_ssid,account_ssid,free_ssid FROM portal_settings WHERE id=1').get();
    return json(res, 200, { ...settings, limited_session_hours:sessionHoursFor('limited') });
  }
  if (route === '/api/auth/register' && req.method === 'POST') {
    const { fullName, email, phone, address, password, consent, context } = await body(req);
    if (!fullName || !email || !phone || !address || !password || !consent) return json(res, 400, { error: 'Lengkapi data pendaftaran dan persetujuan.' });
    if (password.length < 8) return json(res, 400, { error: 'Kata sandi minimal 8 karakter.' });
    const normalized = String(email).toLowerCase().trim(); const exists = db.prepare('SELECT id FROM users WHERE email=?').get(normalized);
    if (exists) return json(res, 409, { error: 'Email ini sudah terdaftar. Silakan login.' });
    const token = randomBytes(24).toString('hex'); const userId = id();
    let verificationUrl;
    try { verificationUrl = await sendVerification(normalized, token); }
    catch (error) { console.error('Verification email failed:', error.message); return json(res, 503, { error:'Email verifikasi belum dapat dikirim. Hubungi administrator portal.' }); }
    db.prepare('INSERT INTO users (id,full_name,email,phone_number,address,password_hash,is_verified,verification_token,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(userId, fullName.trim(), normalized, phone.trim(), address.trim(), hashPassword(password), 0, hashToken(token), new Date().toISOString());
    return json(res, 201, { message: 'Cek email untuk verifikasi.', email: normalized, verificationUrl: process.env.NODE_ENV === 'production' ? undefined : verificationUrl });
  }
  if (route === '/api/auth/resend' && req.method === 'POST') {
    const { email } = await body(req); const normalized = String(email || '').toLowerCase().trim();
    const user = db.prepare('SELECT id,is_verified FROM users WHERE email=?').get(normalized);
    if (!user) return json(res, 200, { message:'Jika email terdaftar, tautan verifikasi akan dikirim.' });
    if (user.is_verified) return json(res, 409, { error:'Email sudah terverifikasi. Silakan login.' });
    const token = randomBytes(24).toString('hex');
    try { await sendVerification(normalized, token); }
    catch (error) { console.error('Verification resend failed:', error.message); return json(res, 503, { error:'Email verifikasi belum dapat dikirim. Hubungi administrator portal.' }); }
    db.prepare('UPDATE users SET verification_token=? WHERE id=?').run(hashToken(token), user.id);
    return json(res, 200, { message:'Email verifikasi dikirim ulang.' });
  }
  if (route === '/api/auth/verify' && req.method === 'POST') {
    const { token } = await body(req); const user = db.prepare('SELECT id FROM users WHERE verification_token=?').get(hashToken(token || ''));
    if (!user) return json(res, 400, { error: 'Tautan verifikasi tidak valid atau sudah digunakan.' });
    db.prepare('UPDATE users SET is_verified=1, verification_token=NULL WHERE id=?').run(user.id);
    return json(res, 200, { message: 'Email berhasil diverifikasi.' });
  }
  if (route === '/api/auth/forgot-password' && req.method === 'POST') {
    const { email } = await body(req);
    const normalized = String(email || '').toLowerCase().trim();
    const genericMessage = 'Jika email terdaftar, tautan reset kata sandi akan dikirim.';
    const user = db.prepare('SELECT id,email FROM users WHERE email=?').get(normalized);
    if (!user) return json(res, 200, { message:genericMessage });
    const now = new Date();
    const recentRequest = db.prepare('SELECT created_at FROM password_reset_tokens WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(user.id);
    if (recentRequest && new Date(recentRequest.created_at).getTime() > now.getTime() - 60 * 1000) return json(res, 200, { message:genericMessage });
    const retentionDeadline = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM password_reset_tokens WHERE expires_at<? OR (used_at IS NOT NULL AND used_at<?)').run(retentionDeadline, retentionDeadline);
    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const configuredMinutes = Number.isFinite(config.passwordResetMinutes) && config.passwordResetMinutes > 0 ? config.passwordResetMinutes : 30;
    const expiresAt = new Date(now.getTime() + configuredMinutes * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_reset_tokens (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(tokenHash, user.id, now.toISOString(), expiresAt);
    try { await sendPasswordReset(user.email, token); }
    catch (error) {
      db.prepare('DELETE FROM password_reset_tokens WHERE token_hash=?').run(tokenHash);
      console.error('Password reset email failed:', error.message);
      return json(res, 503, { error:'Email reset kata sandi belum dapat dikirim. Coba kembali beberapa saat lagi.' });
    }
    db.prepare('UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND token_hash<>? AND used_at IS NULL').run(now.toISOString(), user.id, tokenHash);
    return json(res, 200, { message:genericMessage });
  }
  if (route === '/api/auth/reset-password' && req.method === 'POST') {
    const { token, password } = await body(req);
    const newPassword = String(password || '');
    if (newPassword.length < 8) return json(res, 400, { error:'Kata sandi baru minimal 8 karakter.' });
    const nowIso = new Date().toISOString();
    const reset = db.prepare(`SELECT token_hash,user_id FROM password_reset_tokens
      WHERE token_hash=? AND used_at IS NULL AND expires_at>?`).get(hashToken(token || ''), nowIso);
    if (!reset) return json(res, 400, { error:'Tautan reset tidak valid, sudah digunakan, atau kedaluwarsa.' });
    const activeClients = db.prepare("SELECT gateway_id,mac_address FROM clients WHERE user_id=? AND auth_status='authorized'").all(reset.user_id);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), reset.user_id);
      db.prepare('UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL').run(nowIso, reset.user_id);
      db.prepare('UPDATE captive_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(nowIso, reset.user_id);
      for (const client of activeClients) markClientOffline(client.gateway_id, client.mac_address, 'password-reset');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, 200, { message:'Kata sandi berhasil diperbarui.' });
  }
  if (route === '/api/auth/login' && req.method === 'POST') {
    const { email, password, context } = await body(req); const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase().trim());
    if (!user || !verifyPassword(password || '', user.password_hash)) return json(res, 401, { error: 'Email atau kata sandi tidak tepat.' });
    if (!user.is_verified) return json(res, 403, { error: 'Email belum terverifikasi. Periksa inbox Anda.' });
    const captive = contextFrom(context); writeLog(user.id, captive, 'high_speed'); return json(res, 200, { authorization: authorize(captive, 'high_speed', user.email, user.id), user: { name: user.full_name, email: user.email } });
  }
  if (route === '/api/captive/limited' && req.method === 'POST') { const { context } = await body(req); const captive = contextFrom(context); const setting = db.prepare('SELECT limited_bandwidth_kbps FROM portal_settings WHERE id=1').get(); writeLog(null, captive, 'limited'); const authorization = authorize(captive, 'limited', `guest-${captive.client_mac || id().slice(0,8)}`); return json(res, 200, { bandwidthKbps:setting.limited_bandwidth_kbps, sessionHours:sessionHoursFor('limited'), authorization }); }
  if (route === '/api/admin/login' && req.method === 'POST') { const { email, password } = await body(req); if (email !== config.adminEmail || password !== config.adminPassword) return json(res, 401, { error: 'Kredensial admin tidak tepat.' }); const sig = createHash('sha256').update(`${config.adminEmail}:${config.sessionSecret}`).digest('hex'); const encodedEmail = Buffer.from(config.adminEmail).toString('base64url'); return json(res, 200, { ok: true, email:config.adminEmail }, { 'set-cookie': adminCookie(`${encodedEmail}.${sig}`) }); }
  if (route === '/api/admin/session' && req.method === 'GET') { if (!adminSession(req)) return json(res, 401, { error: 'Sesi admin diperlukan.' }); return json(res, 200, { ok:true, email:config.adminEmail }); }
  if (route === '/api/admin/logout' && req.method === 'POST') return json(res, 200, { ok:true }, { 'set-cookie': adminCookie('', 0) });
  if (route === '/api/admin/network' && req.method === 'GET') {
    if (!requireAdmin(req,res)) return;
    const projects = db.prepare(`SELECT p.id,p.name,p.location,p.created_at,
      COUNT(DISTINCT CASE WHEN g.id<>'unassigned' OR c.mac_address IS NOT NULL THEN g.id END) AS gateway_count,COUNT(c.mac_address) AS client_count
      FROM projects p LEFT JOIN gateways g ON g.project_id=p.id
      LEFT JOIN clients c ON c.gateway_id=g.id
      GROUP BY p.id ORDER BY CASE WHEN p.id='default-project' THEN 0 ELSE 1 END,p.name`).all();
    const gateways = db.prepare(`SELECT g.id,g.project_id,g.name,g.location,g.model,g.created_at,g.last_seen_at,
      p.name AS project_name,COUNT(c.mac_address) AS client_count,
      SUM(CASE WHEN c.auth_status='authorized' THEN 1 ELSE 0 END) AS authorized_count
      FROM gateways g JOIN projects p ON p.id=g.project_id
      LEFT JOIN clients c ON c.gateway_id=g.id
      GROUP BY g.id ORDER BY CASE WHEN g.id='unassigned' THEN 1 ELSE 0 END,p.name,g.name`).all();
    const offlineDeadline = new Date(Date.now() - (Number.isFinite(config.clientOfflineMinutes) && config.clientOfflineMinutes > 0 ? config.clientOfflineMinutes : 20) * 60 * 1000).toISOString();
    return json(res, 200, {
      projects,
      gateways:gateways.map(gateway => ({ ...gateway, status:gateway.id !== 'unassigned' && gateway.last_seen_at >= offlineDeadline ? 'online' : 'offline' }))
    });
  }
  if (route === '/api/admin/projects' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    const name = String(payload.name || '').trim().slice(0,120);
    const location = String(payload.location || '').trim().slice(0,180) || null;
    if (!name) return json(res, 400, { error:'Nama project wajib diisi.' });
    const project = { id:`project-${id().slice(0,12)}`, name, location, created_at:new Date().toISOString() };
    db.prepare('INSERT INTO projects (id,name,location,created_at) VALUES (?,?,?,?)').run(project.id, project.name, project.location, project.created_at);
    return json(res, 201, { project });
  }
  if (route === '/api/admin/gateways' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    if (!payload.gatewayId) return json(res, 400, { error:'ID gateway wajib diisi.' });
    const gatewayId = gatewayKey(payload.gatewayId);
    const projectId = String(payload.projectId || 'default-project').trim();
    const project = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
    if (!project) return json(res, 400, { error:'Project tujuan tidak ditemukan.' });
    const current = db.prepare('SELECT * FROM gateways WHERE id=?').get(gatewayId);
    const name = String(payload.name || current?.name || `Gateway ${gatewayId}`).trim().slice(0,120);
    const location = String(payload.location ?? current?.location ?? '').trim().slice(0,180) || null;
    const model = String(payload.model ?? current?.model ?? '').trim().slice(0,120) || null;
    const createdAt = current?.created_at || new Date().toISOString();
    db.prepare(`INSERT INTO gateways (id,project_id,name,location,model,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,name=excluded.name,location=excluded.location,model=excluded.model`)
      .run(gatewayId, projectId, name, location, model, createdAt, current?.last_seen_at || null);
    return json(res, 200, { gateway:db.prepare('SELECT * FROM gateways WHERE id=?').get(gatewayId) });
  }
  if (route === '/api/admin/clients' && req.method === 'GET') {
    if (!requireAdmin(req,res)) return;
    sweepOfflineClients();
    const gatewayId = String(url.searchParams.get('gatewayId') || '').trim();
    const projectId = String(url.searchParams.get('projectId') || '').trim();
    const scopeSql = gatewayId ? ' WHERE c.gateway_id=?' : projectId ? ' WHERE g.project_id=?' : '';
    const scopeParams = gatewayId ? [gatewayId] : projectId ? [projectId] : [];
    const rows = db.prepare(`SELECT c.gateway_id,c.mac_address,c.client_ip,c.ssid,c.access_type,c.auth_status,c.first_seen_at,c.last_seen_at,c.authorized_until,
      g.name AS gateway_name,g.location AS gateway_location,g.model AS gateway_model,g.project_id,
      p.name AS project_name,p.location AS project_location,
      u.full_name,u.email,u.phone_number,u.address,u.is_verified
      FROM clients c LEFT JOIN users u ON u.id=c.user_id
      JOIN gateways g ON g.id=c.gateway_id JOIN projects p ON p.id=g.project_id
      ${scopeSql} ORDER BY c.last_seen_at DESC LIMIT 500`).all(...scopeParams);
    const ssidSettings = db.prepare('SELECT default_ssid,account_ssid,free_ssid FROM portal_settings WHERE id=1').get() || {};
    const clients = rows.map(row => ({
      ...row,
      ssid:ssidFromGateway({ ssid:row.ssid }) || (row.access_type === 'limited' ? ssidSettings.free_ssid : ssidSettings.account_ssid || ssidSettings.default_ssid) || null
    }));
    const today = new Date().toISOString().slice(0,10);
    const stats = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN substr(c.last_seen_at,1,10)=? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN c.auth_status='authorized' THEN 1 ELSE 0 END) AS authorized
      FROM clients c JOIN gateways g ON g.id=c.gateway_id ${scopeSql}`).get(today, ...scopeParams);
    return json(res, 200, { clients, stats:{ total:stats.total || 0, today:stats.today || 0, authorized:stats.authorized || 0 } });
  }
  if (route === '/api/admin/notifications' && req.method === 'GET') {
    if (!requireAdmin(req,res)) return;
    sweepOfflineClients();
    const gatewayId = String(url.searchParams.get('gatewayId') || '').trim();
    const projectId = String(url.searchParams.get('projectId') || '').trim();
    const scopeCondition = gatewayId ? 'n.gateway_id=?' : projectId ? 'g.project_id=?' : '';
    const scopeSql = scopeCondition ? ` WHERE ${scopeCondition}` : '';
    const scopeParams = gatewayId ? [gatewayId] : projectId ? [projectId] : [];
    const notifications = db.prepare(`SELECT n.id,n.type,n.client_mac,n.gateway_id,n.title,n.message,n.created_at,n.read_at,
      g.name AS gateway_name,g.project_id,p.name AS project_name
      FROM notifications n JOIN gateways g ON g.id=n.gateway_id JOIN projects p ON p.id=g.project_id
      ${scopeSql} ORDER BY n.created_at DESC LIMIT 60`).all(...scopeParams);
    const unreadWhere = scopeCondition ? `WHERE n.read_at IS NULL AND ${scopeCondition}` : 'WHERE n.read_at IS NULL';
    const unreadCount = db.prepare(`SELECT COUNT(*) AS total FROM notifications n JOIN gateways g ON g.id=n.gateway_id ${unreadWhere}`).get(...scopeParams)?.total || 0;
    return json(res, 200, { notifications, unreadCount });
  }
  if (route === '/api/admin/notifications/read' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const gatewayId = String(url.searchParams.get('gatewayId') || '').trim();
    const projectId = String(url.searchParams.get('projectId') || '').trim();
    const now = new Date().toISOString();
    if (gatewayId) db.prepare('UPDATE notifications SET read_at=? WHERE read_at IS NULL AND gateway_id=?').run(now, gatewayId);
    else if (projectId) db.prepare('UPDATE notifications SET read_at=? WHERE read_at IS NULL AND gateway_id IN (SELECT id FROM gateways WHERE project_id=?)').run(now, projectId);
    else db.prepare('UPDATE notifications SET read_at=? WHERE read_at IS NULL').run(now);
    return json(res, 200, { ok:true });
  }
  if (route === '/api/admin/clients' && req.method === 'DELETE') {
    if (!requireAdmin(req,res)) return;
    const { gatewayId, macAddress } = await body(req);
    if (!gatewayId) return json(res, 400, { error:'Identitas gateway diperlukan agar data perangkat yang tepat dapat dihapus.' });
    const result = deleteClientRecords(gatewayId, macAddress);
    if (result.error) return json(res, result.status, { error:result.error });
    return json(res, 200, result);
  }
  if (route === '/api/admin/settings' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const { welcomeTitle,welcomeText,limitedBandwidthKbps,termsText,googleSheetId,accountSsid,freeSsid } = await body(req);
    const normalizedAccountSsid = String(accountSsid || '@PERUMNET_WiFi').trim().slice(0,128);
    const normalizedFreeSsid = String(freeSsid || '@PERUMNET_FreeWiFi').trim().slice(0,128);
    if (!normalizedAccountSsid || !normalizedFreeSsid) return json(res, 400, { error:'Kedua SSID portal wajib diisi.' });
    db.prepare('UPDATE portal_settings SET welcome_title=?,welcome_text=?,limited_bandwidth_kbps=?,terms_text=?,google_sheet_id=?,default_ssid=?,account_ssid=?,free_ssid=?,updated_at=? WHERE id=1')
      .run(welcomeTitle, welcomeText, Number(limitedBandwidthKbps || 512), termsText, googleSheetId || null, normalizedAccountSsid, normalizedAccountSsid, normalizedFreeSsid, new Date().toISOString());
    return json(res, 200, { ok:true, accountSsid:normalizedAccountSsid, freeSsid:normalizedFreeSsid });
  }
  return json(res, 404, { error: 'Endpoint tidak ditemukan.' });
}
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' };
const server = createServer(async (req, res) => {
  // A request-target beginning with // is treated as a host by WHATWG URL.
  // ReyeeOS sends exactly that form for WiFiDog, so keep it as a path.
  const requestUrl = req.url.startsWith('//') ? `/${req.url.replace(/^\/+/, '')}` : req.url;
  const url = new URL(requestUrl, config.baseUrl);
  try {
    // Reyee WiFiDog appends these paths to the Auth Server URL. A leading double
    // slash is normal in ReyeeOS redirects, so normalize it before matching.
    const normalizedPath = url.pathname.replace(/^\/+/,'/');
    const freeWifiDog = normalizedPath === '/free/auth/wifidogAuth' || normalizedPath.startsWith('/free/auth/wifidogAuth/');
    const wifiDogPath = freeWifiDog ? normalizedPath.slice('/free'.length) : normalizedPath;
    if (wifiDogPath === '/auth/wifidogAuth/login/' || wifiDogPath === '/auth/wifidogAuth/login') {
      trackClient(contextFrom(Object.fromEntries(url.searchParams.entries())));
      res.writeHead(200, { 'content-type': mime['.html'] }); return res.end(await readFile(join(root, 'index.html')));
    }
    if (wifiDogPath === '/auth/wifidogAuth/ping/' || wifiDogPath === '/auth/wifidogAuth/ping') {
      ensureGateway(contextFrom(Object.fromEntries(url.searchParams.entries()))); return text(res, 200, 'Pong');
    }
    if (wifiDogPath === '/auth/wifidogAuth/auth/' || wifiDogPath === '/auth/wifidogAuth/auth') {
      const stage = url.searchParams.get('stage');
      if (stage === 'check') { ensureGateway(contextFrom(Object.fromEntries(url.searchParams.entries()))); return text(res, 200, 'Auth: 1\n'); } // Gateway health probe.
      return text(res, 200, confirmWifiDogSession(url) ? 'Auth: 1\n' : 'Auth: 0\n');
    }
    if (wifiDogPath === '/auth/wifidogAuth/portal/' || wifiDogPath === '/auth/wifidogAuth/portal') {
      res.writeHead(302, { location: `${config.baseUrl}${freeWifiDog ? '/free' : '/'}?connected=1` }); return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    let pathname = (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/free' || url.pathname === '/free/') ? '/index.html' : url.pathname;
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root)) return json(res, 403, { error: 'Forbidden' });
    await stat(target); res.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream' }); res.end(await readFile(target));
  } catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'Tidak ditemukan.' }); console.error(error); json(res, 500, { error: 'Kesalahan server.' }); }
});
server.listen(config.port, () => console.log(`PerumNet Captive Portal running at ${config.baseUrl}`));
