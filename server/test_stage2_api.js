const express = require('express');
const { createClient } = require('@libsql/client');
process.env.TURSO_DATABASE_URL = 'file:isolated_stage2_api.db';
process.env.ADMIN_SEED_PASSWORD = 'testpassword';
process.env.JWT_SECRET = 'testsecret';
const { initializeDatabase, getDatabase } = require('./db/setup');

async function testAPI() {
  const db = getDatabase();
  await db.execute("PRAGMA foreign_keys = OFF");
  await db.execute("DROP TABLE IF EXISTS complaint_workers");
  await db.execute("DROP TABLE IF EXISTS team_memberships");
  await db.execute("DROP TABLE IF EXISTS work_reports");
  await db.execute("DROP TABLE IF EXISTS status_history");
  await db.execute("DROP TABLE IF EXISTS complaints");
  await db.execute("DROP TABLE IF EXISTS teams");
  await db.execute("DROP TABLE IF EXISTS workers");
  await db.execute("DROP TABLE IF EXISTS admins");
  await db.execute("PRAGMA foreign_keys = ON");
  await initializeDatabase();
  
  // Seed data
  await db.execute("INSERT INTO teams (id, name, is_active) VALUES (1, 'Alpha Team', 1)");
  await db.execute("INSERT INTO teams (id, name, is_active) VALUES (2, 'Beta Team', 1)");
  await db.execute("INSERT INTO teams (id, name, is_active) VALUES (3, 'Inactive Team', 0)");
  
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (1, 'W1', 'w1', '111', 'pw', 1)");
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (2, 'W2', 'w2', '222', 'pw', 1)");
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (3, 'W3', 'w3', '333', 'pw', 0)");
  
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 1)");
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 2)");
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (2, 2)"); // W2 is in both
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 3)"); // W3 is inactive
  
  await db.execute("INSERT INTO complaints (id, complaint_id, name, phone, description, location, status) VALUES (1, 'CMP1', 'Bob', '11', 'desc', 'loc', 'Submitted')");
  
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('./routes/admin')(db));
  
  const server = app.listen(3002);
  const baseUrl = 'http://localhost:3002';

  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'testpassword' })
  });
  const { token } = await loginRes.json();
  const auth = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  console.log('\\n--- STAGE 2 TESTS ---');

  // Test 1: Assign one worker
  let res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ team_id: 1, worker_ids: [1] })
  });
  let body = await res.json();
  console.log('Assign one worker:', res.ok ? '✅' : '❌ ' + body.error);

  // Test 2: Assign multiple workers
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ team_id: 1, worker_ids: [1, 2] })
  });
  body = await res.json();
  console.log('Assign multiple workers:', res.ok && body.complaint.team_id === 1 ? '✅' : '❌ ' + body.error);
  
  let cwRes = await db.execute("SELECT * FROM complaint_workers WHERE complaint_id = 1");
  console.log('Multiple workers stored?', cwRes.rows.length === 2 ? '✅' : '❌');

  // Test 3: Reject worker from another team
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ team_id: 2, worker_ids: [1] }) // W1 is not in Beta Team
  });
  body = await res.json();
  console.log('Reject worker from another team:', res.status === 400 ? '✅' : '❌ ' + body.error);

  // Test 4: Reject inactive worker
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ team_id: 1, worker_ids: [3] }) // W3 is inactive
  });
  body = await res.json();
  console.log('Reject inactive worker:', res.status === 400 ? '✅' : '❌ ' + body.error);

  // Test 5: Reject inactive team
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ team_id: 3, worker_ids: [] }) // Team 3 is inactive
  });
  body = await res.json();
  console.log('Reject inactive team:', res.status === 400 ? '✅' : '❌ ' + body.error);

  // Test 6: Changing a complaint's team clears incompatible workers
  // We assigned team 1 and [1,2] above. Now we change to Team 2 without specifying worker_ids
  // Wait, if team_id is changed and worker_ids is NOT provided, it should clear workers.
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ team_id: 2 })
  });
  body = await res.json();
  cwRes = await db.execute("SELECT * FROM complaint_workers WHERE complaint_id = 1");
  console.log('Change team clears workers:', cwRes.rows.length === 0 ? '✅' : '❌ (found ' + cwRes.rows.length + ')');

  // Test 7: Unassign team and workers
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ team_id: null, worker_ids: [] })
  });
  body = await res.json();
  console.log('Unassign team:', body.complaint.team_id === null ? '✅' : '❌');

  // Test 8: Reject invalid calendar dates
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ deadline: '2026-02-30' })
  });
  console.log('Reject invalid date:', res.status === 400 ? '✅' : '❌');

  // Test 9: Updating status without supplying team_id or worker_ids preserves them
  await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ team_id: 1, worker_ids: [1] })
  });
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'In Progress' })
  });
  body = await res.json();
  cwRes = await db.execute("SELECT * FROM complaint_workers WHERE complaint_id = 1");
  console.log('Update status preserves assignments:', body.complaint.status === 'In Progress' && cwRes.rows.length === 1 ? '✅' : '❌');

  // Test 10: Mixed team_id and legacy worker_id request is rejected.
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ team_id: 1, worker_id: 2 })
  });
  body = await res.json();
  console.log('Mixed legacy/new assignment rejected:', res.status === 400 && body.error.includes('Cannot mix') ? '✅' : '❌');

  // Test 11: An invalid worker in a multi-worker request causes no partial changes.
  await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ team_id: 1, worker_ids: [1] })
  });
  const beforeState = await db.execute("SELECT * FROM complaint_workers WHERE complaint_id = 1");
  
  res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ team_id: 1, worker_ids: [1, 999] }) // 999 is invalid
  });
  const afterState = await db.execute("SELECT * FROM complaint_workers WHERE complaint_id = 1");
  
  console.log('Invalid worker in multi-worker rejected:', res.status === 400 ? '✅' : '❌');
  console.log('No partial changes occurred:', beforeState.rows.length === afterState.rows.length ? '✅' : '❌');

  // Clean up
  server.close();
  process.exit(0);
}

testAPI().catch(console.error);
