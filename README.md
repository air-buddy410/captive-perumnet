# PerumNet Captive Portal

Jalankan aplikasi:

```bash
npm run dev
```

Portal tersedia di `http://localhost:3000`. Saat deployment, gunakan `https://hotspot.perumnet.id` sebagai `APP_BASE_URL`. SQLite dibuat otomatis di `data/portal.db`; email verifikasi development dicatat di `data/email-outbox.ndjson`.

## Integrasi Ruijie Reyee EG

Konfigurasikan gateway sebagai **Third-party Authentication** dan arahkan `Auth Server URL` ke URL publik aplikasi ini. Tambahkan parameter context gateway seperti `client_mac`, `client_ip`, `ssid`, `orig_url`, dan terutama `login_url`.

Gunakan `REYEE_AUTH_MODE=redirect` saat konfigurasi gateway telah siap. Jika gateway memakai **WiFiDog**, portal membaca `gw_address`, `gw_port`, MAC, dan gateway ID, membuat token unik jangka pendek yang disimpan sebagai hash, lalu mengarahkan browser ke endpoint lokal gateway (`/wifidog/auth`). Gateway mengonfirmasi token melalui `/auth/wifidogAuth/auth/?stage=login`; hanya token yang cocok dengan MAC dan belum kedaluwarsa yang menerima `Auth: 1`. TTL login token dapat diatur melalui `WIFIDOG_TOKEN_TTL_SECONDS` (default 300 detik), durasi High Speed melalui `WIFIDOG_SESSION_HOURS` (default 12 jam), dan durasi Limited melalui `WIFIDOG_LIMITED_SESSION_HOURS` (default 2 jam). Batas bandwidth Limited harus diterapkan sebagai Flow Control pada gateway karena trafik client tidak melewati server portal.

Dashboard membuat notifikasi ketika gateway mengonfirmasi login, serta ketika client logout, masa akses berakhir, atau heartbeat tidak lagi diterima. Batas client dianggap offline dapat diatur dengan `CLIENT_OFFLINE_MINUTES` (default 20 menit). Nilai ini sebaiknya lebih panjang dari interval counters/heartbeat pada gateway.

## Multi-project dan multi-gateway

Setiap nilai `gw_id` yang diterima dari Ruijie otomatis dibuat sebagai gateway di dashboard. Admin dapat mengelompokkan gateway ke beberapa project, mengisi nama, lokasi, dan model, lalu memfilter data perangkat serta notifikasi per project atau per gateway. Satu MAC yang berpindah gateway disimpan sebagai dua konteks perangkat terpisah sehingga status dan pencabutan akses tidak saling menimpa.

Database versi lama dimigrasikan otomatis saat aplikasi pertama kali dijalankan. Sebelum upgrade produksi, tetap buat salinan `data/portal.db`; deployment VPS pada project ini melakukan backup tersebut sebelum proses PM2 direstart.

Untuk deployment, gunakan HTTPS publik, set `APP_BASE_URL`, ganti semua credential default, lalu isi konfigurasi `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, dan `EMAIL_FROM` untuk email verifikasi.

Tautan lupa kata sandi memakai SMTP yang sama, hanya dapat digunakan satu kali, dan berlaku 30 menit. Durasi ini dapat diubah melalui `PASSWORD_RESET_MINUTES`.
