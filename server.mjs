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
  CREATE TABLE IF NOT EXISTS access_logs (
    id TEXT PRIMARY KEY, user_id TEXT, mac_address TEXT, client_ip TEXT,
    access_type TEXT NOT NULL CHECK(access_type IN ('high_speed','limited')),
    ssid TEXT, timestamp TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS clients (
    mac_address TEXT PRIMARY KEY, client_ip TEXT, ssid TEXT, gateway_id TEXT,
    user_id TEXT, access_type TEXT CHECK(access_type IN ('high_speed','limited')),
    auth_status TEXT NOT NULL DEFAULT 'pending' CHECK(auth_status IN ('pending','authorized')),
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, authorized_until TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
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
  CREATE TABLE IF NOT EXISTS portal_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1), welcome_title TEXT NOT NULL,
    welcome_text TEXT NOT NULL, limited_bandwidth_kbps INTEGER NOT NULL DEFAULT 512,
    terms_text TEXT NOT NULL, google_sheet_id TEXT, updated_at TEXT NOT NULL
  );
`);
try { db.exec("ALTER TABLE portal_settings ADD COLUMN default_ssid TEXT NOT NULL DEFAULT 'PerumNet Guest'"); } catch { /* The column already exists after an upgrade. */ }
try { db.exec('ALTER TABLE clients ADD COLUMN authorized_until TEXT'); } catch { /* The column already exists after an upgrade. */ }
db.prepare(`INSERT OR IGNORE INTO portal_settings (id,welcome_title,welcome_text,limited_bandwidth_kbps,terms_text,updated_at) VALUES (1,?,?,?,?,?)`)
  .run('Internet sesuai kebutuhan Anda.', 'Pilih akses cepat atau langsung terhubung dengan kecepatan terbatas.', 512, 'Dengan melanjutkan, Anda menyetujui ketentuan penggunaan jaringan.', new Date().toISOString());

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
  wifiDogLimitedSessionHours: Number(process.env.WIFIDOG_LIMITED_SESSION_HOURS || 2)
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
function contextFrom(value = {}) {
  return {
    client_mac: value.client_mac || value.mac || null,
    client_ip: value.client_ip || value.ip || null,
    ssid: value.ssid || null,
    login_url: value.login_url || null,
    logout_url: value.logout_url || null,
    orig_url: value.orig_url || value.url || null,
    // WiFiDog context is forwarded by Reyee when opening an external portal.
    gw_address: value.gw_address || null,
    gw_port: value.gw_port || null,
    gw_id: value.gw_id || null,
    token: value.token || null
  };
}
function trackClient(context) {
  const mac = String(context.client_mac || '').trim().toLowerCase();
  if (!mac) return;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO clients (mac_address,client_ip,ssid,gateway_id,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(mac_address) DO UPDATE SET
      client_ip=COALESCE(excluded.client_ip,clients.client_ip),
      ssid=COALESCE(excluded.ssid,clients.ssid),
      gateway_id=COALESCE(excluded.gateway_id,clients.gateway_id),
      last_seen_at=excluded.last_seen_at`).run(mac, context.client_ip, context.ssid, context.gw_id, now, now);
}
function wifiDogAuthorization(context, profile, userId) {
  if (!context.gw_address || !context.gw_port) return null;
  const port = Number(context.gw_port);
  const gateway = String(context.gw_address).trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-zA-Z0-9.:[\]-]+$/.test(gateway)) return null;
  const mac = String(context.client_mac || '').trim().toLowerCase();
  if (!mac) return null;
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
  db.prepare('UPDATE captive_sessions SET revoked_at=? WHERE mac_address=? AND revoked_at IS NULL').run(nowIso, mac);
  db.prepare(`INSERT INTO captive_sessions
    (token_hash,mac_address,client_ip,gateway_id,user_id,access_type,created_at,login_expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(hashToken(token), mac, context.client_ip, context.gw_id, userId, profile, nowIso, loginExpiresAt);
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
  trackClient(context);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO access_logs (id,user_id,mac_address,client_ip,access_type,ssid,timestamp) VALUES (?,?,?,?,?,?,?)').run(id(), userId, context.client_mac, context.client_ip, accessType, context.ssid, now);
  if (context.client_mac) db.prepare('UPDATE clients SET user_id=?, access_type=?, auth_status=?, last_seen_at=?, authorized_until=NULL WHERE mac_address=?').run(userId, accessType, 'pending', now, String(context.client_mac).toLowerCase());
}

function confirmWifiDogSession(url) {
  const stage = String(url.searchParams.get('stage') || '').toLowerCase();
  const context = contextFrom(Object.fromEntries(url.searchParams.entries()));
  trackClient(context);
  const mac = String(context.client_mac || '').trim().toLowerCase();
  const rawToken = String(url.searchParams.get('token') || '');
  const now = new Date();
  const nowIso = now.toISOString();

  if (stage === 'logout') {
    if (rawToken) db.prepare('UPDATE captive_sessions SET revoked_at=? WHERE token_hash=?').run(nowIso, hashToken(rawToken));
    if (mac) db.prepare("UPDATE clients SET auth_status='pending',access_type=NULL,user_id=NULL,authorized_until=NULL,last_seen_at=? WHERE mac_address=?").run(nowIso, mac);
    return false;
  }

  if (stage === 'login') {
    if (!rawToken || !mac) return false;
    const session = db.prepare('SELECT * FROM captive_sessions WHERE token_hash=?').get(hashToken(rawToken));
    const gatewayMatches = !session?.gateway_id || !context.gw_id || session.gateway_id === context.gw_id;
    const canLogin = session && !session.revoked_at && session.mac_address === mac && gatewayMatches &&
      ((session.authorized_at && session.authorized_until > nowIso) || (!session.authorized_at && session.login_expires_at > nowIso));
    if (!canLogin) return false;
    const sessionHours = sessionHoursFor(session.access_type);
    const authorizedAt = session.authorized_at || nowIso;
    const authorizedUntil = session.authorized_until || new Date(now.getTime() + sessionHours * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE captive_sessions SET authorized_at=?,authorized_until=? WHERE token_hash=?').run(authorizedAt, authorizedUntil, hashToken(rawToken));
    db.prepare(`UPDATE clients SET user_id=?,access_type=?,auth_status='authorized',last_seen_at=?,authorized_until=? WHERE mac_address=?`)
      .run(session.user_id, session.access_type, nowIso, authorizedUntil, mac);
    return true;
  }

  if (rawToken) {
    const session = db.prepare('SELECT mac_address,authorized_at,authorized_until,revoked_at FROM captive_sessions WHERE token_hash=?').get(hashToken(rawToken));
    return !!(session && !session.revoked_at && session.authorized_at && session.authorized_until > nowIso && (!mac || session.mac_address === mac));
  }

  if (!mac) return false;
  const client = db.prepare('SELECT auth_status,authorized_until FROM clients WHERE mac_address=?').get(mac);
  const valid = client?.auth_status === 'authorized' && client.authorized_until && client.authorized_until > nowIso;
  if (client?.auth_status === 'authorized' && !valid) db.prepare("UPDATE clients SET auth_status='pending',access_type=NULL,user_id=NULL,authorized_until=NULL WHERE mac_address=?").run(mac);
  return !!valid;
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

async function api(req, res, url) {
  const route = url.pathname;
  if (route === '/api/settings' && req.method === 'GET') {
    const settings = db.prepare('SELECT welcome_title,welcome_text,limited_bandwidth_kbps,terms_text,default_ssid FROM portal_settings WHERE id=1').get();
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
    const { token, context } = await body(req); const user = db.prepare('SELECT id,email FROM users WHERE verification_token=?').get(hashToken(token || ''));
    if (!user) return json(res, 400, { error: 'Tautan verifikasi tidak valid atau sudah digunakan.' });
    db.prepare('UPDATE users SET is_verified=1, verification_token=NULL WHERE id=?').run(user.id); const captive = contextFrom(context); writeLog(user.id, captive, 'high_speed');
    return json(res, 200, { message: 'Email terverifikasi.', authorization: authorize(captive, 'high_speed', user.email, user.id) });
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
  if (route === '/api/admin/clients' && req.method === 'GET') {
    if (!requireAdmin(req,res)) return;
    const rows = db.prepare(`SELECT c.mac_address,c.client_ip,c.ssid,c.access_type,c.auth_status,c.first_seen_at,c.last_seen_at,
      u.full_name,u.email,u.phone_number,u.address,u.is_verified
      FROM clients c LEFT JOIN users u ON u.id=c.user_id
      ORDER BY c.last_seen_at DESC LIMIT 250`).all();
    const today = new Date().toISOString().slice(0,10);
    const stats = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN substr(last_seen_at,1,10)=? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN auth_status='authorized' THEN 1 ELSE 0 END) AS authorized FROM clients`).get(today);
    return json(res, 200, { clients:rows, stats:{ total:stats.total || 0, today:stats.today || 0, authorized:stats.authorized || 0 } });
  }
  if (route === '/api/admin/settings' && req.method === 'POST') { if (!requireAdmin(req,res)) return; const { welcomeTitle,welcomeText,limitedBandwidthKbps,termsText,googleSheetId,defaultSsid } = await body(req); db.prepare('UPDATE portal_settings SET welcome_title=?,welcome_text=?,limited_bandwidth_kbps=?,terms_text=?,google_sheet_id=?,default_ssid=?,updated_at=? WHERE id=1').run(welcomeTitle, welcomeText, Number(limitedBandwidthKbps || 512), termsText, googleSheetId || null, String(defaultSsid || 'PerumNet Guest').trim(), new Date().toISOString()); return json(res, 200, { ok: true }); }
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
    const wifiDogPath = url.pathname.replace(/^\/+/,'/');
    if (wifiDogPath === '/auth/wifidogAuth/login/' || wifiDogPath === '/auth/wifidogAuth/login') {
      res.writeHead(200, { 'content-type': mime['.html'] }); return res.end(await readFile(join(root, 'index.html')));
    }
    if (wifiDogPath === '/auth/wifidogAuth/ping/' || wifiDogPath === '/auth/wifidogAuth/ping') return text(res, 200, 'Pong');
    if (wifiDogPath === '/auth/wifidogAuth/auth/' || wifiDogPath === '/auth/wifidogAuth/auth') {
      const stage = url.searchParams.get('stage');
      if (stage === 'check') return text(res, 200, 'Auth: 1\n'); // Gateway health probe.
      return text(res, 200, confirmWifiDogSession(url) ? 'Auth: 1\n' : 'Auth: 0\n');
    }
    if (wifiDogPath === '/auth/wifidogAuth/portal/' || wifiDogPath === '/auth/wifidogAuth/portal') {
      res.writeHead(302, { location: `${config.baseUrl}/?connected=1` }); return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    let pathname = (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/') ? '/index.html' : url.pathname;
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root)) return json(res, 403, { error: 'Forbidden' });
    await stat(target); res.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream' }); res.end(await readFile(target));
  } catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'Tidak ditemukan.' }); console.error(error); json(res, 500, { error: 'Kesalahan server.' }); }
});
server.listen(config.port, () => console.log(`PerumNet Captive Portal running at ${config.baseUrl}`));
