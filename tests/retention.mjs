import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = await mkdtemp(join(tmpdir(), 'perumnet-retention-'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const bootOnce = async (port) => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT:String(port), APP_BASE_URL:`http://127.0.0.1:${port}`, PORTAL_DATA_DIR:dataDir,
      NODE_ENV:'test', GUEST_DATA_RETENTION_DAYS:'30',
      ADMIN_EMAIL:'admin-test@example.com', ADMIN_PASSWORD:'admin-test-password',
      SESSION_SECRET:'test-session-secret-value-32-chars-long',
      SMTP_HOST:'', SMTP_USER:'', SMTP_PASSWORD:'', EMAIL_FROM:''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/settings`)).ok) break; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (attempt === 49) throw new Error(`Server test tidak aktif. ${stderr}`);
  }
  child.kill();
  await new Promise(resolve => child.on('exit', resolve));
};

const port = 34000 + Math.floor(Math.random() * 500);

try {
  // First boot creates the schema.
  await bootOnce(port);

  const dbPath = join(dataDir, 'portal.db');
  const db = new DatabaseSync(dbPath);
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();

  db.prepare('INSERT INTO users (id,full_name,email,phone_number,address,password_hash,is_verified,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('user-lama', 'Pelanggan Lama', 'lama@example.test', '08123456789', 'Jalan Tes 1', 'x:y', 1, old);

  // Two ageing rows per table: one belongs to a registered customer, one to a
  // guest who never signed up.
  db.prepare('INSERT INTO access_logs (id,user_id,mac_address,client_ip,access_type,ssid,gateway_id,timestamp) VALUES (?,?,?,?,?,?,?,?)')
    .run('log-terdaftar', 'user-lama', '02:00:00:00:aa:01', '10.0.0.1', 'high_speed', 'VLAN10', 'unassigned', old);
  db.prepare('INSERT INTO access_logs (id,user_id,mac_address,client_ip,access_type,ssid,gateway_id,timestamp) VALUES (?,?,?,?,?,?,?,?)')
    .run('log-tamu-lama', null, '02:00:00:00:bb:01', '10.0.0.2', 'limited', 'VLAN20', 'unassigned', old);
  db.prepare('INSERT INTO access_logs (id,user_id,mac_address,client_ip,access_type,ssid,gateway_id,timestamp) VALUES (?,?,?,?,?,?,?,?)')
    .run('log-tamu-baru', null, '02:00:00:00:bb:02', '10.0.0.3', 'limited', 'VLAN20', 'unassigned', fresh);

  db.prepare('INSERT INTO clients (gateway_id,mac_address,client_ip,ssid,user_id,access_type,auth_status,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('unassigned', '02:00:00:00:aa:01', '10.0.0.1', 'VLAN10', 'user-lama', 'high_speed', 'pending', old, old);
  db.prepare('INSERT INTO clients (gateway_id,mac_address,client_ip,ssid,user_id,access_type,auth_status,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('unassigned', '02:00:00:00:bb:01', '10.0.0.2', 'VLAN20', null, 'limited', 'pending', old, old);

  // telemetry_samples.id is an INTEGER primary key, so let SQLite assign it and
  // identify the rows by MAC instead.
  const sample = db.prepare('INSERT INTO telemetry_samples (gateway_id,mac_address,user_id,access_type,ssid,sampled_at,incoming_bytes,outgoing_bytes,incoming_delta,outgoing_delta) VALUES (?,?,?,?,?,?,?,?,?,?)');
  sample.run('unassigned', '02:00:00:00:aa:01', 'user-lama', 'high_speed', 'VLAN10', old, 1, 1, 1, 1);
  sample.run('unassigned', '02:00:00:00:bb:01', null, 'limited', 'VLAN20', old, 1, 1, 1, 1);
  db.close();

  // Second boot runs the retention sweep.
  await bootOnce(port + 1);

  const check = new DatabaseSync(dbPath);
  const has = (sql, ...args) => check.prepare(sql).get(...args) !== undefined;

  assert(has('SELECT id FROM users WHERE id=?', 'user-lama'),
    'Data pelanggan terdaftar tidak boleh pernah dihapus.');
  assert(has('SELECT id FROM access_logs WHERE id=?', 'log-terdaftar'),
    'Log akses milik pelanggan terdaftar harus tetap tersimpan selamanya.');
  assert(has('SELECT id FROM telemetry_samples WHERE mac_address=?', '02:00:00:00:aa:01'),
    'Telemetry pelanggan terdaftar tidak boleh ikut terhapus.');
  assert(has('SELECT mac_address FROM clients WHERE mac_address=?', '02:00:00:00:aa:01'),
    'Perangkat milik pelanggan terdaftar harus dipertahankan.');

  assert(!has('SELECT id FROM access_logs WHERE id=?', 'log-tamu-lama'),
    'Log akses tamu yang lewat masa simpan harus dihapus.');
  assert(!has('SELECT id FROM telemetry_samples WHERE mac_address=?', '02:00:00:00:bb:01'),
    'Telemetry tamu yang lewat masa simpan harus dihapus.');
  assert(!has('SELECT mac_address FROM clients WHERE mac_address=?', '02:00:00:00:bb:01'),
    'Perangkat tamu yang lewat masa simpan harus dihapus.');

  assert(has('SELECT id FROM access_logs WHERE id=?', 'log-tamu-baru'),
    'Log tamu yang masih dalam masa simpan tidak boleh ikut terhapus.');
  check.close();

  console.log('Data retention contract: PASS');
} finally {
  await rm(dataDir, { recursive:true, force:true });
}
