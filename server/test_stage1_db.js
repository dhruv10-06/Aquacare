require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@libsql/client');
process.env.TURSO_DATABASE_URL = 'file:isolated_stage1.db';
const { initializeDatabase, getDatabase } = require('./db/setup');

async function testDB() {
  if (fs.existsSync('isolated_stage1.db')) fs.unlinkSync('isolated_stage1.db');
  
  const rawDb = createClient({ url: 'file:isolated_stage1.db' });
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
  await rawDb.execute(`
    CREATE TABLE workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    )
  `);
  
  // Fake Phase 2 schema
  await rawDb.execute("ALTER TABLE complaints ADD COLUMN worker_id INTEGER REFERENCES workers(id)");
  await rawDb.execute("ALTER TABLE complaints ADD COLUMN deadline TEXT");
  await rawDb.execute("ALTER TABLE complaints ADD COLUMN legacy_assigned_team TEXT");
  
  // Seed some legacy data
  await rawDb.execute("INSERT INTO workers (username, password_hash, name, phone) VALUES ('w1', 'pw', 'Worker 1', '123')");
  await rawDb.execute("INSERT INTO complaints (complaint_id, name, phone, description, location, worker_id, status) VALUES ('C1', 'N', 'P', 'D', 'L', 1, 'Submitted')");
  
  console.log('Running setup...');
  await initializeDatabase();
  const db = getDatabase();
  console.log('Setup complete. Verifying migrations...');
  
  const cw = (await db.execute('SELECT * FROM complaint_workers')).rows;
  console.log('Migrated worker_id into complaint_workers?', cw.length === 1 && cw[0].worker_id === 1 ? '✅' : '❌');
  
  const sh = (await db.execute('SELECT * FROM status_history')).rows;
  console.log('Seeded status_history?', sh.length === 1 && sh[0].status === 'Submitted' ? '✅' : '❌');
  
  console.log('Testing idempotency (running setup again)...');
  await initializeDatabase();
  
  const cw2 = (await db.execute('SELECT * FROM complaint_workers')).rows;
  console.log('No duplicate complaint_workers?', cw2.length === 1 ? '✅' : '❌');
  
  const sh2 = (await db.execute('SELECT * FROM status_history')).rows;
  console.log('No duplicate status_history?', sh2.length === 1 ? '✅' : '❌');
  
  try { fs.unlinkSync('isolated_stage1.db'); } catch(e){}
}
testDB().catch(console.error);
