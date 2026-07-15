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
assert.doesNotMatch(html, /<span>⚙<\/span>|<span>▦<\/span>/, 'Sidebar tidak boleh kembali memakai emoji sebagai ikon.');
assert.match(html, /placeholder="Username atau email"/, 'Login admin harus menyediakan placeholder identitas.');
assert.match(html, /placeholder="Masukkan kata sandi"/, 'Login admin harus menyediakan placeholder kata sandi.');
assert.doesNotMatch(html, /value="it@perumnet\.id"/, 'Login admin tidak boleh mengisi email secara statis.');
assert.match(app, /const destinationUrl = 'https:\/\/perumnet\.id'/, 'Tujuan redirect PerumNet harus tetap eksplisit.');
assert.match(app, /startDestinationRedirect\(\)/, 'Status koneksi harus memulai redirect otomatis.');
assert.match(app, /data-label="Nomor HP"/, 'Tabel mobile harus memiliki label kartu data.');
assert.match(app, /networkAliasPattern/, 'UI harus menolak network alias sebagai SSID.');
assert.match(app, /context\.wlan_name,context\.ssid_name,context\.essid,context\.wifi_name/, 'UI harus memprioritaskan parameter WLAN Ruijie.');
assert.match(css, /body\.admin-view \.sidebar \.sidebar-brand[^}]*background:transparent/, 'Logo admin harus menyatu dengan sidebar.');
assert.match(css, /@media\(max-width:760px\)/, 'Dashboard harus memiliki breakpoint kartu mobile.');

console.log('Responsive UI contract: PASS');
