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

  return db;
}

module.exports = { initializeDatabase, getDatabase };
