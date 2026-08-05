import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');

// Evaluasi potongan sumber yang sebenarnya, bukan salinannya, supaya aturan
// domain tetap teruji walau kodenya nanti diubah.
const rulesStart = app.indexOf('const hostLanguageRules');
assert.ok(rulesStart !== -1, 'Blok aturan bahasa per domain tidak ditemukan di app.js.');
// Berhenti tepat di akhir IIFE hostLanguage, bukan pada penanda komentar, agar
// tetap tepat walau blok ini dipindah-pindah di dalam berkas.
const rulesEnd = app.indexOf('})();', app.indexOf('const hostLanguage =', rulesStart)) + '})();'.length;
const rulesSource = app.slice(rulesStart, rulesEnd);
assert.ok(rulesSource.includes('const hostLanguage ='), 'Resolver hostLanguage tidak ditemukan.');
assert.ok(!/isFreeView|isAdminView/.test(rulesSource), 'Blok aturan bahasa tidak boleh bergantung pada state tampilan.');

const resolveFor = hostname => {
  const factory = new Function('location', `${rulesSource}; return hostLanguage;`);
  return factory({ hostname });
};

assert.equal(resolveFor('hotspot.perumnet.com'), 'en', 'Domain .com harus membuka portal dalam Bahasa Inggris.');
assert.equal(resolveFor('hotspot.perumnet.id'), 'id', 'Domain .id harus membuka portal dalam Bahasa Indonesia.');
assert.equal(resolveFor('HOTSPOT.PERUMNET.COM'), 'en', 'Host huruf besar harus diperlakukan sama.');
assert.equal(resolveFor('hotspot.perumnet.com.'), 'en', 'Host dengan titik akhir harus tetap dikenali.');
assert.equal(resolveFor('perumnet.com'), 'en', 'Domain utama .com juga berbahasa Inggris.');
assert.equal(resolveFor('localhost'), null, 'Host di luar aturan harus memakai pengaturan admin, bukan dipaksa.');
assert.equal(resolveFor('127.0.0.1'), null, 'Akses lewat IP harus memakai pengaturan admin.');
assert.equal(resolveFor('hotspot.perumnet.net'), null, 'Domain lain harus memakai pengaturan admin.');

// Studio admin harus tetap membaca pengaturan asli, bukan hasil override, agar
// yang tersimpan tidak ikut berubah hanya karena admin membuka domain tertentu.
const editorSource = app.slice(app.indexOf('function hydratePortalEditor'), app.indexOf('function hydratePortalEditor') + 400);
assert.ok(editorSource.includes('normalizedPortalProfiles(settings)'),
  'Studio admin tidak boleh memakai publicPortalProfiles, karena override domain akan ikut tersimpan.');
assert.ok(!editorSource.includes('publicPortalProfiles'),
  'Studio admin tidak boleh terpengaruh override bahasa per domain.');

// Tampilan pengunjung harus melewati jalur yang menerapkan override.
for (const marker of ['function renderPublicPortalContent() {\n  const profiles=publicPortalProfiles();']) {
  assert.ok(app.includes(marker), 'Tampilan portal pengunjung harus memakai publicPortalProfiles.');
}

console.log('Portal language contract: PASS');
