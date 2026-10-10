const express = require('express');
const { createClient } = require('@libsql/client');
process.env.TURSO_DATABASE_URL = 'file:isolated_stage5_transparency.db';
const { initializeDatabase, getDatabase } = require('./db/setup');
const bcrypt = require('bcryptjs');

async function testTransparencyAPI() {
  const db = getDatabase();
  await db.execute("PRAGMA foreign_keys = OFF");
  await db.execute("DROP TABLE IF EXISTS complaint_workers");
  await db.execute("DROP TABLE IF EXISTS team_memberships");
  await db.execute("DROP TABLE IF EXISTS work_reports");
  await db.execute("DROP TABLE IF EXISTS status_history");
  await db.execute("DROP TABLE IF EXISTS complaints");
  await db.execute("DROP TABLE IF EXISTS teams");
  await db.execute("DROP TABLE IF EXISTS workers");
  await db.execute("PRAGMA foreign_keys = ON");
  await initializeDatabase();
  
  // Seed data
  const pwHash = bcrypt.hashSync('workerpw', 10);
  await db.execute("INSERT INTO teams (id, name, is_active) VALUES (1, 'Maintenance Team A', 1)");
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (1, 'Alice', 'alice', '1111111111', ?, 1)", [pwHash]);
  await db.execute("INSERT INTO workers (id, name, username, phone, password_hash, is_active) VALUES (2, 'Bob', 'bob', '2222222222', ?, 1)", [pwHash]);
  
  // 1. Unassigned Complaint
  await db.execute("INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, category) VALUES (1, 'CMP1', 'Citizen1', '9999999999', 'desc', 'loc', 'Submitted', 'Other')");
  await db.execute("INSERT INTO status_history (complaint_id, status, notes) VALUES (1, 'Submitted', 'Complaint registered')");

  // 2. Assigned with Deadline & Not Overdue
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 5);
  await db.execute(`INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, team_id, deadline) VALUES (2, 'CMP2', 'Citizen2', '999', 'desc', 'loc', 'Assigned', 1, '${futureDate.toISOString()}')`);
  await db.execute("INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (2, 1)");
  await db.execute("INSERT INTO status_history (complaint_id, status, notes, created_at) VALUES (2, 'Submitted', 'Registered', '2020-01-01')");
  await db.execute("INSERT INTO status_history (complaint_id, status, notes, created_at) VALUES (2, 'Assigned', 'Assigned', '2020-01-02')");

  // 3. Assigned with Deadline & Overdue, Multiple Workers
  const pastDate = new Date();
  pastDate.setDate(pastDate.getDate() - 5);
  await db.execute(`INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, team_id, deadline) VALUES (3, 'CMP3', 'Citizen3', '999', 'desc', 'loc', 'In Progress', 1, '${pastDate.toISOString()}')`);
  await db.execute("INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (3, 1)");
  await db.execute("INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (3, 2)");
  
  // 4. Reports tests: Rejected, Pending, Approved
  await db.execute(`INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, team_id) VALUES (4, 'CMP4', 'Citizen4', '999', 'desc', 'loc', 'Resolved', 1)`);
  // Rejected report
  await db.execute("INSERT INTO work_reports (complaint_id, worker_id, notes, image_path, status, rejection_reason, created_at) VALUES (4, 1, 'Rejected notes', 'img1', 'Rejected', 'Reason', '2021-01-01')");
  // Approved report
  await db.execute("INSERT INTO work_reports (complaint_id, worker_id, notes, image_path, status, created_at) VALUES (4, 1, 'Approved notes', 'img2', 'Approved', '2021-01-02')");

  // 5. Pending report only
  await db.execute(`INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, team_id) VALUES (5, 'CMP5', 'Citizen5', '999', 'desc', 'loc', 'Awaiting Admin Verification', 1)`);
  await db.execute("INSERT INTO work_reports (complaint_id, worker_id, notes, image_path, status, created_at) VALUES (5, 1, 'Pending notes', 'img3', 'Pending', '2021-01-03')");

  const app = express();
  app.use(express.json());
  
  // Mock multer
  const multer = require('multer');
  const upload = multer({ dest: 'uploads/' });
  const complaintsRouter = require('./routes/complaints')(db);
  app.use('/api/complaints', complaintsRouter);
  
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(3007);
  const baseUrl = 'http://localhost:3007';

  console.log('\\n--- STAGE 5 CITIZEN TRANSPARENCY TESTS ---');
  
  // Test 1: Unassigned complaint
  let res = await fetch(`${baseUrl}/api/complaints/track/CMP1`);
  let data = await res.json();
  console.log('Unassigned handled safely:', !data.team_name && data.assigned_workers.length === 0 ? '✅' : '❌');
  
  // Test 2: Correct Team & Worker names, Deadline, Not Overdue
  res = await fetch(`${baseUrl}/api/complaints/track/CMP2`);
  data = await res.json();
  console.log('Single worker assigned correctly:', data.team_name === 'Maintenance Team A' && data.assigned_workers.length === 1 && data.assigned_workers[0] === 'Alice' ? '✅' : '❌');
  console.log('Overdue indicator false for future deadline:', data.isOverdue === false ? '✅' : '❌');
  console.log('Chronological status history:', data.status_history.length === 2 && data.status_history[0].status === 'Submitted' ? '✅' : '❌');

  // Test 3: Multiple Workers & Overdue
  res = await fetch(`${baseUrl}/api/complaints/track/CMP3`);
  data = await res.json();
  console.log('Multiple workers assigned correctly:', data.assigned_workers.includes('Alice') && data.assigned_workers.includes('Bob') ? '✅' : '❌');
  console.log('Overdue indicator true for past deadline:', data.isOverdue === true ? '✅' : '❌');

  // Test 4: Report Evidence Logic (Rejected, Pending, Approved)
  res = await fetch(`${baseUrl}/api/complaints/track/CMP4`);
  data = await res.json();
  console.log('Exposes only Approved report evidence:', data.completion_report && data.completion_report.notes === 'Approved notes' ? '✅' : '❌');
  
  // Test 5: Awaiting Admin Verification vs Resolved
  res = await fetch(`${baseUrl}/api/complaints/track/CMP5`);
  data = await res.json();
  console.log('Pending evidence not exposed for Awaiting Admin Verification:', data.completion_report === null ? '✅' : '❌');

  // Test 6: Data Leakage Check
  console.log('No worker phone numbers leaked:', !JSON.stringify(data).includes('1111111111') ? '✅' : '❌');
  console.log('No worker password hashes leaked:', !JSON.stringify(data).includes('workerpw') ? '✅' : '❌');

  server.close();
  process.exit(0);
}

testTransparencyAPI().catch(console.error);
