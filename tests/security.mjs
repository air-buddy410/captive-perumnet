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
  // Webfont pernah diam-diam gagal dimuat karena CSP tidak mengizinkan sumbernya,
  // dan portal jatuh ke font sistem tanpa error yang terlihat pengguna. Kaitkan
  // kebijakan dengan apa yang benar-benar diminta halaman supaya keduanya tidak
  // bisa berbeda lagi.
  const policy = shell.headers.get('content-security-policy') || '';
  const html = await (await fetch(`${baseUrl}/`)).text();
  const externalFontHosts = [...html.matchAll(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)/g)].map(match => match[1]);
  for (const host of new Set(externalFontHosts)) {
    assert(policy.includes(host), `CSP harus mengizinkan ${host} selama index.html masih memuatnya.`);
  }
  // Font lokal harus benar-benar tersaji, bukan hanya dideklarasikan di CSS.
  for (const font of ['/assets/fonts/dm-sans-latin.woff2','/assets/fonts/plus-jakarta-sans-latin.woff2']) {
    const response = await fetch(`${baseUrl}${font}`);
    assert(response.ok, `Berkas font ${font} harus dapat diakses (status ${response.status}).`);
    const head = Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString('latin1');
    assert(head === 'wOF2', `Berkas font ${font} harus berupa woff2 yang valid.`);
  }

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

  // Akuntabilitas tim: satu akun per orang, dan tindakan sensitif tercatat.
  const owner = await login();
  const ownerCookie = owner.headers.get('set-cookie')?.split(';')[0];
  const addMember = await fetch(`${baseUrl}/api/admin/team`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:ownerCookie },
    body:JSON.stringify({ email:'staf@example.test', fullName:'Staf Uji', password:'kata-sandi-staf-panjang', role:'staff' })
  });
  assert(addMember.status === 201, `Pemilik harus dapat menambah anggota tim (dapat ${addMember.status}).`);

  const staffLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'staf@example.test', password:'kata-sandi-staf-panjang' })
  });
  const staffCookie = staffLogin.headers.get('set-cookie')?.split(';')[0];
  assert(staffLogin.status === 200 && staffCookie, 'Anggota tim harus dapat masuk dengan akunnya sendiri.');
  assert((await staffLogin.json()).role === 'staff', 'Anggota baru harus berperan staff, bukan owner.');

  const staffEscalation = await fetch(`${baseUrl}/api/admin/team`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:staffCookie },
    body:JSON.stringify({ email:'lain@example.test', fullName:'Orang Lain', password:'kata-sandi-lain-panjang' })
  });
  assert(staffEscalation.status === 403, `Staff tidak boleh menambah anggota tim (dapat ${staffEscalation.status}).`);

  await fetch(`${baseUrl}/api/admin/export.csv`, { headers:{ cookie:staffCookie } });
  const auditResponse = await fetch(`${baseUrl}/api/admin/audit?limit=50`, { headers:{ cookie:ownerCookie } });
  const audit = await auditResponse.json();
  const exportEntry = audit.entries.find(entry => entry.action === 'pelanggan.ekspor-csv');
  assert(exportEntry, 'Ekspor CSV harus tercatat di jejak audit.');
  assert(exportEntry.admin_email === 'staf@example.test',
    `Jejak audit harus menyebut pengunduhnya, bukan akun lain (dapat ${exportEntry.admin_email}).`);
  assert(audit.entries.some(entry => entry.action === 'tim.tambah'), 'Penambahan anggota tim harus tercatat.');

  // Menonaktifkan anggota harus langsung memutus sesinya yang sedang berjalan.
  const members = await (await fetch(`${baseUrl}/api/admin/team`, { headers:{ cookie:ownerCookie } })).json();
  const staffMember = members.members.find(member => member.email === 'staf@example.test');
  const disable = await fetch(`${baseUrl}/api/admin/team`, {
    method:'PATCH', headers:{ 'content-type':'application/json', cookie:ownerCookie },
    body:JSON.stringify({ memberId:staffMember.id, disabled:true })
  });
  assert(disable.status === 200, 'Pemilik harus dapat menonaktifkan anggota.');
  const afterDisable = await fetch(`${baseUrl}/api/admin/session`, { headers:{ cookie:staffCookie } });
  assert(afterDisable.status === 401, 'Sesi anggota yang dinonaktifkan harus langsung ditolak.');

  // Titik peta hotspot: koordinat ditandai manual, jadi rentangnya harus dijaga
  // dan perubahannya tercatat seperti tindakan admin lainnya.
  const gatewayList = await (await fetch(`${baseUrl}/api/admin/network`, { headers:{ cookie:ownerCookie } })).json();
  const mapGateway = gatewayList.gateways.find(gateway => gateway.id !== 'unassigned') || gatewayList.gateways[0];
  assert(mapGateway.map_status, 'Setiap gateway harus membawa map_status untuk peta hotspot.');

  const badLatitude = await fetch(`${baseUrl}/api/admin/gateways/location`, {
    method:'PATCH', headers:{ 'content-type':'application/json', cookie:ownerCookie },
    body:JSON.stringify({ gatewayId:mapGateway.id, latitude:120, longitude:115 })
  });
  assert(badLatitude.status === 400, `Latitude di luar -90..90 harus ditolak (dapat ${badLatitude.status}).`);

  const savePoint = await fetch(`${baseUrl}/api/admin/gateways/location`, {
    method:'PATCH', headers:{ 'content-type':'application/json', cookie:ownerCookie },
    body:JSON.stringify({ gatewayId:mapGateway.id, latitude:-8.65, longitude:115.216 })
  });
  assert(savePoint.status === 200, `Titik peta yang valid harus tersimpan (dapat ${savePoint.status}).`);
  const afterSave = await (await fetch(`${baseUrl}/api/admin/network`, { headers:{ cookie:ownerCookie } })).json();
  const saved = afterSave.gateways.find(gateway => gateway.id === mapGateway.id);
  assert(Number(saved.latitude) === -8.65 && Number(saved.longitude) === 115.216, 'Koordinat harus benar-benar tersimpan.');

  const mapAudit = await (await fetch(`${baseUrl}/api/admin/audit?limit=50`, { headers:{ cookie:ownerCookie } })).json();
  assert(mapAudit.entries.some(entry => entry.action === 'gateway.titik-simpan'), 'Penandaan titik peta harus tercatat di jejak audit.');

  // Akun marketing: boleh melihat data pelanggan dan peta, tetapi tidak boleh
  // menyentuh jaringan. Ditegakkan di server, bukan sekadar menu disembunyikan.
  const addMarketing = await fetch(`${baseUrl}/api/admin/team`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:ownerCookie },
    body:JSON.stringify({ email:'marketing@example.test', fullName:'Tim Marketing', password:'kata-sandi-marketing-panjang', role:'marketing' })
  });
  assert(addMarketing.status === 201, `Peran marketing harus dapat dibuat (dapat ${addMarketing.status}).`);

  const marketingLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'marketing@example.test', password:'kata-sandi-marketing-panjang' })
  });
  const marketingCookie = marketingLogin.headers.get('set-cookie')?.split(';')[0];
  assert(marketingLogin.status === 200 && (await marketingLogin.json()).role === 'marketing',
    'Akun marketing harus dapat masuk dan membawa perannya.');

  const terlarang = [
    ['POST',   '/api/admin/gateways',            { gatewayId:'gw-x', name:'X' }],
    ['DELETE', '/api/admin/gateways',            { gatewayId:'gw-x' }],
    ['PATCH',  '/api/admin/gateways/location',   { gatewayId:mapGateway.id, latitude:-8, longitude:115 }],
    ['POST',   '/api/admin/gateways/approval',   { gatewayId:'gw-x' }],
    ['POST',   '/api/admin/portal-networks',     { gatewayId:'gw-x', networkAlias:'VLAN1', portalMode:'free' }],
    ['POST',   '/api/admin/projects',            { name:'Project Baru' }],
    ['DELETE', '/api/admin/clients',             { gatewayId:'gw-x', macAddress:'aa:bb:cc:dd:ee:ff' }],
    ['GET',    '/api/admin/team',                null],
    ['GET',    '/api/admin/audit',               null]
  ];
  for (const [method, path, payload] of terlarang) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers:{ 'content-type':'application/json', cookie:marketingCookie },
      body: payload ? JSON.stringify(payload) : undefined
    });
    assert(response.status === 403, `Marketing harus ditolak di ${method} ${path} (dapat ${response.status}).`);
  }

  // Yang tetap boleh: memantau pengunjung dan membaca peta hotspot.
  for (const path of ['/api/admin/clients', '/api/admin/network', '/api/admin/users']) {
    const response = await fetch(`${baseUrl}${path}`, { headers:{ cookie:marketingCookie } });
    assert(response.ok, `Marketing harus tetap dapat membaca ${path} (status ${response.status}).`);
  }
  const petaUntukMarketing = await (await fetch(`${baseUrl}/api/admin/network`, { headers:{ cookie:marketingCookie } })).json();
  assert(petaUntukMarketing.gateways.every(gateway => gateway.map_status),
    'Marketing harus tetap menerima status peta untuk halaman pemantauan.');

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
