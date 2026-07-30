# PerumNet Captive Portal

Jalankan aplikasi:

```bash
npm run dev
```

Portal tersedia di `http://localhost:3000`. Saat deployment, gunakan `https://hotspot.perumnet.com` sebagai `APP_BASE_URL`. SQLite dibuat otomatis di `data/portal.db`; email verifikasi development dicatat di `data/email-outbox.ndjson`.

## Integrasi Ruijie Reyee EG

Konfigurasikan gateway sebagai **Third-party Authentication** dengan satu `Auth Server URL` `https://hotspot.perumnet.com`. Portal memilih halaman secara dinamis berdasarkan routing VLAN pada setiap gateway:

- VLAN/SSID akun High Speed `@PERUMNET_WiFi` diarahkan ke portal login/daftar utama.
- VLAN/SSID gratis `@PERUMNET_FreeWiFi` dengan QoS Limited diarahkan otomatis ke halaman `/free`.

Jalur `/free` hanya menampilkan tombol One Click tanpa formulir. Server juga menerima callback WiFiDog dengan prefix `/free/auth/wifidogAuth/...` dan mengembalikan pengguna Limited ke `/free?connected=1` setelah gateway mengonfirmasi token. Tambahkan parameter context gateway seperti `client_mac`, `client_ip`, `ssid`, `orig_url`, dan terutama `login_url`.

Gunakan `REYEE_AUTH_MODE=redirect` saat konfigurasi gateway telah siap. Jika gateway memakai **WiFiDog**, portal membaca `gw_address`, `gw_port`, MAC, dan gateway ID, membuat token unik jangka pendek yang disimpan sebagai hash, lalu mengarahkan browser ke endpoint lokal gateway (`/wifidog/auth`). Gateway mengonfirmasi token melalui `/auth/wifidogAuth/auth/?stage=login`; hanya token yang cocok dengan MAC dan belum kedaluwarsa yang menerima `Auth: 1`. TTL login token dapat diatur melalui `WIFIDOG_TOKEN_TTL_SECONDS` (default 300 detik), durasi High Speed melalui `WIFIDOG_SESSION_HOURS` (default 12 jam), dan durasi Limited melalui `WIFIDOG_LIMITED_SESSION_HOURS` (default 2 jam). Batas bandwidth Limited harus diterapkan sebagai Flow Control pada gateway karena trafik client tidak melewati server portal.

Dashboard membuat notifikasi ketika gateway mengonfirmasi login, serta ketika client logout, masa akses berakhir, atau heartbeat tidak lagi diterima. Batas client dianggap offline dapat diatur dengan `CLIENT_OFFLINE_MINUTES` (default 20 menit). Nilai ini sebaiknya lebih panjang dari interval counters/heartbeat pada gateway.

Dashboard admin membaca callback WiFiDog `stage=counters` (`incoming` dan `outgoing`) untuk menampilkan bandwidth per interval, durasi login, serta total pemakaian data per perangkat. Tampilan diperbarui setiap 5 detik; angka berubah mengikuti interval counter yang dikirim firmware Reyee, bukan trafik yang melewati VPS. Bila gateway belum mengirim counter, dashboard menampilkan status **Menunggu telemetry**.

Setiap callback counter juga disimpan sebagai histori selama 30 hari. Panel grafik admin menyediakan periode 1 jam, 6 jam, 24 jam, dan 7 hari untuk melihat bandwidth gabungan, distribusi penggunaan setiap SSID, serta pengguna dengan trafik tertinggi. Semua grafik mengikuti filter project/gateway yang aktif dan diperbarui otomatis setiap 10 detik.

Daftar perangkat memakai pagination server dengan 10 baris sebagai default dan pilihan 25, 50, atau 100 baris. Filter kategori memisahkan **Online Sekarang**, **Pengguna Terdaftar**, **Free / Limited**, dan **Belum Login**. Ekspor CSV dibuat langsung dari data akun terdaftar; perangkat Free/Limited dan perangkat yang belum login tidak pernah dimasukkan ke file.

Panel laporan historis menyediakan ringkasan mingguan (7 hari) dan bulanan (30 hari) untuk seluruh gateway, satu project, atau satu gateway. Laporan menggabungkan data terpakai, durasi login, jumlah sesi, serta ringkasan per gateway dan dapat diekspor sebagai PDF A4 beridentitas PerumNet.

Bahasa Portal Akun dan Portal Free dapat diatur secara independen ke Bahasa Indonesia atau English melalui **Pengaturan Portal**. Sesi dashboard admin berlaku tiga jam secara default dan dapat disesuaikan melalui `ADMIN_SESSION_HOURS`.

## Multi-project dan multi-gateway

Setiap nilai `gw_id` yang diterima dari Ruijie otomatis dibuat sebagai gateway di dashboard. Admin dapat mengelompokkan gateway ke beberapa project, mengisi nama, lokasi, dan model, lalu memfilter data perangkat serta notifikasi per project atau per gateway. Satu MAC yang berpindah gateway disimpan sebagai dua konteks perangkat terpisah sehingga status dan pencabutan akses tidak saling menimpa.

Gateway yang dihapus masuk ke daftar blokir agar ID yang sama tidak dapat mendaftar kembali. Admin dapat membuka blokir untuk mengembalikannya sebagai gateway pending, atau menghapus catatannya dari tampilan dashboard sambil mempertahankan status blokir.

Database versi lama dimigrasikan otomatis saat aplikasi pertama kali dijalankan. Sebelum upgrade produksi, tetap buat salinan `data/portal.db`; deployment VPS pada project ini melakukan backup tersebut sebelum proses PM2 direstart.

Untuk deployment, gunakan HTTPS publik, set `APP_BASE_URL`, ganti semua credential default, lalu isi konfigurasi `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, dan `EMAIL_REPLY_TO` untuk email verifikasi. Gunakan mailbox serta app password khusus `no-reply@perumnet.id`, lalu arahkan balasan ke `it@perumnet.id`. Jika aplikasi menghubungi mail server melalui IP privat atau Tailscale, isi `SMTP_TLS_SERVERNAME` dengan hostname pada sertifikat TLS (misalnya `mail.perumnet.id`).

Tautan lupa kata sandi memakai SMTP yang sama, hanya dapat digunakan satu kali, dan berlaku 30 menit. Durasi ini dapat diubah melalui `PASSWORD_RESET_MINUTES`.
