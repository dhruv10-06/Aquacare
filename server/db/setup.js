const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

let dbClient = null;

function getDatabase() {
  if (!dbClient) {
    dbClient = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return dbClient;
}

async function initializeDatabase() {
  const db = getDatabase();

  // Create complaints table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS complaints (
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

  // Create workers table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    )
  `);

  // Create admins table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    )
  `);

  // Add category column idempotently
  const tableInfo = await db.execute('PRAGMA table_info(complaints)');
  const hasCategory = tableInfo.rows.some(row => row.name === 'category');
  if (!hasCategory) {
    await db.execute("ALTER TABLE complaints ADD COLUMN category TEXT DEFAULT 'Other'");
  }

  const hasWorkerId = tableInfo.rows.some(row => row.name === 'worker_id');
  if (!hasWorkerId) {
    await db.execute('ALTER TABLE complaints ADD COLUMN worker_id INTEGER REFERENCES workers(id)');
  }

  const hasDeadline = tableInfo.rows.some(row => row.name === 'deadline');
  if (!hasDeadline) {
    await db.execute('ALTER TABLE complaints ADD COLUMN deadline TEXT');
  }

  const hasLegacyTeam = tableInfo.rows.some(row => row.name === 'legacy_assigned_team');
  if (!hasLegacyTeam) {
    await db.execute('ALTER TABLE complaints ADD COLUMN legacy_assigned_team TEXT');
    // Migrate existing assigned_team values into legacy_assigned_team where worker_id is null
    await db.execute('UPDATE complaints SET legacy_assigned_team = assigned_team WHERE assigned_team IS NOT NULL AND worker_id IS NULL');
  }

  // Phase 3 Additions to complaints
  const hasTeamId = tableInfo.rows.some(row => row.name === 'team_id');
  if (!hasTeamId) {
    await db.execute('ALTER TABLE complaints ADD COLUMN team_id INTEGER REFERENCES teams(id)');
  }
  const hasStatusUpdated = tableInfo.rows.some(row => row.name === 'status_updated_at');
  if (!hasStatusUpdated) {
    await db.execute('ALTER TABLE complaints ADD COLUMN status_updated_at TEXT');
    await db.execute('UPDATE complaints SET status_updated_at = updated_at');
  }

  const hasLeaderId = tableInfo.rows.some(row => row.name === 'leader_id');
  if (!hasLeaderId) {
    await db.execute('ALTER TABLE complaints ADD COLUMN leader_id INTEGER REFERENCES workers(id)');
  }

  // Create Phase 3 Tables
  await db.execute(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS team_memberships (
      team_id INTEGER REFERENCES teams(id),
      worker_id INTEGER REFERENCES workers(id),
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, worker_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS complaint_workers (
      complaint_id INTEGER REFERENCES complaints(id),
      worker_id INTEGER REFERENCES workers(id),
      PRIMARY KEY (complaint_id, worker_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS work_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER REFERENCES complaints(id),
      worker_id INTEGER REFERENCES workers(id),
      notes TEXT,
      image_path TEXT,
      status TEXT DEFAULT 'Pending',
      rejection_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewer_id INTEGER REFERENCES admins(id)
    )
  `);

  try {
    // Add reviewer_id if it doesn't exist (idempotent migration)
    await db.execute('ALTER TABLE work_reports ADD COLUMN reviewer_id INTEGER REFERENCES admins(id)');
  } catch (e) {
    // Column already exists or error
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER REFERENCES complaints(id),
      status TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);





  // Seed default admin if none exists
  const adminExists = await db.execute('SELECT COUNT(*) as count FROM admins');
  if (adminExists.rows[0].count === 0) {
    const seedPassword = process.env.ADMIN_SEED_PASSWORD || (crypto.randomBytes(8).toString('hex') + 'A1!');
    const hash = bcrypt.hashSync(seedPassword, 10);
    await db.execute({
      sql: 'INSERT INTO admins (username, password_hash) VALUES (?, ?)',
      args: ['admin', hash]
    });
    
    console.log('Default admin created — username: admin');
    if (!process.env.ADMIN_SEED_PASSWORD) {
      console.log('IMPORTANT: A secure random password was generated for the admin account.');
      console.log('Since you did not provide ADMIN_SEED_PASSWORD, you must reset the admin password directly in the database or set ADMIN_SEED_PASSWORD before initializing a new environment.');
    }
  }

  // Phase 3 Data Migrations (Must run after workers table exists)
  // 1. Migrate existing worker_id into complaint_workers idempotently
  await db.execute(`
    INSERT INTO complaint_workers (complaint_id, worker_id)
    SELECT id, worker_id FROM complaints 
    WHERE worker_id IS NOT NULL 
    AND NOT EXISTS (
      SELECT 1 FROM complaint_workers cw 
      WHERE cw.complaint_id = complaints.id AND cw.worker_id = complaints.worker_id
    )
  `);

  // 2. Seed status_history for existing complaints if they have no history
  await db.execute(`
    INSERT INTO status_history (complaint_id, status, created_at)
    SELECT id, status, updated_at FROM complaints
    WHERE NOT EXISTS (
      SELECT 1 FROM status_history sh WHERE sh.complaint_id = complaints.id
    )
  `);

  return db;
}

module.exports = { initializeDatabase, getDatabase };

if (require.main === module) {
  require('dotenv').config();
  initializeDatabase()
    .then(() => {
      console.log('Database initialized successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to initialize database:', err);
      process.exit(1);
    });
}
