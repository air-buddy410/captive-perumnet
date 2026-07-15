# PerumNet Captive Portal

Jalankan aplikasi:

```bash
npm run dev
```

Portal tersedia di `http://localhost:3000`. Saat deployment, gunakan `https://hotspot.perumnet.id` sebagai `APP_BASE_URL`. SQLite dibuat otomatis di `data/portal.db`; email verifikasi development dicatat di `data/email-outbox.ndjson`.

## Integrasi Ruijie Reyee EG

Konfigurasikan gateway sebagai **Third-party Authentication** dan arahkan `Auth Server URL` ke URL publik aplikasi ini. Tambahkan parameter context gateway seperti `client_mac`, `client_ip`, `ssid`, `orig_url`, dan terutama `login_url`.

Gunakan `REYEE_AUTH_MODE=redirect` saat konfigurasi gateway telah siap. Adapter akan mengembalikan redirect ke `login_url` gateway dengan parameter username, password, dan `post_url`. Nama parameter dapat disesuaikan melalui `.env` karena firmware/template Reyee dapat berbeda. Jangan gunakan mode redirect tanpa menguji template parameter pada EG yang digunakan.

Untuk deployment, gunakan HTTPS publik, set `APP_BASE_URL`, ganti semua credential default, lalu ganti `sendVerification()` di `server.mjs` dengan provider SMTP/Resend pilihan Anda.
