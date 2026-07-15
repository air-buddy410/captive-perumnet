import { createServer } from 'node:http';
import { readFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

try { process.loadEnvFile?.('.env'); } catch { /* .env is optional for local development */ }

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, 'data');
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
  CREATE TABLE IF NOT EXISTS portal_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1), welcome_title TEXT NOT NULL,
    welcome_text TEXT NOT NULL, limited_bandwidth_kbps INTEGER NOT NULL DEFAULT 512,
    terms_text TEXT NOT NULL, google_sheet_id TEXT, updated_at TEXT NOT NULL
  );
`);
try { db.exec("ALTER TABLE portal_settings ADD COLUMN default_ssid TEXT NOT NULL DEFAULT 'PerumNet Guest'"); } catch { /* The column already exists after an upgrade. */ }
db.prepare(`INSERT OR IGNORE INTO portal_settings (id,welcome_title,welcome_text,limited_bandwidth_kbps,terms_text,updated_at) VALUES (1,?,?,?,?,?)`)
  .run('Internet sesuai kebutuhan Anda.', 'Pilih akses cepat atau langsung terhubung dengan kecepatan terbatas.', 512, 'Dengan melanjutkan, Anda menyetujui ketentuan penggunaan jaringan.', new Date().toISOString());

const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@kopipagi.id',
  adminPassword: process.env.ADMIN_PASSWORD || 'password',
  sessionSecret: process.env.SESSION_SECRET || 'development-only-change-me',
  reyeeMode: process.env.REYEE_AUTH_MODE || 'mock', // mock | redirect
  reyeeUserParam: process.env.REYEE_USERNAME_PARAM || 'username',
  reyeePasswordParam: process.env.REYEE_PASSWORD_PARAM || 'password',
  reyeePostUrlParam: process.env.REYEE_POST_URL_PARAM || 'post_url'
};
const id = () => randomBytes(16).toString('hex');
const json = (res, status, value, headers = {}) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(value));
const text = (res, status, value, headers = {}) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }).end(value);
const hashPassword = (password) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const verifyPassword = (password, stored) => { const [salt, key] = stored.split(':'); const actual = scryptSync(password, salt, 64).toString('hex'); return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(key, 'hex')); };
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
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
function wifiDogAuthorization(context, profile) {
  if (!context.gw_address || !context.gw_port || !context.token) return null;
  const port = Number(context.gw_port);
  const gateway = String(context.gw_address).trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-zA-Z0-9.:[\]-]+$/.test(gateway)) return null;
  const host = gateway.includes(':') && !gateway.startsWith('[') ? `[${gateway}]` : gateway;
  const url = new URL(`http://${host}:${port}/wifidog/auth`);
  url.searchParams.set('token', context.token);
  return { mode: 'redirect', protocol: 'wifidog', url: url.toString(), profile };
}
function authorize(context, profile, username) {
  if (config.reyeeMode !== 'redirect') return { mode: 'mock', profile, message: `Otorisasi ${profile} disimulasikan. Atur REYEE_AUTH_MODE=redirect untuk gateway.` };
  const wifiDog = wifiDogAuthorization(context, profile);
  if (wifiDog) return wifiDog;
  if (!context.login_url) return { mode: 'mock', profile, message: 'Data redirect dari gateway belum diterima.' };
  const url = new URL(context.login_url);
  url.searchParams.set(config.reyeeUserParam, username);
  url.searchParams.set(config.reyeePasswordParam, profile === 'limited' ? 'limited-guest' : `portal-${username}`);
  if (context.orig_url) url.searchParams.set(config.reyeePostUrlParam, context.orig_url);
  return { mode: 'redirect', url: url.toString(), profile };
}
function writeLog(userId, context, accessType) { db.prepare('INSERT INTO access_logs (id,user_id,mac_address,client_ip,access_type,ssid,timestamp) VALUES (?,?,?,?,?,?,?)').run(id(), userId, context.client_mac, context.client_ip, accessType, context.ssid, new Date().toISOString()); }
async function sendVerification(email, token) { const link = `${config.baseUrl}/?verify=${token}`; await appendFile(join(dataDir, 'email-outbox.ndjson'), JSON.stringify({ to: email, type: 'verify-email', link, createdAt: new Date().toISOString() }) + '\n'); return link; }

