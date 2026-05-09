const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal') 
    ? false 
    : { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      first_name TEXT,
      last_name TEXT,
      hourly_rate REAL,
      workplace TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id),
      start_time TIMESTAMP,
      end_time TIMESTAMP,
      hours_worked REAL,
      earned REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pending_employees (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      first_name TEXT,
      last_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  console.log('База данных инициализирована');
}

module.exports = { pool, initDB };