import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, css, app] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8')
]);

assert.match(html, /id="success-screen" class="success-page portal-modal"/, 'Status koneksi harus memakai modal.');
assert.match(html, /id="user-login-screen" class="login-page portal-modal"/, 'Login pelanggan harus memakai modal.');
assert.match(html, /id="sidebar-toggle"/, 'Dashboard harus menyediakan tombol navigasi mobile.');
assert.match(html, /class="nav-icon"[^>]*viewBox="0 0 24 24"/, 'Sidebar harus memakai ikon SVG yang konsisten.');
assert.match(html, /class="header-action"[^>]*id="notification-toggle"[^>]*title="Notifikasi"/, 'Header admin harus memakai tombol notifikasi SVG.');
assert.match(html, /id="notification-panel"/, 'Dashboard harus menyediakan panel aktivitas pelanggan.');
assert.match(html, /id="forgot-password-screen" class="login-page portal-modal"/, 'Portal harus menyediakan pemulihan kata sandi melalui email.');
assert.match(html, /id="reset-password-screen" class="login-page account-action-page"/, 'Tautan reset harus membuka halaman khusus di luar hotspot.');
assert.match(html, /id="account-status-screen" class="success-page account-action-page"/, 'Verifikasi email harus membuka halaman status khusus.');
assert.doesNotMatch(html, /class="bell">♢/, 'Header admin tidak boleh kembali memakai simbol berlian.');
assert.doesNotMatch(html, /class="privacy-note"><span>♢/, 'Catatan privasi tidak boleh memakai simbol berlian dekoratif.');
assert.match(html, /class="privacy-icon"[^>]*aria-hidden="true"><svg/, 'Catatan privasi harus memakai ikon shield-check SVG.');
assert.doesNotMatch(html, /penawaran dari Kopi Pagi/, 'Persetujuan data harus menggunakan identitas PerumNet.');
assert.doesNotMatch(html, /<span>⚙<\/span>|<span>▦<\/span>/, 'Sidebar tidak boleh kembali memakai emoji sebagai ikon.');
assert.doesNotMatch(html, /Email \/ Username|Username \/ Email|placeholder="Username atau email"/, 'Semua formulir login harus menggunakan email saja.');
assert.match(html, /<form id="login-form"><label>Email<input type="email" placeholder="nama@email\.com"/, 'Login admin harus meminta email secara eksplisit.');
assert.match(html, /placeholder="Masukkan kata sandi"/, 'Login admin harus menyediakan placeholder kata sandi.');
assert.doesNotMatch(html, /value="it@perumnet\.id"/, 'Login admin tidak boleh mengisi email secara statis.');
assert.match(app, /const destinationUrl = 'https:\/\/perumnet\.id'/, 'Tujuan redirect PerumNet harus tetap eksplisit.');
assert.match(app, /startDestinationRedirect\(\)/, 'Status koneksi harus memulai redirect otomatis.');
assert.match(app, /data-label="Nomor HP"/, 'Tabel mobile harus memiliki label kartu data.');
assert.match(app, /networkAliasPattern/, 'UI harus menolak network alias sebagai SSID.');
assert.match(app, /context\.wlan_name,context\.ssid_name,context\.essid,context\.wifi_name/, 'UI harus memprioritaskan parameter WLAN Ruijie.');
assert.match(app, /\/api\/admin\/notifications/, 'Dashboard harus memuat notifikasi pelanggan dari server.');
assert.match(app, /setInterval\(\(\) => loadNotifications/, 'Dashboard harus memperbarui notifikasi secara berkala.');
assert.match(app, /\/api\/auth\/forgot-password/, 'UI harus dapat meminta email reset kata sandi.');
assert.match(app, /\/api\/auth\/reset-password/, 'UI harus dapat menyimpan kata sandi baru.');
assert.match(app, /showAccountStatus\('Email berhasil diverifikasi\.','Kembali ke jendela login WiFi/, 'Verifikasi email tidak boleh mengarahkan user ke form hotspot.');
assert.match(css, /body\.admin-view \.sidebar \.sidebar-brand[^}]*background:transparent/, 'Logo admin harus menyatu dengan sidebar.');
assert.match(css, /@media\(max-width:760px\)/, 'Dashboard harus memiliki breakpoint kartu mobile.');
assert.match(css, /\.notification-panel\.open/, 'Panel notifikasi harus memiliki state terbuka yang jelas.');

console.log('Responsive UI contract: PASS');
