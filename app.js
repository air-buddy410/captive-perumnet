const $ = (selector) => document.querySelector(selector);
const screens = { portal: $('#portal-screen'), free:$('#free-screen'), success: $('#success-screen'), verify: $('#verify-screen'), userLogin: $('#user-login-screen'), forgotPassword:$('#forgot-password-screen'), resetPassword:$('#reset-password-screen'), accountStatus:$('#account-status-screen'), login: $('#login-screen'), dashboard: $('#dashboard-screen') };
// Preserve every query parameter forwarded by the gateway. WiFiDog uses
// gw_address, gw_port, gw_id, mac, url, and token.
const captiveContext = Object.fromEntries(new URLSearchParams(location.search).entries());
const isAdminView = location.pathname === '/admin' || location.pathname === '/admin/';
const isFreeView = location.pathname === '/free' || location.pathname === '/free/' || location.pathname.startsWith('/free/auth/wifidogAuth/login');
if (isAdminView) { document.body.classList.add('admin-view'); $('#portal-screen').style.display = 'none'; }
if (isFreeView) { document.body.classList.add('free-view'); $('#portal-screen').style.display = 'none'; document.title='PerumNet — Internet Gratis'; }
const pageParams = new URLSearchParams(location.search);
let verificationToken = pageParams.get('verify');
let passwordResetToken = pageParams.get('reset');
if (verificationToken || passwordResetToken) { document.body.classList.add('account-action-view'); $('#portal-screen').style.display='none'; }
let pendingVerificationEmail = '';
let forgotPasswordReturn = 'portal';
const destinationUrl = 'https://perumnet.id';
let redirectTimer;
let notificationTimer;
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
    const accountSsid = portalSettings.account_ssid || '@PERUMNET_WiFi';
    const freeSsid = portalSettings.free_ssid || '@PERUMNET_FreeWiFi';
    const wifiName = gatewaySsid || (isFreeView ? freeSsid : accountSsid);
    setWifiName(wifiName);
    if ($('#setting-account-ssid')) $('#setting-account-ssid').value = accountSsid;
    if ($('#setting-free-ssid')) $('#setting-free-ssid').value = freeSsid;
    if ($('#account-profile-ssid')) $('#account-profile-ssid').textContent = accountSsid;
    if ($('#free-profile-ssid')) $('#free-profile-ssid').textContent = freeSsid;
    if ($('#preview-account-ssid')) $('#preview-account-ssid').textContent = accountSsid;
    if ($('#preview-free-ssid')) $('#preview-free-ssid').textContent = freeSsid;
    if ($('#setting-title')) $('#setting-title').value = portalSettings.welcome_title || $('#setting-title').value;
    if ($('#setting-copy')) $('#setting-copy').value = portalSettings.welcome_text || $('#setting-copy').value;
    if ($('#setting-bandwidth')) $('#setting-bandwidth').value = portalSettings.limited_bandwidth_kbps || 512;
    if ($('#setting-terms')) $('#setting-terms').value = portalSettings.terms_text || $('#setting-terms').value;
    if ($('#portal-title')) $('#portal-title').textContent = portalSettings.welcome_title || $('#portal-title').textContent;
    if ($('#portal-copy')) $('#portal-copy').textContent = portalSettings.welcome_text || $('#portal-copy').textContent;
    if ($('#choice-bandwidth')) $('#choice-bandwidth').textContent = `${portalSettings.limited_bandwidth_kbps || 512} Kbps`;
    if ($('#choice-duration')) $('#choice-duration').textContent = `${portalSettings.limited_session_hours || 2} jam`;
    if ($('#free-duration')) $('#free-duration').textContent = `${portalSettings.limited_session_hours || 2} jam`;
  } catch { setWifiName(gatewaySsid || (isFreeView ? '@PERUMNET_FreeWiFi' : '@PERUMNET_WiFi')); }
}
const leads = [];
let networkCatalog = { projects:[], gateways:[] };
const adminScope = { projectId:'', gatewayId:'' };
function scopeQuery() {
  const params = new URLSearchParams();
  if (adminScope.gatewayId) params.set('gatewayId',adminScope.gatewayId);
  else if (adminScope.projectId) params.set('projectId',adminScope.projectId);
  const value=params.toString(); return value ? `?${value}` : '';
}
function selectedProject() { return networkCatalog.projects.find(project=>project.id===adminScope.projectId); }
function selectedGateway() { return networkCatalog.gateways.find(gateway=>gateway.id===adminScope.gatewayId); }
function updateScopeIdentity() {
  const project=selectedProject(), gateway=selectedGateway();
  $('#scope-title').textContent=gateway?.name || project?.name || 'Semua jaringan';
  $('#scope-subtitle').textContent=gateway ? `${project?.name || gateway.project_name} · ${gateway.location || 'Lokasi belum diisi'}` : project ? `Ringkasan seluruh gateway di ${project.name}` : 'Ringkasan gabungan seluruh project dan gateway';
  $('#workspace-name').textContent=gateway?.name || project?.name || 'Semua Project';
  $('#workspace-context').textContent=gateway ? (gateway.project_name || project?.name || 'Gateway aktif') : project ? 'Seluruh gateway project' : 'Seluruh gateway';
}
function show(screen) { Object.values(screens).forEach(el => el.classList.remove('active')); screens[screen].classList.add('active'); document.body.classList.toggle('modal-open', screens[screen].classList.contains('portal-modal')); if (!screens[screen].classList.contains('portal-modal')) window.scrollTo(0,0); }
function showAccessChoice() { $('#portal-screen').classList.remove('show-form'); show('portal'); }
function showLeadForm() { $('#portal-screen').classList.add('show-form'); show('portal'); }
function showUserLogin(message='') { $('#user-login-error').textContent=message; show('userLogin'); setTimeout(()=>$('#user-login-form input')?.focus(),220); }
function showForgotPassword(returnScreen='portal') { forgotPasswordReturn=returnScreen; $('#forgot-password-feedback').textContent=''; $('#forgot-password-feedback').classList.remove('success'); show('forgotPassword'); setTimeout(()=>$('#forgot-password-form input')?.focus(),220); }
function closeForgotPassword() { forgotPasswordReturn === 'userLogin' ? showUserLogin() : showAccessChoice(); }
function showAccountStatus(title, message, success=true) { $('#account-status-title').textContent=title; $('#account-status-message').textContent=message; $('#account-status-eyebrow').textContent=success ? 'Akun berhasil diperbarui' : 'Tautan tidak dapat diproses'; $('#account-status-icon').textContent=success ? '✓' : '!'; $('#account-status-icon').classList.toggle('error',!success); show('accountStatus'); }
function clearAccountActionUrl() { history.replaceState({},'',location.pathname); }
function startDestinationRedirect() { clearInterval(redirectTimer); let seconds=3; $('#redirect-countdown').textContent=seconds; redirectTimer=setInterval(()=>{ seconds-=1; $('#redirect-countdown').textContent=Math.max(seconds,0); if (seconds <= 0) { clearInterval(redirectTimer); location.assign(destinationUrl); } },1000); }
function connectToWifi(withLead) { $('#success-message').textContent = withLead ? 'Akun Anda sudah aktif dan akses internet berhasil tersambung.' : 'Akses internet Anda sudah aktif. Selamat menggunakan WiFi gratis PerumNet.'; show('success'); startDestinationRedirect(); }
const isConnectedCallback = new URLSearchParams(location.search).get('connected') === '1';
if (isConnectedCallback) connectToWifi(!isFreeView);
else if (isFreeView) show('free');
const escapeHtml = value => String(value ?? '—').replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
const formatTime = value => value ? new Date(value).toLocaleString('id-ID', { dateStyle:'medium', timeStyle:'short' }) : '—';
function relativeTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return formatTime(value);
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'Baru saja';
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return formatTime(value);
}
function renderNotifications(notifications=[], unreadCount=0) {
  const badge = $('#notification-badge');
  badge.hidden = unreadCount < 1;
  badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
  $('#notification-list').innerHTML = notifications.length ? notifications.map(item => {
    const isLogin = item.type === 'client_login';
    const icon = isLogin
      ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/></svg>'
      : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M17 8h5"/></svg>';
    return `<article class="notification-item ${item.read_at ? '' : 'unread'}"><span class="notification-icon ${isLogin ? 'online' : 'offline'}">${icon}</span><div><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.message)}</p><span class="notification-scope">${escapeHtml(item.project_name)} · ${escapeHtml(item.gateway_name)}</span><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(relativeTime(item.created_at))}</time></div></article>`;
  }).join('') : '<p class="notification-empty">Belum ada aktivitas terbaru.</p>';
}
async function loadNotifications() {
  if (!isAdminView) return;
  const result = await api(`/api/admin/notifications${scopeQuery()}`);
  renderNotifications(result.notifications, result.unreadCount);
}
function setNotificationPanel(open) {
  $('#notification-panel').classList.toggle('open', open);
  $('#notification-toggle').setAttribute('aria-expanded', String(open));
}
function startNotificationPolling() {
  clearInterval(notificationTimer);
  notificationTimer = setInterval(() => loadNotifications().catch(() => {}), 15000);
}
async function loadAdminLeads() {
  const { clients, stats } = await api(`/api/admin/clients${scopeQuery()}`);
  leads.splice(0, leads.length, ...clients.map(row => ({
    name:row.full_name || 'Perangkat belum login', email:row.email || row.mac_address,
    ip:row.client_ip || '—', ssid:row.ssid || '—', mac:row.mac_address,
    time:formatTime(row.last_seen_at), initials:row.full_name ? row.full_name.split(' ').slice(0,2).map(part => part[0]).join('') : 'Wi',
    phone:row.phone_number || '—', address:row.address || '—', registered:!!row.email,
    type:row.auth_status === 'pending' && row.authorized_until ? 'offline' : row.access_type === 'high_speed' ? 'high' : row.access_type === 'limited' ? 'limited' : 'pending', verified:!!row.is_verified,
    status:row.auth_status, gatewayId:row.gateway_id, gateway:row.gateway_name || row.gateway_id,
    gatewayLocation:row.gateway_location || '—', projectId:row.project_id, project:row.project_name || '—'
  })));
  $('#total-leads').textContent = stats.total;
  $('#today-leads').textContent = stats.today;
  $('#authorized-leads').textContent = stats.authorized;
  renderLeads();
}
function renderLeads(data=leads) {
  const access = { high:'High Speed', limited:'Limited', pending:'Menunggu login', offline:'Offline' };
  $('#lead-rows').innerHTML = data.map(l => `<tr><td data-label="Pengunjung"><div class="user-cell"><span class="avatar">${escapeHtml(l.initials)}</span><div><b>${escapeHtml(l.name)}</b><span>${escapeHtml(l.email)}</span>${l.type === 'high' && l.verified ? '<em class="verified-status">✓ Email terverifikasi</em>' : ''}</div></div></td><td data-label="Project"><span class="network-cell"><b>${escapeHtml(l.project)}</b></span></td><td data-label="Gateway"><span class="network-cell"><b>${escapeHtml(l.gateway)}</b><small>${escapeHtml(l.gatewayId)}</small></span></td><td data-label="Nomor HP">${escapeHtml(l.phone)}</td><td data-label="Alamat" class="address-cell">${escapeHtml(l.address)}</td><td data-label="IP Klien">${escapeHtml(l.ip)}</td><td data-label="Status"><span class="access-badge ${l.type}">${access[l.type]}</span></td><td data-label="SSID">${escapeHtml(l.ssid)}</td><td data-label="Terakhir terlihat">${escapeHtml(l.time)}</td><td data-label="MAC" class="device-cell">${escapeHtml(l.mac)}</td><td data-label="Aksi" class="action-cell"><button class="delete-client" type="button" data-gateway="${escapeHtml(l.gatewayId)}" data-mac="${escapeHtml(l.mac)}" aria-label="Hapus ${escapeHtml(l.name)}">Hapus data</button></td></tr>`).join('') || '<tr class="empty-row"><td colspan="11" class="empty-state">Belum ada perangkat yang dilaporkan gateway pada filter ini.</td></tr>';
  $('#result-count').textContent = data.length === leads.length ? `Menampilkan ${data.length} perangkat` : `Menampilkan ${data.length} hasil pencarian`;
}
function projectOptions(selected='') { return networkCatalog.projects.map(project=>`<option value="${escapeHtml(project.id)}" ${project.id===selected?'selected':''}>${escapeHtml(project.name)}</option>`).join(''); }
function visibleGateways() { return networkCatalog.gateways.filter(gateway=>gateway.id!=='unassigned' || Number(gateway.client_count)>0); }
function renderGatewayCards() {
  const gateways=visibleGateways();
  $('#gateway-list').innerHTML=gateways.length ? gateways.map(gateway=>`<article class="gateway-card ${gateway.status}"><header><div><span class="gateway-status"><i></i>${gateway.status==='online'?'Online':'Offline'}</span><h3>${escapeHtml(gateway.name)}</h3><code>${escapeHtml(gateway.id)}</code></div><span class="gateway-client-count"><b>${gateway.client_count || 0}</b><small>perangkat</small></span></header><form class="gateway-form" data-gateway-id="${escapeHtml(gateway.id)}"><label>Project<select name="projectId">${projectOptions(gateway.project_id)}</select></label><label>Nama gateway<input name="name" value="${escapeHtml(gateway.name)}" placeholder="Nama gateway" required /></label><div class="gateway-form-grid"><label>Lokasi<input name="location" value="${escapeHtml(gateway.location || '')}" placeholder="Lokasi pemasangan" /></label><label>Model<input name="model" value="${escapeHtml(gateway.model || '')}" placeholder="Contoh: RG-EG105G-P-V3" /></label></div><div class="gateway-card-footer"><span>Terakhir aktif: <b>${escapeHtml(relativeTime(gateway.last_seen_at))}</b></span><button type="submit">Simpan identitas</button></div><p class="gateway-feedback inline-feedback" role="status"></p></form></article>`).join('') : '<div class="gateway-empty">Gateway akan muncul otomatis setelah menerima koneksi Ruijie.</div>';
}
function renderScopeOptions() {
  const projectSelect=$('#scope-project'), gatewaySelect=$('#scope-gateway');
  projectSelect.innerHTML='<option value="">Semua project</option>'+networkCatalog.projects.map(project=>`<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)} (${project.gateway_count || 0})</option>`).join('');
  projectSelect.value=adminScope.projectId;
  const availableGateways=adminScope.projectId ? visibleGateways().filter(gateway=>gateway.project_id===adminScope.projectId) : visibleGateways();
  gatewaySelect.innerHTML='<option value="">Semua gateway</option>'+availableGateways.map(gateway=>`<option value="${escapeHtml(gateway.id)}">${escapeHtml(gateway.name)} · ${gateway.status==='online'?'Online':'Offline'}</option>`).join('');
  if (!availableGateways.some(gateway=>gateway.id===adminScope.gatewayId)) adminScope.gatewayId='';
  gatewaySelect.value=adminScope.gatewayId;
  updateScopeIdentity();
}
async function loadAdminNetwork() {
  networkCatalog=await api('/api/admin/network');
  renderScopeOptions(); renderGatewayCards();
  $('#network-project-total').textContent=networkCatalog.projects.length;
  $('#network-gateway-total').textContent=visibleGateways().length;
  $('#network-online-total').textContent=networkCatalog.gateways.filter(gateway=>gateway.status==='online').length;
  $('#gateway-sync-time').textContent=`Disinkronkan ${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`;
}
renderLeads();
loadPortalSettings();
async function restoreAdminSession() { if (!isAdminView) return; try { const session = await api('/api/admin/session'); $('#admin-email').textContent = session.email; await loadAdminNetwork(); await Promise.all([loadAdminLeads(),loadNotifications()]); show('dashboard'); startNotificationPolling(); } catch { show('login'); } }
restoreAdminSession();
if (passwordResetToken) show('resetPassword');
if (verificationToken) { api('/api/auth/verify', { token:verificationToken }).then(() => { verificationToken=''; clearAccountActionUrl(); showAccountStatus('Email berhasil diverifikasi.','Kembali ke jendela login WiFi pada perangkat Anda untuk masuk menggunakan email dan kata sandi.'); }).catch(error => { clearAccountActionUrl(); showAccountStatus('Verifikasi tidak berhasil.',error.message,false); }); }
$('#lead-form').addEventListener('submit', async e => { e.preventDefault(); const data = new FormData(e.currentTarget); if (![...data.values()].every(Boolean)) { $('#form-error').textContent = 'Lengkapi semua data, kata sandi, dan setujui syarat terlebih dahulu.'; return; } const button=e.currentTarget.querySelector('button'); button.disabled=true; try { const result = await api('/api/auth/register', { fullName:data.get('name'), email:data.get('email'), phone:data.get('phone'), address:data.get('address'), password:data.get('password'), consent:data.get('consent'), context:captiveContext }); $('#form-error').textContent=''; pendingVerificationEmail=result.email; $('#verification-email').textContent = result.email; show('verify'); } catch (error) { $('#form-error').textContent = error.message; } finally { button.disabled=false; } });
$('#choose-high-speed').onclick = showLeadForm; $('#back-to-access-choice').onclick = showAccessChoice;
$('#free-connect').onclick = async event => { const button=event.currentTarget,feedback=$('#free-feedback'),label=button.querySelector('.button-label'); button.disabled=true; feedback.textContent=''; label.textContent='Menghubungkan…'; try { const result=await api('/api/captive/limited',{ context:captiveContext }); handleAuthorization(result,()=>connectToWifi(false)); } catch(error) { feedback.textContent=error.message; button.disabled=false; label.textContent='Sambungkan Internet Gratis'; } };
$('#quick-login-form').addEventListener('submit', async e => { e.preventDefault(); const fields=e.currentTarget.querySelectorAll('input'), button=e.currentTarget.querySelector('button'), feedback=$('#quick-login-error'); button.disabled=true; feedback.textContent=''; try { const result=await api('/api/auth/login',{ email:fields[0].value,password:fields[1].value,context:captiveContext }); handleAuthorization(result,()=>connectToWifi(true)); } catch(error) { feedback.textContent=error.message; button.disabled=false; } });
$('#open-user-login').onclick = () => showUserLogin(); $('#back-from-user-login').onclick = showAccessChoice; $('#close-user-login').onclick = showAccessChoice;
$('#user-login-form').addEventListener('submit', async e => { e.preventDefault(); const fields=e.currentTarget.querySelectorAll('input'), button=e.currentTarget.querySelector('.primary-button'), feedback=$('#user-login-error'); button.disabled=true; feedback.textContent=''; try { const result=await api('/api/auth/login',{ email:fields[0].value,password:fields[1].value,context:captiveContext }); handleAuthorization(result,()=>connectToWifi(true)); } catch(error) { feedback.textContent=error.message; button.disabled=false; } });
document.querySelectorAll('[data-forgot-password]').forEach(button => button.onclick = () => showForgotPassword(button.dataset.forgotPassword));
$('#close-forgot-password').onclick = closeForgotPassword; $('#back-from-forgot-password').onclick = closeForgotPassword;
$('#forgot-password-form').addEventListener('submit', async event => { event.preventDefault(); const form=event.currentTarget, button=form.querySelector('.primary-button'), feedback=$('#forgot-password-feedback'), email=new FormData(form).get('email'); button.disabled=true; feedback.textContent='Mengirim tautan reset…'; feedback.classList.remove('success'); try { const result=await api('/api/auth/forgot-password',{ email }); feedback.textContent=result.message; feedback.classList.add('success'); form.reset(); } catch(error) { feedback.textContent=error.message; } finally { button.disabled=false; } });
$('#reset-password-form').addEventListener('submit', async event => { event.preventDefault(); const form=event.currentTarget, data=new FormData(form), password=String(data.get('password')||''), confirmation=String(data.get('confirmPassword')||''), button=form.querySelector('.primary-button'), feedback=$('#reset-password-feedback'); feedback.textContent=''; if(password.length<8){ feedback.textContent='Kata sandi baru minimal 8 karakter.'; return; } if(password!==confirmation){ feedback.textContent='Konfirmasi kata sandi belum sama.'; return; } button.disabled=true; try { await api('/api/auth/reset-password',{ token:passwordResetToken,password }); passwordResetToken=''; clearAccountActionUrl(); form.reset(); showAccountStatus('Kata sandi berhasil diperbarui.','Silakan kembali ke jendela login WiFi dan masuk menggunakan email serta kata sandi baru.'); } catch(error) { feedback.textContent=error.message; } finally { button.disabled=false; } });
$('#account-status-action').onclick = () => location.assign(destinationUrl);
$('#resend-verification').onclick = async e => { const feedback=$('#verification-status'); if (!pendingVerificationEmail) { feedback.textContent='Kembali ke formulir lalu masukkan ulang data pendaftaran.'; return; } e.currentTarget.disabled=true; feedback.textContent='Mengirim ulang email…'; try { const result=await api('/api/auth/resend',{ email:pendingVerificationEmail }); feedback.textContent=result.message; } catch(error) { feedback.textContent=error.message; } finally { e.currentTarget.disabled=false; } }; $('#back-from-verify').onclick = showAccessChoice;
$('#browse-button').onclick = () => { clearInterval(redirectTimer); location.assign(destinationUrl); };
$('#admin-trigger').onclick = e => { e.preventDefault(); location.assign('/admin'); }; $('#access-admin-trigger').onclick = e => { e.preventDefault(); location.assign('/admin'); }; $('#back-portal').onclick = () => location.assign('/');
$('#login-form').addEventListener('submit', async e => { e.preventDefault(); const fields = e.currentTarget.querySelectorAll('input'); try { await api('/api/admin/login', { email:fields[0].value, password:fields[1].value }); location.replace('/admin'); } catch (error) { alert(error.message); } }); $('#logout').onclick = async () => { clearInterval(notificationTimer); try { await api('/api/admin/logout', {}); } finally { location.assign('/'); } };
function setSidebar(open) { document.body.classList.toggle('sidebar-open',open); $('#sidebar-toggle').setAttribute('aria-expanded',String(open)); }
$('#sidebar-toggle').onclick = () => setSidebar(!document.body.classList.contains('sidebar-open')); $('#sidebar-backdrop').onclick = () => setSidebar(false);
$('#notification-toggle').onclick = event => { event.stopPropagation(); setNotificationPanel(!$('#notification-panel').classList.contains('open')); };
$('#notification-panel').onclick = event => event.stopPropagation();
$('#notification-read-all').onclick = async () => { try { await api(`/api/admin/notifications/read${scopeQuery()}`, {}); await loadNotifications(); } catch (error) { alert(error.message); } };
document.addEventListener('click', () => setNotificationPanel(false));
document.querySelectorAll('.nav-item').forEach(item => item.onclick = () => { document.querySelectorAll('.nav-item').forEach(i=>i.classList.remove('active')); item.classList.add('active'); const tab=item.dataset.tab; document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active')); $(`#${tab}-tab`).classList.add('active'); $('#dash-title').textContent={ leads:'Data Pengunjung',network:'Project & Gateway',settings:'Pengaturan Portal' }[tab]; if(tab==='network') loadAdminNetwork().catch(error=>alert(error.message)); setNotificationPanel(false); setSidebar(false); });
document.addEventListener('keydown',event=>{ if(event.key==='Escape'){ if($('#notification-panel').classList.contains('open')) setNotificationPanel(false); else if(document.body.classList.contains('sidebar-open')) setSidebar(false); else if(screens.forgotPassword.classList.contains('active')) closeForgotPassword(); else if(screens.userLogin.classList.contains('active')) showAccessChoice(); } });
$('#scope-project').addEventListener('change',async event=>{ adminScope.projectId=event.target.value; adminScope.gatewayId=''; renderScopeOptions(); try { await Promise.all([loadAdminLeads(),loadNotifications()]); } catch(error){ alert(error.message); } });
$('#scope-gateway').addEventListener('change',async event=>{ adminScope.gatewayId=event.target.value; const gateway=selectedGateway(); if(gateway) adminScope.projectId=gateway.project_id; renderScopeOptions(); try { await Promise.all([loadAdminLeads(),loadNotifications()]); } catch(error){ alert(error.message); } });
$('#project-form').addEventListener('submit',async event=>{ event.preventDefault(); const form=event.currentTarget,button=form.querySelector('button'),feedback=$('#project-feedback'),data=new FormData(form); button.disabled=true; feedback.textContent=''; try { await api('/api/admin/projects',{ name:data.get('name'),location:data.get('location') }); form.reset(); feedback.textContent='Project berhasil ditambahkan.'; feedback.classList.add('success'); await loadAdminNetwork(); } catch(error){ feedback.textContent=error.message; feedback.classList.remove('success'); } finally { button.disabled=false; } });
$('#gateway-list').addEventListener('submit',async event=>{ const form=event.target.closest('.gateway-form'); if(!form) return; event.preventDefault(); const button=form.querySelector('button[type="submit"]'),feedback=form.querySelector('.gateway-feedback'),data=new FormData(form); button.disabled=true; feedback.textContent='Menyimpan…'; try { await api('/api/admin/gateways',{ gatewayId:form.dataset.gatewayId,projectId:data.get('projectId'),name:data.get('name'),location:data.get('location'),model:data.get('model') }); feedback.textContent='Identitas gateway tersimpan.'; feedback.classList.add('success'); await loadAdminNetwork(); await loadAdminLeads(); } catch(error){ feedback.textContent=error.message; feedback.classList.remove('success'); } finally { button.disabled=false; } });
$('#search-input').addEventListener('input', e => { const q=e.target.value.toLowerCase(); renderLeads(leads.filter(l => `${l.name} ${l.email} ${l.phone} ${l.address} ${l.mac} ${l.ip} ${l.ssid} ${l.project} ${l.gateway} ${l.gatewayId}`.toLowerCase().includes(q))); });
$('#lead-rows').addEventListener('click', async event => { const button=event.target.closest('.delete-client'); if (!button) return; const lead=leads.find(item=>item.mac===button.dataset.mac && item.gatewayId===button.dataset.gateway); if (!lead) return; const detail=lead.registered ? 'Akun, profil, seluruh perangkat terkait, dan riwayat akses akan dihapus.' : `Perangkat dan riwayat one-click pada ${lead.gateway} akan dihapus.`; if (!confirm(`Hapus data ${lead.name}?\n\n${detail}\nOtorisasi WiFiDog juga akan dicabut.`)) return; button.disabled=true; try { const result=await api('/api/admin/clients',{ gatewayId:lead.gatewayId,macAddress:lead.mac },'DELETE'); await Promise.all([loadAdminNetwork(),loadAdminLeads(),loadNotifications()]); alert(result.deletedAccount ? 'Akun berhasil dihapus dan akses Ruijie dicabut.' : 'Data perangkat berhasil dihapus dan akses Ruijie dicabut.'); } catch(error) { alert(error.message); button.disabled=false; } });
$('#export-csv').onclick = () => { const csvCell = value => `"${String(value ?? '').replaceAll('"','""')}"`; const csv=['Nama,Email / Identitas,Project,Gateway,Gateway ID,Nomor HP,Alamat,MAC,IP Klien,SSID,Tipe Akses,Status,Waktu Terakhir',...leads.map(l=>[l.name,l.email,l.project,l.gateway,l.gatewayId,l.phone,l.address,l.mac,l.ip,l.ssid,l.type === 'high' ? 'High Speed' : l.type === 'limited' ? 'Limited' : l.type === 'offline' ? 'Offline' : 'Menunggu login',l.status,l.time].map(csvCell).join(','))].join('\n'); const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download=`data-perangkat-perumnet-${adminScope.gatewayId || adminScope.projectId || 'semua'}.csv`; a.click(); URL.revokeObjectURL(a.href); };
$('#settings-form').addEventListener('submit', async e => { e.preventDefault(); const accountSsid=$('#setting-account-ssid').value.trim() || '@PERUMNET_WiFi', freeSsid=$('#setting-free-ssid').value.trim() || '@PERUMNET_FreeWiFi', title=$('#setting-title').value || 'Masuk ke internet cepat.', copy=$('#setting-copy').value, terms=$('#setting-terms').value, bandwidth=Number($('#setting-bandwidth').value || 512); const b=e.currentTarget.querySelector('button'); const old=b.innerHTML; try { await api('/api/admin/settings', { accountSsid,freeSsid,welcomeTitle:title,welcomeText:copy,termsText:terms,limitedBandwidthKbps:bandwidth }); portalSettings={ ...portalSettings,account_ssid:accountSsid,free_ssid:freeSsid,default_ssid:accountSsid,welcome_title:title,welcome_text:copy,terms_text:terms,limited_bandwidth_kbps:bandwidth }; setWifiName(gatewaySsid || accountSsid); $('#portal-title').textContent=title; $('#portal-copy').textContent=copy; $('#account-profile-ssid').textContent=accountSsid; $('#free-profile-ssid').textContent=freeSsid; $('#preview-account-ssid').textContent=accountSsid; $('#preview-free-ssid').textContent=freeSsid; $('#preview-title').textContent=title; $('#preview-copy').textContent=copy; b.innerHTML='Tersimpan ✓'; } catch (error) { alert(error.message); } setTimeout(()=>b.innerHTML=old,1600); });
