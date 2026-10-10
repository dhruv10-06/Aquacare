require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { createClient } = require('@libsql/client');
process.env.TURSO_DATABASE_URL = 'file:isolated_stage1_api.db';
process.env.ADMIN_SEED_PASSWORD = 'testpassword';
process.env.JWT_SECRET = 'testsecret';
const { initializeDatabase, getDatabase } = require('./db/setup');

async function testAPI() {
  if (fs.existsSync('isolated_stage1_api.db')) fs.unlinkSync('isolated_stage1_api.db');
  
  const rawDb = createClient({ url: 'file:isolated_stage1_api.db' });
  await rawDb.execute(`
    CREATE TABLE complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      description TEXT NOT NULL,
      location TEXT NOT NULL,
      image_path TEXT,
      status TEXT DEFAULT 'Submitted',
      assigned_team TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  
  await initializeDatabase();
  const db = getDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('./routes/admin')(db));
  
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  
  // Login to get token
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'testpassword' })
  });
  const token = (await loginRes.json()).token;
  const auth = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Create Worker
  const createWorkerRes = await fetch(`${baseUrl}/api/admin/workers`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'W1', phone: '1111111111', username: 'w1', password: 'pw' })
  });
  console.log('Worker creation:', await createWorkerRes.text());
  
  const workers = await (await fetch(`${baseUrl}/api/admin/workers`, { headers: auth })).json();
  if (workers.length === 0) {
    console.error('Workers array empty after creation!');
    server.close();
    return;
  }
  const workerId = workers[0].id;
  console.log('Worker API masks hash?', workers[0].password_hash === undefined ? '✅' : '❌');

  // Test Team Creation
  await fetch(`${baseUrl}/api/admin/teams`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Alpha Team' }) });
  let teams = await (await fetch(`${baseUrl}/api/admin/teams`, { headers: auth })).json();
  console.log('Team Created?', teams.length === 1 && teams[0].name === 'Alpha Team' ? '✅' : '❌');
  const teamId = teams[0].id;

  // Test Team Activation
  await fetch(`${baseUrl}/api/admin/teams/${teamId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ is_active: false }) });
  teams = await (await fetch(`${baseUrl}/api/admin/teams`, { headers: auth })).json();
  console.log('Team Deactivated?', teams[0].is_active === 0 ? '✅' : '❌');

  // Test Team Membership Add
  const addRes = await fetch(`${baseUrl}/api/admin/teams/${teamId}/members`, { method: 'POST', headers: auth, body: JSON.stringify({ worker_id: workerId }) });
  console.log('Worker Added to Team?', addRes.status === 201 ? '✅' : '❌');

  // Test Duplicate Membership
  const dupRes = await fetch(`${baseUrl}/api/admin/teams/${teamId}/members`, { method: 'POST', headers: auth, body: JSON.stringify({ worker_id: workerId }) });
  console.log('Duplicate Membership Rejected?', dupRes.status === 400 ? '✅' : '❌');

  // Get Members
  const members = await (await fetch(`${baseUrl}/api/admin/teams/${teamId}/members`, { headers: auth })).json();
  console.log('Member list fetched correctly?', members.length === 1 && members[0].name === 'W1' ? '✅' : '❌');
  console.log('Member API masks hash?', members[0].password_hash === undefined ? '✅' : '❌');

  // Remove Member
  await fetch(`${baseUrl}/api/admin/teams/${teamId}/members/${workerId}`, { method: 'DELETE', headers: auth });
  const members2 = await (await fetch(`${baseUrl}/api/admin/teams/${teamId}/members`, { headers: auth })).json();
  console.log('Member removed?', members2.length === 0 ? '✅' : '❌');

  server.close();
  try { fs.unlinkSync('isolated_stage1_api.db'); } catch(e){}
}
testAPI().catch(console.error);
