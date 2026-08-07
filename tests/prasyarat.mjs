// Berkas ini sengaja tidak mengimpor apa pun dari aplikasi.
// Modul node:sqlite baru ada di Node 22.5, dan kalau versinya terlalu tua
// impor itu gagal dengan jejak galat internal Node yang sulit dibaca.
// Pemeriksaan di sini berjalan lebih dulu supaya pesannya jelas.
const MINIMAL = [22, 5];
const [mayor, minor] = process.versions.node.split('.').map(Number);

if (mayor < MINIMAL[0] || (mayor === MINIMAL[0] && minor < MINIMAL[1])) {
  console.error(`Node yang dipakai terlalu tua: v${process.versions.node} (${process.execPath})`);
  console.error(`Aplikasi ini butuh Node ${MINIMAL.join('.')} atau lebih baru karena memakai modul bawaan node:sqlite.`);
  console.error('Di server produksi, Node 22 ada di /home/perumnet/.local/node-v22/bin.');
  process.exit(1);
}
