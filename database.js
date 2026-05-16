const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false }
});

async function initDB() {
  // ── Companies (must be first — others reference it) ──────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      bot_token TEXT UNIQUE NOT NULL,
      admin_telegram_id BIGINT NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Core tables ───────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      telegram_id BIGINT,
      first_name TEXT,
      last_name TEXT,
      hourly_rate REAL,
      workplace TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, telegram_id)
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id),
      start_time TIMESTAMP,
      end_time TIMESTAMP,
      hours_worked REAL,
      earned REAL,
      confirmed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pending_employees (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      telegram_id BIGINT,
      first_name TEXT,
      last_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, telegram_id)
    );

    CREATE TABLE IF NOT EXISTS planned_shifts (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id),
      planned_date TEXT,
      shift_start TEXT,
      shift_end TEXT,
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS adjustments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id),
      amount REAL NOT NULL,
      comment TEXT,
      month TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Safe migrations for existing installs ─────────────────────────────────
  await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);`);
  await pool.query(`ALTER TABLE pending_employees ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);`);
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone_offset INTEGER DEFAULT 7;`);

  // ── Seed default company from env (backward compat for existing data) ─────
  const token = process.env.BOT_TOKEN;
  const adminId = parseInt(process.env.ADMIN_ID);
  if (token && adminId) {
    await pool.query(`
      INSERT INTO companies (name, bot_token, admin_telegram_id)
      VALUES ('Default', $1, $2)
      ON CONFLICT (bot_token) DO NOTHING
    `, [token, adminId]);

    // Attach orphan employees (existing data) to default company
    await pool.query(`
      UPDATE employees SET company_id = (
        SELECT id FROM companies WHERE bot_token = $1 LIMIT 1
      ) WHERE company_id IS NULL
    `, [token]);

    await pool.query(`
      UPDATE pending_employees SET company_id = (
        SELECT id FROM companies WHERE bot_token = $1 LIMIT 1
      ) WHERE company_id IS NULL
    `, [token]);
  }

  console.log('База данных инициализирована');
}

// Helper: get company by bot token
async function getCompanyByToken(token) {
  const { rows } = await pool.query('SELECT * FROM companies WHERE bot_token = $1 AND active = TRUE', [token]);
  return rows[0] || null;
}

// Helper: get all active companies
async function getAllCompanies() {
  const { rows } = await pool.query('SELECT * FROM companies WHERE active = TRUE ORDER BY created_at');
  return rows;
}

module.exports = { pool, initDB, getCompanyByToken, getAllCompanies };
