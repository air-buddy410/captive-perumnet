import { createServer } from 'node:http';
import { readFile, writeFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';

try { process.loadEnvFile?.('.env'); } catch { /* .env is optional for local development */ }

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.PORTAL_DATA_DIR ? resolve(process.env.PORTAL_DATA_DIR) : join(root, 'data');
await mkdir(dataDir, { recursive: true });
const uploadsDir = join(dataDir, 'uploads');
await mkdir(uploadsDir, { recursive: true });
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
    approval_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(approval_status IN ('pending','approved')),
    approved_at TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );
  CREATE TABLE IF NOT EXISTS gateway_blocks (
    gateway_id TEXT PRIMARY KEY, blocked_at TEXT NOT NULL, reason TEXT
  );
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portal_network_routes (
    gateway_id TEXT NOT NULL, network_alias TEXT NOT NULL,
    client_cidr TEXT, network_description TEXT,
    portal_mode TEXT NOT NULL DEFAULT 'account'
      CHECK(portal_mode IN ('account','free')),
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, configured_at TEXT,
    PRIMARY KEY(gateway_id,network_alias),
    FOREIGN KEY(gateway_id) REFERENCES gateways(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_portal_network_cidr ON portal_network_routes(gateway_id,client_cidr);
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
    session_started_at TEXT, last_counter_at TEXT,
    incoming_bytes INTEGER NOT NULL DEFAULT 0, outgoing_bytes INTEGER NOT NULL DEFAULT 0,
    incoming_bps REAL, outgoing_bps REAL,
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
    last_counter_at TEXT, incoming_bytes INTEGER NOT NULL DEFAULT 0,
    outgoing_bytes INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_captive_sessions_mac ON captive_sessions(mac_address);
  CREATE TABLE IF NOT EXISTS telemetry_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gateway_id TEXT NOT NULL, mac_address TEXT NOT NULL,
    user_id TEXT, access_type TEXT, ssid TEXT,
    sampled_at TEXT NOT NULL,
    incoming_bytes INTEGER NOT NULL DEFAULT 0, outgoing_bytes INTEGER NOT NULL DEFAULT 0,
    incoming_delta INTEGER NOT NULL DEFAULT 0, outgoing_delta INTEGER NOT NULL DEFAULT 0,
    incoming_bps REAL, outgoing_bps REAL
  );
  CREATE INDEX IF NOT EXISTS idx_telemetry_sampled_at ON telemetry_samples(sampled_at DESC);
  CREATE INDEX IF NOT EXISTS idx_telemetry_gateway_time ON telemetry_samples(gateway_id,sampled_at DESC);
  CREATE INDEX IF NOT EXISTS idx_telemetry_user_time ON telemetry_samples(user_id,sampled_at DESC);
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
  CREATE TABLE IF NOT EXISTS portal_profile_content (
    profile TEXT PRIMARY KEY CHECK(profile IN ('account','free')),
    eyebrow TEXT NOT NULL, headline TEXT NOT NULL, description TEXT NOT NULL,
    primary_button_label TEXT NOT NULL,
    announcement_enabled INTEGER NOT NULL DEFAULT 0,
    announcement_tone TEXT NOT NULL DEFAULT 'info'
      CHECK(announcement_tone IN ('info','promo','warning')),
    announcement_title TEXT, announcement_text TEXT,
    announcement_link_label TEXT, announcement_link_url TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portal_promotions (
    id TEXT PRIMARY KEY,
    profile TEXT NOT NULL CHECK(profile IN ('account','free')),
    title TEXT NOT NULL, description TEXT,
    image_url TEXT, link_label TEXT, link_url TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_portal_promotions_profile
    ON portal_promotions(profile,is_active,sort_order);
`);
try { db.exec("ALTER TABLE portal_settings ADD COLUMN default_ssid TEXT NOT NULL DEFAULT 'PerumNet Guest'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec("ALTER TABLE portal_settings ADD COLUMN account_ssid TEXT NOT NULL DEFAULT '@PERUMNET_WiFi'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec("ALTER TABLE portal_settings ADD COLUMN free_ssid TEXT NOT NULL DEFAULT '@PERUMNET_FreeWiFi'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE clients ADD COLUMN authorized_until TEXT'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE clients ADD COLUMN session_started_at TEXT'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE clients ADD COLUMN last_counter_at TEXT'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE clients ADD COLUMN incoming_bytes INTEGER NOT NULL DEFAULT 0'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE clients ADD COLUMN outgoing_bytes INTEGER NOT NULL DEFAULT 0'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE clients ADD COLUMN incoming_bps REAL'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE clients ADD COLUMN outgoing_bps REAL'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE captive_sessions ADD COLUMN last_counter_at TEXT'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE captive_sessions ADD COLUMN incoming_bytes INTEGER NOT NULL DEFAULT 0'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE captive_sessions ADD COLUMN outgoing_bytes INTEGER NOT NULL DEFAULT 0'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec("ALTER TABLE access_logs ADD COLUMN gateway_id TEXT NOT NULL DEFAULT 'unassigned'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec("ALTER TABLE notifications ADD COLUMN gateway_id TEXT NOT NULL DEFAULT 'unassigned'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec("ALTER TABLE gateways ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending','approved'))"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE gateways ADD COLUMN approved_at TEXT'); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE portal_network_routes ADD COLUMN network_description TEXT'); } catch { /* The column already exists after an upgrade. */ }

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
        session_started_at TEXT, last_counter_at TEXT,
        incoming_bytes INTEGER NOT NULL DEFAULT 0, outgoing_bytes INTEGER NOT NULL DEFAULT 0,
        incoming_bps REAL, outgoing_bps REAL,
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
if (!db.prepare("SELECT name FROM schema_migrations WHERE name='gateway-approval-v1'").get()) {
  db.exec(`
    UPDATE gateways SET
      approval_status=CASE
        WHEN id='unassigned' THEN 'pending'
        WHEN name='Gateway ' || id THEN 'pending'
        ELSE 'approved'
      END,
      approved_at=CASE
        WHEN id<>'unassigned' AND name<>'Gateway ' || id THEN COALESCE(approved_at,created_at)
        ELSE NULL
      END;
  `);
  db.prepare('INSERT INTO schema_migrations (name,applied_at) VALUES (?,?)').run('gateway-approval-v1', migratedAt);
}
const routeGroups = db.prepare(`SELECT gateway_id,client_cidr FROM portal_network_routes
  WHERE client_cidr IS NOT NULL GROUP BY gateway_id,client_cidr`).all();
for (const group of routeGroups) {
  const routes = db.prepare(`SELECT * FROM portal_network_routes WHERE gateway_id=? AND client_cidr=?
    ORDER BY configured_at IS NOT NULL DESC,configured_at DESC,last_seen_at DESC`).all(group.gateway_id, group.client_cidr);
  const preferred = routes.find(route => /^(?:vlan|network|lan)[\s_-]*\d+$/i.test(route.network_alias));
  if (!preferred) {
    db.prepare('DELETE FROM portal_network_routes WHERE gateway_id=? AND client_cidr=?').run(group.gateway_id, group.client_cidr);
    continue;
  }
  const source = routes[0];
  const firstSeen = routes.map(route => route.first_seen_at).filter(Boolean).sort()[0] || preferred.first_seen_at;
  const lastSeen = routes.map(route => route.last_seen_at).filter(Boolean).sort().at(-1) || preferred.last_seen_at;
  const description = preferred.network_description || routes.find(route => route.network_description)?.network_description || null;
  db.prepare(`UPDATE portal_network_routes SET portal_mode=?,configured_at=?,first_seen_at=?,last_seen_at=?,network_description=?
    WHERE gateway_id=? AND network_alias=?`)
    .run(source.portal_mode, source.configured_at || preferred.configured_at, firstSeen, lastSeen, description, group.gateway_id, preferred.network_alias);
  db.prepare('DELETE FROM portal_network_routes WHERE gateway_id=? AND client_cidr=? AND network_alias<>?')
    .run(group.gateway_id, group.client_cidr, preferred.network_alias);
}
db.prepare(`INSERT OR IGNORE INTO portal_settings (id,welcome_title,welcome_text,limited_bandwidth_kbps,terms_text,updated_at) VALUES (1,?,?,?,?,?)`)
  .run('Masuk ke internet cepat.', 'Gunakan akun PerumNet yang sudah terverifikasi atau daftar untuk mendapatkan akses High Speed.', 512, 'Dengan melanjutkan, Anda menyetujui ketentuan penggunaan jaringan.', new Date().toISOString());
db.prepare(`UPDATE portal_settings SET welcome_title=?,welcome_text=?,updated_at=?
  WHERE id=1 AND welcome_title='Internet sesuai kebutuhan Anda.' AND welcome_text='Pilih akses cepat atau langsung terhubung dengan kecepatan terbatas.'`)
  .run('Masuk ke internet cepat.', 'Gunakan akun PerumNet yang sudah terverifikasi atau daftar untuk mendapatkan akses High Speed.', new Date().toISOString());
const initialPortalSettings = db.prepare('SELECT welcome_title,welcome_text FROM portal_settings WHERE id=1').get();
db.prepare(`INSERT OR IGNORE INTO portal_profile_content
  (profile,eyebrow,headline,description,primary_button_label,announcement_enabled,announcement_tone,updated_at)
  VALUES ('account',?,?,?,?,0,'info',?)`)
  .run('Akses pelanggan', initialPortalSettings.welcome_title, initialPortalSettings.welcome_text, 'Login', new Date().toISOString());
db.prepare(`INSERT OR IGNORE INTO portal_profile_content
  (profile,eyebrow,headline,description,primary_button_label,announcement_enabled,announcement_tone,updated_at)
  VALUES ('free',?,?,?,?,0,'info',?)`)
  .run('Akses gratis', 'Terhubung dalam satu klik.', 'Tidak perlu akun atau mengisi data diri. Tekan tombol di bawah untuk mulai menggunakan internet.', 'Sambungkan Internet Gratis', new Date().toISOString());

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
const portalProfileDefaults = {
  account:{
    eyebrow:'Akses pelanggan',
    headline:'Masuk ke internet cepat.',
    description:'Gunakan akun PerumNet yang sudah terverifikasi atau daftar untuk mendapatkan akses High Speed.',
    primary_button_label:'Login'
  },
  free:{
    eyebrow:'Akses gratis',
    headline:'Terhubung dalam satu klik.',
    description:'Tidak perlu akun atau mengisi data diri. Tekan tombol di bawah untuk mulai menggunakan internet.',
    primary_button_label:'Sambungkan Internet Gratis'
  }
};
function publicPortalSettings() {
  const settings = db.prepare('SELECT welcome_title,welcome_text,limited_bandwidth_kbps,terms_text,default_ssid,account_ssid,free_ssid FROM portal_settings WHERE id=1').get();
  const content = db.prepare(`SELECT profile,eyebrow,headline,description,primary_button_label,
    announcement_enabled,announcement_tone,announcement_title,announcement_text,
    announcement_link_label,announcement_link_url,updated_at
    FROM portal_profile_content ORDER BY profile`).all();
  const promotions = db.prepare(`SELECT id,profile,title,description,image_url,link_label,link_url,is_active,sort_order
    FROM portal_promotions ORDER BY profile,sort_order,id`).all();
  const profiles = {};
  for (const profile of ['account','free']) {
    const row = content.find(item => item.profile === profile) || { profile,...portalProfileDefaults[profile] };
    profiles[profile] = {
      ...row,
      ssid:profile === 'account' ? settings.account_ssid : settings.free_ssid,
      announcement_enabled:!!row.announcement_enabled,
      promotions:promotions.filter(item => item.profile === profile && item.is_active).map(item => ({ ...item,is_active:true }))
    };
  }
  return { ...settings,profiles,promotions:promotions.map(item => ({ ...item,is_active:!!item.is_active })),limited_session_hours:sessionHoursFor('limited') };
}
function normalizedPortalUrl(value, fieldName) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  if (candidate.startsWith('/uploads/') && /^\/uploads\/[a-f0-9-]+\.(?:png|jpe?g|webp)$/i.test(candidate)) return candidate;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString().slice(0,1000);
  } catch { /* Validation below returns a useful admin-facing error. */ }
  throw new Error(`${fieldName} harus menggunakan URL http/https yang valid.`);
}
function normalizedPortalText(value, fallback, maxLength, fieldName, required = true) {
  const normalized = String(value ?? '').trim().replace(/\r\n/g,'\n').slice(0,maxLength);
  if (required && !normalized) throw new Error(`${fieldName} wajib diisi.`);
  return normalized || fallback || null;
}
function normalizePortalProfile(profile, value = {}) {
  const defaults = portalProfileDefaults[profile];
  return {
    profile,
    ssid:normalizedPortalText(value.ssid, profile === 'account' ? '@PERUMNET_WiFi' : '@PERUMNET_FreeWiFi',128,`SSID Portal ${profile === 'account' ? 'Akun' : 'Free'}`),
    eyebrow:normalizedPortalText(value.eyebrow,defaults.eyebrow,80,'Label kecil'),
    headline:normalizedPortalText(value.headline,defaults.headline,160,'Judul portal'),
    description:normalizedPortalText(value.description,defaults.description,700,'Deskripsi portal'),
    primary_button_label:normalizedPortalText(value.primary_button_label,defaults.primary_button_label,80,'Teks tombol'),
    announcement_enabled:value.announcement_enabled ? 1 : 0,
    announcement_tone:['info','promo','warning'].includes(value.announcement_tone) ? value.announcement_tone : 'info',
    announcement_title:normalizedPortalText(value.announcement_title,null,140,'Judul pengumuman',false),
    announcement_text:normalizedPortalText(value.announcement_text,null,700,'Isi pengumuman',false),
    announcement_link_label:normalizedPortalText(value.announcement_link_label,null,80,'Teks link pengumuman',false),
    announcement_link_url:normalizedPortalUrl(value.announcement_link_url,'Link pengumuman')
  };
}
function normalizePortalPromotion(value = {}, index = 0) {
  const profile = value.profile === 'free' ? 'free' : value.profile === 'account' ? 'account' : '';
  if (!profile) throw new Error('Setiap promo harus terkait dengan Portal Akun atau Portal Free.');
  const promoId = /^[a-f0-9-]{8,80}$/i.test(String(value.id || '')) ? String(value.id) : id();
  return {
    id:promoId,
    profile,
    title:normalizedPortalText(value.title,null,140,'Judul promo'),
    description:normalizedPortalText(value.description,null,700,'Deskripsi promo',false),
    image_url:normalizedPortalUrl(value.image_url,'Gambar promo'),
    link_label:normalizedPortalText(value.link_label,null,80,'Teks tombol promo',false),
    link_url:normalizedPortalUrl(value.link_url,'Link promo'),
    is_active:value.is_active === false ? 0 : 1,
    sort_order:index
  };
}
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
function normalizeNetworkAlias(value) {
  const alias = String(value || '').trim();
  if (!networkAliasPattern.test(alias)) return null;
  const number = alias.match(/\d+/)?.[0];
  return number ? `VLAN${number}` : null;
}
function ssidFromGateway(value = {}) {
  const candidates = [value.wlan_name, value.ssid_name, value.essid, value.wifi_name, value.ap_ssid, value.ssid, value.SSID];
  for (const candidate of candidates) {
    const ssid = String(candidate || '').trim();
    if (ssid && !networkAliasPattern.test(ssid)) return ssid.slice(0, 128);
  }
  return null;
}
function networkAliasFromGateway(value = {}) {
  const candidates = [value.vlan_name, value.vlan, value.network_alias, value.network, value.ssid, value.SSID];
  for (const candidate of candidates) {
    const alias = normalizeNetworkAlias(candidate);
    if (alias) return alias;
  }
  return null;
}
function networkDescriptionFromGateway(value = {}) {
  const candidates = [
    value.vlan_description, value.vlan_desc, value.vlan_name, value.network_description, value.network_desc, value.network_name,
    value.interface_description, value.interface_desc, value.remark, value.description
  ];
  for (const candidate of candidates) {
    const description = String(candidate || '').trim();
    if (description && !networkAliasPattern.test(description)) return description.slice(0, 160);
  }
  return null;
}
function clientCidr(value) {
  const match = String(value || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (!match || match.slice(1).some(part => Number(part) > 255)) return null;
  return `${match[1]}.${match[2]}.${match[3]}.0/24`;
}
function contextFrom(value = {}) {
  return {
    client_mac: value.client_mac || value.mac || null,
    client_ip: value.client_ip || value.ip || null,
    // Reyee Gateway may populate `ssid` with a network alias such as VLAN10.
    // Prefer explicit WLAN parameters and never persist that alias as the SSID.
    ssid: ssidFromGateway(value),
    network_alias: networkAliasFromGateway(value),
    network_description: networkDescriptionFromGateway(value),
    network_slot: String(value.slot_num || '').trim().slice(0, 32) || null,
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
function blockedGateway(gatewayId) {
  const id = gatewayKey(gatewayId);
  return id !== 'unassigned' && !!db.prepare('SELECT gateway_id FROM gateway_blocks WHERE gateway_id=?').get(id);
}
function ensureGateway(context = {}) {
  const gatewayId = gatewayKey(context);
  if (blockedGateway(gatewayId)) return gatewayId;
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
function gatewayApproval(context = {}, register = true) {
  const gatewayId = gatewayKey(context);
  if (gatewayId === 'unassigned') return { gatewayId, status:'unassigned' };
  if (blockedGateway(gatewayId)) return { gatewayId, status:'blocked' };
  if (register) ensureGateway(context);
  const gateway = db.prepare('SELECT approval_status FROM gateways WHERE id=?').get(gatewayId);
  return { gatewayId, status:gateway?.approval_status || 'pending' };
}
function gatewayAuthorizationError(context = {}) {
  if (!context.gw_id) return null;
  const approval = gatewayApproval(context, true);
  if (approval.status === 'approved') return null;
  return approval.status === 'blocked'
    ? 'Gateway ini diblokir oleh administrator PerumNet.'
    : 'Gateway belum diverifikasi administrator PerumNet. Hubungi administrator sebelum menggunakan portal.';
}
function observePortalNetwork(context = {}) {
  if (blockedGateway(context)) return null;
  const gatewayId = ensureGateway(context);
  const alias = networkAliasFromGateway(context);
  const cidr = clientCidr(context.client_ip);
  const description = networkDescriptionFromGateway(context);
  if (gatewayId === 'unassigned') return null;
  if (!alias) {
    if (!cidr) return null;
    const knownRoute = db.prepare(`SELECT * FROM portal_network_routes WHERE gateway_id=? AND client_cidr=?
      ORDER BY configured_at IS NOT NULL DESC,last_seen_at DESC LIMIT 1`).get(gatewayId, cidr);
    if (knownRoute) db.prepare('UPDATE portal_network_routes SET last_seen_at=? WHERE gateway_id=? AND network_alias=?')
      .run(new Date().toISOString(), gatewayId, knownRoute.network_alias);
    return knownRoute || null;
  }
  const now = new Date().toISOString();
  const sameSubnet = cidr ? db.prepare(`SELECT * FROM portal_network_routes WHERE gateway_id=? AND client_cidr=?
    ORDER BY configured_at IS NOT NULL DESC,configured_at DESC,last_seen_at DESC`).all(gatewayId, cidr) : [];
  const inherited = sameSubnet[0] || null;
  const existing = db.prepare('SELECT * FROM portal_network_routes WHERE gateway_id=? AND network_alias=?').get(gatewayId, alias);
  if (existing) {
    db.prepare(`UPDATE portal_network_routes SET client_cidr=COALESCE(?,client_cidr),
      network_description=COALESCE(?,network_description),last_seen_at=? WHERE gateway_id=? AND network_alias=?`)
      .run(cidr, description, now, gatewayId, alias);
    if (cidr) db.prepare('DELETE FROM portal_network_routes WHERE gateway_id=? AND client_cidr=? AND network_alias<>?')
      .run(gatewayId, cidr, alias);
    return db.prepare('SELECT * FROM portal_network_routes WHERE gateway_id=? AND network_alias=?').get(gatewayId, alias);
  }
  const portalMode = inherited?.portal_mode || 'account';
  db.prepare(`INSERT INTO portal_network_routes
    (gateway_id,network_alias,client_cidr,network_description,portal_mode,first_seen_at,last_seen_at,configured_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(gatewayId, alias, cidr, description || inherited?.network_description || null, portalMode, now, now, inherited?.configured_at || null);
  if (cidr) db.prepare('DELETE FROM portal_network_routes WHERE gateway_id=? AND client_cidr=? AND network_alias<>?')
    .run(gatewayId, cidr, alias);
  return db.prepare('SELECT * FROM portal_network_routes WHERE gateway_id=? AND network_alias=?').get(gatewayId, alias);
}
function portalRouteForContext(context = {}, observe = false) {
  if (observe) return observePortalNetwork(context);
  const gatewayId = gatewayKey(context);
  const alias = networkAliasFromGateway(context);
  const cidr = clientCidr(context.client_ip);
  if (gatewayId === 'unassigned' || (!alias && !cidr)) return null;
  return db.prepare(`SELECT * FROM portal_network_routes WHERE gateway_id=?
    AND (network_alias=? OR (? IS NOT NULL AND client_cidr=?))
    ORDER BY network_alias=? DESC,configured_at IS NOT NULL DESC,last_seen_at DESC LIMIT 1`)
    .get(gatewayId, alias || '', cidr, cidr, alias || '');
}
function portalModeForCallback(context = {}) {
  const gatewayId = gatewayKey(context);
  const mac = String(context.client_mac || '').trim().toLowerCase();
  if (gatewayId !== 'unassigned' && mac) {
    const session = db.prepare(`SELECT access_type FROM captive_sessions
      WHERE gateway_id=? AND mac_address=? ORDER BY created_at DESC LIMIT 1`).get(gatewayId, mac);
    if (session?.access_type === 'limited') return 'free';
    if (session?.access_type === 'high_speed') return 'account';
  }
  return portalRouteForContext(context)?.portal_mode || 'account';
}
function trackClient(context) {
  const mac = String(context.client_mac || '').trim().toLowerCase();
  const gatewayId = ensureGateway(context);
  observePortalNetwork({ ...context, gw_id:gatewayId });
  if (gatewayApproval({ gw_id:gatewayId }, false).status !== 'approved') return { gatewayId, mac:null, quarantined:true };
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
  db.prepare("UPDATE clients SET auth_status='pending',incoming_bps=0,outgoing_bps=0 WHERE gateway_id=? AND mac_address=?").run(scopedGatewayId, mac);
  createClientNotification('client_offline', {
    gatewayId:scopedGatewayId, macAddress:mac, userId:client.user_id, accessType:client.access_type,
    eventKey:`offline:${scopedGatewayId}:${mac}:${client.authorized_until || new Date().toISOString()}`, reason
  });
  return true;
}

function wifiDogCounter(searchParams, names) {
  for (const name of names) {
    const raw = searchParams.get(name);
    if (raw === null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
  }
  return null;
}

let nextTelemetryPruneAt = 0;

// WiFiDog sends cumulative traffic counters with the login/counters callback.
// Store both totals and the rate between the two most recent callbacks so the
// dashboard can monitor actual gateway traffic without routing it via the VPS.
function recordWifiDogTelemetry(session, url, now = new Date()) {
  if (!session?.token_hash || !session.mac_address) return false;
  const incoming = wifiDogCounter(url.searchParams, ['incoming','Incoming','incoming_bytes','rx_bytes']);
  const outgoing = wifiDogCounter(url.searchParams, ['outgoing','Outgoing','outgoing_bytes','tx_bytes']);
  if (incoming === null && outgoing === null) return false;
  const nowIso = now.toISOString();
  const previousIncoming = Number(session.incoming_bytes || 0);
  const previousOutgoing = Number(session.outgoing_bytes || 0);
  const nextIncoming = incoming ?? previousIncoming;
  const nextOutgoing = outgoing ?? previousOutgoing;
  const elapsedSeconds = session.last_counter_at ? (now.getTime() - new Date(session.last_counter_at).getTime()) / 1000 : 0;
  const incomingDelta = nextIncoming >= previousIncoming ? nextIncoming - previousIncoming : nextIncoming;
  const outgoingDelta = nextOutgoing >= previousOutgoing ? nextOutgoing - previousOutgoing : nextOutgoing;
  const incomingBps = elapsedSeconds > 0 ? Math.round((incomingDelta * 8) / elapsedSeconds) : null;
  const outgoingBps = elapsedSeconds > 0 ? Math.round((outgoingDelta * 8) / elapsedSeconds) : null;
  const gatewayId = gatewayKey(session.gateway_id);
  db.prepare(`UPDATE captive_sessions SET last_counter_at=?,incoming_bytes=?,outgoing_bytes=? WHERE token_hash=?`)
    .run(nowIso, nextIncoming, nextOutgoing, session.token_hash);
  db.prepare(`UPDATE clients SET last_seen_at=?,last_counter_at=?,incoming_bytes=?,outgoing_bytes=?,incoming_bps=?,outgoing_bps=?
    WHERE gateway_id=? AND mac_address=?`)
    .run(nowIso, nowIso, nextIncoming, nextOutgoing, incomingBps, outgoingBps, gatewayId, session.mac_address);
  const client = db.prepare('SELECT user_id,access_type,ssid FROM clients WHERE gateway_id=? AND mac_address=?').get(gatewayId, session.mac_address);
  const settings = db.prepare('SELECT account_ssid,free_ssid FROM portal_settings WHERE id=1').get() || {};
  const accessType = client?.access_type || session.access_type || null;
  const ssid = ssidFromGateway({ ssid:client?.ssid }) || (accessType === 'limited' ? settings.free_ssid : settings.account_ssid) || null;
  db.prepare(`INSERT INTO telemetry_samples
    (gateway_id,mac_address,user_id,access_type,ssid,sampled_at,incoming_bytes,outgoing_bytes,incoming_delta,outgoing_delta,incoming_bps,outgoing_bps)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(gatewayId, session.mac_address, client?.user_id || session.user_id || null, accessType, ssid, nowIso,
      nextIncoming, nextOutgoing, incomingDelta, outgoingDelta, incomingBps, outgoingBps);
  if (now.getTime() >= nextTelemetryPruneAt) {
    db.prepare('DELETE FROM telemetry_samples WHERE sampled_at<?').run(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
    nextTelemetryPruneAt = now.getTime() + 60 * 60 * 1000;
  }
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
  if (gatewayApproval(context, true).status !== 'approved') return null;
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

  if (gatewayApproval({ ...context, gw_id:requestGatewayId }, true).status !== 'approved') return false;
  if (isClientRevoked(requestGatewayId, mac, nowIso)) return false;
  trackClient({ ...context, gw_id:requestGatewayId });

  if (stage === 'logout') {
    if (tokenSession) recordWifiDogTelemetry(tokenSession, url, now);
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
    if (firstAuthorization) {
      db.prepare(`UPDATE clients SET user_id=?,access_type=?,auth_status='authorized',last_seen_at=?,authorized_until=?,
        session_started_at=?,last_counter_at=NULL,incoming_bytes=0,outgoing_bytes=0,incoming_bps=NULL,outgoing_bps=NULL
        WHERE gateway_id=? AND mac_address=?`)
        .run(session.user_id, session.access_type, nowIso, authorizedUntil, authorizedAt, sessionGatewayId, mac);
    } else {
      db.prepare(`UPDATE clients SET user_id=?,access_type=?,auth_status='authorized',last_seen_at=?,authorized_until=?
        WHERE gateway_id=? AND mac_address=?`)
        .run(session.user_id, session.access_type, nowIso, authorizedUntil, sessionGatewayId, mac);
    }
    recordWifiDogTelemetry({ ...session, gateway_id:sessionGatewayId, authorized_at:authorizedAt, authorized_until:authorizedUntil }, url, now);
    if (firstAuthorization) createClientNotification('client_login', {
      gatewayId:sessionGatewayId, macAddress:mac, userId:session.user_id, accessType:session.access_type,
      eventKey:`login:${hashToken(rawToken)}`
    });
    return true;
  }

  if (rawToken) {
    const session = tokenSession;
    const valid = !!(session && !session.revoked_at && session.authorized_at && session.authorized_until > nowIso && (!mac || session.mac_address === mac));
    if (valid && stage === 'counters') recordWifiDogTelemetry(session, url, now);
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
  if (userId) {
    const result = deleteUserRecords(userId);
    return result.error ? result : { ...result, gatewayId:scopedGatewayId, macAddress:mac };
  }
  const relatedClients = [{ gateway_id:scopedGatewayId, mac_address:mac }];
  const deviceCount = relatedClients.length;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM telemetry_samples WHERE gateway_id=? AND mac_address=?').run(scopedGatewayId, mac);
    db.prepare('DELETE FROM notifications WHERE gateway_id=? AND client_mac=?').run(scopedGatewayId, mac);
    db.prepare('DELETE FROM captive_sessions WHERE gateway_id=? AND mac_address=?').run(scopedGatewayId, mac);
    db.prepare('DELETE FROM access_logs WHERE gateway_id=? AND mac_address=?').run(scopedGatewayId, mac);
    db.prepare('DELETE FROM clients WHERE gateway_id=? AND mac_address=?').run(scopedGatewayId, mac);
    const revokedAt = new Date();
    const expiresAt = new Date(revokedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const revoke = db.prepare('INSERT OR REPLACE INTO revoked_gateway_clients (gateway_id,mac_hash,revoked_at,expires_at) VALUES (?,?,?,?)');
    for (const relatedClient of relatedClients) revoke.run(relatedClient.gateway_id, hashToken(relatedClient.mac_address), revokedAt.toISOString(), expiresAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok:true, gatewayId:scopedGatewayId, macAddress:mac, deletedAccount:false, deletedDevices:deviceCount, gatewayAuthorizationRevoked:true };
}
function deleteUserRecords(userId) {
  const scopedUserId = String(userId || '').trim();
  const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(scopedUserId);
  if (!user) return { error:'Data pengguna tidak ditemukan.', status:404 };
  const relatedClients = db.prepare('SELECT gateway_id,mac_address FROM clients WHERE user_id=?').all(scopedUserId);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM telemetry_samples WHERE user_id=?').run(scopedUserId);
    db.prepare('DELETE FROM notifications WHERE user_id=?').run(scopedUserId);
    db.prepare('DELETE FROM captive_sessions WHERE user_id=?').run(scopedUserId);
    db.prepare('DELETE FROM access_logs WHERE user_id=?').run(scopedUserId);
    for (const client of relatedClients) {
      db.prepare('DELETE FROM telemetry_samples WHERE gateway_id=? AND mac_address=?').run(client.gateway_id, client.mac_address);
      db.prepare('DELETE FROM notifications WHERE gateway_id=? AND client_mac=?').run(client.gateway_id, client.mac_address);
      db.prepare('DELETE FROM captive_sessions WHERE gateway_id=? AND mac_address=?').run(client.gateway_id, client.mac_address);
      db.prepare('DELETE FROM access_logs WHERE gateway_id=? AND mac_address=?').run(client.gateway_id, client.mac_address);
    }
    db.prepare('DELETE FROM clients WHERE user_id=?').run(scopedUserId);
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(scopedUserId);
    db.prepare('DELETE FROM users WHERE id=?').run(scopedUserId);
    const revokedAt = new Date();
    const expiresAt = new Date(revokedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const revoke = db.prepare('INSERT OR REPLACE INTO revoked_gateway_clients (gateway_id,mac_hash,revoked_at,expires_at) VALUES (?,?,?,?)');
    for (const client of relatedClients) revoke.run(client.gateway_id, hashToken(client.mac_address), revokedAt.toISOString(), expiresAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok:true, userId:scopedUserId, email:user.email, deletedAccount:true, deletedDevices:relatedClients.length, gatewayAuthorizationRevoked:relatedClients.length > 0 };
}
function deleteAndBlockGateway(gatewayId) {
  const scopedGatewayId = gatewayKey(gatewayId);
  if (scopedGatewayId === 'unassigned') return { error:'Gateway sistem tidak dapat dihapus.', status:400 };
  const gateway = db.prepare('SELECT id,name FROM gateways WHERE id=?').get(scopedGatewayId);
  if (!gateway) return { error:'Gateway tidak ditemukan.', status:404 };
  const blockedAt = new Date().toISOString();
  const counts = {
    clients:db.prepare('SELECT COUNT(*) AS total FROM clients WHERE gateway_id=?').get(scopedGatewayId)?.total || 0,
    networks:db.prepare('SELECT COUNT(*) AS total FROM portal_network_routes WHERE gateway_id=?').get(scopedGatewayId)?.total || 0
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM telemetry_samples WHERE gateway_id=?').run(scopedGatewayId);
    db.prepare('DELETE FROM notifications WHERE gateway_id=?').run(scopedGatewayId);
    db.prepare('DELETE FROM captive_sessions WHERE gateway_id=?').run(scopedGatewayId);
    db.prepare('DELETE FROM access_logs WHERE gateway_id=?').run(scopedGatewayId);
    db.prepare('DELETE FROM revoked_gateway_clients WHERE gateway_id=?').run(scopedGatewayId);
    db.prepare('DELETE FROM clients WHERE gateway_id=?').run(scopedGatewayId);
    db.prepare('DELETE FROM portal_network_routes WHERE gateway_id=?').run(scopedGatewayId);
    db.prepare('DELETE FROM gateways WHERE id=?').run(scopedGatewayId);
    db.prepare(`INSERT INTO gateway_blocks (gateway_id,blocked_at,reason) VALUES (?,?,?)
      ON CONFLICT(gateway_id) DO UPDATE SET blocked_at=excluded.blocked_at,reason=excluded.reason`)
      .run(scopedGatewayId, blockedAt, `Dihapus oleh administrator: ${gateway.name}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok:true, gatewayId:scopedGatewayId, blocked:true, deletedClients:counts.clients, deletedNetworks:counts.networks };
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

const monitoringRanges = Object.freeze({
  '1h':{ hours:1, bucketMinutes:5, label:'1 jam terakhir' },
  '6h':{ hours:6, bucketMinutes:15, label:'6 jam terakhir' },
  '24h':{ hours:24, bucketMinutes:60, label:'24 jam terakhir' },
  '7d':{ hours:24 * 7, bucketMinutes:6 * 60, label:'7 hari terakhir' }
});
function monitoringData(url) {
  const range = Object.hasOwn(monitoringRanges, url.searchParams.get('range')) ? url.searchParams.get('range') : '24h';
  const rangeConfig = monitoringRanges[range];
  const gatewayId = String(url.searchParams.get('gatewayId') || '').trim();
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const now = new Date();
  const startAt = new Date(now.getTime() - rangeConfig.hours * 60 * 60 * 1000);
  const sampleConditions = ['s.sampled_at>=?'];
  const sampleParams = [startAt.toISOString()];
  const clientConditions = [];
  const clientParams = [];
  if (gatewayId) {
    sampleConditions.push('s.gateway_id=?'); sampleParams.push(gatewayId);
    clientConditions.push('c.gateway_id=?'); clientParams.push(gatewayId);
  } else if (projectId) {
    sampleConditions.push('g.project_id=?'); sampleParams.push(projectId);
    clientConditions.push('g.project_id=?'); clientParams.push(projectId);
  }
  const bucketMs = rangeConfig.bucketMinutes * 60 * 1000;
  const bucketSeconds = Math.floor(bucketMs / 1000);
  const sampleWhere = sampleConditions.join(' AND ');
  const timelineRows = db.prepare(`WITH per_device AS (
    SELECT CAST(unixepoch(s.sampled_at)/? AS INTEGER)*? AS bucket_at,s.gateway_id,s.mac_address,
      AVG(CASE WHEN s.incoming_bps IS NOT NULL THEN s.incoming_bps END) AS incoming_bps,
      AVG(CASE WHEN s.outgoing_bps IS NOT NULL THEN s.outgoing_bps END) AS outgoing_bps,
      SUM(s.incoming_delta) AS incoming_bytes,SUM(s.outgoing_delta) AS outgoing_bytes
    FROM telemetry_samples s JOIN gateways g ON g.id=s.gateway_id
    WHERE ${sampleWhere} GROUP BY bucket_at,s.gateway_id,s.mac_address
  ) SELECT bucket_at,ROUND(COALESCE(SUM(incoming_bps),0)) AS incoming_bps,
    ROUND(COALESCE(SUM(outgoing_bps),0)) AS outgoing_bps,SUM(incoming_bytes) AS incoming_bytes,SUM(outgoing_bytes) AS outgoing_bytes
    FROM per_device GROUP BY bucket_at ORDER BY bucket_at`).all(bucketSeconds,bucketSeconds,...sampleParams);
  const historicalSsids = db.prepare(`SELECT s.ssid,s.access_type,SUM(s.incoming_delta) AS incoming_bytes,SUM(s.outgoing_delta) AS outgoing_bytes
    FROM telemetry_samples s JOIN gateways g ON g.id=s.gateway_id WHERE ${sampleWhere} GROUP BY s.ssid,s.access_type`).all(...sampleParams);
  const historicalUsers = db.prepare(`SELECT CASE WHEN s.user_id IS NOT NULL THEN 'user:'||s.user_id ELSE 'device:'||s.gateway_id||'|'||s.mac_address END AS identity_key,
    MAX(s.user_id) AS user_id,MAX(s.gateway_id) AS gateway_id,MAX(s.mac_address) AS mac_address,MAX(s.access_type) AS access_type,
    MAX(s.ssid) AS ssid,MAX(u.full_name) AS full_name,MAX(u.email) AS email,
    SUM(s.incoming_delta) AS incoming_bytes,SUM(s.outgoing_delta) AS outgoing_bytes
    FROM telemetry_samples s JOIN gateways g ON g.id=s.gateway_id LEFT JOIN users u ON u.id=s.user_id
    WHERE ${sampleWhere} GROUP BY identity_key`).all(...sampleParams);
  const sampleCount = db.prepare(`SELECT COUNT(*) AS total FROM telemetry_samples s JOIN gateways g ON g.id=s.gateway_id WHERE ${sampleWhere}`).get(...sampleParams)?.total || 0;
  const clientWhere = clientConditions.length ? `WHERE ${clientConditions.join(' AND ')}` : '';
  const clients = db.prepare(`SELECT c.gateway_id,c.mac_address,c.user_id,c.access_type,c.auth_status,c.ssid,c.session_started_at,
    c.last_seen_at,c.last_counter_at,c.incoming_bps,c.outgoing_bps,u.full_name,u.email
    FROM clients c JOIN gateways g ON g.id=c.gateway_id LEFT JOIN users u ON u.id=c.user_id ${clientWhere}`).all(...clientParams);
  const settings = db.prepare('SELECT account_ssid,free_ssid FROM portal_settings WHERE id=1').get() || {};
  const resolvedSsid = row => ssidFromGateway({ ssid:row.ssid }) || (row.access_type === 'limited' ? settings.free_ssid : settings.account_ssid) || 'SSID tidak diketahui';
  const deviceKey = row => `${row.gateway_id}|${row.mac_address}`;
  const userKey = row => row.user_id ? `user:${row.user_id}` : `device:${deviceKey(row)}`;
  const positive = value => Math.max(0, Number(value || 0));
  const firstBucket = Math.floor(startAt.getTime() / bucketMs) * bucketMs;
  const lastBucket = Math.floor(now.getTime() / bucketMs) * bucketMs;
  const ssids = new Map();
  const users = new Map();
  const activeUsers = new Set();

  const ensureSsid = name => {
    if (!ssids.has(name)) ssids.set(name, { ssid:name,incoming_bytes:0,outgoing_bytes:0,incoming_bps:0,outgoing_bps:0,active_users:0,_active:new Set() });
    return ssids.get(name);
  };
  const ensureUser = row => {
    const key = userKey(row);
    if (!users.has(key)) users.set(key, {
      key,name:row.full_name || (row.access_type === 'limited' ? `Free · ${String(row.mac_address || '').slice(-8).toUpperCase()}` : `Perangkat · ${String(row.mac_address || '').slice(-8).toUpperCase()}`),
      detail:row.email || row.mac_address || 'Perangkat WiFi',access_type:row.access_type || 'pending',ssid:resolvedSsid(row),
      incoming_bytes:0,outgoing_bytes:0,incoming_bps:0,outgoing_bps:0,duration_seconds:0,active:false
    });
    return users.get(key);
  };

  for (const client of clients) {
    const ssidName = resolvedSsid(client);
    const ssid = ensureSsid(ssidName);
    const user = ensureUser(client);
    const isActive = client.auth_status === 'authorized';
    if (isActive) {
      activeUsers.add(user.key);
      ssid._active.add(user.key);
      user.active = true;
      const incomingBps = positive(client.incoming_bps);
      const outgoingBps = positive(client.outgoing_bps);
      ssid.incoming_bps += incomingBps; ssid.outgoing_bps += outgoingBps;
      user.incoming_bps += incomingBps; user.outgoing_bps += outgoingBps;
    }
    const sessionStart = new Date(client.session_started_at || 0).getTime();
    const sessionEnd = isActive ? now.getTime() : new Date(client.last_counter_at || client.last_seen_at || 0).getTime();
    user.duration_seconds = Math.max(user.duration_seconds, sessionStart > 0 && sessionEnd >= sessionStart ? Math.floor((sessionEnd - sessionStart) / 1000) : 0);
  }

  for (const row of historicalSsids) {
    const ssid = ensureSsid(resolvedSsid(row));
    ssid.incoming_bytes += positive(row.incoming_bytes);
    ssid.outgoing_bytes += positive(row.outgoing_bytes);
  }
  for (const row of historicalUsers) {
    const user = ensureUser(row);
    user.incoming_bytes += positive(row.incoming_bytes);
    user.outgoing_bytes += positive(row.outgoing_bytes);
  }

  const timelineByBucket = new Map(timelineRows.map(row => [Number(row.bucket_at) * 1000,row]));
  const timeline = [];
  for (let at = firstBucket; at <= lastBucket; at += bucketMs) {
    const point = timelineByBucket.get(at) || {};
    timeline.push({ at:new Date(at).toISOString(),incoming_bps:positive(point.incoming_bps),outgoing_bps:positive(point.outgoing_bps),incoming_bytes:positive(point.incoming_bytes),outgoing_bytes:positive(point.outgoing_bytes) });
  }
  const incomingBytes = timelineRows.reduce((total,row) => total + positive(row.incoming_bytes),0);
  const outgoingBytes = timelineRows.reduce((total,row) => total + positive(row.outgoing_bytes),0);
  for (const ssid of ssids.values()) ssid.active_users = ssid._active.size;
  const ssidRows = [...ssids.values()].map(({ _active, ...ssid }) => ({ ...ssid,total_bytes:ssid.incoming_bytes + ssid.outgoing_bytes }))
    .filter(ssid => ssid.total_bytes > 0 || ssid.active_users > 0 || ssid.incoming_bps + ssid.outgoing_bps > 0)
    .sort((a,b) => b.total_bytes - a.total_bytes || (b.incoming_bps + b.outgoing_bps) - (a.incoming_bps + a.outgoing_bps));
  const userRows = [...users.values()].map(user => ({ ...user,total_bytes:user.incoming_bytes + user.outgoing_bytes }))
    .filter(user => user.total_bytes > 0 || user.active || user.incoming_bps + user.outgoing_bps > 0)
    .sort((a,b) => b.total_bytes - a.total_bytes || (b.incoming_bps + b.outgoing_bps) - (a.incoming_bps + a.outgoing_bps)).slice(0,12);
  const liveIncomingBps = clients.filter(client => client.auth_status === 'authorized').reduce((total,client) => total + positive(client.incoming_bps),0);
  const liveOutgoingBps = clients.filter(client => client.auth_status === 'authorized').reduce((total,client) => total + positive(client.outgoing_bps),0);
  return {
    range,range_label:rangeConfig.label,generated_at:now.toISOString(),has_history:sampleCount > 0,sample_count:sampleCount,
    summary:{ active_users:activeUsers.size,active_devices:clients.filter(client=>client.auth_status==='authorized').length,
      tracked_devices:clients.filter(client=>client.last_counter_at).length,ssid_count:ssidRows.length,
      incoming_bps:Math.round(liveIncomingBps),outgoing_bps:Math.round(liveOutgoingBps),
      incoming_bytes:incomingBytes,outgoing_bytes:outgoingBytes,total_bytes:incomingBytes + outgoingBytes },
    timeline,ssids:ssidRows,users:userRows,retention_days:30
  };
}

async function api(req, res, url) {
  const route = url.pathname;
  if (route === '/api/settings' && req.method === 'GET') {
    return json(res, 200, publicPortalSettings(), { 'cache-control':'no-store' });
  }
  if (route === '/api/auth/register' && req.method === 'POST') {
    const { fullName, email, phone, address, password, consent, context } = await body(req);
    const captive = contextFrom(context);
    const gatewayError = gatewayAuthorizationError(captive);
    if (config.reyeeMode === 'redirect' && gatewayError) return json(res, 403, { error:gatewayError, gatewayStatus:gatewayApproval(captive, false).status });
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
    const { email, password, context } = await body(req);
    const captive = contextFrom(context);
    const gatewayError = gatewayAuthorizationError(captive);
    if (config.reyeeMode === 'redirect' && gatewayError) return json(res, 403, { error:gatewayError, gatewayStatus:gatewayApproval(captive, false).status });
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase().trim());
    if (!user || !verifyPassword(password || '', user.password_hash)) return json(res, 401, { error: 'Email atau kata sandi tidak tepat.' });
    if (!user.is_verified) return json(res, 403, { error: 'Email belum terverifikasi. Periksa inbox Anda.' });
    writeLog(user.id, captive, 'high_speed'); return json(res, 200, { authorization: authorize(captive, 'high_speed', user.email, user.id), user: { name: user.full_name, email: user.email } });
  }
  if (route === '/api/captive/limited' && req.method === 'POST') {
    const { context } = await body(req);
    const captive = contextFrom(context);
    const gatewayError = gatewayAuthorizationError(captive);
    if (config.reyeeMode === 'redirect' && gatewayError) return json(res, 403, { error:gatewayError, gatewayStatus:gatewayApproval(captive, false).status });
    const networkRoute = portalRouteForContext(captive, true);
    if (config.reyeeMode === 'redirect' && captive.client_mac && networkRoute?.portal_mode !== 'free') {
      return json(res, 403, { error:'One-click hanya tersedia pada jaringan FreeWiFi. Sambungkan perangkat ke SSID gratis lalu coba kembali.' });
    }
    const setting = db.prepare('SELECT limited_bandwidth_kbps FROM portal_settings WHERE id=1').get();
    writeLog(null, captive, 'limited');
    const authorization = authorize(captive, 'limited', `guest-${captive.client_mac || id().slice(0,8)}`);
    return json(res, 200, { bandwidthKbps:setting.limited_bandwidth_kbps, sessionHours:sessionHoursFor('limited'), authorization });
  }
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
    const gateways = db.prepare(`SELECT g.id,g.project_id,g.name,g.location,g.model,g.created_at,g.last_seen_at,g.approval_status,g.approved_at,
      p.name AS project_name,COUNT(c.mac_address) AS client_count,
      SUM(CASE WHEN c.auth_status='authorized' THEN 1 ELSE 0 END) AS authorized_count
      FROM gateways g JOIN projects p ON p.id=g.project_id
      LEFT JOIN clients c ON c.gateway_id=g.id
      GROUP BY g.id ORDER BY CASE WHEN g.approval_status='pending' AND g.id<>'unassigned' THEN 0 WHEN g.id='unassigned' THEN 2 ELSE 1 END,p.name,g.name`).all();
    const portalNetworks = db.prepare(`SELECT n.gateway_id,n.network_alias,n.client_cidr,n.network_description,n.portal_mode,
      n.first_seen_at,n.last_seen_at,n.configured_at,g.name AS gateway_name,g.project_id,g.approval_status,p.name AS project_name
      FROM portal_network_routes n JOIN gateways g ON g.id=n.gateway_id JOIN projects p ON p.id=g.project_id
      WHERE UPPER(n.network_alias) LIKE 'VLAN%'
      ORDER BY p.name,g.name,CAST(SUBSTR(n.network_alias,5) AS INTEGER)`).all();
    const blockedGateways = db.prepare('SELECT gateway_id,blocked_at,reason FROM gateway_blocks ORDER BY blocked_at DESC').all();
    const offlineDeadline = new Date(Date.now() - (Number.isFinite(config.clientOfflineMinutes) && config.clientOfflineMinutes > 0 ? config.clientOfflineMinutes : 20) * 60 * 1000).toISOString();
    return json(res, 200, {
      projects,
      gateways:gateways.map(gateway => ({ ...gateway, status:gateway.id !== 'unassigned' && gateway.last_seen_at >= offlineDeadline ? 'online' : 'offline' })),
      portalNetworks,
      blockedGateways
    });
  }
  if (route === '/api/admin/monitoring' && req.method === 'GET') {
    if (!requireAdmin(req,res)) return;
    sweepOfflineClients();
    return json(res, 200, monitoringData(url));
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
  if (route === '/api/admin/gateways/approval' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    const gatewayId = gatewayKey(payload.gatewayId);
    if (gatewayId === 'unassigned') return json(res, 400, { error:'Gateway sistem tidak dapat diverifikasi.' });
    const gateway = db.prepare('SELECT id FROM gateways WHERE id=?').get(gatewayId);
    if (!gateway) return json(res, 404, { error:'Gateway tidak ditemukan atau sedang diblokir.' });
    const approvedAt = new Date().toISOString();
    db.prepare("UPDATE gateways SET approval_status='approved',approved_at=? WHERE id=?").run(approvedAt, gatewayId);
    return json(res, 200, { gateway:db.prepare('SELECT * FROM gateways WHERE id=?').get(gatewayId) });
  }
  if (route === '/api/admin/gateways' && req.method === 'DELETE') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    const result = deleteAndBlockGateway(payload.gatewayId);
    if (result.error) return json(res, result.status, { error:result.error });
    return json(res, 200, result);
  }
  if (route === '/api/admin/gateway-blocks' && req.method === 'DELETE') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    const gatewayId = gatewayKey(payload.gatewayId);
    if (gatewayId === 'unassigned') return json(res, 400, { error:'ID gateway tidak valid.' });
    const result = db.prepare('DELETE FROM gateway_blocks WHERE gateway_id=?').run(gatewayId);
    if (!result.changes) return json(res, 404, { error:'Gateway tidak ada dalam daftar blokir.' });
    return json(res, 200, { ok:true, gatewayId, message:'Blokir dibuka. Request berikutnya akan masuk sebagai gateway pending.' });
  }
  if (route === '/api/admin/portal-networks' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    const gatewayId = gatewayKey(payload.gatewayId);
    const networkAlias = normalizeNetworkAlias(payload.networkAlias);
    const portalMode = payload.portalMode === 'free' ? 'free' : payload.portalMode === 'account' ? 'account' : '';
    const networkDescription = String(payload.networkDescription || '').trim().slice(0,160) || null;
    if (gatewayId === 'unassigned' || !networkAlias || !portalMode) return json(res, 400, { error:'Gateway, jaringan, dan jenis portal wajib dipilih.' });
    const routeRecord = db.prepare('SELECT * FROM portal_network_routes WHERE gateway_id=? AND network_alias=?').get(gatewayId, networkAlias);
    if (!routeRecord) return json(res, 404, { error:'Jaringan belum terdeteksi pada gateway ini.' });
    const now = new Date().toISOString();
    db.prepare('UPDATE portal_network_routes SET portal_mode=?,network_description=?,configured_at=? WHERE gateway_id=? AND network_alias=?')
      .run(portalMode, networkDescription, now, gatewayId, networkAlias);
    return json(res, 200, { network:db.prepare('SELECT * FROM portal_network_routes WHERE gateway_id=? AND network_alias=?').get(gatewayId, networkAlias) });
  }
  if (route === '/api/admin/users' && req.method === 'GET') {
    if (!requireAdmin(req,res)) return;
    const search = String(url.searchParams.get('search') || '').trim().toLowerCase().slice(0,120);
    const verification = ['all','verified','unverified'].includes(url.searchParams.get('verification')) ? url.searchParams.get('verification') : 'all';
    const allowedLimits = [10,25,50,100];
    const requestedLimit = Number(url.searchParams.get('limit') || 10);
    const limit = allowedLimits.includes(requestedLimit) ? requestedLimit : 10;
    const requestedPage = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1',10) || 1);
    const conditions = [];
    const params = [];
    if (verification === 'verified') conditions.push('u.is_verified=1');
    else if (verification === 'unverified') conditions.push('u.is_verified=0');
    if (search) {
      conditions.push("LOWER(u.full_name || ' ' || u.email || ' ' || u.phone_number || ' ' || u.address) LIKE ?");
      params.push(`%${search}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS total FROM users u ${where}`).get(...params)?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * limit;
    const users = db.prepare(`SELECT u.id,u.full_name,u.email,u.phone_number,u.address,u.is_verified,u.created_at,
      (SELECT COUNT(*) FROM clients c WHERE c.user_id=u.id) AS device_count,
      (SELECT COUNT(*) FROM access_logs a WHERE a.user_id=u.id) AS login_count,
      (SELECT MAX(c.last_seen_at) FROM clients c WHERE c.user_id=u.id) AS last_seen_at,
      (SELECT g.name FROM clients c JOIN gateways g ON g.id=c.gateway_id WHERE c.user_id=u.id ORDER BY c.last_seen_at DESC LIMIT 1) AS gateway_name,
      (SELECT p.name FROM clients c JOIN gateways g ON g.id=c.gateway_id JOIN projects p ON p.id=g.project_id WHERE c.user_id=u.id ORDER BY c.last_seen_at DESC LIMIT 1) AS project_name
      FROM users u ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const stats = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN is_verified=1 THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN is_verified=0 THEN 1 ELSE 0 END) AS unverified FROM users`).get();
    return json(res, 200, {
      users,
      stats:{ total:stats.total || 0, verified:stats.verified || 0, unverified:stats.unverified || 0 },
      pagination:{ page,limit,total,totalPages }
    });
  }
  if (route === '/api/admin/users' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    const fullName = String(payload.fullName || '').trim().replace(/\s+/g,' ').slice(0,120);
    const email = String(payload.email || '').trim().toLowerCase().slice(0,254);
    const phone = String(payload.phone || '').trim().replace(/\s+/g,' ').slice(0,40);
    const address = String(payload.address || '').trim().replace(/\s+/g,' ').slice(0,500);
    const password = String(payload.password || '');
    if (fullName.length < 2) return json(res, 400, { error:'Nama lengkap minimal 2 karakter.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error:'Format email tidak valid.' });
    if (phone.length < 6) return json(res, 400, { error:'Nomor HP minimal 6 karakter.' });
    if (address.length < 3) return json(res, 400, { error:'Alamat minimal 3 karakter.' });
    if (password.length < 8) return json(res, 400, { error:'Kata sandi minimal 8 karakter.' });
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return json(res, 409, { error:'Email sudah digunakan pengguna lain.' });
    const userId = id();
    db.prepare('INSERT INTO users (id,full_name,email,phone_number,address,password_hash,is_verified,verification_token,created_at) VALUES (?,?,?,?,?,?,1,NULL,?)')
      .run(userId,fullName,email,phone,address,hashPassword(password),new Date().toISOString());
    return json(res, 201, { user:db.prepare('SELECT id,full_name,email,phone_number,address,is_verified,created_at FROM users WHERE id=?').get(userId) });
  }
  if (route === '/api/admin/users' && req.method === 'PATCH') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    const userId = String(payload.userId || '').trim();
    const current = db.prepare('SELECT id,email FROM users WHERE id=?').get(userId);
    if (!current) return json(res, 404, { error:'Data pengguna tidak ditemukan.' });
    const fullName = String(payload.fullName || '').trim().replace(/\s+/g,' ').slice(0,120);
    const email = String(payload.email || '').trim().toLowerCase().slice(0,254);
    const phone = String(payload.phone || '').trim().replace(/\s+/g,' ').slice(0,40);
    const address = String(payload.address || '').trim().replace(/\s+/g,' ').slice(0,500);
    if (fullName.length < 2) return json(res, 400, { error:'Nama lengkap minimal 2 karakter.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error:'Format email tidak valid.' });
    if (phone.length < 6) return json(res, 400, { error:'Nomor HP minimal 6 karakter.' });
    if (address.length < 3) return json(res, 400, { error:'Alamat minimal 3 karakter.' });
    const duplicate = db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(email,userId);
    if (duplicate) return json(res, 409, { error:'Email sudah digunakan pengguna lain.' });
    db.prepare('UPDATE users SET full_name=?,email=?,phone_number=?,address=? WHERE id=?').run(fullName,email,phone,address,userId);
    return json(res, 200, { user:db.prepare('SELECT id,full_name,email,phone_number,address,is_verified,created_at FROM users WHERE id=?').get(userId) });
  }
  if (route === '/api/admin/users' && req.method === 'DELETE') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    const result = deleteUserRecords(payload.userId);
    if (result.error) return json(res, result.status, { error:result.error });
    return json(res, 200, result);
  }
  if (route === '/api/admin/export.csv' && req.method === 'GET') {
    if (!requireAdmin(req,res)) return;
    const gatewayId = String(url.searchParams.get('gatewayId') || '').trim();
    const projectId = String(url.searchParams.get('projectId') || '').trim();
    const scoped = !!(gatewayId || projectId);
    const scopeCondition = gatewayId ? 'c.gateway_id=?' : projectId ? 'g.project_id=?' : '';
    const scopeParams = gatewayId ? [gatewayId] : projectId ? [projectId] : [];
    const rows = db.prepare(`WITH ranked_clients AS (
      SELECT c.gateway_id,c.mac_address,c.client_ip,c.ssid,c.auth_status,c.last_seen_at,c.session_started_at,
        c.incoming_bytes,c.outgoing_bytes,g.name AS gateway_name,g.project_id,p.name AS project_name,c.user_id,
        ROW_NUMBER() OVER (PARTITION BY c.user_id ORDER BY c.last_seen_at DESC) AS row_number
      FROM clients c JOIN gateways g ON g.id=c.gateway_id JOIN projects p ON p.id=g.project_id
      WHERE c.user_id IS NOT NULL${scopeCondition ? ` AND ${scopeCondition}` : ''}
    )
    SELECT u.full_name,u.email,u.phone_number,u.address,u.is_verified,u.created_at,
      r.project_name,r.gateway_name,r.gateway_id,r.mac_address,r.client_ip,r.ssid,r.auth_status,
      r.last_seen_at,r.session_started_at,r.incoming_bytes,r.outgoing_bytes
    FROM users u ${scoped ? 'JOIN' : 'LEFT JOIN'} ranked_clients r ON r.user_id=u.id AND r.row_number=1
    ORDER BY u.created_at DESC`).all(...scopeParams);
    const csvCell = value => {
      let safe = String(value ?? '');
      if (/^[=+\-@]/.test(safe)) safe = `'${safe}`;
      return `"${safe.replaceAll('"','""')}"`;
    };
    const header = ['Nama Lengkap','Email','Nomor HP','Alamat','Status Verifikasi','Tanggal Daftar','Project','Gateway','Gateway ID','MAC','IP Klien','SSID','Status Akses','Terakhir Terlihat','Total Penggunaan (Bytes)','Durasi Sesi (Detik)'];
    const now = Date.now();
    const lines = rows.map(row => {
      const sessionEnd = row.auth_status === 'authorized' ? now : new Date(row.last_seen_at || row.session_started_at || 0).getTime();
      const sessionStart = new Date(row.session_started_at || 0).getTime();
      const duration = sessionStart > 0 && sessionEnd >= sessionStart ? Math.floor((sessionEnd - sessionStart) / 1000) : 0;
      return [row.full_name,row.email,row.phone_number,row.address,row.is_verified ? 'Terverifikasi' : 'Belum terverifikasi',row.created_at,
        row.project_name,row.gateway_name,row.gateway_id,row.mac_address,row.client_ip,row.ssid,row.auth_status,row.last_seen_at,
        Number(row.incoming_bytes || 0) + Number(row.outgoing_bytes || 0),duration].map(csvCell).join(',');
    });
    res.writeHead(200, {
      'content-type':'text/csv; charset=utf-8',
      'content-disposition':'attachment; filename="pengguna-terdaftar-perumnet.csv"',
      'cache-control':'no-store'
    });
    return res.end(`\ufeff${[header.map(csvCell).join(','),...lines].join('\n')}`);
  }
  if (route === '/api/admin/clients' && req.method === 'GET') {
    if (!requireAdmin(req,res)) return;
    sweepOfflineClients();
    const gatewayId = String(url.searchParams.get('gatewayId') || '').trim();
    const projectId = String(url.searchParams.get('projectId') || '').trim();
    const category = ['all','account','free','pending'].includes(url.searchParams.get('category')) ? url.searchParams.get('category') : 'all';
    const search = String(url.searchParams.get('search') || '').trim().toLowerCase().slice(0,120);
    const allowedLimits = [10,25,50,100];
    const requestedLimit = Number(url.searchParams.get('limit') || 10);
    const limit = allowedLimits.includes(requestedLimit) ? requestedLimit : 10;
    const requestedPage = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1',10) || 1);
    const scopeConditions = [];
    const scopeParams = [];
    if (gatewayId) { scopeConditions.push('c.gateway_id=?'); scopeParams.push(gatewayId); }
    else if (projectId) { scopeConditions.push('g.project_id=?'); scopeParams.push(projectId); }
    const filteredConditions = [...scopeConditions];
    const filteredParams = [...scopeParams];
    if (category === 'account') filteredConditions.push('c.user_id IS NOT NULL');
    else if (category === 'free') filteredConditions.push("c.user_id IS NULL AND c.access_type='limited'");
    else if (category === 'pending') filteredConditions.push('c.user_id IS NULL AND c.access_type IS NULL');
    if (search) {
      filteredConditions.push(`LOWER(COALESCE(u.full_name,'') || ' ' || COALESCE(u.email,'') || ' ' || COALESCE(u.phone_number,'') || ' ' ||
        COALESCE(u.address,'') || ' ' || c.mac_address || ' ' || COALESCE(c.client_ip,'') || ' ' || COALESCE(c.ssid,'') || ' ' ||
        g.id || ' ' || g.name || ' ' || p.name) LIKE ?`);
      filteredParams.push(`%${search}%`);
    }
    const filteredWhere = filteredConditions.length ? `WHERE ${filteredConditions.join(' AND ')}` : '';
    const scopeWhere = scopeConditions.length ? `WHERE ${scopeConditions.join(' AND ')}` : '';
    const totalFiltered = db.prepare(`SELECT COUNT(*) AS total FROM clients c LEFT JOIN users u ON u.id=c.user_id
      JOIN gateways g ON g.id=c.gateway_id JOIN projects p ON p.id=g.project_id ${filteredWhere}`).get(...filteredParams)?.total || 0;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * limit;
    const rows = db.prepare(`SELECT c.gateway_id,c.mac_address,c.client_ip,c.ssid,c.user_id,c.access_type,c.auth_status,c.first_seen_at,c.last_seen_at,c.authorized_until,
      c.session_started_at,c.last_counter_at,c.incoming_bytes,c.outgoing_bytes,c.incoming_bps,c.outgoing_bps,
      g.name AS gateway_name,g.location AS gateway_location,g.model AS gateway_model,g.project_id,
      p.name AS project_name,p.location AS project_location,
      u.full_name,u.email,u.phone_number,u.address,u.is_verified
      FROM clients c LEFT JOIN users u ON u.id=c.user_id
      JOIN gateways g ON g.id=c.gateway_id JOIN projects p ON p.id=g.project_id
      ${filteredWhere} ORDER BY c.last_seen_at DESC LIMIT ? OFFSET ?`).all(...filteredParams, limit, offset);
    const ssidSettings = db.prepare('SELECT default_ssid,account_ssid,free_ssid FROM portal_settings WHERE id=1').get() || {};
    const now = Date.now();
    const clients = rows.map(row => {
      const sessionStart = new Date(row.session_started_at || 0).getTime();
      const sessionEnd = row.auth_status === 'authorized' ? now : new Date(row.last_counter_at || row.last_seen_at || 0).getTime();
      return {
        ...row,
        ssid:ssidFromGateway({ ssid:row.ssid }) || (row.access_type === 'limited' ? ssidSettings.free_ssid : ssidSettings.account_ssid || ssidSettings.default_ssid) || null,
        category:row.user_id ? 'account' : row.access_type === 'limited' ? 'free' : 'pending',
        total_usage_bytes:Number(row.incoming_bytes || 0) + Number(row.outgoing_bytes || 0),
        duration_seconds:sessionStart > 0 && sessionEnd >= sessionStart ? Math.floor((sessionEnd - sessionStart) / 1000) : 0,
        telemetry_status:row.last_counter_at ? (row.auth_status === 'authorized' ? 'live' : 'ended') : 'waiting'
      };
    });
    const today = new Date().toISOString().slice(0,10);
    const stats = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN substr(c.last_seen_at,1,10)=? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN c.auth_status='authorized' THEN 1 ELSE 0 END) AS authorized
      FROM clients c JOIN gateways g ON g.id=c.gateway_id ${scopeWhere}`).get(today, ...scopeParams);
    const categoryCounts = db.prepare(`SELECT COUNT(*) AS all_count,
      SUM(CASE WHEN c.user_id IS NOT NULL THEN 1 ELSE 0 END) AS account_count,
      SUM(CASE WHEN c.user_id IS NULL AND c.access_type='limited' THEN 1 ELSE 0 END) AS free_count,
      SUM(CASE WHEN c.user_id IS NULL AND c.access_type IS NULL THEN 1 ELSE 0 END) AS pending_count
      FROM clients c JOIN gateways g ON g.id=c.gateway_id ${scopeWhere}`).get(...scopeParams);
    return json(res, 200, {
      clients,
      stats:{ total:stats.total || 0, today:stats.today || 0, authorized:stats.authorized || 0 },
      categories:{ all:categoryCounts.all_count || 0, account:categoryCounts.account_count || 0, free:categoryCounts.free_count || 0, pending:categoryCounts.pending_count || 0 },
      pagination:{ page, limit, total:totalFiltered, totalPages }
    });
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
  if (route === '/api/admin/uploads' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    const mimeType = String(payload.mimeType || '').toLowerCase();
    const extensionByMime = { 'image/png':'png','image/jpeg':'jpg','image/webp':'webp' };
    const extension = extensionByMime[mimeType];
    if (!extension) return json(res, 400, { error:'Gambar harus berformat PNG, JPG, atau WebP.' });
    const encoded = String(payload.data || '').replace(/^data:[^;]+;base64,/,'');
    if (!encoded || encoded.length > 4_200_000) return json(res, 413, { error:'Ukuran gambar maksimal 3 MB.' });
    let buffer;
    try { buffer = Buffer.from(encoded,'base64'); }
    catch { return json(res, 400, { error:'Data gambar tidak valid.' }); }
    if (!buffer.length || buffer.length > 3_000_000) return json(res, 413, { error:'Ukuran gambar maksimal 3 MB.' });
    const isPng = buffer.length > 8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isWebp = buffer.length > 12 && buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP';
    if ((mimeType === 'image/png' && !isPng) || (mimeType === 'image/jpeg' && !isJpeg) || (mimeType === 'image/webp' && !isWebp)) {
      return json(res, 400, { error:'Isi file tidak sesuai dengan format gambar.' });
    }
    const filename = `${Date.now()}-${randomBytes(10).toString('hex')}.${extension}`;
    await writeFile(join(uploadsDir,filename),buffer,{ flag:'wx' });
    return json(res, 201, { url:`/uploads/${filename}`,size:buffer.length,mimeType });
  }
  if (route === '/api/admin/portal-content' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const payload = await body(req);
    let account;
    let free;
    let promotions;
    let bandwidth;
    let termsText;
    try {
      account = normalizePortalProfile('account',payload.profiles?.account);
      free = normalizePortalProfile('free',payload.profiles?.free);
      if (account.ssid.toLowerCase() === free.ssid.toLowerCase()) throw new Error('SSID Portal Akun dan Portal Free harus berbeda.');
      if (account.announcement_enabled && (!account.announcement_title || !account.announcement_text)) throw new Error('Judul dan isi pengumuman Portal Akun wajib diisi saat pengumuman aktif.');
      if (free.announcement_enabled && (!free.announcement_title || !free.announcement_text)) throw new Error('Judul dan isi pengumuman Portal Free wajib diisi saat pengumuman aktif.');
      const rawPromotions = Array.isArray(payload.promotions) ? payload.promotions : [];
      if (rawPromotions.length > 12) throw new Error('Maksimal 12 promo aktif untuk seluruh portal.');
      if (rawPromotions.filter(item => item.profile === 'account').length > 6 || rawPromotions.filter(item => item.profile === 'free').length > 6) {
        throw new Error('Maksimal 6 promo untuk setiap profil portal.');
      }
      promotions = rawPromotions.map(normalizePortalPromotion);
      const requestedBandwidth = Number(payload.limitedBandwidthKbps || 512);
      if (!Number.isFinite(requestedBandwidth)) throw new Error('Referensi QoS harus berupa angka.');
      bandwidth = Math.min(100000,Math.max(64,requestedBandwidth));
      termsText = normalizedPortalText(payload.termsText,'Dengan melanjutkan, Anda menyetujui ketentuan penggunaan jaringan.',1200,'Syarat dan ketentuan');
    } catch (error) {
      return json(res, 400, { error:error.message });
    }
    const now = new Date().toISOString();
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`UPDATE portal_settings SET welcome_title=?,welcome_text=?,limited_bandwidth_kbps=?,terms_text=?,
        default_ssid=?,account_ssid=?,free_ssid=?,updated_at=? WHERE id=1`)
        .run(account.headline,account.description,bandwidth,termsText,account.ssid,account.ssid,free.ssid,now);
      const saveProfile = db.prepare(`INSERT INTO portal_profile_content
        (profile,eyebrow,headline,description,primary_button_label,announcement_enabled,announcement_tone,
          announcement_title,announcement_text,announcement_link_label,announcement_link_url,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(profile) DO UPDATE SET eyebrow=excluded.eyebrow,headline=excluded.headline,
          description=excluded.description,primary_button_label=excluded.primary_button_label,
          announcement_enabled=excluded.announcement_enabled,announcement_tone=excluded.announcement_tone,
          announcement_title=excluded.announcement_title,announcement_text=excluded.announcement_text,
          announcement_link_label=excluded.announcement_link_label,announcement_link_url=excluded.announcement_link_url,
          updated_at=excluded.updated_at`);
      for (const profile of [account,free]) {
        saveProfile.run(profile.profile,profile.eyebrow,profile.headline,profile.description,profile.primary_button_label,
          profile.announcement_enabled,profile.announcement_tone,profile.announcement_title,profile.announcement_text,
          profile.announcement_link_label,profile.announcement_link_url,now);
      }
      db.prepare('DELETE FROM portal_promotions').run();
      const savePromotion = db.prepare(`INSERT INTO portal_promotions
        (id,profile,title,description,image_url,link_label,link_url,is_active,sort_order,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const promotion of promotions) savePromotion.run(promotion.id,promotion.profile,promotion.title,promotion.description,
        promotion.image_url,promotion.link_label,promotion.link_url,promotion.is_active,promotion.sort_order,now,now);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
    return json(res, 200, publicPortalSettings(), { 'cache-control':'no-store' });
  }
  if (route === '/api/admin/settings' && req.method === 'POST') {
    if (!requireAdmin(req,res)) return;
    const { welcomeTitle,welcomeText,limitedBandwidthKbps,termsText,googleSheetId,accountSsid,freeSsid } = await body(req);
    const normalizedAccountSsid = String(accountSsid || '@PERUMNET_WiFi').trim().slice(0,128);
    const normalizedFreeSsid = String(freeSsid || '@PERUMNET_FreeWiFi').trim().slice(0,128);
    if (!normalizedAccountSsid || !normalizedFreeSsid) return json(res, 400, { error:'Kedua SSID portal wajib diisi.' });
    if (normalizedAccountSsid.toLowerCase() === normalizedFreeSsid.toLowerCase()) return json(res, 400, { error:'SSID Portal Akun dan Portal Free harus berbeda.' });
    db.prepare('UPDATE portal_settings SET welcome_title=?,welcome_text=?,limited_bandwidth_kbps=?,terms_text=?,google_sheet_id=?,default_ssid=?,account_ssid=?,free_ssid=?,updated_at=? WHERE id=1')
      .run(welcomeTitle, welcomeText, Number(limitedBandwidthKbps || 512), termsText, googleSheetId || null, normalizedAccountSsid, normalizedAccountSsid, normalizedFreeSsid, new Date().toISOString());
    db.prepare(`UPDATE portal_profile_content SET headline=?,description=?,updated_at=? WHERE profile='account'`)
      .run(welcomeTitle,welcomeText,new Date().toISOString());
    return json(res, 200, { ok:true, accountSsid:normalizedAccountSsid, freeSsid:normalizedFreeSsid });
  }
  return json(res, 404, { error: 'Endpoint tidak ditemukan.' });
}
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml' };
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
      const context = contextFrom(Object.fromEntries(url.searchParams.entries()));
      const approval = gatewayApproval(context, true);
      if (approval.status !== 'blocked') portalRouteForContext(context, true);
      if (approval.status !== 'approved') {
        const reviewUrl = new URL('/gateway-review', config.baseUrl);
        reviewUrl.searchParams.set('status', approval.status);
        res.writeHead(302, { location:reviewUrl.toString(), 'cache-control':'no-store' }); return res.end();
      }
      const networkRoute = portalRouteForContext(context, true);
      trackClient(context);
      if (!freeWifiDog && networkRoute?.portal_mode === 'free') {
        const freeLogin = new URL(`/free${wifiDogPath}`, config.baseUrl);
        freeLogin.search = url.search;
        res.writeHead(302, { location:freeLogin.toString(), 'cache-control':'no-store' }); return res.end();
      }
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
      const context = contextFrom(Object.fromEntries(url.searchParams.entries()));
      const approval = gatewayApproval(context, true);
      if (approval.status !== 'approved') {
        res.writeHead(302, { location:`${config.baseUrl}/gateway-review?status=${approval.status}` }); return res.end();
      }
      const freeSession = freeWifiDog || portalModeForCallback(context) === 'free';
      res.writeHead(302, { location: `${config.baseUrl}${freeSession ? '/free' : '/'}?connected=1` }); return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    if (url.pathname.startsWith('/uploads/')) {
      const filename = url.pathname.slice('/uploads/'.length);
      if (!/^[a-f0-9-]+\.(?:png|jpe?g|webp)$/i.test(filename)) return json(res, 404, { error:'Gambar tidak ditemukan.' });
      const target = join(uploadsDir,filename);
      await stat(target);
      res.writeHead(200, {
        'content-type':mime[extname(target).toLowerCase()] || 'application/octet-stream',
        'cache-control':'public, max-age=31536000, immutable',
        'x-content-type-options':'nosniff'
      });
      return res.end(await readFile(target));
    }
    let pathname = (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/free' || url.pathname === '/free/' || url.pathname === '/gateway-review' || url.pathname === '/gateway-review/') ? '/index.html' : url.pathname;
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root)) return json(res, 403, { error: 'Forbidden' });
    await stat(target); res.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream' }); res.end(await readFile(target));
  } catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'Tidak ditemukan.' }); console.error(error); json(res, 500, { error: 'Kesalahan server.' }); }
});
server.listen(config.port, () => console.log(`PerumNet Captive Portal running at ${config.baseUrl}`));
