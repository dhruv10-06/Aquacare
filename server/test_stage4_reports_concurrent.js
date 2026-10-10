const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

process.env.TURSO_DATABASE_URL = 'file:isolated_stage4_reports.db';
process.env.ADMIN_SEED_PASSWORD = 'testpassword';
process.env.JWT_SECRET = 'testsecret';

// Mock Cloudinary completely
const cloudinary = require('cloudinary').v2;
cloudinary.config = () => {};
let destroyedImages = [];
cloudinary.uploader.destroy = async (file) => {
  destroyedImages.push(file);
};

// Mock CloudinaryStorage to use diskStorage so we can test multipart uploads locally
const multer = require('multer');
const multerCloudinary = require('multer-storage-cloudinary');
multerCloudinary.CloudinaryStorage = function(opts) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, __dirname),
    filename: (req, file, cb) => cb(null, 'test_' + Date.now() + '_' + Math.random() + '.jpg')
  });
};

const { initializeDatabase, getDatabase } = require('./db/setup');

const dummyImagePath = path.join(__dirname, 'dummy_test.jpg');
if (!fs.existsSync(dummyImagePath)) fs.writeFileSync(dummyImagePath, 'dummy content');

async function testConcurrency() {
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
  
  // Complaint 1 is In Progress by W1 and W2 (Team 1)
  await db.execute("INSERT INTO complaints (id, complaint_id, name, phone, description, location, status, team_id) VALUES (1, 'CMP1', 'Bob', '11', 'desc', 'loc', 'In Progress', 1)");
  await db.execute("INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (1, 1)");
  await db.execute("INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (1, 2)");

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('./routes/admin')(db));
  app.use('/api/worker', require('./routes/worker')(db));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(3006);
  const baseUrl = 'http://localhost:3006';

  console.log('\\n--- STAGE 4 CONCURRENCY TESTS ---');
  
  // Login
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

  // 1. Concurrent Worker Report Submission
  destroyedImages = [];
  
  const form1 = new FormData();
  form1.append('notes', 'W1 notes');
  form1.append('image', new Blob(['dummy'], { type: 'image/jpeg' }), 'dummy1.jpg');
  
  const form2 = new FormData();
  form2.append('notes', 'W2 notes');
  form2.append('image', new Blob(['dummy'], { type: 'image/jpeg' }), 'dummy2.jpg');

  const p1 = fetch(`${baseUrl}/api/worker/tasks/1/report`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${w1Token}` }, body: form1
  });
  const p2 = fetch(`${baseUrl}/api/worker/tasks/1/report`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${w2Token}` }, body: form2
  });

  const [res1, res2] = await Promise.all([p1, p2]);
  
  const statusCodes = [res1.status, res2.status].sort();
  console.log('Concurrent submission returns exactly one 200 and one 409 (or 400):', 
    (statusCodes[0] === 200 && (statusCodes[1] === 409 || statusCodes[1] === 400)) ? '✅' : '❌ (' + statusCodes + ')');
  
  const rRes = await db.execute("SELECT * FROM work_reports WHERE complaint_id = 1");
  console.log('Exactly one pending report created:', rRes.rows.length === 1 && rRes.rows[0].status === 'Pending' ? '✅' : '❌');
  
  const cRes = await db.execute("SELECT status FROM complaints WHERE id = 1");
  console.log('Complaint status is Awaiting Admin Verification:', cRes.rows[0].status === 'Awaiting Admin Verification' ? '✅' : '❌');

  const hRes = await db.execute("SELECT * FROM status_history WHERE complaint_id = 1 AND status = 'Awaiting Admin Verification'");
  console.log('Exactly one history entry created:', hRes.rows.length === 1 ? '✅' : '❌');

  console.log('Losing request cleaned up its orphaned Cloudinary image:', destroyedImages.length === 1 ? '✅' : '❌');

  // 2. Concurrent Admin Verification (Approve vs Reject)
  const v1 = fetch(`${baseUrl}/api/admin/complaints/1/verify`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'Approve' })
  });
  const v2 = fetch(`${baseUrl}/api/admin/complaints/1/verify`, {
    method: 'PATCH', headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'Reject', reason: 'Too slow' })
  });

  const [vres1, vres2] = await Promise.all([v1, v2]);
  const vstatusCodes = [vres1.status, vres2.status].sort();
  console.log('Concurrent verification returns exactly one 200 and one 409 (or 400):', 
    (vstatusCodes[0] === 200 && (vstatusCodes[1] === 409 || vstatusCodes[1] === 400)) ? '✅' : '❌ (' + vstatusCodes + ')');

  const rFinal = await db.execute("SELECT * FROM work_reports WHERE complaint_id = 1");
  console.log('Exactly one report state modified:', (rFinal.rows[0].status === 'Approved' || rFinal.rows[0].status === 'Rejected') ? '✅' : '❌');
  
  const cFinal = await db.execute("SELECT status FROM complaints WHERE id = 1");
  console.log('Complaint status matches the winning request:', 
    (cFinal.rows[0].status === 'Resolved' && rFinal.rows[0].status === 'Approved') ||
    (cFinal.rows[0].status === 'In Progress' && rFinal.rows[0].status === 'Rejected') ? '✅' : '❌');

  server.close();
  // Cleanup test images
  fs.readdirSync(__dirname).filter(f => f.startsWith('test_') && f.endsWith('.jpg')).forEach(f => fs.unlinkSync(path.join(__dirname, f)));
  process.exit(0);
}

testConcurrency().catch(console.error);
