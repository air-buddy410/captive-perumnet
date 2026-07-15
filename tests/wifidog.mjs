import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'perumnet-wifidog-'));
const port = 32000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT:String(port), APP_BASE_URL:baseUrl, PORTAL_DATA_DIR:dataDir,
    REYEE_AUTH_MODE:'redirect', NODE_ENV:'test',
    WIFIDOG_LIMITED_SESSION_HOURS:'0.0005',
    ADMIN_EMAIL:'admin-test@example.com', ADMIN_PASSWORD:'admin-test-password',
    SMTP_HOST:'', SMTP_USER:'', SMTP_PASSWORD:'', EMAIL_FROM:''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverError = '';
child.stderr.on('data', chunk => { serverError += chunk; });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const request = async (path, options) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body:await response.text() };
};

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/settings`)).ok) break; } catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (attempt === 49) throw new Error(`Server test tidak aktif. ${serverError}`);
  }

  const mac = '02:00:00:00:10:01';
  const context = { gw_address:'10.1.10.1', gw_port:'2060', gw_id:'test-gateway', mac, ip:'10.1.10.10', ssid:'TEST' };
  const limitedResponse = await fetch(`${baseUrl}/api/captive/limited`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ context })
  });
  const limited = await limitedResponse.json();
  assert(limitedResponse.status === 200, 'One-click harus berhasil.');
  assert(limited.sessionHours === 0.0005, 'Durasi one-click harus mengikuti konfigurasi limited.');
  assert(limited.authorization?.protocol === 'wifidog', 'Respons harus memakai protokol WiFiDog.');
  const gatewayUrl = new URL(limited.authorization.url);
  const token = gatewayUrl.searchParams.get('token');
  assert(gatewayUrl.hostname === '10.1.10.1' && gatewayUrl.port === '2060', 'Redirect harus menuju gateway lokal.');
  assert(token?.length === 64, 'Token WiFiDog harus acak dan tersedia.');

  const queryBefore = await request(`/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}`);
  assert(queryBefore.body === 'Auth: 0\n', 'Client belum boleh aktif sebelum token dikonfirmasi gateway.');
  const wrongMac = await request(`/auth/wifidogAuth/auth/?stage=login&gw_id=test-gateway&ip=10.1.10.11&mac=02:00:00:00:10:02&token=${token}`);
  assert(wrongMac.body === 'Auth: 0\n', 'Token harus ditolak untuk MAC berbeda.');
  const login = await request(`/auth/wifidogAuth/auth/?stage=login&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}&token=${token}`);
  assert(login.body === 'Auth: 1\n', 'Token valid harus mengaktifkan internet.');
  const queryAfter = await request(`/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}`);
  assert(queryAfter.body === 'Auth: 1\n', 'Query session aktif harus diizinkan.');
  const counters = await request(`/auth/wifidogAuth/auth/?stage=counters&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}&token=${token}`);
  assert(counters.body === 'Auth: 1\n', 'Counters dengan token aktif harus diizinkan.');
  await new Promise(resolve => setTimeout(resolve, 1900));
  const queryExpired = await request(`/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}`);
  assert(queryExpired.body === 'Auth: 0\n', 'Session limited harus ditutup setelah durasinya habis.');
  const logout = await request(`/auth/wifidogAuth/auth/?stage=logout&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}&token=${token}`);
  assert(logout.body === 'Auth: 0\n', 'Logout harus mencabut session.');
  const queryLoggedOut = await request(`/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}`);
  assert(queryLoggedOut.body === 'Auth: 0\n', 'Client logout tidak boleh tetap aktif.');

  const accountMac = '02:00:00:00:20:01';
  const accountContext = { ...context, mac:accountMac, ip:'10.1.10.20' };
  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ fullName:'WiFiDog Test', email:'wifidog-test@example.com', phone:'081234567890', address:'Test', password:'test-password-123', consent:true })
  });
  assert(registerResponse.status === 201, 'Registrasi akun tes harus berhasil.');
  const outbox = (await readFile(join(dataDir, 'email-outbox.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const verificationToken = new URL(outbox.at(-1).link).searchParams.get('verify');
  const verifyResponse = await fetch(`${baseUrl}/api/auth/verify`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ token:verificationToken, context:accountContext })
  });
  const verified = await verifyResponse.json();
  assert(verifyResponse.status === 200 && verified.authorization?.protocol === 'wifidog', 'Verifikasi akun harus membuat token High Speed.');

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'wifidog-test@example.com', password:'test-password-123', context:accountContext })
  });
  const accountLogin = await loginResponse.json();
  const accountGatewayUrl = new URL(accountLogin.authorization.url);
  const accountToken = accountGatewayUrl.searchParams.get('token');
  assert(loginResponse.status === 200 && accountLogin.authorization.profile === 'high_speed', 'Login akun terverifikasi harus membuat token High Speed.');
  const accountAuth = await request(`/auth/wifidogAuth/auth/?stage=login&gw_id=test-gateway&ip=10.1.10.20&mac=${accountMac}&token=${accountToken}`);
  assert(accountAuth.body === 'Auth: 1\n', 'Gateway harus menerima token login akun terverifikasi.');
  const adminLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'admin-test@example.com', password:'admin-test-password' })
  });
  const adminCookie = adminLogin.headers.get('set-cookie');
  assert(adminLogin.status === 200 && adminCookie, 'Admin tes harus dapat login.');
  const deleteResponse = await fetch(`${baseUrl}/api/admin/clients`, {
    method:'DELETE', headers:{ 'content-type':'application/json', cookie:adminCookie }, body:JSON.stringify({ macAddress:accountMac })
  });
  const deleted = await deleteResponse.json();
  assert(deleteResponse.status === 200 && deleted.deletedAccount && deleted.gatewayAuthorizationRevoked, 'Hapus admin harus menghapus akun dan mencabut otorisasi gateway.');
  const revokedCounter = await request(`/auth/wifidogAuth/auth/?stage=counters&gw_id=test-gateway&ip=10.1.10.20&mac=${accountMac}&token=${accountToken}`);
  assert(revokedCounter.body === 'Auth: 0\n', 'Token lama harus ditolak setelah data dihapus admin.');
  const revokedQuery = await request(`/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.10.20&mac=${accountMac}`);
  assert(revokedQuery.body === 'Auth: 0\n', 'MAC lama harus tidak terotorisasi setelah data dihapus admin.');
  const clientsAfterDelete = await fetch(`${baseUrl}/api/admin/clients`, { headers:{ cookie:adminCookie } });
  const deletedClientList = await clientsAfterDelete.json();
  assert(!deletedClientList.clients.some(client=>client.mac_address===accountMac), 'Perangkat yang dicabut tidak boleh muncul kembali hanya karena polling gateway.');
  const removedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'wifidog-test@example.com', password:'test-password-123', context:accountContext })
  });
  assert(removedLogin.status === 401, 'Akun yang dihapus tidak boleh dapat login kembali.');
  console.log('WiFiDog token handshake: PASS');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  await rm(dataDir, { recursive:true, force:true });
}
