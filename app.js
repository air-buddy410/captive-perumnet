const $ = (selector) => document.querySelector(selector);
const screens = { portal: $('#portal-screen'), success: $('#success-screen'), limited: $('#limited-screen'), verify: $('#verify-screen'), userLogin: $('#user-login-screen'), login: $('#login-screen'), dashboard: $('#dashboard-screen') };
// Preserve every query parameter forwarded by the gateway. WiFiDog uses
// gw_address, gw_port, gw_id, mac, url, and token.
const captiveContext = Object.fromEntries(new URLSearchParams(location.search).entries());
const isAdminView = location.pathname === '/admin' || location.pathname === '/admin/';
if (isAdminView) { document.body.classList.add('admin-view'); $('#portal-screen').style.display = 'none'; }
let verificationToken = new URLSearchParams(location.search).get('verify');
async function api(path, payload) { const response = await fetch(path, { method: payload ? 'POST' : 'GET', credentials:'same-origin', headers: payload ? { 'content-type': 'application/json' } : undefined, body: payload ? JSON.stringify(payload) : undefined }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Permintaan gagal.'); return result; }
function handleAuthorization(result, fallback) { if (result?.authorization?.mode === 'redirect') { location.assign(result.authorization.url); return; } fallback(); }
let portalSettings = {};
const gatewaySsid = String(captiveContext.ssid || captiveContext.SSID || '').trim();
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
  } catch { setWifiName(gatewaySsid || 'PerumNet Guest'); }
}
const leads = [];
function show(screen) { Object.values(screens).forEach(el => el.classList.remove('active')); screens[screen].classList.add('active'); window.scrollTo(0,0); }
function showAccessChoice() { $('#portal-screen').classList.remove('show-form'); show('portal'); }
function showLeadForm() { $('#portal-screen').classList.add('show-form'); show('portal'); }
function showUserLogin() { show('userLogin'); }
function connectToWifi(withLead) { $('#success-message').textContent = withLead ? 'Data Anda telah tersimpan dan akses internet sudah aktif. Selamat berselancar.' : 'Akses internet Anda sudah aktif. Selamat berselancar dengan WiFi gratis PerumNet.'; show('success'); }
function connectLimited() { show('limited'); }
const escapeHtml = value => String(value ?? '—').replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
const formatTime = value => value ? new Date(value).toLocaleString('id-ID', { dateStyle:'medium', timeStyle:'short' }) : '—';
async function loadAdminLeads() {
  const { clients, stats } = await api('/api/admin/clients');
  leads.splice(0, leads.length, ...clients.map(row => ({
    name:row.full_name || 'Perangkat belum login', email:row.email || row.mac_address,
    ip:row.client_ip || '—', ssid:row.ssid || '—', mac:row.mac_address,
    time:formatTime(row.last_seen_at), initials:row.full_name ? row.full_name.split(' ').slice(0,2).map(part => part[0]).join('') : 'Wi',
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
  $('#lead-rows').innerHTML = data.map(l => `<tr><td><div class="user-cell"><span class="avatar">${escapeHtml(l.initials)}</span><div><b>${escapeHtml(l.name)}</b><span>${escapeHtml(l.email)}</span>${l.type === 'high' && l.verified ? '<em class="verified-status">✓ Email terverifikasi</em>' : ''}</div></div></td><td>${escapeHtml(l.ip)}</td><td><span class="access-badge ${l.type}">${access[l.type]}</span></td><td>${escapeHtml(l.ssid)}</td><td>${escapeHtml(l.time)}</td><td class="more">${escapeHtml(l.mac)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-state">Belum ada perangkat yang dilaporkan gateway.</td></tr>';
  $('#result-count').textContent = data.length === leads.length ? `Menampilkan ${data.length} perangkat` : `Menampilkan ${data.length} hasil pencarian`;
}
renderLeads();
loadPortalSettings();
async function restoreAdminSession() { if (!isAdminView) return; try { const session = await api('/api/admin/session'); $('#admin-email').textContent = session.email; await loadAdminLeads(); show('dashboard'); } catch { show('login'); } }
restoreAdminSession();
if (verificationToken) { api('/api/auth/verify', { token:verificationToken, context:captiveContext }).then(result => handleAuthorization(result, () => connectToWifi(true))).catch(error => alert(error.message)); }
$('#lead-form').addEventListener('submit', async e => { e.preventDefault(); const data = new FormData(e.currentTarget); if (![...data.values()].every(Boolean)) { $('#form-error').textContent = 'Lengkapi semua data, kata sandi, dan setujui syarat terlebih dahulu.'; return; } try { const result = await api('/api/auth/register', { fullName:data.get('name'), email:data.get('email'), phone:data.get('phone'), address:data.get('address'), password:data.get('password'), consent:data.get('consent'), context:captiveContext }); $('#form-error').textContent=''; $('#verification-email').textContent = result.email; verificationToken = result.verificationUrl ? new URL(result.verificationUrl).searchParams.get('verify') : null; show('verify'); } catch (error) { $('#form-error').textContent = error.message; } });
$('#choose-high-speed').onclick = showLeadForm; $('#back-to-access-choice').onclick = showAccessChoice; $('#choose-limited').onclick = async () => { try { const result = await api('/api/captive/limited', { context:captiveContext }); $('#limited-bandwidth').textContent = `${result.bandwidthKbps} Kbps`; handleAuthorization(result, connectLimited); } catch (error) { alert(error.message); } };
$('#quick-login-form').addEventListener('submit', async e => { e.preventDefault(); const fields = e.currentTarget.querySelectorAll('input'); try { const result = await api('/api/auth/login', { email:fields[0].value, password:fields[1].value, context:captiveContext }); handleAuthorization(result, () => connectToWifi(true)); } catch (error) { alert(error.message); } });
$('#open-user-login').onclick = showUserLogin; $('#back-from-user-login').onclick = showAccessChoice;
$('#user-login-form').addEventListener('submit', async e => { e.preventDefault(); const fields = e.currentTarget.querySelectorAll('input'); try { const result = await api('/api/auth/login', { email:fields[0].value, password:fields[1].value, context:captiveContext }); handleAuthorization(result, () => connectToWifi(true)); } catch (error) { alert(error.message); } });
$('#simulate-verification').onclick = async () => { if (!verificationToken) return alert('Buka tautan verifikasi yang dikirim ke email Anda.'); try { const result = await api('/api/auth/verify', { token:verificationToken, context:captiveContext }); handleAuthorization(result, () => connectToWifi(true)); } catch (error) { alert(error.message); } }; $('#back-from-verify').onclick = showAccessChoice;
$('#return-portal').onclick = showAccessChoice; $('#browse-button').onclick = () => alert('Akses internet kecepatan penuh telah aktif. Selamat browsing!');
$('#upgrade-access').onclick = showLeadForm; $('#continue-limited').onclick = () => alert('Akses terbatas tetap aktif. Selamat browsing!');
$('#admin-trigger').onclick = e => { e.preventDefault(); location.assign('/admin'); }; $('#access-admin-trigger').onclick = e => { e.preventDefault(); location.assign('/admin'); }; $('#back-portal').onclick = () => location.assign('/');
$('#login-form').addEventListener('submit', async e => { e.preventDefault(); const fields = e.currentTarget.querySelectorAll('input'); try { await api('/api/admin/login', { email:fields[0].value, password:fields[1].value }); location.replace('/admin'); } catch (error) { alert(error.message); } }); $('#logout').onclick = async () => { try { await api('/api/admin/logout', {}); } finally { location.assign('/'); } };
document.querySelectorAll('.nav-item').forEach(item => item.onclick = () => { document.querySelectorAll('.nav-item').forEach(i=>i.classList.remove('active')); item.classList.add('active'); const tab=item.dataset.tab; document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active')); $(`#${tab}-tab`).classList.add('active'); $('#dash-title').textContent=tab==='leads'?'Data Pengunjung':'Pengaturan Portal'; });
$('#search-input').addEventListener('input', e => { const q=e.target.value.toLowerCase(); renderLeads(leads.filter(l => `${l.name} ${l.email} ${l.mac} ${l.ip} ${l.ssid}`.toLowerCase().includes(q))); });
$('#export-csv').onclick = () => { const csvCell = value => `"${String(value ?? '').replaceAll('"','""')}"`; const csv=['Nama,Identitas / MAC,IP Klien,SSID,Tipe Akses,Status,Waktu Terakhir',...leads.map(l=>[l.name,l.email,l.ip,l.ssid,l.type === 'high' ? 'High Speed' : l.type === 'limited' ? 'Limited' : 'Menunggu login',l.status,l.time].map(csvCell).join(','))].join('\n'); const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='data-perangkat-perumnet.csv'; a.click(); URL.revokeObjectURL(a.href); };
$('#settings-form').addEventListener('submit', async e => { e.preventDefault(); const wifi=$('#setting-wifi').value.trim() || 'PerumNet Guest', title=$('#setting-title').value || 'Terhubung dalam hitungan detik.', copy=$('#setting-copy').value, terms=$('#setting-terms').value, bandwidth=Number($('#setting-bandwidth').value || 512); const b=e.currentTarget.querySelector('button'); const old=b.innerHTML; try { await api('/api/admin/settings', { defaultSsid:wifi, welcomeTitle:title, welcomeText:copy, termsText:terms, limitedBandwidthKbps:bandwidth }); portalSettings = { ...portalSettings, default_ssid:wifi, welcome_title:title, welcome_text:copy, terms_text:terms, limited_bandwidth_kbps:bandwidth }; setWifiName(gatewaySsid || wifi); $('#portal-title').textContent=title; $('#portal-copy').textContent=copy; $('#choice-bandwidth').textContent=`${bandwidth} Kbps`; $('#preview-title').textContent=title; $('#preview-copy').textContent=copy; b.innerHTML='Tersimpan ✓'; } catch (error) { alert(error.message); } setTimeout(()=>b.innerHTML=old,1600); });
