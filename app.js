const $ = (selector) => document.querySelector(selector);
const screens = { portal: $('#portal-screen'), success: $('#success-screen'), limited: $('#limited-screen'), verify: $('#verify-screen'), userLogin: $('#user-login-screen'), login: $('#login-screen'), dashboard: $('#dashboard-screen') };
// Preserve every query parameter forwarded by the gateway. WiFiDog uses
// gw_address, gw_port, gw_id, mac, url, and token.
const captiveContext = Object.fromEntries(new URLSearchParams(location.search).entries());
const isAdminView = location.pathname === '/admin' || location.pathname === '/admin/';
if (isAdminView) { document.body.classList.add('admin-view'); $('#portal-screen').style.display = 'none'; }
let verificationToken = new URLSearchParams(location.search).get('verify');
let pendingVerificationEmail = '';
const destinationUrl = 'https://perumnet.id';
let redirectTimer;
async function api(path, payload, method) { const requestMethod = method || (payload ? 'POST' : 'GET'); const hasBody = payload !== undefined && requestMethod !== 'GET'; const response = await fetch(path, { method:requestMethod, credentials:'same-origin', headers:hasBody ? { 'content-type':'application/json' } : undefined, body:hasBody ? JSON.stringify(payload) : undefined }); const raw = await response.text(); let result; try { result = JSON.parse(raw); } catch { throw new Error(response.ok ? 'Respons server portal tidak valid.' : `Server portal sedang tidak tersedia (${response.status}). Coba kembali beberapa saat lagi.`); } if (!response.ok) throw new Error(result.error || 'Permintaan gagal.'); return result; }
function handleAuthorization(result, fallback) { if (result?.authorization?.mode === 'redirect') { location.assign(result.authorization.url); return; } fallback(); }
let portalSettings = {};
const networkAliasPattern = /^(?:vlan|network|lan)[\s_-]*\d+$/i;
function ssidFromGateway(context={}) { const candidates=[context.wlan_name,context.ssid_name,context.essid,context.wifi_name,context.ap_ssid,context.ssid,context.SSID]; return candidates.map(value=>String(value||'').trim()).find(value=>value && !networkAliasPattern.test(value)) || ''; }
const gatewaySsid = ssidFromGateway(captiveContext);
function setWifiName(name) { document.querySelectorAll('[data-wifi-name]').forEach(element => { element.textContent = name; }); }
async function loadPortalSettings() {
  try {
    portalSettings = await api('/api/settings');
    const wifiName = gatewaySsid || portalSettings.default_ssid || 'PerumNet Guest';
    setWifiName(wifiName);
    if ($('#setting-wifi')) $('#setting-wifi').value = portalSettings.default_ssid || 'PerumNet Guest';
    if ($('#setting-title')) $('#setting-title').value = portalSettings.welcome_title || $('#setting-title').value;
    if ($('#setting-copy')) $('#setting-copy').value = portalSettings.welcome_text || $('#setting-copy').value;
    if ($('#setting-bandwidth')) $('#setting-bandwidth').value = portalSettings.limited_bandwidth_kbps || 512;
    if ($('#setting-terms')) $('#setting-terms').value = portalSettings.terms_text || $('#setting-terms').value;
    if ($('#portal-title')) $('#portal-title').textContent = portalSettings.welcome_title || $('#portal-title').textContent;
    if ($('#portal-copy')) $('#portal-copy').textContent = portalSettings.welcome_text || $('#portal-copy').textContent;
    if ($('#choice-bandwidth')) $('#choice-bandwidth').textContent = `${portalSettings.limited_bandwidth_kbps || 512} Kbps`;
    if ($('#choice-duration')) $('#choice-duration').textContent = `${portalSettings.limited_session_hours || 2} jam`;
  } catch { setWifiName(gatewaySsid || 'PerumNet Guest'); }
}
const leads = [];
function show(screen) { Object.values(screens).forEach(el => el.classList.remove('active')); screens[screen].classList.add('active'); document.body.classList.toggle('modal-open', screens[screen].classList.contains('portal-modal')); if (!screens[screen].classList.contains('portal-modal')) window.scrollTo(0,0); }
function showAccessChoice() { $('#portal-screen').classList.remove('show-form'); show('portal'); }
function showLeadForm() { $('#portal-screen').classList.add('show-form'); show('portal'); }
function showUserLogin(message='') { $('#user-login-error').textContent=message; show('userLogin'); setTimeout(()=>$('#user-login-form input')?.focus(),220); }
function startDestinationRedirect() { clearInterval(redirectTimer); let seconds=3; $('#redirect-countdown').textContent=seconds; redirectTimer=setInterval(()=>{ seconds-=1; $('#redirect-countdown').textContent=Math.max(seconds,0); if (seconds <= 0) { clearInterval(redirectTimer); location.assign(destinationUrl); } },1000); }
function connectToWifi(withLead) { $('#success-message').textContent = withLead ? 'Akun Anda sudah aktif dan akses internet berhasil tersambung.' : 'Akses internet Anda sudah aktif. Selamat menggunakan WiFi gratis PerumNet.'; show('success'); startDestinationRedirect(); }
function connectLimited() { show('limited'); }
if (new URLSearchParams(location.search).get('connected') === '1') connectToWifi(false);
const escapeHtml = value => String(value ?? '—').replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
const formatTime = value => value ? new Date(value).toLocaleString('id-ID', { dateStyle:'medium', timeStyle:'short' }) : '—';
async function loadAdminLeads() {
  const { clients, stats } = await api('/api/admin/clients');
  leads.splice(0, leads.length, ...clients.map(row => ({
    name:row.full_name || 'Perangkat belum login', email:row.email || row.mac_address,
    ip:row.client_ip || '—', ssid:row.ssid || '—', mac:row.mac_address,
    time:formatTime(row.last_seen_at), initials:row.full_name ? row.full_name.split(' ').slice(0,2).map(part => part[0]).join('') : 'Wi',
    phone:row.phone_number || '—', address:row.address || '—', registered:!!row.email,
    type:row.access_type === 'high_speed' ? 'high' : row.access_type === 'limited' ? 'limited' : 'pending', verified:!!row.is_verified,
    status:row.auth_status
  })));
  $('#total-leads').textContent = stats.total;
  $('#today-leads').textContent = stats.today;
  $('#authorized-leads').textContent = stats.authorized;
  renderLeads();
}
function renderLeads(data=leads) {
  const access = { high:'High Speed', limited:'Limited', pending:'Menunggu login' };
  $('#lead-rows').innerHTML = data.map(l => `<tr><td data-label="Pengunjung"><div class="user-cell"><span class="avatar">${escapeHtml(l.initials)}</span><div><b>${escapeHtml(l.name)}</b><span>${escapeHtml(l.email)}</span>${l.type === 'high' && l.verified ? '<em class="verified-status">✓ Email terverifikasi</em>' : ''}</div></div></td><td data-label="Nomor HP">${escapeHtml(l.phone)}</td><td data-label="Alamat" class="address-cell">${escapeHtml(l.address)}</td><td data-label="IP Klien">${escapeHtml(l.ip)}</td><td data-label="Status"><span class="access-badge ${l.type}">${access[l.type]}</span></td><td data-label="SSID">${escapeHtml(l.ssid)}</td><td data-label="Terakhir terlihat">${escapeHtml(l.time)}</td><td data-label="MAC" class="device-cell">${escapeHtml(l.mac)}</td><td data-label="Aksi" class="action-cell"><button class="delete-client" type="button" data-mac="${escapeHtml(l.mac)}" aria-label="Hapus ${escapeHtml(l.name)}">Hapus data</button></td></tr>`).join('') || '<tr class="empty-row"><td colspan="9" class="empty-state">Belum ada perangkat yang dilaporkan gateway.</td></tr>';
  $('#result-count').textContent = data.length === leads.length ? `Menampilkan ${data.length} perangkat` : `Menampilkan ${data.length} hasil pencarian`;
}
renderLeads();
loadPortalSettings();
async function restoreAdminSession() { if (!isAdminView) return; try { const session = await api('/api/admin/session'); $('#admin-email').textContent = session.email; await loadAdminLeads(); show('dashboard'); } catch { show('login'); } }
restoreAdminSession();
if (verificationToken) { api('/api/auth/verify', { token:verificationToken, context:captiveContext }).then(result => { if (captiveContext.mac || captiveContext.client_mac) handleAuthorization(result, () => connectToWifi(true)); else showUserLogin('Email berhasil diverifikasi. Silakan masuk untuk menyambungkan internet.'); }).catch(error => showUserLogin(error.message)); }
$('#lead-form').addEventListener('submit', async e => { e.preventDefault(); const data = new FormData(e.currentTarget); if (![...data.values()].every(Boolean)) { $('#form-error').textContent = 'Lengkapi semua data, kata sandi, dan setujui syarat terlebih dahulu.'; return; } const button=e.currentTarget.querySelector('button'); button.disabled=true; try { const result = await api('/api/auth/register', { fullName:data.get('name'), email:data.get('email'), phone:data.get('phone'), address:data.get('address'), password:data.get('password'), consent:data.get('consent'), context:captiveContext }); $('#form-error').textContent=''; pendingVerificationEmail=result.email; $('#verification-email').textContent = result.email; show('verify'); } catch (error) { $('#form-error').textContent = error.message; } finally { button.disabled=false; } });
$('#choose-high-speed').onclick = showLeadForm; $('#back-to-access-choice').onclick = showAccessChoice; $('#choose-limited').onclick = async e => { e.currentTarget.disabled=true; try { const result = await api('/api/captive/limited', { context:captiveContext }); $('#limited-bandwidth').textContent = `${result.bandwidthKbps} Kbps`; $('#limited-duration').textContent = `${result.sessionHours || 2} jam`; handleAuthorization(result, connectLimited); } catch (error) { alert(error.message); e.currentTarget.disabled=false; } };
$('#quick-login-form').addEventListener('submit', async e => { e.preventDefault(); const fields=e.currentTarget.querySelectorAll('input'), button=e.currentTarget.querySelector('button'), feedback=$('#quick-login-error'); button.disabled=true; feedback.textContent=''; try { const result=await api('/api/auth/login',{ email:fields[0].value,password:fields[1].value,context:captiveContext }); handleAuthorization(result,()=>connectToWifi(true)); } catch(error) { feedback.textContent=error.message; button.disabled=false; } });
$('#open-user-login').onclick = () => showUserLogin(); $('#back-from-user-login').onclick = showAccessChoice; $('#close-user-login').onclick = showAccessChoice;
$('#user-login-form').addEventListener('submit', async e => { e.preventDefault(); const fields=e.currentTarget.querySelectorAll('input'), button=e.currentTarget.querySelector('button'), feedback=$('#user-login-error'); button.disabled=true; feedback.textContent=''; try { const result=await api('/api/auth/login',{ email:fields[0].value,password:fields[1].value,context:captiveContext }); handleAuthorization(result,()=>connectToWifi(true)); } catch(error) { feedback.textContent=error.message; button.disabled=false; } });
$('#resend-verification').onclick = async e => { const feedback=$('#verification-status'); if (!pendingVerificationEmail) { feedback.textContent='Kembali ke formulir lalu masukkan ulang data pendaftaran.'; return; } e.currentTarget.disabled=true; feedback.textContent='Mengirim ulang email…'; try { const result=await api('/api/auth/resend',{ email:pendingVerificationEmail }); feedback.textContent=result.message; } catch(error) { feedback.textContent=error.message; } finally { e.currentTarget.disabled=false; } }; $('#back-from-verify').onclick = showAccessChoice;
$('#browse-button').onclick = () => { clearInterval(redirectTimer); location.assign(destinationUrl); };
$('#upgrade-access').onclick = showLeadForm; $('#continue-limited').onclick = () => location.assign(destinationUrl);
$('#admin-trigger').onclick = e => { e.preventDefault(); location.assign('/admin'); }; $('#access-admin-trigger').onclick = e => { e.preventDefault(); location.assign('/admin'); }; $('#back-portal').onclick = () => location.assign('/');
$('#login-form').addEventListener('submit', async e => { e.preventDefault(); const fields = e.currentTarget.querySelectorAll('input'); try { await api('/api/admin/login', { email:fields[0].value, password:fields[1].value }); location.replace('/admin'); } catch (error) { alert(error.message); } }); $('#logout').onclick = async () => { try { await api('/api/admin/logout', {}); } finally { location.assign('/'); } };
function setSidebar(open) { document.body.classList.toggle('sidebar-open',open); $('#sidebar-toggle').setAttribute('aria-expanded',String(open)); }
$('#sidebar-toggle').onclick = () => setSidebar(!document.body.classList.contains('sidebar-open')); $('#sidebar-backdrop').onclick = () => setSidebar(false);
document.querySelectorAll('.nav-item').forEach(item => item.onclick = () => { document.querySelectorAll('.nav-item').forEach(i=>i.classList.remove('active')); item.classList.add('active'); const tab=item.dataset.tab; document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active')); $(`#${tab}-tab`).classList.add('active'); $('#dash-title').textContent=tab==='leads'?'Data Pengunjung':'Pengaturan Portal'; setSidebar(false); });
document.addEventListener('keydown',event=>{ if(event.key==='Escape'){ if(document.body.classList.contains('sidebar-open')) setSidebar(false); else if(screens.userLogin.classList.contains('active')) showAccessChoice(); } });
$('#search-input').addEventListener('input', e => { const q=e.target.value.toLowerCase(); renderLeads(leads.filter(l => `${l.name} ${l.email} ${l.phone} ${l.address} ${l.mac} ${l.ip} ${l.ssid}`.toLowerCase().includes(q))); });
$('#lead-rows').addEventListener('click', async event => { const button=event.target.closest('.delete-client'); if (!button) return; const lead=leads.find(item=>item.mac===button.dataset.mac); if (!lead) return; const detail=lead.registered ? 'Akun, profil, seluruh perangkat terkait, dan riwayat akses akan dihapus.' : 'Perangkat dan seluruh riwayat akses one-click akan dihapus.'; if (!confirm(`Hapus data ${lead.name}?\n\n${detail}\nOtorisasi WiFiDog juga akan dicabut.`)) return; button.disabled=true; try { const result=await api('/api/admin/clients',{ macAddress:lead.mac },'DELETE'); await loadAdminLeads(); alert(result.deletedAccount ? 'Akun berhasil dihapus dan akses Ruijie dicabut.' : 'Data perangkat berhasil dihapus dan akses Ruijie dicabut.'); } catch(error) { alert(error.message); button.disabled=false; } });
$('#export-csv').onclick = () => { const csvCell = value => `"${String(value ?? '').replaceAll('"','""')}"`; const csv=['Nama,Email / Identitas,Nomor HP,Alamat,MAC,IP Klien,SSID,Tipe Akses,Status,Waktu Terakhir',...leads.map(l=>[l.name,l.email,l.phone,l.address,l.mac,l.ip,l.ssid,l.type === 'high' ? 'High Speed' : l.type === 'limited' ? 'Limited' : 'Menunggu login',l.status,l.time].map(csvCell).join(','))].join('\n'); const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='data-perangkat-perumnet.csv'; a.click(); URL.revokeObjectURL(a.href); };
$('#settings-form').addEventListener('submit', async e => { e.preventDefault(); const wifi=$('#setting-wifi').value.trim() || 'PerumNet Guest', title=$('#setting-title').value || 'Terhubung dalam hitungan detik.', copy=$('#setting-copy').value, terms=$('#setting-terms').value, bandwidth=Number($('#setting-bandwidth').value || 512); const b=e.currentTarget.querySelector('button'); const old=b.innerHTML; try { await api('/api/admin/settings', { defaultSsid:wifi, welcomeTitle:title, welcomeText:copy, termsText:terms, limitedBandwidthKbps:bandwidth }); portalSettings = { ...portalSettings, default_ssid:wifi, welcome_title:title, welcome_text:copy, terms_text:terms, limited_bandwidth_kbps:bandwidth }; setWifiName(gatewaySsid || wifi); $('#portal-title').textContent=title; $('#portal-copy').textContent=copy; $('#choice-bandwidth').textContent=`${bandwidth} Kbps`; $('#preview-title').textContent=title; $('#preview-copy').textContent=copy; b.innerHTML='Tersimpan ✓'; } catch (error) { alert(error.message); } setTimeout(()=>b.innerHTML=old,1600); });