async function api(req, res, url) {
  const route = url.pathname;
  if (route === '/api/settings' && req.method === 'GET') return json(res, 200, db.prepare('SELECT welcome_title,welcome_text,limited_bandwidth_kbps,terms_text,default_ssid FROM portal_settings WHERE id=1').get());
  if (route === '/api/auth/register' && req.method === 'POST') {
    const { fullName, email, phone, address, password, consent, context } = await body(req);
    if (!fullName || !email || !phone || !address || !password || !consent) return json(res, 400, { error: 'Lengkapi data pendaftaran dan persetujuan.' });
    if (password.length < 8) return json(res, 400, { error: 'Kata sandi minimal 8 karakter.' });
    const normalized = String(email).toLowerCase().trim(); const exists = db.prepare('SELECT id FROM users WHERE email=?').get(normalized);
    if (exists) return json(res, 409, { error: 'Email ini sudah terdaftar. Silakan login.' });
    const token = randomBytes(24).toString('hex'); const userId = id();
    db.prepare('INSERT INTO users (id,full_name,email,phone_number,address,password_hash,is_verified,verification_token,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(userId, fullName.trim(), normalized, phone.trim(), address.trim(), hashPassword(password), 0, hashToken(token), new Date().toISOString());
    const verificationUrl = await sendVerification(normalized, token);
    return json(res, 201, { message: 'Cek email untuk verifikasi.', email: normalized, verificationUrl: process.env.NODE_ENV === 'production' ? undefined : verificationUrl });
  }
  if (route === '/api/auth/verify' && req.method === 'POST') {
    const { token, context } = await body(req); const user = db.prepare('SELECT id,email FROM users WHERE verification_token=?').get(hashToken(token || ''));
    if (!user) return json(res, 400, { error: 'Tautan verifikasi tidak valid atau sudah digunakan.' });
    db.prepare('UPDATE users SET is_verified=1, verification_token=NULL WHERE id=?').run(user.id); const captive = contextFrom(context); writeLog(user.id, captive, 'high_speed');
    return json(res, 200, { message: 'Email terverifikasi.', authorization: authorize(captive, 'high_speed', user.email) });
  }
  if (route === '/api/auth/login' && req.method === 'POST') {
    const { email, password, context } = await body(req); const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase().trim());
    if (!user || !verifyPassword(password || '', user.password_hash)) return json(res, 401, { error: 'Email atau kata sandi tidak tepat.' });
    if (!user.is_verified) return json(res, 403, { error: 'Email belum terverifikasi. Periksa inbox Anda.' });
    const captive = contextFrom(context); writeLog(user.id, captive, 'high_speed'); return json(res, 200, { authorization: authorize(captive, 'high_speed', user.email), user: { name: user.full_name, email: user.email } });
  }
  if (route === '/api/captive/limited' && req.method === 'POST') { const { context } = await body(req); const captive = contextFrom(context); const setting = db.prepare('SELECT limited_bandwidth_kbps FROM portal_settings WHERE id=1').get(); writeLog(null, captive, 'limited'); return json(res, 200, { bandwidthKbps: setting.limited_bandwidth_kbps, authorization: authorize(captive, 'limited', `guest-${captive.client_mac || id().slice(0,8)}`) }); }
  if (route === '/api/admin/login' && req.method === 'POST') { const { email, password } = await body(req); if (email !== config.adminEmail || password !== config.adminPassword) return json(res, 401, { error: 'Kredensial admin tidak tepat.' }); const sig = createHash('sha256').update(`${config.adminEmail}:${config.sessionSecret}`).digest('hex'); const encodedEmail = Buffer.from(config.adminEmail).toString('base64url'); return json(res, 200, { ok: true, email:config.adminEmail }, { 'set-cookie': adminCookie(`${encodedEmail}.${sig}`) }); }
  if (route === '/api/admin/session' && req.method === 'GET') { if (!adminSession(req)) return json(res, 401, { error: 'Sesi admin diperlukan.' }); return json(res, 200, { ok:true, email:config.adminEmail }); }
  if (route === '/api/admin/logout' && req.method === 'POST') return json(res, 200, { ok:true }, { 'set-cookie': adminCookie('', 0) });
  if (route === '/api/admin/leads' && req.method === 'GET') { if (!requireAdmin(req,res)) return; const rows = db.prepare(`SELECT l.id,l.access_type,l.mac_address,l.client_ip,l.ssid,l.timestamp,u.full_name,u.email,u.phone_number,u.address,u.is_verified FROM access_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.timestamp DESC LIMIT 250`).all(); return json(res, 200, rows); }
  if (route === '/api/admin/settings' && req.method === 'POST') { if (!requireAdmin(req,res)) return; const { welcomeTitle,welcomeText,limitedBandwidthKbps,termsText,googleSheetId,defaultSsid } = await body(req); db.prepare('UPDATE portal_settings SET welcome_title=?,welcome_text=?,limited_bandwidth_kbps=?,terms_text=?,google_sheet_id=?,default_ssid=?,updated_at=? WHERE id=1').run(welcomeTitle, welcomeText, Number(limitedBandwidthKbps || 512), termsText, googleSheetId || null, String(defaultSsid || 'PerumNet Guest').trim(), new Date().toISOString()); return json(res, 200, { ok: true }); }
  return json(res, 404, { error: 'Endpoint tidak ditemukan.' });
}
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, config.baseUrl);
  try {
    // Reyee WiFiDog appends these paths to the Auth Server URL. A leading double
    // slash is normal in ReyeeOS redirects, so normalize it before matching.
    const wifiDogPath = url.pathname.replace(/^\/+/,'/');
    if (wifiDogPath === '/auth/wifidogAuth/login/' || wifiDogPath === '/auth/wifidogAuth/login') {
      res.writeHead(200, { 'content-type': mime['.html'] }); return res.end(await readFile(join(root, 'index.html')));
    }
    if (wifiDogPath === '/auth/wifidogAuth/ping/' || wifiDogPath === '/auth/wifidogAuth/ping') return text(res, 200, 'Pong');
    if (wifiDogPath === '/auth/wifidogAuth/auth/' || wifiDogPath === '/auth/wifidogAuth/auth') {
      // check is a gateway health probe; query asks whether an unauthenticated
      // station already has a session. No session is granted at this stage.
      return text(res, 200, url.searchParams.get('stage') === 'check' ? 'Auth: 1\n' : 'Auth: 0\n');
    }
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    let pathname = (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/') ? '/index.html' : url.pathname;
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root)) return json(res, 403, { error: 'Forbidden' });
    await stat(target); res.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream' }); res.end(await readFile(target));
  } catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'Tidak ditemukan.' }); console.error(error); json(res, 500, { error: 'Kesalahan server.' }); }
});
server.listen(config.port, () => console.log(`PerumNet Captive Portal running at ${config.baseUrl}`));
