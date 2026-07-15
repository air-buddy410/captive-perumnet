# PerumNet Captive Portal

Jalankan aplikasi:

```bash
npm run dev
```

Portal tersedia di `http://localhost:3000`. Saat deployment, gunakan `https://hotspot.perumnet.id` sebagai `APP_BASE_URL`. SQLite dibuat otomatis di `data/portal.db`; email verifikasi development dicatat di `data/email-outbox.ndjson`.

## Integrasi Ruijie Reyee EG

Konfigurasikan gateway sebagai **Third-party Authentication** dan arahkan `Auth Server URL` ke URL publik aplikasi ini. Tambahkan parameter context gateway seperti `client_mac`, `client_ip`, `ssid`, `orig_url`, dan terutama `login_url`.

Gunakan `REYEE_AUTH_MODE=redirect` saat konfigurasi gateway telah siap. Jika gateway memakai **WiFiDog**, portal membaca `gw_address`, `gw_port`, MAC, dan gateway ID, membuat token unik jangka pendek yang disimpan sebagai hash, lalu mengarahkan browser ke endpoint lokal gateway (`/wifidog/auth`). Gateway mengonfirmasi token melalui `/auth/wifidogAuth/auth/?stage=login`; hanya token yang cocok dengan MAC dan belum kedaluwarsa yang menerima `Auth: 1`. TTL login token dapat diatur melalui `WIFIDOG_TOKEN_TTL_SECONDS` (default 300 detik) dan durasi session melalui `WIFIDOG_SESSION_HOURS` (default 12 jam). Untuk template generik, adapter tetap mengembalikan redirect ke `login_url` gateway dengan parameter username, password, dan `post_url`.

Untuk deployment, gunakan HTTPS publik, set `APP_BASE_URL`, ganti semua credential default, lalu ganti `sendVerification()` di `server.mjs` dengan provider SMTP/Resend pilihan Anda.
