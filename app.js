const $ = (selector) => document.querySelector(selector);
const screens = { portal: $('#portal-screen'), free:$('#free-screen'), success: $('#success-screen'), verify: $('#verify-screen'), userLogin: $('#user-login-screen'), forgotPassword:$('#forgot-password-screen'), resetPassword:$('#reset-password-screen'), accountStatus:$('#account-status-screen'), gatewayReview:$('#gateway-review-screen'), login: $('#login-screen'), dashboard: $('#dashboard-screen') };
// Preserve every query parameter forwarded by the gateway. WiFiDog uses
// gw_address, gw_port, gw_id, mac, url, and token.
const captiveContext = Object.fromEntries(new URLSearchParams(location.search).entries());
const isAdminView = location.pathname === '/admin' || location.pathname === '/admin/';
const isFreeView = location.pathname === '/free' || location.pathname === '/free/' || location.pathname.startsWith('/free/auth/wifidogAuth/login');
const isGatewayReviewView = location.pathname === '/gateway-review' || location.pathname === '/gateway-review/';
function mountAdminUsersPage() {
  if($('#users-tab')) return;
  $('#network-tab').insertAdjacentHTML('beforebegin',`
    <div id="users-tab" class="tab-content">
      <section class="user-management-heading">
        <div><span class="eyebrow">Database pelanggan terdaftar</span><h2>Data Pengguna</h2><p>Kelola data diri yang masuk melalui formulir portal. Perubahan di halaman ini langsung digunakan pada login akun dan file CSV.</p></div>
        <button class="primary-button add-user-button" id="add-admin-user" type="button"><span>＋</span> Tambah Pengguna</button>
      </section>
      <div class="profile-stats">
        <article><span class="profile-stat-icon total">◎</span><div><small>Total Pengguna</small><b id="profile-total">0</b><em>Seluruh akun yang mengisi data</em></div></article>
        <article><span class="profile-stat-icon verified">✓</span><div><small>Email Terverifikasi</small><b id="profile-verified">0</b><em>Sudah dapat login ke portal</em></div></article>
        <article><span class="profile-stat-icon review">!</span><div><small>Perlu Ditinjau</small><b id="profile-unverified">0</b><em>Email belum terverifikasi</em></div></article>
      </div>
      <section class="profile-management-card">
        <header class="profile-management-header"><div><h3>Database Data Diri</h3><p>Halaman ini tidak menampilkan perangkat Free/Limited atau perangkat yang belum login.</p></div><div class="profile-header-actions"><button class="outline-button table-refresh-button" id="users-refresh" type="button" aria-busy="false"><svg class="refresh-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg><span>Refresh</span></button><button class="outline-button" id="users-export-csv" type="button">⇩ Ekspor CSV</button></div></header>
        <div class="profile-filter" id="profile-verification-filter" role="tablist" aria-label="Filter status verifikasi"><button class="active" type="button" data-verification="all">Semua</button><button type="button" data-verification="verified">Terverifikasi</button><button type="button" data-verification="unverified">Perlu Ditinjau</button></div>
        <div class="profile-tools"><label class="search"><span>⌕</span><input id="profile-search" type="search" placeholder="Cari nama, email, nomor HP, atau alamat..." /></label><label class="page-size-control">Baris per halaman<select id="profile-page-size"><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label></div>
        <div class="profile-table-scroll"><table class="profile-table"><thead><tr><th>Nama Pengguna</th><th>Email</th><th>Nomor HP</th><th>Alamat</th><th>Verifikasi</th><th>Aktivitas Terakhir</th><th>Terdaftar</th><th>Aksi</th></tr></thead><tbody id="profile-rows"><tr class="empty-row"><td colspan="8" class="empty-state">Memuat data pengguna…</td></tr></tbody></table></div>
        <footer class="table-footer profile-footer"><span id="profile-result-count">Memuat data pengguna…</span><span class="profile-sync-status" id="profile-sync-status">Belum disinkronkan</span><nav class="pagination" aria-label="Pagination data pengguna"><button id="profile-page-prev" type="button" aria-label="Halaman sebelumnya">←</button><b id="profile-page-indicator">1 / 1</b><button id="profile-page-next" type="button" aria-label="Halaman berikutnya">→</button></nav></footer>
      </section>
      <section class="admin-user-modal" id="admin-user-modal" aria-hidden="true">
        <button class="admin-user-backdrop" type="button" data-close-user-editor aria-label="Tutup form pengguna"></button>
        <div class="admin-user-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-user-modal-title">
          <header><div><span class="eyebrow" id="admin-user-modal-eyebrow">Perbaiki data pelanggan</span><h3 id="admin-user-modal-title">Edit Data Pengguna</h3></div><button class="modal-close-button" type="button" data-close-user-editor aria-label="Tutup">×</button></header>
          <form id="admin-user-form">
            <input id="admin-user-id" name="userId" type="hidden" />
            <div class="admin-user-grid"><label>Nama lengkap<input id="admin-user-name" name="fullName" maxlength="120" placeholder="Nama lengkap pelanggan" required /></label><label>Email<input id="admin-user-email" name="email" type="email" maxlength="254" placeholder="nama@email.com" required /></label><label>Nomor HP / WhatsApp<input id="admin-user-phone" name="phone" maxlength="40" placeholder="08xx xxxx xxxx" required /></label><label class="admin-user-address">Alamat<textarea id="admin-user-address" name="address" maxlength="500" placeholder="Kota atau alamat tempat tinggal" required></textarea></label><label class="admin-user-password" id="admin-user-password-field">Kata sandi awal<input id="admin-user-password" name="password" type="password" minlength="8" placeholder="Minimal 8 karakter" autocomplete="new-password" /><small>Akun yang ditambahkan admin langsung berstatus terverifikasi.</small></label></div>
            <div class="admin-user-verification" id="admin-user-verification"><span class="verification-dot"></span><div><b>Status email</b><small id="admin-user-verification-copy">Terverifikasi</small></div></div>
            <p class="admin-user-note">Mengubah email juga mengubah email yang digunakan pelanggan untuk login berikutnya. Kata sandi lama tidak berubah saat data diedit.</p>
            <p class="inline-feedback" id="admin-user-feedback" role="status"></p>
            <footer><button class="outline-button" type="button" data-close-user-editor>Batal</button><button class="primary-button" id="save-admin-user" type="submit">Simpan Data <span>→</span></button></footer>
          </form>
        </div>
      </section>
    </div>`);
}
mountAdminUsersPage();
if (isAdminView) { document.body.classList.add('admin-view'); $('#portal-screen').style.display = 'none'; }
if (isFreeView) { document.body.classList.add('free-view'); $('#portal-screen').style.display = 'none'; document.title='PerumNet — Internet Gratis'; }
if (isGatewayReviewView) { document.body.classList.add('account-action-view'); $('#portal-screen').style.display='none'; document.title='PerumNet — Verifikasi Gateway'; }
const pageParams = new URLSearchParams(location.search);
let verificationToken = pageParams.get('verify');
let passwordResetToken = pageParams.get('reset');
if (verificationToken || passwordResetToken) { document.body.classList.add('account-action-view'); $('#portal-screen').style.display='none'; }
let pendingVerificationEmail = '';
let forgotPasswordReturn = 'portal';
const destinationUrl = 'https://perumnet.id';
let redirectTimer;
let notificationTimer;
let monitoringTimer;
let analyticsTimer;
let searchTimer;
let adminRefreshPromise;
let tableRefreshPromise;
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
let networkCatalog = { projects:[], gateways:[], portalNetworks:[], blockedGateways:[] };
const adminScope = { projectId:'', gatewayId:'' };
const adminTable = { page:1, limit:10, category:'all', search:'', total:0, totalPages:1 };
const adminMonitoring = { range:'24h', loading:false };
const adminUsers = { page:1, limit:10, verification:'all', search:'', total:0, totalPages:1 };
const registeredUsers = [];
let leadsLoading = false;
let usersLoading = false;
function scopeQuery(extra={}) {
  const params = new URLSearchParams();
  if (adminScope.gatewayId) params.set('gatewayId',adminScope.gatewayId);
  else if (adminScope.projectId) params.set('projectId',adminScope.projectId);
  Object.entries(extra).forEach(([key,value]) => { if (value !== '' && value !== undefined && value !== null) params.set(key,String(value)); });
  const value=params.toString(); return value ? `?${value}` : '';
}
function selectedProject() { return networkCatalog.projects.find(project=>project.id===adminScope.projectId); }
function selectedGateway() { return networkCatalog.gateways.find(gateway=>gateway.id===adminScope.gatewayId); }
function updateScopeIdentity() {
  const project=selectedProject(), gateway=selectedGateway();
  $('#scope-title').textContent=gateway?.name || project?.name || 'Semua jaringan';
  $('#scope-subtitle').textContent=gateway ? `${project?.name || gateway.project_name} · ${gateway.location || 'Lokasi belum diisi'}` : project ? `Ringkasan seluruh gateway di ${project.name}` : 'Ringkasan gabungan seluruh project dan gateway';
  $('#workspace-name').textContent=gateway?.name || project?.name || 'Semua Project';
  $('#workspace-context').textContent=gateway ? (gateway.project_name || project?.name || 'Gateway aktif') : project ? `${project.gateway_count || 0} gateway` : `${networkCatalog.projects.length} project · ${visibleGateways().length} gateway`;
  $('#workspace-toggle .avatar').textContent=gateway ? 'GW' : project ? project.name.split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase() : 'PN';
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
if (isGatewayReviewView) {
  const gatewayStatus=pageParams.get('status');
  if(gatewayStatus==='blocked'){
    $('#gateway-review-title').textContent='Gateway diblokir.';
    $('#gateway-review-message').textContent='Gateway ini telah dihapus dan diblokir oleh administrator sehingga tidak dapat menggunakan layanan captive portal.';
  }
  show('gatewayReview');
}
else if (isConnectedCallback) connectToWifi(!isFreeView);
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
function refreshClock() {
  return new Date().toLocaleTimeString('id-ID',{ hour:'2-digit',minute:'2-digit',second:'2-digit' });
}
function setRefreshLoading(button,loading) {
  if(!button) return;
  button.disabled=loading;
  button.classList.toggle('is-loading',loading);
  button.setAttribute('aria-busy',String(loading));
}
function updateAdminRefreshStatus(state='live') {
  const status=$('#admin-refresh-status');
  if(!status) return;
  const labels={ loading:'Menyinkronkan semua data…',error:'Refresh gagal · coba lagi' };
  status.textContent=labels[state] || `Sinkron ${refreshClock()}`;
  status.classList.toggle('error',state==='error');
  if(state==='live') $('#dash-date').textContent=`Sinkron terakhir ${refreshClock()}`;
}
function updateTableRefreshStatus(state='live') {
  const status=$('#table-refresh-status');
  if(!status) return;
  const labels={ loading:'Memperbarui tabel…',error:'Refresh tabel gagal.' };
  status.textContent=labels[state] || `Tabel diperbarui ${refreshClock()}.`;
  status.classList.toggle('error',state==='error');
}
async function refreshAdminData() {
  if(!isAdminView) return;
  if(adminRefreshPromise) return adminRefreshPromise;
  const button=$('#admin-refresh');
  setRefreshLoading(button,true);
  updateAdminRefreshStatus('loading');
  adminRefreshPromise=(async()=>{
    await loadAdminNetwork();
    const results=await Promise.allSettled([loadAdminLeads(),loadAdminMonitoring(),loadAdminUsers(),loadNotifications()]);
    const rejected=results.find(result=>result.status==='rejected');
    if(rejected) throw rejected.reason;
    updateAdminRefreshStatus('live');
    startNotificationPolling();
    startMonitoringPolling();
  })();
  try { await adminRefreshPromise; }
  catch(error) { updateAdminRefreshStatus('error'); throw error; }
  finally { adminRefreshPromise=null; setRefreshLoading(button,false); }
}
async function refreshTableData() {
  if(!isAdminView) return;
  if(tableRefreshPromise) return tableRefreshPromise;
  const button=$('#table-refresh');
  setRefreshLoading(button,true);
  updateTableRefreshStatus('loading');
  tableRefreshPromise=loadAdminLeads();
  try { await tableRefreshPromise; updateTableRefreshStatus('live'); }
  catch(error) { updateTableRefreshStatus('error'); throw error; }
  finally { tableRefreshPromise=null; setRefreshLoading(button,false); }
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
function startMonitoringPolling() {
  clearInterval(monitoringTimer);
  monitoringTimer=setInterval(()=>{
    if(document.visibilityState==='visible' && screens.dashboard.classList.contains('active') && $('#leads-tab').classList.contains('active')) loadAdminLeads({ silent:true });
  },5000);
  clearInterval(analyticsTimer);
  analyticsTimer=setInterval(()=>{
    if(document.visibilityState==='visible' && screens.dashboard.classList.contains('active') && $('#leads-tab').classList.contains('active')) loadAdminMonitoring({ silent:true });
    else if(document.visibilityState==='visible' && screens.dashboard.classList.contains('active') && $('#users-tab').classList.contains('active')) loadAdminUsers({ silent:true });
  },10000);
}
const formatBytes = value => {
  const bytes = Math.max(0,Number(value || 0));
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units=['KB','MB','GB','TB']; let amount=bytes/1024,unit=units[0];
  for(let index=1;index<units.length && amount>=1024;index+=1){ amount/=1024; unit=units[index]; }
  return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${unit}`;
};
const formatBitrate = value => {
  const bps=Math.max(0,Number(value || 0));
  if (bps<1000) return `${Math.round(bps)} bps`;
  if (bps<1000000) return `${(bps/1000).toFixed(bps>=100000?0:1)} Kbps`;
  return `${(bps/1000000).toFixed(bps>=10000000?1:2)} Mbps`;
};
const formatDuration = value => {
  const seconds=Math.max(0,Math.floor(Number(value || 0))),hours=Math.floor(seconds/3600),minutes=Math.floor((seconds%3600)/60),remaining=seconds%60;
  if(hours) return `${hours}j ${minutes}m`;
  if(minutes) return `${minutes}m ${remaining}d`;
  return `${remaining} detik`;
};
function chartTimeLabel(value) {
  const date=new Date(value);
  if(adminMonitoring.range==='7d') return date.toLocaleDateString('id-ID',{ day:'numeric',month:'short' });
  return date.toLocaleTimeString('id-ID',{ hour:'2-digit',minute:'2-digit' });
}
function niceChartMaximum(value) {
  const maximum=Math.max(1,Number(value || 0)),magnitude=10 ** Math.floor(Math.log10(maximum)),normalized=maximum/magnitude;
  return (normalized<=1?1:normalized<=2?2:normalized<=5?5:10)*magnitude;
}
function renderGlobalTrafficChart(timeline=[],hasHistory=false) {
  const container=$('#global-traffic-chart');
  if(!hasHistory || !timeline.length){ container.innerHTML='<div class="chart-empty">Menunggu histori counter dari gateway. Grafik mulai terisi otomatis ketika pengguna aktif memakai internet.</div>'; return; }
  const width=760,height=255,padding={ top:18,right:14,bottom:31,left:55 },chartWidth=width-padding.left-padding.right,chartHeight=height-padding.top-padding.bottom;
  const maximum=niceChartMaximum(Math.max(...timeline.flatMap(point=>[Number(point.incoming_bps||0),Number(point.outgoing_bps||0)])));
  const x=index=>padding.left+(timeline.length===1?chartWidth/2:(index/(timeline.length-1))*chartWidth);
  const y=value=>padding.top+chartHeight-(Math.max(0,Number(value||0))/maximum)*chartHeight;
  const pathFor=key=>timeline.map((point,index)=>`${index?'L':'M'} ${x(index).toFixed(2)} ${y(point[key]).toFixed(2)}`).join(' ');
  const downloadPath=pathFor('incoming_bps'),uploadPath=pathFor('outgoing_bps');
  const downloadArea=`${downloadPath} L ${x(timeline.length-1).toFixed(2)} ${(padding.top+chartHeight).toFixed(2)} L ${x(0).toFixed(2)} ${(padding.top+chartHeight).toFixed(2)} Z`;
  const grid=[0,.25,.5,.75,1].map(ratio=>{ const lineY=padding.top+chartHeight-ratio*chartHeight; return `<line class="chart-grid" x1="${padding.left}" y1="${lineY}" x2="${width-padding.right}" y2="${lineY}"/><text class="chart-axis-label" x="${padding.left-8}" y="${lineY+3}" text-anchor="end">${escapeHtml(formatBitrate(maximum*ratio))}</text>`; }).join('');
  const labelIndexes=[0,Math.round((timeline.length-1)/3),Math.round((timeline.length-1)*2/3),timeline.length-1].filter((value,index,array)=>array.indexOf(value)===index);
  const xLabels=labelIndexes.map(index=>`<text class="chart-axis-label" x="${x(index)}" y="${height-8}" text-anchor="${index===0?'start':index===timeline.length-1?'end':'middle'}">${escapeHtml(chartTimeLabel(timeline[index].at))}</text>`).join('');
  const pointStep=Math.max(1,Math.ceil(timeline.length/12));
  const points=timeline.map((point,index)=>index%pointStep===0||index===timeline.length-1 ? `<circle class="chart-point download" cx="${x(index)}" cy="${y(point.incoming_bps)}" r="3"><title>${escapeHtml(`${chartTimeLabel(point.at)} · Download ${formatBitrate(point.incoming_bps)}`)}</title></circle><circle class="chart-point upload" cx="${x(index)}" cy="${y(point.outgoing_bps)}" r="3"><title>${escapeHtml(`${chartTimeLabel(point.at)} · Upload ${formatBitrate(point.outgoing_bps)}`)}</title></circle>`:'').join('');
  container.innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Grafik bandwidth gabungan download dan upload"><defs><linearGradient id="traffic-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#08a69c" stop-opacity=".24"/><stop offset="1" stop-color="#08a69c" stop-opacity="0"/></linearGradient></defs>${grid}${xLabels}<path class="chart-area" d="${downloadArea}"/><path class="download-line" d="${downloadPath}"/><path class="upload-line" d="${uploadPath}"/>${points}</svg>`;
}
function chartBarWidths(item) {
  const incoming=Number(item.incoming_bytes||0),outgoing=Number(item.outgoing_bytes||0),historical=incoming+outgoing;
  const liveIncoming=Number(item.incoming_bps||0),liveOutgoing=Number(item.outgoing_bps||0),live=liveIncoming+liveOutgoing;
  const total=historical||live;
  return { metric:total,incomingPercent:total?((historical?incoming:liveIncoming)/total)*100:0,outgoingPercent:total?((historical?outgoing:liveOutgoing)/total)*100:0 };
}
function renderSsidUsageChart(rows=[]) {
  const container=$('#ssid-usage-chart');
  if(!rows.length){ container.innerHTML='<div class="chart-empty compact">Belum ada SSID pada jaringan yang dipilih.</div>'; return; }
  const metrics=rows.map(chartBarWidths),maximum=Math.max(1,...metrics.map(item=>item.metric));
  container.innerHTML=rows.map((row,index)=>{ const widths=metrics[index],barWidth=widths.metric?Math.max(2,(widths.metric/maximum)*100):0,live=Number(row.incoming_bps||0)+Number(row.outgoing_bps||0); return `<div class="bar-chart-row"><div class="bar-chart-meta"><div class="bar-chart-identity"><b>${escapeHtml(row.ssid)}</b><small>${escapeHtml(`${row.active_users||0} pengguna aktif`)}</small></div><div class="bar-chart-value"><b>${escapeHtml(formatBytes(row.total_bytes))}</b><small>${escapeHtml(`Live ${formatBitrate(live)}`)}</small></div></div><div class="bar-track" title="${escapeHtml(`${row.ssid}: ${formatBytes(row.total_bytes)}`)}"><div class="bar-fill" style="width:${barWidth.toFixed(2)}%"><span class="download" style="width:${widths.incomingPercent.toFixed(2)}%"></span><span class="upload" style="width:${widths.outgoingPercent.toFixed(2)}%"></span></div></div></div>`; }).join('');
}
function renderUserUsageChart(rows=[]) {
  const container=$('#user-usage-chart');
  if(!rows.length){ container.innerHTML='<div class="chart-empty compact">Belum ada pemakaian pengguna pada periode ini.</div>'; return; }
  const metrics=rows.map(chartBarWidths),maximum=Math.max(1,...metrics.map(item=>item.metric));
  container.innerHTML=rows.map((row,index)=>{ const widths=metrics[index],barWidth=widths.metric?Math.max(2,(widths.metric/maximum)*100):0,live=Number(row.incoming_bps||0)+Number(row.outgoing_bps||0),access=row.access_type==='limited'?'Free':'Akun'; return `<div class="bar-chart-row"><div class="bar-chart-meta"><div class="bar-chart-identity"><b>${escapeHtml(row.name)}<span class="user-access ${row.access_type==='limited'?'limited':''}">${access}</span></b><small>${escapeHtml(`${row.detail} · ${row.ssid}`)}</small></div><div class="bar-chart-value"><b>${escapeHtml(formatBytes(row.total_bytes))}</b><small>${escapeHtml(`${row.active?'Aktif':'Offline'} · ${formatBitrate(live)} · ${formatDuration(row.duration_seconds)}`)}</small></div></div><div class="bar-track" title="${escapeHtml(`${row.name}: ${formatBytes(row.total_bytes)}`)}"><div class="bar-fill user" style="width:${barWidth.toFixed(2)}%"></div></div></div>`; }).join('');
}
function renderAdminMonitoring(result) {
  const summary=result.summary||{},combined=Number(summary.incoming_bps||0)+Number(summary.outgoing_bps||0);
  $('#monitoring-live-rate').textContent=formatBitrate(combined);
  $('#monitoring-live-split').textContent=`↓ ${formatBitrate(summary.incoming_bps)} · ↑ ${formatBitrate(summary.outgoing_bps)}`;
  $('#monitoring-usage-label').textContent=`Pemakaian ${result.range_label}`;
  $('#monitoring-total-usage').textContent=formatBytes(summary.total_bytes);
  $('#monitoring-usage-split').textContent=`↓ ${formatBytes(summary.incoming_bytes)} · ↑ ${formatBytes(summary.outgoing_bytes)}`;
  $('#monitoring-active-users').textContent=summary.active_users||0;
  $('#monitoring-active-devices').textContent=`${summary.active_devices||0} perangkat terhubung`;
  $('#monitoring-ssid-total').textContent=summary.ssid_count||0;
  $('#monitoring-tracked-devices').textContent=`${summary.tracked_devices||0} perangkat mengirim counter`;
  $('#ssid-period-label').textContent=result.range_label;
  $('#user-period-label').textContent=`Top 12 · ${result.range_label}`;
  const source=$('#monitoring-source-status');
  source.textContent=result.has_history ? `${result.sample_count.toLocaleString('id-ID')} sampel counter · histori disimpan ${result.retention_days} hari` : 'Grafik akan terisi setelah gateway mengirim callback counter.';
  source.classList.toggle('has-history',!!result.has_history);
  $('#monitoring-updated-at').textContent=`Diperbarui ${new Date(result.generated_at).toLocaleTimeString('id-ID',{ hour:'2-digit',minute:'2-digit',second:'2-digit' })}`;
  renderGlobalTrafficChart(result.timeline,result.has_history);
  renderSsidUsageChart(result.ssids);
  renderUserUsageChart(result.users);
}
async function loadAdminMonitoring({ silent=false }={}) {
  if(!isAdminView || adminMonitoring.loading) return;
  adminMonitoring.loading=true;
  try { const result=await api(`/api/admin/monitoring${scopeQuery({ range:adminMonitoring.range })}`); renderAdminMonitoring(result); updateMonitoringStatus('live'); }
  catch(error){ updateMonitoringStatus('error'); if(!silent) throw error; }
  finally { adminMonitoring.loading=false; }
}
function updateMonitoringStatus(state='live') {
  const status=$('#monitoring-status'); if(!status) return;
  status.classList.toggle('error',state==='error');
  status.classList.toggle('synced',state==='live');
  status.querySelector('small').textContent=state==='error' ? 'Sinkronisasi terputus' : `Diperbarui ${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
}
async function loadAdminLeads({ silent=false }={}) {
  if (leadsLoading) return;
  leadsLoading=true;
  try {
    const result = await api(`/api/admin/clients${scopeQuery({ page:adminTable.page,limit:adminTable.limit,category:adminTable.category,search:adminTable.search })}`);
    const { clients,stats,categories,pagination }=result;
    leads.splice(0, leads.length, ...clients.map(row => ({
      name:row.full_name || (row.category === 'free' ? 'Pengguna Free' : 'Perangkat belum login'), email:row.email || row.mac_address,
      ip:row.client_ip || '—', ssid:row.ssid || '—', mac:row.mac_address,
      time:formatTime(row.last_seen_at), initials:row.full_name ? row.full_name.split(' ').slice(0,2).map(part => part[0]).join('') : row.category === 'free' ? 'FR' : 'Wi',
      phone:row.phone_number || '—', address:row.address || '—', registered:!!row.email, category:row.category || 'pending',
      type:row.auth_status === 'pending' && row.authorized_until ? 'offline' : row.access_type === 'high_speed' ? 'high' : row.access_type === 'limited' ? 'limited' : 'pending', verified:!!row.is_verified,
      status:row.auth_status, gatewayId:row.gateway_id, gateway:row.gateway_name || row.gateway_id,
      gatewayLocation:row.gateway_location || '—', projectId:row.project_id, project:row.project_name || '—',
      incomingBps:row.incoming_bps,outgoingBps:row.outgoing_bps,incomingBytes:row.incoming_bytes || 0,outgoingBytes:row.outgoing_bytes || 0,
      totalUsage:row.total_usage_bytes || 0,durationSeconds:row.duration_seconds || 0,telemetryStatus:row.telemetry_status || 'waiting'
    })));
    Object.assign(adminTable,pagination);
    $('#total-leads').textContent = stats.total;
    $('#today-leads').textContent = stats.today;
    $('#authorized-leads').textContent = stats.authorized;
    ['all','account','free','pending'].forEach(key=>{ $(`#category-count-${key}`).textContent=categories[key] || 0; });
    renderLeads(); updateMonitoringStatus('live'); updateTableRefreshStatus('live'); updateAdminRefreshStatus('live');
  } catch(error) {
    updateMonitoringStatus('error');
    if(!silent) throw error;
  } finally { leadsLoading=false; }
}
function renderLeads() {
  const access = { high:'High Speed', limited:'Limited', pending:'Menunggu login', offline:'Offline' };
  const categoryLabel={ account:'Pengguna Terdaftar',free:'Free / Limited',pending:'Belum Login' };
  $('#lead-rows').innerHTML = leads.map(l => {
    const bandwidth=l.telemetryStatus==='waiting' ? '<span class="telemetry-waiting">Menunggu telemetry</span>' : l.telemetryStatus==='ended' ? '<span class="telemetry-ended">Sesi selesai</span>' : `<span class="telemetry-rate"><b>↓ ${escapeHtml(formatBitrate(l.incomingBps))}</b><small>↑ ${escapeHtml(formatBitrate(l.outgoingBps))}</small></span>`;
    const usage=`<span class="usage-cell"><b>${escapeHtml(formatBytes(l.totalUsage))}</b><small>↓ ${escapeHtml(formatBytes(l.incomingBytes))} · ↑ ${escapeHtml(formatBytes(l.outgoingBytes))}</small></span>`;
    return `<tr><td data-label="Pengunjung"><div class="user-cell"><span class="avatar">${escapeHtml(l.initials)}</span><div><b>${escapeHtml(l.name)}</b><span>${escapeHtml(l.email)}</span>${l.type === 'high' && l.verified ? '<em class="verified-status">✓ Email terverifikasi</em>' : ''}</div></div></td><td data-label="Kategori"><span class="category-badge ${escapeHtml(l.category)}">${escapeHtml(categoryLabel[l.category] || categoryLabel.pending)}</span></td><td data-label="Project"><span class="network-cell"><b>${escapeHtml(l.project)}</b></span></td><td data-label="Gateway"><span class="network-cell"><b>${escapeHtml(l.gateway)}</b><small>${escapeHtml(l.gatewayId)}</small></span></td><td data-label="Nomor HP">${escapeHtml(l.phone)}</td><td data-label="Alamat" class="address-cell">${escapeHtml(l.address)}</td><td data-label="IP Klien">${escapeHtml(l.ip)}</td><td data-label="Status"><span class="access-badge ${l.type}">${access[l.type]}</span></td><td data-label="Bandwidth">${bandwidth}</td><td data-label="Durasi Login"><span class="duration-cell">${escapeHtml(formatDuration(l.durationSeconds))}</span></td><td data-label="Data Terpakai">${usage}</td><td data-label="SSID">${escapeHtml(l.ssid)}</td><td data-label="Terakhir terlihat">${escapeHtml(l.time)}</td><td data-label="MAC" class="device-cell">${escapeHtml(l.mac)}</td><td data-label="Aksi" class="action-cell"><button class="delete-client" type="button" data-gateway="${escapeHtml(l.gatewayId)}" data-mac="${escapeHtml(l.mac)}" aria-label="Hapus ${escapeHtml(l.name)}">Hapus data</button></td></tr>`;
  }).join('') || '<tr class="empty-row"><td colspan="15" class="empty-state">Belum ada perangkat pada kategori atau pencarian ini.</td></tr>';
  const start=adminTable.total ? (adminTable.page-1)*adminTable.limit+1 : 0,end=Math.min(adminTable.page*adminTable.limit,adminTable.total);
  $('#result-count').textContent=`Menampilkan ${start}–${end} dari ${adminTable.total} perangkat`;
  $('#page-indicator').textContent=`${adminTable.page} / ${adminTable.totalPages}`;
  $('#page-prev').disabled=adminTable.page<=1;
  $('#page-next').disabled=adminTable.page>=adminTable.totalPages;
}
function renderRegisteredUsers() {
  $('#profile-rows').innerHTML=registeredUsers.map(user=>{
    const initials=user.full_name.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
    const activity=user.last_seen_at
      ? `<span class="profile-activity"><b>${escapeHtml(relativeTime(user.last_seen_at))}</b><small>${escapeHtml(user.project_name || 'Project tidak tersedia')} · ${escapeHtml(user.gateway_name || 'Gateway tidak tersedia')}</small><em>${Number(user.device_count || 0)} perangkat · ${Number(user.login_count || 0)} login</em></span>`
      : '<span class="profile-activity empty"><b>Belum pernah login</b><small>Akun belum terhubung ke perangkat</small></span>';
    return `<tr><td data-label="Nama"><div class="profile-user-cell"><span class="avatar">${escapeHtml(initials || 'PN')}</span><div><b>${escapeHtml(user.full_name)}</b><small>ID ${escapeHtml(user.id.slice(0,8))}</small></div></div></td><td data-label="Email"><span class="profile-email">${escapeHtml(user.email)}</span></td><td data-label="Nomor HP">${escapeHtml(user.phone_number)}</td><td data-label="Alamat" class="profile-address-cell">${escapeHtml(user.address)}</td><td data-label="Verifikasi"><span class="verification-badge ${user.is_verified ? 'verified':'unverified'}">${user.is_verified ? '✓ Terverifikasi':'! Perlu ditinjau'}</span></td><td data-label="Aktivitas">${activity}</td><td data-label="Terdaftar">${escapeHtml(formatTime(user.created_at))}</td><td data-label="Aksi"><div class="profile-row-actions"><button class="edit-profile" type="button" data-user-id="${escapeHtml(user.id)}">Edit</button><button class="delete-profile" type="button" data-user-id="${escapeHtml(user.id)}">Hapus</button></div></td></tr>`;
  }).join('') || '<tr class="empty-row"><td colspan="8" class="empty-state">Tidak ada pengguna pada pencarian atau filter ini.</td></tr>';
  const start=adminUsers.total ? (adminUsers.page-1)*adminUsers.limit+1 : 0;
  const end=Math.min(adminUsers.page*adminUsers.limit,adminUsers.total);
  $('#profile-result-count').textContent=`Menampilkan ${start}–${end} dari ${adminUsers.total} pengguna`;
  $('#profile-page-indicator').textContent=`${adminUsers.page} / ${adminUsers.totalPages}`;
  $('#profile-page-prev').disabled=adminUsers.page<=1;
  $('#profile-page-next').disabled=adminUsers.page>=adminUsers.totalPages;
}
async function loadAdminUsers({ silent=false }={}) {
  if(!isAdminView || usersLoading) return;
  usersLoading=true;
  const refreshButton=$('#users-refresh');
  try {
    const query=new URLSearchParams({ page:String(adminUsers.page),limit:String(adminUsers.limit),verification:adminUsers.verification });
    if(adminUsers.search) query.set('search',adminUsers.search);
    const result=await api(`/api/admin/users?${query}`);
    registeredUsers.splice(0,registeredUsers.length,...result.users);
    Object.assign(adminUsers,result.pagination);
    $('#profile-total').textContent=result.stats.total;
    $('#profile-verified').textContent=result.stats.verified;
    $('#profile-unverified').textContent=result.stats.unverified;
    $('#profile-sync-status').textContent=`Sinkron ${refreshClock()}`;
    $('#profile-sync-status').classList.remove('error');
    renderRegisteredUsers();
    updateAdminRefreshStatus('live');
  } catch(error) {
    $('#profile-sync-status').textContent='Sinkronisasi gagal';
    $('#profile-sync-status').classList.add('error');
    if(!silent) throw error;
  } finally {
    usersLoading=false;
    setRefreshLoading(refreshButton,false);
  }
}
function openAdminUserEditor(user=null) {
  const creating=!user;
  const form=$('#admin-user-form');
  form.reset();
  $('#admin-user-id').value=user?.id || '';
  $('#admin-user-name').value=user?.full_name || '';
  $('#admin-user-email').value=user?.email || '';
  $('#admin-user-phone').value=user?.phone_number || '';
  $('#admin-user-address').value=user?.address || '';
  $('#admin-user-password').required=creating;
  $('#admin-user-password-field').hidden=!creating;
  $('#admin-user-verification').hidden=creating;
  $('#admin-user-modal-eyebrow').textContent=creating ? 'Buat akun dari dashboard':'Perbaiki data pelanggan';
  $('#admin-user-modal-title').textContent=creating ? 'Tambah Pengguna':'Edit Data Pengguna';
  $('#admin-user-verification').classList.toggle('unverified',!creating && !user.is_verified);
  $('#admin-user-verification-copy').textContent=user?.is_verified ? 'Terverifikasi' : 'Belum terverifikasi';
  $('.admin-user-note').textContent=creating
    ? 'Akun yang dibuat administrator langsung terverifikasi dan dapat dipakai login menggunakan email serta kata sandi yang dibuat.'
    : 'Mengubah email juga mengubah email yang digunakan pelanggan untuk login berikutnya. Kata sandi lama tidak berubah saat data diedit.';
  $('#admin-user-feedback').textContent='';
  $('#admin-user-modal').classList.add('open');
  $('#admin-user-modal').setAttribute('aria-hidden','false');
  document.body.classList.add('admin-modal-open');
  setTimeout(()=>$('#admin-user-name').focus(),80);
}
function closeAdminUserEditor() {
  $('#admin-user-modal').classList.remove('open');
  $('#admin-user-modal').setAttribute('aria-hidden','true');
  document.body.classList.remove('admin-modal-open');
}
function projectOptions(selected='') { return networkCatalog.projects.map(project=>`<option value="${escapeHtml(project.id)}" ${project.id===selected?'selected':''}>${escapeHtml(project.name)}</option>`).join(''); }
function managedGateways() { return networkCatalog.gateways.filter(gateway=>gateway.id!=='unassigned'); }
function visibleGateways() { return managedGateways().filter(gateway=>gateway.approval_status==='approved'); }
function workspaceInitials(value='') { return String(value).trim().split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase() || 'PN'; }
function renderWorkspaceMenu() {
  const allActive=!adminScope.projectId && !adminScope.gatewayId;
  const allOption=`<button class="workspace-option ${allActive?'active':''}" type="button" role="menuitemradio" aria-checked="${allActive}" data-project-id="" data-gateway-id=""><span class="workspace-option-icon">ALL</span><span class="workspace-option-copy"><b>Semua jaringan</b><small>${networkCatalog.projects.length} project · ${visibleGateways().length} gateway</small></span><span class="workspace-check">✓</span></button>`;
  const projects=networkCatalog.projects.map(project=>{
    const projectActive=adminScope.projectId===project.id && !adminScope.gatewayId;
    const projectGateways=visibleGateways().filter(gateway=>gateway.project_id===project.id);
    const projectOption=`<button class="workspace-option ${projectActive?'active':''}" type="button" role="menuitemradio" aria-checked="${projectActive}" data-project-id="${escapeHtml(project.id)}" data-gateway-id=""><span class="workspace-option-icon">${escapeHtml(workspaceInitials(project.name))}</span><span class="workspace-option-copy"><b>${escapeHtml(project.name)}</b><small>${projectGateways.length} gateway${project.location?` · ${escapeHtml(project.location)}`:''}</small></span><span class="workspace-check">✓</span></button>`;
    const gatewayOptions=projectGateways.map(gateway=>{ const active=adminScope.gatewayId===gateway.id; return `<button class="workspace-option gateway ${gateway.status==='online'?'online':''} ${active?'active':''}" type="button" role="menuitemradio" aria-checked="${active}" data-project-id="${escapeHtml(project.id)}" data-gateway-id="${escapeHtml(gateway.id)}"><span class="workspace-option-icon"><i></i></span><span class="workspace-option-copy"><b>${escapeHtml(gateway.name)}</b><small>${gateway.status==='online'?'Online':'Offline'} · ${gateway.client_count||0} perangkat</small></span><span class="workspace-check">✓</span></button>`; }).join('');
    return `<div class="workspace-project-group">${projectOption}${gatewayOptions}</div>`;
  }).join('');
  $('#workspace-options').innerHTML=allOption+projects;
}
function renderGatewayCards() {
  const gateways=managedGateways();
  $('#gateway-list').innerHTML=gateways.length ? gateways.map(gateway=>{
    const pending=gateway.approval_status!=='approved';
    return `<article class="gateway-card ${gateway.status} ${pending?'pending':''}"><header><div><span class="gateway-approval ${pending?'pending':'approved'}">${pending?'Menunggu verifikasi':'Terverifikasi'}</span><span class="gateway-status"><i></i>${gateway.status==='online'?'Online':'Offline'}</span><h3>${escapeHtml(gateway.name)}</h3><code>${escapeHtml(gateway.id)}</code></div><span class="gateway-client-count"><b>${gateway.client_count || 0}</b><small>perangkat</small></span></header><form class="gateway-form" data-gateway-id="${escapeHtml(gateway.id)}"><label>Project<select name="projectId">${projectOptions(gateway.project_id)}</select></label><label>Nama gateway<input name="name" value="${escapeHtml(gateway.name)}" placeholder="Nama gateway" required /></label><div class="gateway-form-grid"><label>Lokasi<input name="location" value="${escapeHtml(gateway.location || '')}" placeholder="Lokasi pemasangan" /></label><label>Model<input name="model" value="${escapeHtml(gateway.model || '')}" placeholder="Contoh: RG-EG105G-P-V3" /></label></div><div class="gateway-last-seen">Terakhir aktif: <b>${escapeHtml(relativeTime(gateway.last_seen_at))}</b></div><div class="gateway-actions"><button class="save-gateway" type="submit">Simpan identitas</button>${pending?'<button class="approve-gateway" type="button">Setujui Gateway</button>':''}<button class="delete-gateway" type="button">Hapus &amp; blokir</button></div><p class="gateway-feedback inline-feedback" role="status"></p></form></article>`;
  }).join('') : '<div class="gateway-empty">Gateway akan muncul sebagai pending setelah menerima koneksi Ruijie.</div>';
}
function renderBlockedGateways() {
  const blocked=networkCatalog.blockedGateways || [];
  $('#blocked-gateway-section').hidden=!blocked.length;
  $('#blocked-gateway-list').innerHTML=blocked.map(gateway=>`<article class="blocked-gateway-item"><div><b>${escapeHtml(gateway.gateway_id)}</b><span>Diblokir ${escapeHtml(relativeTime(gateway.blocked_at))}</span></div><button type="button" class="unblock-gateway" data-gateway-id="${escapeHtml(gateway.gateway_id)}">Buka blokir</button></article>`).join('');
}
function renderPortalNetworkRoutes() {
  const routes=networkCatalog.portalNetworks || [];
  const accountSsid=portalSettings.account_ssid || '@PERUMNET_WiFi';
  const freeSsid=portalSettings.free_ssid || '@PERUMNET_FreeWiFi';
  $('#portal-network-list').innerHTML=routes.length ? routes.map(route=>{
    const isFree=route.portal_mode==='free';
    const portalLabel=isFree?'Portal Free':'Portal Akun';
    const ssid=isFree?freeSsid:accountSsid;
    const pending=route.approval_status!=='approved';
    const description=route.network_description || '';
    return `<article class="portal-network-card ${isFree?'free':'account'} ${pending?'pending':''}"><header><span class="portal-route-icon">${isFree?'FR':'AC'}</span><div><small>${escapeHtml(route.project_name)} · ${escapeHtml(route.gateway_name)}${pending?' · Gateway pending':''}</small><h4>${escapeHtml(route.network_alias)}</h4><p class="portal-network-description">${escapeHtml(description || 'Deskripsi VLAN belum diisi')}</p></div><span class="portal-route-badge">${portalLabel}</span></header><div class="portal-route-meta"><span><small>Subnet VLAN</small><b>${escapeHtml(route.client_cidr || 'Belum tersedia')}</b></span><span><small>SSID ditampilkan</small><b>${escapeHtml(ssid)}</b></span><span><small>Terakhir terlihat</small><b>${escapeHtml(relativeTime(route.last_seen_at))}</b></span></div><form class="portal-route-form" data-gateway-id="${escapeHtml(route.gateway_id)}" data-network-alias="${escapeHtml(route.network_alias)}"><label class="portal-description-field">Deskripsi VLAN<input name="networkDescription" value="${escapeHtml(description)}" maxlength="160" placeholder="Contoh: Free WiFi atau User High Speed" /></label><label>Jenis portal<select name="portalMode"><option value="account" ${isFree?'':'selected'}>Portal Akun · Login/Daftar</option><option value="free" ${isFree?'selected':''}>Portal Free · One Click</option></select></label><button type="submit">Simpan routing</button><p class="inline-feedback portal-route-feedback" role="status"></p></form></article>`;
  }).join('') : '<div class="gateway-empty">Jaringan akan muncul setelah menerima redirect WiFiDog dari Ruijie.</div>';
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
  renderWorkspaceMenu();
}
async function loadAdminNetwork() {
  networkCatalog=await api('/api/admin/network');
  renderScopeOptions(); renderGatewayCards(); renderBlockedGateways(); renderPortalNetworkRoutes();
  $('#network-project-total').textContent=networkCatalog.projects.length;
  $('#network-gateway-total').textContent=managedGateways().length;
  $('#network-online-total').textContent=visibleGateways().filter(gateway=>gateway.status==='online').length;
  $('#network-pending-total').textContent=managedGateways().filter(gateway=>gateway.approval_status!=='approved').length;
  $('#gateway-sync-time').textContent=`Disinkronkan ${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`;
}
function activateAdminTab(requestedTab='leads',{ updateHash=true }={}) {
  const tab=['leads','users','network','settings'].includes(requestedTab) ? requestedTab : 'leads';
  document.querySelectorAll('.nav-item').forEach(item=>item.classList.toggle('active',item.dataset.tab===tab));
  document.querySelectorAll('.tab-content').forEach(content=>content.classList.toggle('active',content.id===`${tab}-tab`));
  $('#dash-title').textContent={ leads:'Data Pengunjung',users:'Data Pengguna',network:'Project & Gateway',settings:'Pengaturan Portal' }[tab];
  if(updateHash) history.replaceState({},'',tab==='leads' ? '/admin' : `/admin#${tab}`);
  if(tab==='network') loadAdminNetwork().catch(error=>alert(error.message));
  if(tab==='leads') Promise.all([loadAdminLeads({ silent:true }),loadAdminMonitoring({ silent:true })]);
  if(tab==='users') loadAdminUsers({ silent:true });
  if(tab!=='users') closeAdminUserEditor();
  setNotificationPanel(false);
  setSidebar(false);
}
renderLeads();
loadPortalSettings();
async function restoreAdminSession() { if (!isAdminView) return; try { const session = await api('/api/admin/session'); $('#admin-email').textContent = session.email; await loadAdminNetwork(); await Promise.all([loadAdminLeads(),loadAdminMonitoring(),loadNotifications()]); updateAdminRefreshStatus('live'); show('dashboard'); activateAdminTab(location.hash.slice(1) || 'leads',{ updateHash:false }); startNotificationPolling(); startMonitoringPolling(); } catch { show('login'); } }
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
$('#login-form').addEventListener('submit', async e => { e.preventDefault(); const fields = e.currentTarget.querySelectorAll('input'); try { await api('/api/admin/login', { email:fields[0].value, password:fields[1].value }); location.replace('/admin'); } catch (error) { alert(error.message); } }); $('#logout').onclick = async () => { clearInterval(notificationTimer); clearInterval(monitoringTimer); clearInterval(analyticsTimer); try { await api('/api/admin/logout', {}); } finally { location.assign('/'); } };
function setWorkspaceMenu(open) { $('.workspace-switcher').classList.toggle('open',open); $('#workspace-toggle').setAttribute('aria-expanded',String(open)); }
async function applyAdminScope(projectId='',gatewayId='') {
  const gateway=networkCatalog.gateways.find(item=>item.id===gatewayId);
  adminScope.gatewayId=gateway?.id || '';
  adminScope.projectId=gateway?.project_id || projectId;
  adminTable.page=1;
  renderScopeOptions();
  setWorkspaceMenu(false);
  await Promise.all([loadAdminLeads(),loadAdminMonitoring(),loadNotifications()]);
}
function setSidebar(open) { document.body.classList.toggle('sidebar-open',open); $('#sidebar-toggle').setAttribute('aria-expanded',String(open)); if(!open) setWorkspaceMenu(false); }
$('#sidebar-toggle').onclick = () => setSidebar(!document.body.classList.contains('sidebar-open')); $('#sidebar-backdrop').onclick = () => setSidebar(false);
$('#workspace-toggle').onclick=event=>{ event.stopPropagation(); setWorkspaceMenu(!$('.workspace-switcher').classList.contains('open')); };
$('#workspace-close').onclick=event=>{ event.stopPropagation(); setWorkspaceMenu(false); $('#workspace-toggle').focus(); };
$('#workspace-menu').onclick=async event=>{ event.stopPropagation(); const option=event.target.closest('.workspace-option'); if(!option) return; option.disabled=true; try { const shouldCloseSidebar=matchMedia('(max-width:1100px)').matches; await applyAdminScope(option.dataset.projectId||'',option.dataset.gatewayId||''); if(shouldCloseSidebar) setSidebar(false); } catch(error){ alert(error.message); option.disabled=false; } };
$('#admin-refresh').onclick=()=>refreshAdminData().catch(error=>alert(error.message));
$('#notification-toggle').onclick = event => { event.stopPropagation(); setNotificationPanel(!$('#notification-panel').classList.contains('open')); };
$('#notification-panel').onclick = event => event.stopPropagation();
$('#notification-read-all').onclick = async () => { try { await api(`/api/admin/notifications/read${scopeQuery()}`, {}); await loadNotifications(); } catch (error) { alert(error.message); } };
document.addEventListener('click', () => { setNotificationPanel(false); setWorkspaceMenu(false); });
document.querySelectorAll('.nav-item').forEach(item => item.onclick = () => activateAdminTab(item.dataset.tab));
document.addEventListener('keydown',event=>{ if(event.key==='Escape'){ if($('#admin-user-modal').classList.contains('open')) closeAdminUserEditor(); else if($('.workspace-switcher').classList.contains('open')) setWorkspaceMenu(false); else if($('#notification-panel').classList.contains('open')) setNotificationPanel(false); else if(document.body.classList.contains('sidebar-open')) setSidebar(false); else if(screens.forgotPassword.classList.contains('active')) closeForgotPassword(); else if(screens.userLogin.classList.contains('active')) showAccessChoice(); } });
$('#scope-project').addEventListener('change',event=>applyAdminScope(event.target.value,'').catch(error=>alert(error.message)));
$('#scope-gateway').addEventListener('change',event=>applyAdminScope(adminScope.projectId,event.target.value).catch(error=>alert(error.message)));
$('#project-form').addEventListener('submit',async event=>{ event.preventDefault(); const form=event.currentTarget,button=form.querySelector('button'),feedback=$('#project-feedback'),data=new FormData(form); button.disabled=true; feedback.textContent=''; try { await api('/api/admin/projects',{ name:data.get('name'),location:data.get('location') }); form.reset(); feedback.textContent='Project berhasil ditambahkan.'; feedback.classList.add('success'); await loadAdminNetwork(); } catch(error){ feedback.textContent=error.message; feedback.classList.remove('success'); } finally { button.disabled=false; } });
$('#gateway-list').addEventListener('submit',async event=>{ const form=event.target.closest('.gateway-form'); if(!form) return; event.preventDefault(); const button=form.querySelector('button[type="submit"]'),feedback=form.querySelector('.gateway-feedback'),data=new FormData(form); button.disabled=true; feedback.textContent='Menyimpan…'; try { await api('/api/admin/gateways',{ gatewayId:form.dataset.gatewayId,projectId:data.get('projectId'),name:data.get('name'),location:data.get('location'),model:data.get('model') }); feedback.textContent='Identitas gateway tersimpan.'; feedback.classList.add('success'); await loadAdminNetwork(); await loadAdminLeads(); } catch(error){ feedback.textContent=error.message; feedback.classList.remove('success'); } finally { button.disabled=false; } });
$('#gateway-list').addEventListener('click',async event=>{
  const approveButton=event.target.closest('.approve-gateway'),deleteButton=event.target.closest('.delete-gateway');
  if(!approveButton && !deleteButton) return;
  const form=event.target.closest('.gateway-form'),gatewayId=form?.dataset.gatewayId;
  if(!form || !gatewayId) return;
  if(approveButton){
    if(!confirm(`Setujui gateway ${gatewayId}?\n\nSetelah disetujui, gateway dapat membuat token login sesuai routing VLAN yang Anda atur.`)) return;
    const data=new FormData(form);
    approveButton.disabled=true;
    try{
      await api('/api/admin/gateways',{ gatewayId,projectId:data.get('projectId'),name:data.get('name'),location:data.get('location'),model:data.get('model') });
      await api('/api/admin/gateways/approval',{ gatewayId });
      await loadAdminNetwork();
      alert('Gateway berhasil diverifikasi dan sekarang dapat menggunakan captive portal.');
    }catch(error){ alert(error.message); approveButton.disabled=false; }
    return;
  }
  const gateway=managedGateways().find(item=>item.id===gatewayId);
  const message=`Hapus dan blokir ${gateway?.name || gatewayId}?\n\nSeluruh client, sesi, histori monitoring, notifikasi, dan routing VLAN pada gateway ini akan dihapus. ID yang sama tidak dapat muncul kembali sebelum blokir dibuka.`;
  if(!confirm(message)) return;
  deleteButton.disabled=true;
  try{
    await api('/api/admin/gateways',{ gatewayId },'DELETE');
    if(adminScope.gatewayId===gatewayId){ adminScope.gatewayId=''; adminScope.projectId=''; }
    await Promise.all([loadAdminNetwork(),loadAdminLeads(),loadAdminMonitoring(),loadNotifications()]);
    alert('Gateway berhasil dihapus dan ID-nya telah diblokir.');
  }catch(error){ alert(error.message); deleteButton.disabled=false; }
});
$('#blocked-gateway-list').addEventListener('click',async event=>{
  const button=event.target.closest('.unblock-gateway');
  if(!button) return;
  const gatewayId=button.dataset.gatewayId;
  if(!confirm(`Buka blokir ${gatewayId}?\n\nGateway belum langsung dipercaya. Request berikutnya akan muncul kembali sebagai pending dan tetap harus disetujui admin.`)) return;
  button.disabled=true;
  try{ await api('/api/admin/gateway-blocks',{ gatewayId },'DELETE'); await loadAdminNetwork(); }
  catch(error){ alert(error.message); button.disabled=false; }
});
$('#portal-network-list').addEventListener('submit',async event=>{ const form=event.target.closest('.portal-route-form'); if(!form) return; event.preventDefault(); const button=form.querySelector('button[type="submit"]'),feedback=form.querySelector('.portal-route-feedback'),data=new FormData(form),portalMode=data.get('portalMode'),networkDescription=data.get('networkDescription'); button.disabled=true; feedback.textContent='Menyimpan routing…'; feedback.classList.remove('success'); try { await api('/api/admin/portal-networks',{ gatewayId:form.dataset.gatewayId,networkAlias:form.dataset.networkAlias,portalMode,networkDescription }); feedback.textContent='Routing dan deskripsi VLAN tersimpan.'; feedback.classList.add('success'); await loadAdminNetwork(); } catch(error){ feedback.textContent=error.message; } finally { button.disabled=false; } });
$('#search-input').addEventListener('input', event => { clearTimeout(searchTimer); adminTable.search=event.target.value.trim(); adminTable.page=1; searchTimer=setTimeout(()=>loadAdminLeads().catch(error=>alert(error.message)),280); });
$('#category-filter').addEventListener('click',event=>{ const button=event.target.closest('[data-category]'); if(!button || button.classList.contains('active')) return; document.querySelectorAll('#category-filter [data-category]').forEach(item=>item.classList.toggle('active',item===button)); adminTable.category=button.dataset.category; adminTable.page=1; loadAdminLeads().catch(error=>alert(error.message)); });
$('#monitoring-range').addEventListener('click',event=>{ const button=event.target.closest('[data-range]'); if(!button || button.classList.contains('active')) return; document.querySelectorAll('#monitoring-range [data-range]').forEach(item=>item.classList.toggle('active',item===button)); adminMonitoring.range=button.dataset.range; loadAdminMonitoring().catch(error=>alert(error.message)); });
$('#page-size').addEventListener('change',event=>{ adminTable.limit=Number(event.target.value)||10; adminTable.page=1; loadAdminLeads().catch(error=>alert(error.message)); });
$('#page-prev').onclick=()=>{ if(adminTable.page<=1) return; adminTable.page-=1; loadAdminLeads().catch(error=>alert(error.message)); };
$('#page-next').onclick=()=>{ if(adminTable.page>=adminTable.totalPages) return; adminTable.page+=1; loadAdminLeads().catch(error=>alert(error.message)); };
$('#table-refresh').onclick=()=>refreshTableData().catch(error=>alert(error.message));
$('#add-admin-user').onclick=()=>openAdminUserEditor();
document.querySelectorAll('[data-close-user-editor]').forEach(button=>button.onclick=closeAdminUserEditor);
$('#users-refresh').onclick=event=>{ if(usersLoading) return; setRefreshLoading(event.currentTarget,true); loadAdminUsers().catch(error=>alert(error.message)); };
$('#profile-verification-filter').onclick=event=>{ const button=event.target.closest('[data-verification]'); if(!button || button.classList.contains('active')) return; document.querySelectorAll('#profile-verification-filter [data-verification]').forEach(item=>item.classList.toggle('active',item===button)); adminUsers.verification=button.dataset.verification; adminUsers.page=1; loadAdminUsers().catch(error=>alert(error.message)); };
$('#profile-search').oninput=event=>{ clearTimeout(searchTimer); adminUsers.search=event.target.value.trim(); adminUsers.page=1; searchTimer=setTimeout(()=>loadAdminUsers().catch(error=>alert(error.message)),280); };
$('#profile-page-size').onchange=event=>{ adminUsers.limit=Number(event.target.value)||10; adminUsers.page=1; loadAdminUsers().catch(error=>alert(error.message)); };
$('#profile-page-prev').onclick=()=>{ if(adminUsers.page<=1) return; adminUsers.page-=1; loadAdminUsers().catch(error=>alert(error.message)); };
$('#profile-page-next').onclick=()=>{ if(adminUsers.page>=adminUsers.totalPages) return; adminUsers.page+=1; loadAdminUsers().catch(error=>alert(error.message)); };
$('#profile-rows').onclick=async event=>{
  const editButton=event.target.closest('.edit-profile'),deleteButton=event.target.closest('.delete-profile');
  if(!editButton && !deleteButton) return;
  const userId=(editButton || deleteButton).dataset.userId;
  const user=registeredUsers.find(item=>item.id===userId);
  if(!user) return;
  if(editButton){ openAdminUserEditor(user); return; }
  const detail=user.device_count
    ? `Akun dan ${user.device_count} perangkat terkait akan dihapus. Semua sesi WiFiDog aktif juga akan dicabut.`
    : 'Akun akan dihapus permanen dari database dan file CSV.';
  if(!confirm(`Hapus pengguna ${user.full_name}?\n\n${detail}`)) return;
  deleteButton.disabled=true;
  try {
    await api('/api/admin/users',{ userId:user.id },'DELETE');
    await Promise.all([loadAdminUsers(),loadAdminLeads(),loadAdminMonitoring(),loadNotifications()]);
    alert('Data pengguna berhasil dihapus dari database dan ekspor CSV.');
  } catch(error) { alert(error.message); deleteButton.disabled=false; }
};
$('#admin-user-form').onsubmit=async event=>{
  event.preventDefault();
  const form=event.currentTarget,data=new FormData(form),userId=data.get('userId'),creating=!userId;
  const button=$('#save-admin-user'),old=button.innerHTML,feedback=$('#admin-user-feedback');
  const payload={ userId,fullName:data.get('fullName'),email:data.get('email'),phone:data.get('phone'),address:data.get('address') };
  if(creating) payload.password=data.get('password');
  button.disabled=true; button.innerHTML=creating ? 'Membuat akun…':'Menyimpan…'; feedback.textContent='';
  try {
    await api('/api/admin/users',payload,creating ? 'POST':'PATCH');
    await Promise.all([loadAdminUsers(),loadAdminLeads()]);
    closeAdminUserEditor();
  } catch(error) { feedback.textContent=error.message; }
  finally { button.disabled=false; button.innerHTML=old; }
};
$('#users-export-csv').onclick=async event=>{
  const button=event.currentTarget,old=button.textContent; button.disabled=true; button.textContent='Menyiapkan CSV…';
  try {
    const response=await fetch('/api/admin/export.csv',{ credentials:'same-origin' });
    if(!response.ok) throw new Error('File CSV tidak dapat dibuat. Silakan login ulang.');
    const href=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');
    anchor.href=href; anchor.download='database-pengguna-perumnet.csv'; anchor.click();
    setTimeout(()=>URL.revokeObjectURL(href),1000);
  } catch(error) { alert(error.message); }
  finally { button.disabled=false; button.textContent=old; }
};
$('#lead-rows').addEventListener('click', async event => { const button=event.target.closest('.delete-client'); if (!button) return; const lead=leads.find(item=>item.mac===button.dataset.mac && item.gatewayId===button.dataset.gateway); if (!lead) return; const detail=lead.registered ? 'Akun, profil, seluruh perangkat terkait, histori monitoring, dan riwayat akses akan dihapus.' : `Perangkat, histori monitoring, dan riwayat one-click pada ${lead.gateway} akan dihapus.`; if (!confirm(`Hapus data ${lead.name}?\n\n${detail}\nOtorisasi WiFiDog juga akan dicabut.`)) return; button.disabled=true; try { const result=await api('/api/admin/clients',{ gatewayId:lead.gatewayId,macAddress:lead.mac },'DELETE'); await Promise.all([loadAdminNetwork(),loadAdminLeads(),loadAdminUsers(),loadAdminMonitoring(),loadNotifications()]); alert(result.deletedAccount ? 'Akun berhasil dihapus dan akses Ruijie dicabut.' : 'Data perangkat berhasil dihapus dan akses Ruijie dicabut.'); } catch(error) { alert(error.message); button.disabled=false; } });
$('#export-csv').onclick = async event => { const button=event.currentTarget,old=button.textContent; button.disabled=true; button.textContent='Menyiapkan CSV…'; try { const response=await fetch(`/api/admin/export.csv${scopeQuery()}`,{ credentials:'same-origin' }); if(!response.ok) throw new Error('File CSV tidak dapat dibuat. Silakan login ulang.'); const href=URL.createObjectURL(await response.blob()),a=document.createElement('a'); a.href=href; a.download=`pengguna-terdaftar-perumnet-${adminScope.gatewayId || adminScope.projectId || 'semua'}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(href),1000); } catch(error){ alert(error.message); } finally { button.disabled=false; button.textContent=old; } };
$('#settings-form').addEventListener('submit', async e => { e.preventDefault(); const accountSsid=$('#setting-account-ssid').value.trim() || '@PERUMNET_WiFi', freeSsid=$('#setting-free-ssid').value.trim() || '@PERUMNET_FreeWiFi', title=$('#setting-title').value || 'Masuk ke internet cepat.', copy=$('#setting-copy').value, terms=$('#setting-terms').value, bandwidth=Number($('#setting-bandwidth').value || 512); const b=e.currentTarget.querySelector('button'); const old=b.innerHTML; try { await api('/api/admin/settings', { accountSsid,freeSsid,welcomeTitle:title,welcomeText:copy,termsText:terms,limitedBandwidthKbps:bandwidth }); portalSettings={ ...portalSettings,account_ssid:accountSsid,free_ssid:freeSsid,default_ssid:accountSsid,welcome_title:title,welcome_text:copy,terms_text:terms,limited_bandwidth_kbps:bandwidth }; setWifiName(gatewaySsid || accountSsid); $('#portal-title').textContent=title; $('#portal-copy').textContent=copy; $('#account-profile-ssid').textContent=accountSsid; $('#free-profile-ssid').textContent=freeSsid; $('#preview-account-ssid').textContent=accountSsid; $('#preview-free-ssid').textContent=freeSsid; $('#preview-title').textContent=title; $('#preview-copy').textContent=copy; b.innerHTML='Tersimpan ✓'; } catch (error) { alert(error.message); } setTimeout(()=>b.innerHTML=old,1600); });
