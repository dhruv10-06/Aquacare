const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

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
    const hash = bcrypt.hashSync('aq098aq.', 10);
    await db.execute({
      sql: 'INSERT INTO admins (username, password_hash) VALUES (?, ?)',
      args: ['admin', hash]
    });
    console.log('Default admin created — username: admin');
  }

  return db;
}

module.exports = { initializeDatabase, getDatabase };
