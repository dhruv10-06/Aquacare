const express = require('express');
const { createClient } = require('@libsql/client');
process.env.TURSO_DATABASE_URL = 'file:isolated_stage3_worker.db';
process.env.ADMIN_SEED_PASSWORD = 'testpassword';
process.env.JWT_SECRET = 'testsecret';
const { initializeDatabase, getDatabase } = require('./db/setup');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

async function testWorkerAPI() {
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
  const pwHash = bcrypt.hashSync('workerpw', 10);
  await db.execute("INSERT INTO teams (id, name, is_active) VALUES (1, 'Team A', 1)");
  await db.execute("INSERT INTO teams (id, name, is_active) VALUES (2, 'Team B', 1)");
  
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (1, 'Worker 1', 'w1', '111', ?, 1)", [pwHash]);
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (2, 'Worker 2', 'w2', '222', ?, 1)", [pwHash]);
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (3, 'Worker 3', 'w3', '333', ?, 0)", [pwHash]);
  
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 1)");
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 2)");
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (2, 2)"); // W2 is in both
  
  await db.execute("INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, team_id) VALUES (1, 'CMP1', 'Bob', '11', 'desc', 'loc', 'Assigned', 1)");
  await db.execute("INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (1, 1)"); // Assigned to W1

  await db.execute("INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, team_id) VALUES (2, 'CMP2', 'Alice', '22', 'desc', 'loc', 'Assigned', 2)");
  await db.execute("INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (2, 2)"); // Assigned to W2

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('./routes/admin')(db));
  app.use('/api/worker', require('./routes/worker')(db));
  app.use('/api/complaints', require('./routes/complaints')(db));
  
  const server = app.listen(3003);
  const baseUrl = 'http://localhost:3003';

  console.log('\\n--- STAGE 3 TESTS ---');

  // Test 1: Invalid worker credentials
  let res = await fetch(`${baseUrl}/api/worker/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'w1', password: 'wrongpassword' })
  });
  console.log('Invalid worker credentials rejected:', res.status === 401 ? '✅' : '❌');

  // Test 2: Deactivated worker login
  res = await fetch(`${baseUrl}/api/worker/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'w3', password: 'workerpw' })
  });
  console.log('Deactivated worker login rejected:', res.status === 403 ? '✅' : '❌');

  // Test 3: Valid worker login
  res = await fetch(`${baseUrl}/api/worker/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'w1', password: 'workerpw' })
  });
  let body = await res.json();
  const worker1Token = body.token;
  console.log('Valid worker login:', worker1Token ? '✅' : '❌');

  // Test 4: Admin token rejected by worker endpoint
  const adminRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'testpassword' })
  });
  const { token: adminToken } = await adminRes.json();
  
  res = await fetch(`${baseUrl}/api/worker/tasks`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log('Admin token rejected by worker endpoint:', res.status === 403 ? '✅' : '❌');

  // Test 5: Worker token rejected by admin endpoint
  res = await fetch(`${baseUrl}/api/admin/complaints`, {
    headers: { 'Authorization': `Bearer ${worker1Token}` }
  });
  console.log('Worker token rejected by admin endpoint:', res.status === 403 ? '✅' : '❌');

  // Test 6: Worker sees only their team's complaints
  res = await fetch(`${baseUrl}/api/worker/tasks`, {
    headers: { 'Authorization': `Bearer ${worker1Token}` }
  });
  body = await res.json();
  const seesCMP1 = body.some(c => c.complaint_id === 'CMP1');
  const seesCMP2 = body.some(c => c.complaint_id === 'CMP2');
  console.log('Worker sees only authorized team complaints:', seesCMP1 && !seesCMP2 ? '✅' : '❌');

  // Test 7: Personal assignment distinguished
  const cmp1 = body.find(c => c.complaint_id === 'CMP1');
  console.log('Personal assignment distinguished:', cmp1.is_personally_assigned === true ? '✅' : '❌');

  // Test 8: Worker 2 login
  res = await fetch(`${baseUrl}/api/worker/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'w2', password: 'workerpw' })
  });
  const worker2Token = (await res.json()).token;

  // Test 9: Worker cannot start another worker's complaint
  // CMP1 is assigned to W1. W2 is in Team A, so W2 can see CMP1, but not start it.
  res = await fetch(`${baseUrl}/api/worker/tasks/1/start`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${worker2Token}` }
  });
  console.log('Worker cannot start another worker’s complaint:', res.status === 403 ? '✅' : '❌');

  // Test 10: Worker can start their own eligible complaint
  res = await fetch(`${baseUrl}/api/worker/tasks/1/start`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${worker1Token}` }
  });
  console.log('Worker can start their own complaint:', res.status === 200 ? '✅' : '❌');

  // Test 11: Invalid status transitions rejected (cannot start an already In Progress task)
  res = await fetch(`${baseUrl}/api/worker/tasks/1/start`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${worker1Token}` }
  });
  console.log('Invalid status transition rejected:', res.status === 400 ? '✅' : '❌');

  // Test 12: Status history recorded correctly
  const histRes = await db.execute("SELECT * FROM status_history WHERE complaint_id = 1");
  console.log('Status history recorded:', histRes.rows.length === 1 && histRes.rows[0].status === 'In Progress' ? '✅' : '❌');

  // Test 13: Worker access revoked after deactivation
  await db.execute("UPDATE workers SET is_active = 0 WHERE id = 1");
  res = await fetch(`${baseUrl}/api/worker/tasks`, {
    headers: { 'Authorization': `Bearer ${worker1Token}` }
  });
  console.log('Worker access revoked after deactivation:', res.status === 403 ? '✅' : '❌');

  // Test 14: Citizen tracking still works
  res = await fetch(`${baseUrl}/api/complaints/track/CMP1`);
  console.log('Citizen tracking still works:', res.status === 200 ? '✅' : '❌');

  // Test 15: Deactivated team complaints are not visible
  await db.execute("UPDATE teams SET is_active = 0 WHERE id = 2");
  res = await fetch(`${baseUrl}/api/worker/tasks`, {
    headers: { 'Authorization': `Bearer ${worker2Token}` }
  });
  body = await res.json();
  const seesCMP2After = body.some(c => c.complaint_id === 'CMP2');
  console.log('Deactivated team complaints not visible:', !seesCMP2After ? '✅' : '❌');

  // Test 16: Starting work requires team membership and active team
  // We use W2 who is assigned to CMP2. First, we reactivate Team 2 and W2, and change status back to Assigned.
  await db.execute("UPDATE teams SET is_active = 1 WHERE id = 2");
  await db.execute("UPDATE complaints SET status = 'Assigned' WHERE id = 2");
  
  // Now remove W2 from Team 2 but leave W2 in complaint_workers.
  await db.execute("DELETE FROM team_memberships WHERE worker_id = 2 AND team_id = 2");
  res = await fetch(`${baseUrl}/api/worker/tasks/2/start`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${worker2Token}` }
  });
  console.log('Cannot start work if removed from team:', res.status === 403 ? '✅' : '❌');

  // Test 17: A worker cannot start a complaint belonging to a deactivated team
  // Re-add W2 to Team 2, but deactivate Team 2
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (2, 2)");
  await db.execute("UPDATE teams SET is_active = 0 WHERE id = 2");
  res = await fetch(`${baseUrl}/api/worker/tasks/2/start`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${worker2Token}` }
  });
  console.log('Cannot start work if team is deactivated:', res.status === 403 ? '✅' : '❌');

  // Clean up
  server.close();
  process.exit(0);
}

testWorkerAPI().catch(console.error);
