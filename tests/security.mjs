import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'perumnet-security-'));
const port = 33000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const adminEmail = 'admin-test@example.com';
const adminPassword = 'admin-test-password';
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT:String(port), APP_BASE_URL:baseUrl, PORTAL_DATA_DIR:dataDir,
    REYEE_AUTH_MODE:'redirect', NODE_ENV:'test',
    ADMIN_EMAIL:adminEmail, ADMIN_PASSWORD:adminPassword,
    SESSION_SECRET:'test-session-secret-value-32-chars-long',
    SMTP_HOST:'', SMTP_USER:'', SMTP_PASSWORD:'', EMAIL_FROM:''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverError = '';
child.stderr.on('data', chunk => { serverError += chunk; });
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/settings`)).ok) break; } catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (attempt === 49) throw new Error(`Server test tidak aktif. ${serverError}`);
  }

  // The static handler used to serve every file under the project root, which
  // exposed the customer database, the .env secrets and the git metadata.
  for (const path of ['/data/portal.db', '/server.mjs', '/package.json', '/.gitignore', '/.env', '/.env.example', '/.git/config', '/tests/security.mjs', '/package-lock.json']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert(response.status === 404, `File internal ${path} tidak boleh disajikan (status ${response.status}).`);
  }

  for (const path of ['/', '/admin', '/free', '/index.html', '/app.js', '/styles.css', '/assets/perumnet-favicon.png']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert(response.ok, `Aset portal ${path} harus tetap tersaji (status ${response.status}).`);
  }

  const shell = await fetch(`${baseUrl}/`);
  assert(shell.headers.get('x-content-type-options') === 'nosniff', 'Respons HTML harus memakai nosniff.');
  assert(shell.headers.get('x-frame-options') === 'DENY', 'Dashboard admin tidak boleh dapat di-iframe.');
  assert(/frame-ancestors 'none'/.test(shell.headers.get('content-security-policy') || ''), 'CSP harus melarang framing.');
  assert(/script-src 'self'/.test(shell.headers.get('content-security-policy') || ''), 'CSP harus membatasi sumber script.');

  const oversized = await fetch(`${baseUrl}/api/auth/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'a@b.co', password:'x'.repeat(400 * 1024) })
  });
  assert(oversized.status === 413, `Body melebihi batas harus ditolak dengan 413 (dapat ${oversized.status}).`);

  const junkRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ fullName:'A'.repeat(400), email:'bukan-email', phone:'0812345678', address:'Jalan Tes 1', password:'password123', consent:true, context:{} })
  });
  assert(junkRegistration.status === 400, `Email tanpa format valid harus ditolak (dapat ${junkRegistration.status}).`);

  const login = async () => fetch(`${baseUrl}/api/admin/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:adminEmail, password:adminPassword })
  });
  const goodLogin = await login();
  const cookie = goodLogin.headers.get('set-cookie')?.split(';')[0];
  assert(goodLogin.status === 200 && cookie, 'Admin harus dapat login.');

  const beforeLogout = await fetch(`${baseUrl}/api/admin/session`, { headers:{ cookie } });
  assert(beforeLogout.status === 200, 'Sesi admin harus aktif sebelum logout.');
  await fetch(`${baseUrl}/api/admin/logout`, { method:'POST', headers:{ cookie } });
  const afterLogout = await fetch(`${baseUrl}/api/admin/session`, { headers:{ cookie } });
  assert(afterLogout.status === 401, 'Cookie admin harus tidak berlaku lagi setelah logout.');

  let throttled = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/admin/login`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ email:adminEmail, password:`salah-${attempt}` })
    });
    if (response.status === 429) { throttled = true; break; }
  }
  assert(throttled, 'Login admin harus dibatasi setelah percobaan berulang.');

  console.log('Security contract: PASS');
} finally {
  child.kill();
  await rm(dataDir, { recursive:true, force:true });
}
