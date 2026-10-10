const express = require('express');
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Ensure isolated database
const testDbFile = path.join(__dirname, 'isolated_leader_test.db');
if (fs.existsSync(testDbFile)) fs.unlinkSync(testDbFile);
process.env.TURSO_DATABASE_URL = `file:${testDbFile}`;
delete process.env.TURSO_AUTH_TOKEN;
process.env.JWT_SECRET = 'test_secret_key_123';

const { initializeDatabase, getDatabase } = require('./db/setup');

async function runTests() {
  console.log('--- STARTING ISOLATED LEADER WORKFLOW REGRESSION TESTS ---');
  
  // 1. Initialize isolated schema
  const db = getDatabase();
  await initializeDatabase();
  
  // Seed teams and workers
  const pwHash = bcrypt.hashSync('worker123', 10);
  await db.execute("INSERT INTO teams (id, name, is_active) VALUES (1, 'Alpha Team', 1)");
  await db.execute("INSERT INTO teams (id, name, is_active) VALUES (2, 'Beta Team', 1)");
  await db.execute("INSERT INTO teams (id, name, is_active) VALUES (3, 'Inactive Team', 0)");

  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (1, 'Alice', 'alice', '111', ?, 1)", [pwHash]);
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (2, 'Bob', 'bob', '222', ?, 1)", [pwHash]);
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (3, 'Charlie', 'charlie', '333', ?, 0)", [pwHash]); // Inactive
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (4, 'Dave', 'dave', '444', ?, 1)", [pwHash]); // Beta Team

  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 1)"); // Alice in Alpha
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 2)"); // Bob in Alpha
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 3)"); // Charlie in Alpha (inactive worker)
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (2, 4)"); // Dave in Beta

  // Seed complaint (Submitted)
  await db.execute("INSERT INTO complaints (id, complaint_id, name, phone, description, location, status) VALUES (1, 'CMP1', 'Citizen A', '1234567890', 'Water leak', 'Sector 1', 'Submitted')");
  // Seed complaint with legacy assignment
  await db.execute("INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, assigned_team) VALUES (2, 'CMP2', 'Citizen B', '1234567890', 'Pipeline break', 'Sector 2', 'Submitted', 'Legacy Pipeline Unit')");

  // Spin up express test server
  const app = express();
  app.use(express.json());
  
  const adminRouter = require('./routes/admin')(db);
  const workerRouter = require('./routes/worker')(db);
  app.use('/api/admin', adminRouter);
  app.use('/api/worker', workerRouter);

  const server = app.listen(3015);
  const baseUrl = 'http://localhost:3015';

  const adminToken = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET);
  const aliceToken = jwt.sign({ id: 1, username: 'alice', role: 'worker' }, process.env.JWT_SECRET);
  const bobToken = jwt.sign({ id: 2, username: 'bob', role: 'worker' }, process.env.JWT_SECRET);
  const daveToken = jwt.sign({ id: 4, username: 'dave', role: 'worker' }, process.env.JWT_SECRET);

  try {
    // TEST 1: Admin rejects non-member leader
    let res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: 1, leader_id: 4 }) // Dave is in Team 2, not Team 1
    });
    console.log('Reject non-member leader:', res.status === 400 ? '✅' : '❌');

    // TEST 2: Admin rejects inactive worker as leader
    res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: 1, leader_id: 3 }) // Charlie is inactive
    });
    console.log('Reject inactive worker as leader:', res.status === 400 ? '✅' : '❌');

    // TEST 3: Admin rejects leader without team
    res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leader_id: 1 }) // No team_id provided and complaint has no team
    });
    console.log('Reject leader without team:', res.status === 400 ? '✅' : '❌');

    // TEST 4: Admin assigns team and valid team leader successfully + auto-transitions Submitted to Assigned
    res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: 1, leader_id: 1 }) // Alice as leader
    });
    const c1Data = await res.json();
    const test4Pass = res.status === 200 && c1Data.complaint.leader_id === 1 && c1Data.complaint.status === 'Assigned';
    console.log('Admin assigns team and leader + auto-transitions to Assigned:', test4Pass ? '✅' : '❌');

    // TEST 5: Verify assignment persists after reload & status_history entry created
    const getRes = await fetch(`${baseUrl}/api/admin/complaints`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const complaints = await getRes.json();
    const reloaded = complaints.find(c => c.id === 1);
    const histRes = await db.execute("SELECT * FROM status_history WHERE complaint_id = 1");
    const test5Pass = reloaded && reloaded.leader_id === 1 && reloaded.team_id === 1 && histRes.rows.length >= 1;
    console.log('Assignment persists on reload & status_history recorded:', test5Pass ? '✅' : '❌');

    // TEST 6: Worker logs in and loads tasks (Alice is leader, Bob is ordinary team member)
    res = await fetch(`${baseUrl}/api/worker/tasks`, {
      headers: { 'Authorization': `Bearer ${aliceToken}` }
    });
    const aliceTasks = await res.json();
    const aliceTask = aliceTasks.find(t => t.id === 1);
    
    res = await fetch(`${baseUrl}/api/worker/tasks`, {
      headers: { 'Authorization': `Bearer ${bobToken}` }
    });
    const bobTasks = await res.json();
    const bobTask = bobTasks.find(t => t.id === 1);

    const test6Pass = aliceTask && aliceTask.is_team_leader === true && bobTask && bobTask.is_team_leader === false;
    console.log('Worker task loading & leader distinction:', test6Pass ? '✅' : '❌');

    // TEST 7: Ordinary active team member (Bob) can start the task
    res = await fetch(`${baseUrl}/api/worker/tasks/1/start`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${bobToken}` }
    });
    console.log('Ordinary active team member can start task:', res.status === 200 ? '✅' : '❌');

    // Verify status is now In Progress
    const inProgCheck = (await db.execute("SELECT status FROM complaints WHERE id = 1")).rows[0].status;
    console.log('Task status transitioned to In Progress:', inProgCheck === 'In Progress' ? '✅' : '❌');

    // TEST 8: Non-leader (Bob) cannot submit completion report
    res = await fetch(`${baseUrl}/api/worker/tasks/1/report`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Finished by Bob' })
    });
    console.log('Non-leader cannot submit completion report:', res.status === 403 ? '✅' : '❌');

    // TEST 9: Updating assignment on In Progress complaint does not reset status
    res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deadline: '2026-12-31' })
    });
    const inProgAfterUpdate = (await db.execute("SELECT status, deadline FROM complaints WHERE id = 1")).rows[0];
    console.log('Assignment update preserves In Progress status:', inProgAfterUpdate.status === 'In Progress' && inProgAfterUpdate.deadline === '2026-12-31' ? '✅' : '❌');

    // TEST 10: Changing team clears stale leader if leader_id not specified
    res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: 2 }) // Move to Beta team without specifying leader
    });
    const movedComplaint = (await db.execute("SELECT team_id, leader_id FROM complaints WHERE id = 1")).rows[0];
    console.log('Changing team clears stale leader:', movedComplaint.team_id === 2 && movedComplaint.leader_id === null ? '✅' : '❌');

    // Move back to Team 1 with Alice as leader and set to In Progress for report tests
    await db.execute("UPDATE complaints SET team_id = 1, leader_id = 1, status = 'In Progress' WHERE id = 1");

    // TEST 11: Admin verification endpoint tests (approve / reject)
    // Create pending report
    await db.execute("INSERT INTO work_reports (complaint_id, worker_id, notes, image_path, status) VALUES (1, 1, 'Completed pipe repair', 'http://example.com/pic.jpg', 'Pending')");
    await db.execute("UPDATE complaints SET status = 'Awaiting Admin Verification' WHERE id = 1");

    // Direct PATCH to Resolved is rejected
    res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Resolved' })
    });
    console.log('Direct status PATCH to Resolved rejected:', res.status === 400 ? '✅' : '❌');

    // Admin rejects report with reason -> status transitions back to In Progress
    res = await fetch(`${baseUrl}/api/admin/complaints/1/verify`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'Reject', reason: 'Insufficient photo evidence' })
    });
    const afterReject = (await db.execute("SELECT status FROM complaints WHERE id = 1")).rows[0].status;
    console.log('Admin rejects report -> complaint returns to In Progress:', res.status === 200 && afterReject === 'In Progress' ? '✅' : '❌');

    // Re-submit pending report and approve
    await db.execute("INSERT INTO work_reports (complaint_id, worker_id, notes, image_path, status) VALUES (1, 1, 'Completed pipe repair v2', 'http://example.com/pic2.jpg', 'Pending')");
    await db.execute("UPDATE complaints SET status = 'Awaiting Admin Verification' WHERE id = 1");

    res = await fetch(`${baseUrl}/api/admin/complaints/1/verify`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'Approve' })
    });
    const afterApprove = (await db.execute("SELECT status FROM complaints WHERE id = 1")).rows[0].status;
    console.log('Admin approves report -> complaint becomes Resolved:', res.status === 200 && afterApprove === 'Resolved' ? '✅' : '❌');

    // TEST 12: Resolved complaint status cannot be changed
    res = await fetch(`${baseUrl}/api/admin/complaints/1`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Assigned' })
    });
    console.log('Resolved complaint status transition rejected:', res.status === 400 ? '✅' : '❌');

    // TEST 13: Legacy assignments remain intact
    const legacyCmp = (await db.execute("SELECT * FROM complaints WHERE id = 2")).rows[0];
    console.log('Legacy assignment preserved:', legacyCmp.assigned_team === 'Legacy Pipeline Unit' && legacyCmp.team_id === null ? '✅' : '❌');

    console.log('--- ALL LEADER WORKFLOW REGRESSION TESTS COMPLETE ---');
  } finally {
    server.close();
    if (fs.existsSync(testDbFile)) {
      try { fs.unlinkSync(testDbFile); } catch (e) {}
    }
  }
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
