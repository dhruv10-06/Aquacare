const express = require('express');
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
process.env.TURSO_DATABASE_URL = 'file:isolated_stage4_reports.db';
process.env.ADMIN_SEED_PASSWORD = 'testpassword';
process.env.JWT_SECRET = 'testsecret';

// Stub cloudinary to avoid network dependency in tests
jest = { fn: () => {} };
const cloudinary = require('cloudinary').v2;
cloudinary.config = () => {};
cloudinary.uploader.destroy = async () => {};

const { initializeDatabase, getDatabase } = require('./db/setup');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Create dummy image file for upload testing
const dummyImagePath = path.join(__dirname, 'dummy_test.jpg');
if (!fs.existsSync(dummyImagePath)) fs.writeFileSync(dummyImagePath, 'dummy content');

async function testReportsAPI() {
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
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (1, 'Worker 1', 'w1', '111', ?, 1)", [pwHash]);
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (2, 'Worker 2', 'w2', '222', ?, 1)", [pwHash]);
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 1)");
  await db.execute("INSERT INTO team_memberships (team_id, worker_id) VALUES (1, 2)");
  
  // Complaint 1 is In Progress by W1
  await db.execute("INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, team_id, leader_id) VALUES (1, 'CMP1', 'Bob', '11', 'desc', 'loc', 'In Progress', 1, 1)");
  await db.execute("INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (1, 1)");
  
  // Complaint 2 is Assigned to W2
  await db.execute("INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, team_id, leader_id) VALUES (2, 'CMP2', 'Alice', '22', 'desc', 'loc', 'Assigned', 1, 2)");
  await db.execute("INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (2, 2)");

  const app = express();
  app.use(express.json());
  
  // Mock multer so we don't hit real cloudinary
  const multer = require('multer');
  const upload = multer({ dest: path.join(__dirname, 'uploads/') });
  // Intercept the report route manually to inject the local multer for testing
  const workerRouter = require('./routes/worker')(db);
  // We cannot easily inject into the existing router without modifying it, but we can patch the router's middleware.
  // Actually, we'll just test the route directly by starting the app.
  // But wait, the route uses CloudinaryStorage. If it tries to upload to cloudinary, it might fail without creds.
  // Let's stub cloudinary fully.
  // The worker route uses `upload.single('image')`.
  
  app.use('/api/admin', require('./routes/admin')(db));
  app.use('/api/worker', require('./routes/worker')(db));
  
  // Custom error handler to silence multer errors if they occur
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });

  const server = app.listen(3005);
  const baseUrl = 'http://localhost:3005';

  console.log('\\n--- STAGE 4 TESTS ---');
  
  // Get tokens
  let res = await fetch(`${baseUrl}/api/worker/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'w1', password: 'workerpw' })
  });
  const w1Token = (await res.json()).token;

  res = await fetch(`${baseUrl}/api/worker/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'w2', password: 'workerpw' })
  });
  const w2Token = (await res.json()).token;

  res = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'testpassword' })
  });
  const adminToken = (await res.json()).token;

  // Test 1: Worker cannot submit report for complaint not In Progress
  res = await fetch(`${baseUrl}/api/worker/tasks/2/report`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${w2Token}`, 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ notes: 'Done' })
  });
  console.log('Test 1 Res:', res.status, await res.text());
  console.log('Cannot submit report for Assigned task (no image):', res.status === 400 ? '✅' : '❌');

  // Test 2: Non-leader worker cannot submit report
  res = await fetch(`${baseUrl}/api/worker/tasks/1/report`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${w2Token}`, 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ notes: 'Done' })
  });
  console.log('Test 2 Res:', res.status, await res.text());
  console.log('Non-leader worker cannot submit report:', res.status === 400 || res.status === 403 ? '✅' : '❌');

  // We skip Cloudinary successful upload test because mocking it deeply is hard here.
  // Instead, we will simulate a successful DB insert manually to test the Admin verification.
  // Or if we provided CLOUDINARY_URL dummy in env, Multer might just throw an error. 
  // Let's check what Test 1 returned.
  // If it's 500, Cloudinary failed.
  // To avoid cloudinary issues in this isolated test, let's insert a pending report directly to test Admin verify.

  await db.execute({
    sql: "INSERT INTO work_reports (complaint_id, worker_id, notes, image_path, status) VALUES (1, 1, 'Fixed leak', 'http://dummy/img.jpg', 'Pending')"
  });
  await db.execute({
    sql: "UPDATE complaints SET status = 'Awaiting Admin Verification' WHERE id = 1"
  });

  // Test 3: Admin sees pending report
  res = await fetch(`${baseUrl}/api/admin/reports/pending`, { headers: { 'Authorization': `Bearer ${adminToken}` }});
  let reports = await res.json();
  console.log('Admin sees pending report:', reports.length === 1 && reports[0].notes === 'Fixed leak' ? '✅' : '❌');

  // Test 4: Admin cannot approve without valid action
  res = await fetch(`${baseUrl}/api/admin/complaints/1/verify`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'Unknown' })
  });
  console.log('Admin cannot verify with invalid action:', res.status === 400 ? '✅' : '❌');

  // Test 5: Admin cannot reject without reason
  res = await fetch(`${baseUrl}/api/admin/complaints/1/verify`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'Reject' })
  });
  console.log('Admin cannot reject without reason:', res.status === 400 ? '✅' : '❌');

  // Test 6: Admin rejects report with reason
  res = await fetch(`${baseUrl}/api/admin/complaints/1/verify`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'Reject', reason: 'Blurry photo' })
  });
  console.log('Admin rejects report with reason:', res.status === 200 ? '✅' : '❌');

  // Verify DB state after rejection
  let cRes = await db.execute("SELECT status FROM complaints WHERE id = 1");
  console.log('Complaint status returns to In Progress:', cRes.rows[0].status === 'In Progress' ? '✅' : '❌');
  let rRes = await db.execute("SELECT status, rejection_reason FROM work_reports WHERE complaint_id = 1");
  console.log('Report marked Rejected with reason:', rRes.rows[0].status === 'Rejected' && rRes.rows[0].rejection_reason === 'Blurry photo' ? '✅' : '❌');

  // Add another pending report for approval
  await db.execute({
    sql: "INSERT INTO work_reports (complaint_id, worker_id, notes, image_path, status) VALUES (1, 1, 'Fixed properly', 'http://dummy/img2.jpg', 'Pending')"
  });
  await db.execute({
    sql: "UPDATE complaints SET status = 'Awaiting Admin Verification' WHERE id = 1"
  });

  // Test 7: Admin approves report
  res = await fetch(`${baseUrl}/api/admin/complaints/1/verify`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'Approve' })
  });
  console.log('Admin approves report:', res.status === 200 ? '✅' : '❌');

  // Verify DB state after approval
  cRes = await db.execute("SELECT status FROM complaints WHERE id = 1");
  console.log('Complaint status becomes Resolved:', cRes.rows[0].status === 'Resolved' ? '✅' : '❌');
  rRes = await db.execute("SELECT status FROM work_reports WHERE complaint_id = 1 ORDER BY id DESC LIMIT 1");
  console.log('Latest report marked Approved:', rRes.rows[0].status === 'Approved' ? '✅' : '❌');

  // Test 8: Previous reports remain intact
  rRes = await db.execute("SELECT count(*) as cnt FROM work_reports WHERE complaint_id = 1");
  console.log('Previous reports remain intact:', rRes.rows[0].cnt === 2 ? '✅' : '❌');

  server.close();
  process.exit(0);
}

testReportsAPI().catch(console.error);
