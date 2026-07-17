import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = await mkdtemp(join(tmpdir(), 'perumnet-migration-'));
const databasePath = join(dataDir, 'portal.db');
const legacy = new DatabaseSync(databasePath);
legacy.exec(`
  CREATE TABLE clients (
    mac_address TEXT PRIMARY KEY, client_ip TEXT, ssid TEXT, gateway_id TEXT,
    user_id TEXT, access_type TEXT CHECK(access_type IN ('high_speed','limited')),
    auth_status TEXT NOT NULL DEFAULT 'pending' CHECK(auth_status IN ('pending','authorized')),
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, authorized_until TEXT
  );
  INSERT INTO clients (mac_address,client_ip,ssid,gateway_id,access_type,auth_status,first_seen_at,last_seen_at)
  VALUES ('02:00:00:00:99:01','10.99.0.10','Legacy WiFi','legacy-gateway','limited','pending','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z');
  CREATE TABLE portal_network_routes (
    gateway_id TEXT NOT NULL, network_alias TEXT NOT NULL,
    client_cidr TEXT, portal_mode TEXT NOT NULL DEFAULT 'account',
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, configured_at TEXT,
    PRIMARY KEY(gateway_id,network_alias)
  );
  INSERT INTO portal_network_routes
    (gateway_id,network_alias,client_cidr,portal_mode,first_seen_at,last_seen_at,configured_at)
  VALUES
    ('legacy-gateway','10.99.0.0/24','10.99.0.0/24','free','2026-01-01T00:00:00.000Z','2026-01-03T00:00:00.000Z','2026-01-03T00:00:00.000Z'),
    ('legacy-gateway','VLAN99','10.99.0.0/24','account','2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z',NULL);
`);
legacy.close();

const port = 33000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd:new URL('..',import.meta.url),
  env:{ ...process.env,PORT:String(port),APP_BASE_URL:baseUrl,PORTAL_DATA_DIR:dataDir,NODE_ENV:'test',ADMIN_EMAIL:'migration@example.com',ADMIN_PASSWORD:'migration-password',SMTP_HOST:'',SMTP_USER:'',SMTP_PASSWORD:'' },
  stdio:['ignore','pipe','pipe']
});
let serverError='';
child.stderr.on('data',chunk=>{ serverError+=chunk; });
const assert=(condition,message)=>{ if(!condition) throw new Error(message); };

try {
  let settings;
  for(let attempt=0;attempt<50;attempt+=1){
    try { const response=await fetch(`${baseUrl}/api/settings`); if(response.ok){ settings=await response.json(); break; } } catch { /* Starting. */ }
    await new Promise(resolve=>setTimeout(resolve,100));
    if(attempt===49) throw new Error(`Server migrasi tidak aktif. ${serverError}`);
  }
  assert(settings.account_ssid==='@PERUMNET_WiFi' && settings.free_ssid==='@PERUMNET_FreeWiFi','Migrasi harus menambahkan fallback SSID untuk kedua profil portal.');
  const login=await fetch(`${baseUrl}/api/admin/login`,{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'migration@example.com',password:'migration-password'}) });
  const cookie=login.headers.get('set-cookie');
  const clientsResponse=await fetch(`${baseUrl}/api/admin/clients`,{headers:{cookie}});
  const clients=await clientsResponse.json();
  assert(clients.clients.some(client=>client.gateway_id==='legacy-gateway' && client.mac_address==='02:00:00:00:99:01'),'Data client lama harus tetap tersedia setelah migrasi.');
  const networkResponse=await fetch(`${baseUrl}/api/admin/network`,{headers:{cookie}});
  const network=await networkResponse.json();
  assert(network.gateways.some(gateway=>gateway.id==='legacy-gateway'),'Gateway dari data lama harus dibuat otomatis.');
  assert(network.gateways.some(gateway=>gateway.id==='legacy-gateway' && gateway.approval_status==='pending'),'Gateway legacy tanpa nama administrator harus masuk karantina setelah upgrade.');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve=>child.once('exit',resolve));
}

const migrated = new DatabaseSync(databasePath);
const clientColumns = migrated.prepare('PRAGMA table_info(clients)').all();
const primaryKey = clientColumns.filter(column=>column.pk>0);
assert(primaryKey.length===2 && primaryKey.some(column=>column.name==='gateway_id') && primaryKey.some(column=>column.name==='mac_address'),'Primary key client harus menjadi gabungan gateway dan MAC.');
assert(['session_started_at','last_counter_at','incoming_bytes','outgoing_bytes','incoming_bps','outgoing_bps'].every(name=>clientColumns.some(column=>column.name===name)),'Migrasi harus menambahkan kolom telemetry WiFiDog tanpa menghilangkan client lama.');
const telemetryColumns = migrated.prepare('PRAGMA table_info(telemetry_samples)').all();
assert(['gateway_id','mac_address','user_id','ssid','sampled_at','incoming_delta','outgoing_delta','incoming_bps','outgoing_bps'].every(name=>telemetryColumns.some(column=>column.name===name)),'Migrasi harus menambahkan histori telemetry untuk grafik tanpa mengubah data client lama.');
const gatewayColumns = migrated.prepare('PRAGMA table_info(gateways)').all();
assert(['approval_status','approved_at'].every(name=>gatewayColumns.some(column=>column.name===name)),'Migrasi harus menambahkan status verifikasi gateway.');
assert(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_blocks'").get(),'Migrasi harus menyediakan daftar blokir gateway.');
const routeColumns = migrated.prepare('PRAGMA table_info(portal_network_routes)').all();
assert(routeColumns.some(column=>column.name==='network_description'),'Migrasi harus menambahkan deskripsi VLAN tanpa merusak routing lama.');
assert(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portal_profile_content'").get(),'Migrasi harus menambahkan konten terpisah untuk Portal Akun dan Portal Free.');
assert(migrated.prepare("SELECT COUNT(*) AS total FROM portal_profile_content").get().total===2,'Migrasi harus menginisialisasi tepat dua profil konten portal.');
assert(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portal_promotions'").get(),'Migrasi harus menyediakan penyimpanan promo dinamis.');
const migratedRoutes = migrated.prepare("SELECT network_alias,client_cidr,portal_mode FROM portal_network_routes WHERE gateway_id='legacy-gateway'").all();
assert(migratedRoutes.length===1 && migratedRoutes[0].network_alias==='VLAN99' && migratedRoutes[0].portal_mode==='free','Migrasi harus menggabungkan interface IP ke VLAN dan mempertahankan routing yang sudah dikonfigurasi.');
migrated.close();
await rm(dataDir,{recursive:true,force:true});
console.log('Legacy multi-gateway migration: PASS');
