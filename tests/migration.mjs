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
  for(let attempt=0;attempt<50;attempt+=1){
    try { if((await fetch(`${baseUrl}/api/settings`)).ok) break; } catch { /* Starting. */ }
    await new Promise(resolve=>setTimeout(resolve,100));
    if(attempt===49) throw new Error(`Server migrasi tidak aktif. ${serverError}`);
  }
  const login=await fetch(`${baseUrl}/api/admin/login`,{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'migration@example.com',password:'migration-password'}) });
  const cookie=login.headers.get('set-cookie');
  const clientsResponse=await fetch(`${baseUrl}/api/admin/clients`,{headers:{cookie}});
  const clients=await clientsResponse.json();
  assert(clients.clients.some(client=>client.gateway_id==='legacy-gateway' && client.mac_address==='02:00:00:00:99:01'),'Data client lama harus tetap tersedia setelah migrasi.');
  const networkResponse=await fetch(`${baseUrl}/api/admin/network`,{headers:{cookie}});
  const network=await networkResponse.json();
  assert(network.gateways.some(gateway=>gateway.id==='legacy-gateway'),'Gateway dari data lama harus dibuat otomatis.');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve=>child.once('exit',resolve));
}

const migrated = new DatabaseSync(databasePath);
const primaryKey = migrated.prepare('PRAGMA table_info(clients)').all().filter(column=>column.pk>0);
assert(primaryKey.length===2 && primaryKey.some(column=>column.name==='gateway_id') && primaryKey.some(column=>column.name==='mac_address'),'Primary key client harus menjadi gabungan gateway dan MAC.');
migrated.close();
await rm(dataDir,{recursive:true,force:true});
console.log('Legacy multi-gateway migration: PASS');
