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
  const context = { gw_address:'10.1.10.1', gw_port:'2060', gw_id:'test-gateway', mac, ip:'10.1.10.10', ssid:'VLAN10' };
  const defaultLogin = await fetch(`${baseUrl}/auth/wifidogAuth/login/?gw_id=test-gateway&gw_address=10.1.10.1&gw_port=2060&mac=${encodeURIComponent(mac)}&ip=10.1.10.10&ssid=VLAN10&vlan_description=Guest%20Free`, { redirect:'manual' });
  assert(defaultLogin.status === 302 && new URL(defaultLogin.headers.get('location')).pathname === '/gateway-review', 'Gateway baru harus dikarantina sampai diverifikasi admin.');
  const adminLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'admin-test@example.com', password:'admin-test-password' })
  });
  const adminCookie = adminLogin.headers.get('set-cookie');
  assert(adminLogin.status === 200 && adminCookie, 'Admin tes harus dapat login.');
  const discoveredNetworkResponse = await fetch(`${baseUrl}/api/admin/network`, { headers:{ cookie:adminCookie } });
  const discoveredNetwork = await discoveredNetworkResponse.json();
  assert(discoveredNetwork.portalNetworks.some(route=>route.gateway_id==='test-gateway' && route.network_alias==='VLAN10' && route.portal_mode==='account'), 'Redirect WiFiDog harus menemukan alias VLAN dengan fallback Portal Akun.');
  assert(discoveredNetwork.portalNetworks.some(route=>route.gateway_id==='test-gateway' && route.network_description==='Guest Free'), 'Deskripsi VLAN harus dibaca jika firmware mengirim parameternya.');
  assert(discoveredNetwork.gateways.some(gateway=>gateway.id==='test-gateway' && gateway.approval_status==='pending'), 'Gateway baru harus tampil sebagai menunggu verifikasi.');
  const quarantinedLimited = await fetch(`${baseUrl}/api/captive/limited`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ context })
  });
  assert(quarantinedLimited.status === 403, 'Gateway pending tidak boleh membuat token one-click.');
  const approveGateway = await fetch(`${baseUrl}/api/admin/gateways/approval`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ gatewayId:'test-gateway' })
  });
  assert(approveGateway.status === 200, 'Admin harus dapat menyetujui gateway pending.');
  const approvedDefaultLogin = await fetch(`${baseUrl}/auth/wifidogAuth/login/?gw_id=test-gateway&gw_address=10.1.10.1&gw_port=2060&mac=${encodeURIComponent(mac)}&ip=10.1.10.10&ssid=VLAN10`, { redirect:'manual' });
  assert(approvedDefaultLogin.status === 200, 'Gateway terverifikasi harus membuka Portal Akun sebagai fallback aman.');
  const mapFreeNetwork = await fetch(`${baseUrl}/api/admin/portal-networks`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ gatewayId:'test-gateway',networkAlias:'VLAN10',portalMode:'free',networkDescription:'Free WiFi Pengunjung' })
  });
  assert(mapFreeNetwork.status === 200, 'Admin harus dapat memetakan VLAN ke Portal Free.');
  const dynamicFreeLogin = await fetch(`${baseUrl}/auth/wifidogAuth/login/?gw_id=test-gateway&gw_address=10.1.10.1&gw_port=2060&mac=${encodeURIComponent(mac)}&ip=10.1.10.10&ssid=VLAN10`, { redirect:'manual' });
  assert(dynamicFreeLogin.status === 302 && new URL(dynamicFreeLogin.headers.get('location')).pathname === '/free/auth/wifidogAuth/login/', 'Satu Auth Server URL harus otomatis mengarahkan VLAN Free ke halaman /free.');
  const freePageResponse = await fetch(`${baseUrl}/free?gw_id=test-gateway&mac=${encodeURIComponent(mac)}`);
  assert(freePageResponse.status === 200 && (await freePageResponse.text()).includes('id="free-screen"'), 'Route /free harus menyajikan portal one-click.');
  const freeLoginResponse = await fetch(`${baseUrl}/free/auth/wifidogAuth/login/?gw_id=test-gateway&mac=${encodeURIComponent(mac)}&ip=10.1.10.10`);
  assert(freeLoginResponse.status === 200 && (await freeLoginResponse.text()).includes('id="free-connect"'), 'Login WiFiDog dengan prefix /free harus membuka portal one-click.');
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
  const cidrOnlyContext = { gw_address:'10.1.10.1', gw_port:'2060', gw_id:'test-gateway', mac:'02:00:00:00:10:03', ip:'10.1.10.12' };
  const cidrOnlyResponse = await fetch(`${baseUrl}/api/captive/limited`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ context:cidrOnlyContext })
  });
  assert(cidrOnlyResponse.status === 200, 'Request lanjutan tanpa alias VLAN harus memakai routing subnet yang sudah dikenal.');

  const queryBefore = await request(`/free/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}`);
  assert(queryBefore.body === 'Auth: 0\n', 'Client belum boleh aktif sebelum token dikonfirmasi gateway.');
  const wrongMac = await request(`/free/auth/wifidogAuth/auth/?stage=login&gw_id=test-gateway&ip=10.1.10.11&mac=02:00:00:00:10:02&token=${token}`);
  assert(wrongMac.body === 'Auth: 0\n', 'Token harus ditolak untuk MAC berbeda.');
  const login = await request(`/free/auth/wifidogAuth/auth/?stage=login&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}&token=${token}`);
  assert(login.body === 'Auth: 1\n', 'Token valid harus mengaktifkan internet.');
  const freePortalCallback = await fetch(`${baseUrl}/auth/wifidogAuth/portal/?gw_id=test-gateway&mac=${encodeURIComponent(mac)}`, { redirect:'manual' });
  assert(freePortalCallback.status === 302 && new URL(freePortalCallback.headers.get('location')).pathname === '/free', 'Callback global harus mengenali session limited dan kembali ke /free.');
  const queryAfter = await request(`/free/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}`);
  assert(queryAfter.body === 'Auth: 1\n', 'Query session aktif harus diizinkan.');
  const counters = await request(`/free/auth/wifidogAuth/auth/?stage=counters&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}&token=${token}&incoming=100000&outgoing=50000`);
  assert(counters.body === 'Auth: 1\n', 'Counters dengan token aktif harus diizinkan.');
  await new Promise(resolve => setTimeout(resolve, 40));
  const countersUpdated = await request(`/free/auth/wifidogAuth/auth/?stage=counters&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}&token=${token}&incoming=180000&outgoing=90000`);
  assert(countersUpdated.body === 'Auth: 1\n', 'Pembaruan counter WiFiDog harus tetap mempertahankan akses.');
  await new Promise(resolve => setTimeout(resolve, 1900));
  const queryExpired = await request(`/free/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}`);
  assert(queryExpired.body === 'Auth: 0\n', 'Session limited harus ditutup setelah durasinya habis.');
  const logout = await request(`/free/auth/wifidogAuth/auth/?stage=logout&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}&token=${token}`);
  assert(logout.body === 'Auth: 0\n', 'Logout harus mencabut session.');
  const queryLoggedOut = await request(`/free/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.10.10&mac=${mac}`);
  assert(queryLoggedOut.body === 'Auth: 0\n', 'Client logout tidak boleh tetap aktif.');

  const accountMac = '02:00:00:00:20:01';
  const accountContext = { ...context, mac:accountMac, ip:'10.1.30.20', ssid:'VLAN30', wlan_name:'@PERUMNET_WiFi' };
  const accountPortalResponse = await fetch(`${baseUrl}/auth/wifidogAuth/login/?gw_id=test-gateway&gw_address=10.1.10.1&gw_port=2060&mac=${encodeURIComponent(accountMac)}&ip=10.1.30.20&ssid=VLAN30`, { redirect:'manual' });
  assert(accountPortalResponse.status === 200, 'VLAN akun harus tetap membuka portal root dari URL eksternal yang sama.');
  const blockedOneClick = await fetch(`${baseUrl}/api/captive/limited`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ context:accountContext })
  });
  assert(blockedOneClick.status === 403, 'One-click harus ditolak dari VLAN akun agar tidak melewati formulir data.');
  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ fullName:'WiFiDog Test', email:'wifidog-test@example.com', phone:'081234567890', address:'Test', password:'test-password-123', consent:true })
  });
  assert(registerResponse.status === 201, 'Registrasi akun tes harus berhasil.');
  const outbox = (await readFile(join(dataDir, 'email-outbox.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const verificationToken = new URL(outbox.at(-1).link).searchParams.get('verify');
  const verifyResponse = await fetch(`${baseUrl}/api/auth/verify`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ token:verificationToken })
  });
  const verified = await verifyResponse.json();
  assert(verifyResponse.status === 200 && verified.message && !verified.authorization, 'Verifikasi email hanya boleh menampilkan status berhasil tanpa masuk ke hotspot.');

  const forgotResponse = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ email:'wifidog-test@example.com' })
  });
  assert(forgotResponse.status === 200, 'Permintaan lupa kata sandi harus diterima.');
  const resetOutbox = (await readFile(join(dataDir, 'email-outbox.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const resetEmail = resetOutbox.at(-1);
  const resetToken = new URL(resetEmail.link).searchParams.get('reset');
  assert(resetEmail.type === 'reset-password' && resetToken?.length === 64, 'Email reset harus membawa token sekali pakai.');
  const newPassword = 'new-test-password-456';
  const resetResponse = await fetch(`${baseUrl}/api/auth/reset-password`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ token:resetToken, password:newPassword })
  });
  assert(resetResponse.status === 200, 'Kata sandi baru harus dapat disimpan.');
  const reusedReset = await fetch(`${baseUrl}/api/auth/reset-password`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ token:resetToken, password:'another-password-789' })
  });
  assert(reusedReset.status === 400, 'Token reset tidak boleh digunakan dua kali.');
  const oldPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'wifidog-test@example.com', password:'test-password-123', context:accountContext })
  });
  assert(oldPasswordLogin.status === 401, 'Kata sandi lama harus langsung tidak berlaku.');

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'wifidog-test@example.com', password:newPassword, context:accountContext })
  });
  const accountLogin = await loginResponse.json();
  const accountGatewayUrl = new URL(accountLogin.authorization.url);
  const accountToken = accountGatewayUrl.searchParams.get('token');
  assert(loginResponse.status === 200 && accountLogin.authorization.profile === 'high_speed', 'Login akun terverifikasi harus membuat token High Speed.');
  const accountAuth = await request(`/auth/wifidogAuth/auth/?stage=login&gw_id=test-gateway&ip=10.1.30.20&mac=${accountMac}&token=${accountToken}`);
  assert(accountAuth.body === 'Auth: 1\n', 'Gateway harus menerima token login akun terverifikasi.');
  const accountPortalCallback = await fetch(`${baseUrl}/auth/wifidogAuth/portal/?gw_id=test-gateway&mac=${encodeURIComponent(accountMac)}`, { redirect:'manual' });
  assert(accountPortalCallback.status === 302 && new URL(accountPortalCallback.headers.get('location')).pathname === '/', 'Callback global harus mengembalikan session akun ke portal root.');
  const accountCounterWithoutGateway = await request(`/auth/wifidogAuth/auth/?stage=counters&ip=10.1.30.20&mac=${accountMac}&token=${accountToken}&incoming=250000&outgoing=125000`);
  assert(accountCounterWithoutGateway.body === 'Auth: 1\n', 'Callback token tetap harus memakai gateway sesi jika gw_id tidak dikirim ulang.');
  await new Promise(resolve => setTimeout(resolve, 40));
  const accountCounterUpdated = await request(`/auth/wifidogAuth/auth/?stage=counters&ip=10.1.30.20&mac=${accountMac}&token=${accountToken}&incoming=350000&outgoing=175000`);
  assert(accountCounterUpdated.body === 'Auth: 1\n', 'Counter akun harus dapat diperbarui tanpa gw_id ketika token membawa identitas gateway.');
  const monitoringResponse = await fetch(`${baseUrl}/api/admin/monitoring?range=1h`, { headers:{ cookie:adminCookie } });
  const monitoring = await monitoringResponse.json();
  assert(monitoringResponse.status === 200 && monitoring.has_history && monitoring.sample_count >= 4, 'Monitoring harus membaca histori callback counter WiFiDog.');
  assert(monitoring.timeline.length >= 12 && monitoring.summary.total_bytes > 0, 'Monitoring global harus menyediakan timeline dan total penggunaan gabungan.');
  assert(monitoring.ssids.some(item=>item.ssid==='@PERUMNET_WiFi') && monitoring.ssids.some(item=>item.ssid==='@PERUMNET_FreeWiFi'), 'Monitoring harus memisahkan penggunaan setiap SSID.');
  assert(monitoring.users.some(item=>item.detail==='wifidog-test@example.com') && monitoring.users.some(item=>item.access_type==='limited'), 'Monitoring harus menyediakan grafik pengguna akun dan perangkat Free.');
  const portalSettingsUpdate = await fetch(`${baseUrl}/api/admin/settings`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ accountSsid:'@PERUMNET_WiFi',freeSsid:'@PERUMNET_FreeWiFi',welcomeTitle:'Masuk ke internet cepat.',welcomeText:'Gunakan akun terverifikasi.',termsText:'Ketentuan jaringan.',limitedBandwidthKbps:512 })
  });
  assert(portalSettingsUpdate.status === 200, 'Admin harus dapat menyimpan SSID portal akun dan portal free.');
  const updatedPortalSettings = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert(updatedPortalSettings.account_ssid === '@PERUMNET_WiFi' && updatedPortalSettings.free_ssid === '@PERUMNET_FreeWiFi', 'API settings harus mengembalikan dua SSID portal yang tepat.');
  assert(updatedPortalSettings.profiles.account.headline === 'Masuk ke internet cepat.' && updatedPortalSettings.profiles.free.headline === 'Terhubung dalam satu klik.', 'Migrasi konten harus menyediakan profil account dan free yang terpisah.');
  const unauthorizedContentUpdate = await fetch(`${baseUrl}/api/admin/portal-content`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:'{}'
  });
  assert(unauthorizedContentUpdate.status === 401, 'Editor konten portal harus dilindungi session admin.');
  const uploadResponse = await fetch(`${baseUrl}/api/admin/uploads`, {
    method:'POST', headers:{ 'content-type':'application/json',cookie:adminCookie },
    body:JSON.stringify({
      filename:'promo.png',mimeType:'image/png',
      data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    })
  });
  const uploadedImage = await uploadResponse.json();
  assert(uploadResponse.status === 201 && /^\/uploads\/.+\.png$/.test(uploadedImage.url), 'Admin harus dapat mengunggah gambar promo aman.');
  const uploadedImageResponse = await fetch(`${baseUrl}${uploadedImage.url}`);
  assert(uploadedImageResponse.status === 200 && uploadedImageResponse.headers.get('content-type') === 'image/png', 'Gambar promo harus dapat diakses client dengan MIME yang benar.');
  const portalContentUpdate = await fetch(`${baseUrl}/api/admin/portal-content`, {
    method:'POST', headers:{ 'content-type':'application/json',cookie:adminCookie },
    body:JSON.stringify({
      profiles:{
        account:{ ssid:'@PERUMNET_WiFi',eyebrow:'Akses member',headline:'Internet cepat untuk pelanggan.',description:'Login dengan akun PerumNet terverifikasi.',primary_button_label:'Masuk sekarang',announcement_enabled:true,announcement_tone:'info',announcement_title:'Informasi Portal Akun',announcement_text:'Pengumuman ini hanya tampil di jaringan akun.',announcement_link_label:'Baca info',announcement_link_url:'https://perumnet.id' },
        free:{ ssid:'@PERUMNET_FreeWiFi',eyebrow:'Akses gratis',headline:'Gratis dalam satu klik.',description:'Tanpa akun dan tanpa formulir.',primary_button_label:'Hubungkan Gratis',announcement_enabled:true,announcement_tone:'promo',announcement_title:'Promo Portal Free',announcement_text:'Promo ini hanya tampil di jaringan free.',announcement_link_label:'Lihat promo',announcement_link_url:'https://perumnet.id/promo' }
      },
      promotions:[
        { id:'promo-account-001',profile:'account',title:'Promo Member',description:'Khusus pengguna terdaftar.',image_url:uploadedImage.url,link_label:'Lihat',link_url:'https://perumnet.id',is_active:true },
        { id:'promo-free-0001',profile:'free',title:'Promo Gratis',description:'Khusus pengunjung Free WiFi.',image_url:uploadedImage.url,is_active:true },
        { id:'promo-free-draft',profile:'free',title:'Draft Promo',description:'Tidak boleh tampil pada portal client.',is_active:false }
      ],
      termsText:'Ketentuan portal dinamis.',limitedBandwidthKbps:768
    })
  });
  assert(portalContentUpdate.status === 200, 'Admin harus dapat menerbitkan konten dinamis untuk kedua portal.');
  const dynamicPortalSettings = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert(dynamicPortalSettings.profiles.account.headline === 'Internet cepat untuk pelanggan.' && dynamicPortalSettings.profiles.free.headline === 'Gratis dalam satu klik.', 'Judul account dan free harus tersimpan independen.');
  assert(dynamicPortalSettings.profiles.account.promotions[0].title === 'Promo Member' && dynamicPortalSettings.profiles.free.promotions[0].title === 'Promo Gratis', 'Promo harus dikelompokkan sesuai profil SSID.');
  assert(dynamicPortalSettings.promotions.some(item=>item.title==='Draft Promo' && item.is_active===false) && !dynamicPortalSettings.profiles.free.promotions.some(item=>item.title==='Draft Promo'), 'Promo nonaktif harus tetap dapat diedit admin tanpa tampil pada Portal Free.');
  assert(dynamicPortalSettings.profiles.account.announcement_title !== dynamicPortalSettings.profiles.free.announcement_title, 'Pengumuman kedua portal tidak boleh saling menimpa.');
  const duplicateSsidUpdate = await fetch(`${baseUrl}/api/admin/portal-content`, {
    method:'POST', headers:{ 'content-type':'application/json',cookie:adminCookie },
    body:JSON.stringify({ profiles:{ account:{...dynamicPortalSettings.profiles.account,ssid:'SSID-SAMA'},free:{...dynamicPortalSettings.profiles.free,ssid:'SSID-SAMA'} },promotions:[] })
  });
  assert(duplicateSsidUpdate.status === 400, 'Editor harus menolak SSID account dan free yang sama.');
  const secondGatewayContext = { ...context, gw_id:'branch-gateway', ip:'10.2.10.10' };
  const secondGatewayPending = await fetch(`${baseUrl}/auth/wifidogAuth/login/?gw_id=branch-gateway&gw_address=10.2.10.1&gw_port=2060&mac=${encodeURIComponent(mac)}&ip=10.2.10.10&ssid=VLAN10`, { redirect:'manual' });
  assert(secondGatewayPending.status === 302 && new URL(secondGatewayPending.headers.get('location')).pathname === '/gateway-review', 'Gateway kedua juga harus menunggu persetujuan independen.');
  const mapSecondGatewayFree = await fetch(`${baseUrl}/api/admin/portal-networks`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ gatewayId:'branch-gateway',networkAlias:'VLAN10',portalMode:'free' })
  });
  assert(mapSecondGatewayFree.status === 200, 'Routing portal harus dapat diatur berbeda pada gateway kedua.');
  const secondGatewayBeforeApproval = await fetch(`${baseUrl}/api/captive/limited`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ context:secondGatewayContext })
  });
  assert(secondGatewayBeforeApproval.status === 403, 'Routing Free tidak boleh melewati verifikasi gateway.');
  const approveSecondGateway = await fetch(`${baseUrl}/api/admin/gateways/approval`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ gatewayId:'branch-gateway' })
  });
  assert(approveSecondGateway.status === 200, 'Gateway kedua harus dapat disetujui secara terpisah.');
  const secondGatewayResponse = await fetch(`${baseUrl}/api/captive/limited`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ context:secondGatewayContext })
  });
  assert(secondGatewayResponse.status === 200, 'MAC yang sama harus dapat dicatat pada gateway kedua.');
  const networkResponse = await fetch(`${baseUrl}/api/admin/network`, { headers:{ cookie:adminCookie } });
  const network = await networkResponse.json();
  assert(networkResponse.status === 200 && network.gateways.some(gateway=>gateway.id==='test-gateway') && network.gateways.some(gateway=>gateway.id==='branch-gateway'), 'Gateway harus ditemukan otomatis dari gw_id Ruijie.');
  assert(network.portalNetworks.some(route=>route.gateway_id==='test-gateway' && route.network_alias==='VLAN10' && route.portal_mode==='free'), 'API network harus mengembalikan routing portal per gateway.');
  assert(network.portalNetworks.filter(route=>route.gateway_id==='test-gateway' && route.client_cidr==='10.1.10.0/24').length===1, 'Interface IP dan VLAN dengan subnet sama tidak boleh muncul sebagai dua routing.');
  assert(network.portalNetworks.some(route=>route.gateway_id==='test-gateway' && route.network_description==='Free WiFi Pengunjung'), 'Deskripsi VLAN dari admin harus tersimpan per gateway.');
  assert(network.portalNetworks.every(route=>!route.network_alias.includes('/')), 'API admin hanya boleh menampilkan alias VLAN, bukan subnet sebagai nama interface.');
  const projectResponse = await fetch(`${baseUrl}/api/admin/projects`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:adminCookie }, body:JSON.stringify({ name:'Cabang Tes',location:'Denpasar' })
  });
  const projectData = await projectResponse.json();
  assert(projectResponse.status === 201 && projectData.project.id, 'Admin harus dapat membuat project baru.');
  const gatewayUpdate = await fetch(`${baseUrl}/api/admin/gateways`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ gatewayId:'branch-gateway',projectId:projectData.project.id,name:'Gateway Cabang',location:'Renon',model:'RG-EG105G-P-V3' })
  });
  assert(gatewayUpdate.status === 200, 'Admin harus dapat mengatur identitas dan project gateway.');
  const filteredClientsResponse = await fetch(`${baseUrl}/api/admin/clients?gatewayId=branch-gateway`, { headers:{ cookie:adminCookie } });
  const filteredClients = await filteredClientsResponse.json();
  assert(filteredClients.clients.length === 1 && filteredClients.clients[0].project_name === 'Cabang Tes' && filteredClients.clients[0].gateway_name === 'Gateway Cabang', 'Filter gateway harus mengembalikan data dan identitas gateway yang tepat.');
  const projectClientsResponse = await fetch(`${baseUrl}/api/admin/clients?projectId=${projectData.project.id}`, { headers:{ cookie:adminCookie } });
  assert((await projectClientsResponse.json()).stats.total === 1, 'Statistik project harus mengikuti scope yang dipilih.');
  const notificationsResponse = await fetch(`${baseUrl}/api/admin/notifications?gatewayId=test-gateway`, { headers:{ cookie:adminCookie } });
  const notificationData = await notificationsResponse.json();
  assert(notificationsResponse.status === 200, 'Admin harus dapat membaca notifikasi pelanggan.');
  assert(notificationData.notifications.some(item=>item.type==='client_login' && item.client_mac===accountMac), 'Login pelanggan harus membuat notifikasi terhubung.');
  assert(notificationData.notifications.some(item=>item.type==='client_offline' && item.client_mac===mac), 'Session berakhir harus membuat notifikasi offline.');
  assert(notificationData.notifications.every(item=>item.gateway_id==='test-gateway' && item.gateway_name), 'Notifikasi harus membawa scope dan identitas gateway.');
  assert(notificationData.unreadCount >= 2, 'Notifikasi baru harus ditandai belum dibaca.');
  const readNotifications = await fetch(`${baseUrl}/api/admin/notifications/read`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:adminCookie }, body:'{}'
  });
  assert(readNotifications.status === 200, 'Admin harus dapat menandai semua notifikasi sebagai dibaca.');
  const notificationsAfterRead = await fetch(`${baseUrl}/api/admin/notifications`, { headers:{ cookie:adminCookie } });
  assert((await notificationsAfterRead.json()).unreadCount === 0, 'Badge notifikasi harus kosong setelah ditandai dibaca.');
  const clientsBeforeDelete = await fetch(`${baseUrl}/api/admin/clients`, { headers:{ cookie:adminCookie } });
  const clientList = await clientsBeforeDelete.json();
  assert(clientList.pagination.limit === 10 && clientList.pagination.page === 1 && clientList.pagination.total >= 3, 'Daftar perangkat harus memakai pagination server dengan default 10 baris.');
  assert(clientList.categories.account === 1 && clientList.categories.free >= 2, 'Dashboard harus memisahkan pengguna terdaftar dan Free/Limited.');
  assert(clientList.clients.filter(client=>client.mac_address===mac).length === 2, 'Satu MAC pada dua gateway tidak boleh saling menimpa.');
  assert(clientList.clients.some(client=>client.gateway_id==='test-gateway' && client.mac_address===mac && client.ssid==='@PERUMNET_FreeWiFi'), 'Alias VLAN client limited harus diganti SSID fallback portal free.');
  assert(clientList.clients.some(client=>client.mac_address===accountMac && client.ssid==='@PERUMNET_WiFi'), 'Parameter WLAN asli Ruijie harus diprioritaskan sebagai SSID portal akun.');
  const accountTelemetry = clientList.clients.find(client=>client.mac_address===accountMac);
  assert(accountTelemetry.total_usage_bytes === 525000 && accountTelemetry.incoming_bps > 0 && accountTelemetry.outgoing_bps > 0 && accountTelemetry.duration_seconds >= 0, 'Counter WiFiDog harus menjadi total usage, bandwidth real-time, dan durasi sesi akun.');
  const freeCategoryResponse = await fetch(`${baseUrl}/api/admin/clients?category=free&limit=100`, { headers:{ cookie:adminCookie } });
  const freeCategory = await freeCategoryResponse.json();
  assert(freeCategory.pagination.limit === 100 && freeCategory.clients.every(client=>client.category==='free' && !client.email), 'Filter Free harus hanya berisi perangkat one-click dan mendukung 100 baris.');
  const accountCategoryResponse = await fetch(`${baseUrl}/api/admin/clients?category=account`, { headers:{ cookie:adminCookie } });
  const accountCategory = await accountCategoryResponse.json();
  assert(accountCategory.clients.length === 1 && accountCategory.clients[0].email === 'wifidog-test@example.com', 'Filter pengguna terdaftar harus hanya berisi akun yang mengisi data.');
  const unauthorizedUsersResponse = await fetch(`${baseUrl}/api/admin/users`);
  assert(unauthorizedUsersResponse.status === 401, 'Database pengguna harus dilindungi session admin.');
  const adminUsersResponse = await fetch(`${baseUrl}/api/admin/users`, { headers:{ cookie:adminCookie } });
  const adminUsers = await adminUsersResponse.json();
  const registeredUser = adminUsers.users.find(user=>user.email==='wifidog-test@example.com');
  assert(adminUsersResponse.status === 200 && registeredUser && adminUsers.pagination.limit === 10, 'Admin harus dapat membaca database pengguna terdaftar dengan pagination.');
  assert(registeredUser.device_count === 1 && registeredUser.gateway_name === 'Gateway test-gateway', 'Halaman CRUD harus menyertakan ringkasan perangkat dan gateway terbaru.');
  const invalidProfileUpdate = await fetch(`${baseUrl}/api/admin/users`, {
    method:'PATCH', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ userId:registeredUser.id,fullName:'WiFiDog Test',email:'bukan-email',phone:'081234567890',address:'Test' })
  });
  assert(invalidProfileUpdate.status === 400, 'Admin tidak boleh menyimpan format email yang tidak valid.');
  const correctedEmail = 'wifidog.corrected@example.com';
  const updateProfileResponse = await fetch(`${baseUrl}/api/admin/users`, {
    method:'PATCH', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ userId:registeredUser.id,fullName:'WiFiDog Corrected',email:correctedEmail,phone:'0812 3456 7890',address:'Denpasar, Bali' })
  });
  const updatedProfile = await updateProfileResponse.json();
  assert(updateProfileResponse.status === 200 && updatedProfile.user.email === correctedEmail && updatedProfile.user.full_name === 'WiFiDog Corrected', 'Admin harus dapat memperbaiki data diri dan email login.');
  const correctedEmailLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:correctedEmail,password:newPassword,context:accountContext })
  });
  assert(correctedEmailLogin.status === 200, 'Email yang diperbaiki admin harus langsung menjadi credential login baru.');
  const createProfileResponse = await fetch(`${baseUrl}/api/admin/users`, {
    method:'POST', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ fullName:'Pengguna Buatan Admin',email:'admin-created@example.com',phone:'081299999999',address:'Badung',password:'admin-created-password' })
  });
  const createdProfile = await createProfileResponse.json();
  assert(createProfileResponse.status === 201 && createdProfile.user.is_verified === 1, 'Admin harus dapat menambahkan akun terverifikasi dari halaman CRUD.');
  const deleteProfileResponse = await fetch(`${baseUrl}/api/admin/users`, {
    method:'DELETE', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ userId:createdProfile.user.id })
  });
  assert(deleteProfileResponse.status === 200, 'Admin harus dapat menghapus profil yang tidak memiliki perangkat.');
  const deletedProfileSearch = await fetch(`${baseUrl}/api/admin/users?search=admin-created%40example.com`, { headers:{ cookie:adminCookie } });
  assert((await deletedProfileSearch.json()).pagination.total === 0, 'Profil yang dihapus tidak boleh kembali dalam database pengguna.');
  const exportResponse = await fetch(`${baseUrl}/api/admin/export.csv`, { headers:{ cookie:adminCookie } });
  const exportedCsv = await exportResponse.text();
  assert(exportResponse.status === 200 && exportResponse.headers.get('content-type').includes('text/csv'), 'Admin harus dapat mengekspor CSV pengguna terdaftar.');
  assert(exportedCsv.includes(correctedEmail) && exportedCsv.includes('WiFiDog Corrected') && exportedCsv.includes(accountMac) && !exportedCsv.includes(mac) && !exportedCsv.includes('wifidog-test@example.com'), 'CSV harus langsung memakai hasil koreksi admin dan tidak memasukkan perangkat Free/Limited.');
  const deleteResponse = await fetch(`${baseUrl}/api/admin/clients`, {
    method:'DELETE', headers:{ 'content-type':'application/json', cookie:adminCookie }, body:JSON.stringify({ gatewayId:'test-gateway',macAddress:accountMac })
  });
  const deleted = await deleteResponse.json();
  assert(deleteResponse.status === 200 && deleted.deletedAccount && deleted.gatewayAuthorizationRevoked, 'Hapus admin harus menghapus akun dan mencabut otorisasi gateway.');
  const monitoringAfterDelete = await (await fetch(`${baseUrl}/api/admin/monitoring?range=1h`, { headers:{ cookie:adminCookie } })).json();
  assert(!monitoringAfterDelete.users.some(item=>item.detail===correctedEmail), 'Hapus akun harus ikut menghapus histori monitoring pengguna tersebut.');
  const revokedCounter = await request(`/auth/wifidogAuth/auth/?stage=counters&gw_id=test-gateway&ip=10.1.30.20&mac=${accountMac}&token=${accountToken}`);
  assert(revokedCounter.body === 'Auth: 0\n', 'Token lama harus ditolak setelah data dihapus admin.');
  const revokedQuery = await request(`/auth/wifidogAuth/auth/?stage=query&gw_id=test-gateway&ip=10.1.30.20&mac=${accountMac}`);
  assert(revokedQuery.body === 'Auth: 0\n', 'MAC lama harus tidak terotorisasi setelah data dihapus admin.');
  const clientsAfterDelete = await fetch(`${baseUrl}/api/admin/clients`, { headers:{ cookie:adminCookie } });
  const deletedClientList = await clientsAfterDelete.json();
  assert(!deletedClientList.clients.some(client=>client.mac_address===accountMac), 'Perangkat yang dicabut tidak boleh muncul kembali hanya karena polling gateway.');
  const removedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:correctedEmail, password:newPassword, context:accountContext })
  });
  assert(removedLogin.status === 401, 'Akun yang dihapus tidak boleh dapat login kembali.');
  const deleteGatewayResponse = await fetch(`${baseUrl}/api/admin/gateways`, {
    method:'DELETE', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ gatewayId:'branch-gateway' })
  });
  const deletedGateway = await deleteGatewayResponse.json();
  assert(deleteGatewayResponse.status === 200 && deletedGateway.blocked, 'Hapus gateway harus membersihkan data dan memblokir ID gateway.');
  const blockedNetwork = await (await fetch(`${baseUrl}/api/admin/network`, { headers:{ cookie:adminCookie } })).json();
  assert(!blockedNetwork.gateways.some(gateway=>gateway.id==='branch-gateway') && blockedNetwork.blockedGateways.some(gateway=>gateway.gateway_id==='branch-gateway'), 'Gateway terhapus harus hilang dari daftar aktif dan masuk daftar blokir.');
  const blockedGatewayRetry = await fetch(`${baseUrl}/auth/wifidogAuth/login/?gw_id=branch-gateway&gw_address=10.2.10.1&gw_port=2060&mac=${encodeURIComponent(mac)}&ip=10.2.10.10&ssid=VLAN10`, { redirect:'manual' });
  assert(blockedGatewayRetry.status === 302 && new URL(blockedGatewayRetry.headers.get('location')).searchParams.get('status') === 'blocked', 'Request berulang dari gateway terhapus tidak boleh mendaftarkannya kembali.');
  const unblockGateway = await fetch(`${baseUrl}/api/admin/gateway-blocks`, {
    method:'DELETE', headers:{ 'content-type':'application/json', cookie:adminCookie },
    body:JSON.stringify({ gatewayId:'branch-gateway' })
  });
  assert(unblockGateway.status === 200, 'Admin harus dapat membuka blokir jika gateway ternyata valid.');
  await fetch(`${baseUrl}/auth/wifidogAuth/login/?gw_id=branch-gateway&gw_address=10.2.10.1&gw_port=2060&mac=${encodeURIComponent(mac)}&ip=10.2.10.10&ssid=VLAN10`, { redirect:'manual' });
  const rediscoveredGateway = await (await fetch(`${baseUrl}/api/admin/network`, { headers:{ cookie:adminCookie } })).json();
  assert(rediscoveredGateway.gateways.some(gateway=>gateway.id==='branch-gateway' && gateway.approval_status==='pending'), 'Gateway yang dibuka blokirnya harus kembali sebagai pending, bukan langsung dipercaya.');
  console.log('WiFiDog token handshake: PASS');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  await rm(dataDir, { recursive:true, force:true });
}
