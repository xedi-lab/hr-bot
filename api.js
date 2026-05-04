const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

// Получить данные сотрудника
app.get('/employee/:telegram_id', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(parseInt(req.params.telegram_id));
  if (!employee) return res.status(404).json({ error: 'Сотрудник не найден' });
  res.json(employee);
});

// Получить статистику сотрудника за месяц
app.get('/employee/:telegram_id/stats', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(parseInt(req.params.telegram_id));
  if (!employee) return res.status(404).json({ error: 'Сотрудник не найден' });

  const now = new Date();
  now.setHours(now.getUTCHours() + 7);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const stats = db.prepare(`
    SELECT COUNT(*) as shifts_count, SUM(hours_worked) as total_hours, SUM(earned) as total_earned
    FROM shifts
    WHERE employee_id = ? AND start_time >= ? AND end_time IS NOT NULL
  `).get(employee.id, startOfMonth);

  const openShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(employee.id);

  res.json({ ...stats, on_shift: !!openShift, open_shift: openShift || null });
});

// Получить смены сотрудника
app.get('/employee/:telegram_id/shifts', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(parseInt(req.params.telegram_id));
  if (!employee) return res.status(404).json({ error: 'Сотрудник не найден' });

  const period = req.query.period || 'month';
  const now = new Date();
  now.setHours(now.getUTCHours() + 7);

  let startDate;
  if (period === 'week') {
    startDate = new Date(now);
    startDate.setDate(now.getDate() - 7);
  } else if (period === '3months') {
    startDate = new Date(now);
    startDate.setMonth(now.getMonth() - 3);
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const shifts = db.prepare(`
    SELECT * FROM shifts
    WHERE employee_id = ? AND start_time >= ? AND end_time IS NOT NULL
    ORDER BY start_time DESC
  `).all(employee.id, startDate.toISOString());

  res.json(shifts);
});

// Открыть смену
app.post('/employee/:telegram_id/shift/close', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(parseInt(req.params.telegram_id));
  if (!employee) return res.status(404).json({ error: 'Сотрудник не найден' });

  const openShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(employee.id);
  if (!openShift) return res.status(400).json({ error: 'Нет открытой смены' });

  const now = new Date();
  now.setHours(now.getUTCHours() + 7);
  const hour = now.getHours();

  // Минимум 30 минут
  const startTime = new Date(openShift.start_time);
  const diffMs = now - startTime;
  const diffMinutes = diffMs / (1000 * 60);
  if (diffMinutes < 30) {
    const remaining = Math.ceil(30 - diffMinutes);
    return res.status(400).json({ error: `Смену можно закрыть минимум через 30 минут. Осталось: ${remaining} мин.` });
  }

  let endTime = new Date(now);
  let warning = null;

  if (hour >= 21) {
    endTime.setHours(21, 0, 0, 0);
    warning = 'Переработка не учитывается. Оплата считается до 21:00.';
  }

  const hoursWorked = Math.max(0, (endTime - startTime) / (1000 * 60 * 60));
  const earned = parseFloat((hoursWorked * employee.hourly_rate).toFixed(2));

  db.prepare('UPDATE shifts SET end_time = ?, hours_worked = ?, earned = ? WHERE id = ?')
    .run(endTime.toISOString(), hoursWorked.toFixed(2), earned, openShift.id);

  res.json({ success: true, hours_worked: hoursWorked.toFixed(1), earned, warning });
});

app.post('/employee/:telegram_id/shift/open', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(parseInt(req.params.telegram_id));
  if (!employee) return res.status(404).json({ error: 'Сотрудник не найден' });

  const now = new Date();
  now.setHours(now.getUTCHours() + 7);
  const hour = now.getHours();


  if (hour < 9) return res.status(400).json({ error: `Смену можно открыть только с 09:00 НСК. Сейчас ${hour}:${String(now.getMinutes()).padStart(2, '0')}` });
  if (hour >= 21) return res.status(400).json({ error: 'Рабочий день уже закончился' });



  const openShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(employee.id);
  if (openShift) return res.status(400).json({ error: 'Смена уже открыта' });

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND start_time >= ? AND end_time IS NOT NULL').get(employee.id, startOfDay);
  if (todayShift) return res.status(400).json({ error: 'Ты уже отработал смену сегодня. До завтра! 👋' });

  db.prepare('INSERT INTO shifts (employee_id, start_time) VALUES (?, ?)').run(employee.id, now.toISOString());

  res.json({ success: true, time: `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
});

// Закрыть смену
app.post('/employee/:telegram_id/shift/close', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(parseInt(req.params.telegram_id));
  if (!employee) return res.status(404).json({ error: 'Сотрудник не найден' });

  const openShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(employee.id);
  if (!openShift) return res.status(400).json({ error: 'Нет открытой смены' });

  const now = new Date();
  now.setHours(now.getUTCHours() + 7);
  const hour = now.getHours();

  let endTime = new Date(now);
  let warning = null;

  if (hour >= 21) {
    endTime.setHours(21, 0, 0, 0);
    warning = 'Переработка не учитывается. Оплата считается до 21:00.';
  }

  const startTime = new Date(openShift.start_time);
  const diffMs = endTime - startTime;
  const hoursWorked = Math.max(0, diffMs / (1000 * 60 * 60));
  const earned = parseFloat((hoursWorked * employee.hourly_rate).toFixed(2));

  db.prepare('UPDATE shifts SET end_time = ?, hours_worked = ?, earned = ? WHERE id = ?')
    .run(endTime.toISOString(), hoursWorked.toFixed(2), earned, openShift.id);

  res.json({ success: true, hours_worked: hoursWorked.toFixed(1), earned, warning });
});

// Получить всех сотрудников (для админа)
app.get('/admin/employees', (req, res) => {
  const employees = db.prepare('SELECT * FROM employees').all();
  res.json(employees);
});

// Получить статистику всех сотрудников (для админа)
app.get('/admin/stats', (req, res) => {
  const now = new Date();
  now.setHours(now.getUTCHours() + 7);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const employees = db.prepare('SELECT * FROM employees').all();

  const result = employees.map(emp => {
    const stats = db.prepare(`
      SELECT COUNT(*) as shifts_count, SUM(hours_worked) as total_hours, SUM(earned) as total_earned
      FROM shifts
      WHERE employee_id = ? AND start_time >= ? AND end_time IS NOT NULL
    `).get(emp.id, startOfMonth);

    const onShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(emp.id);

    return { ...emp, ...stats, on_shift: !!onShift };
  });

  res.json(result);
});

app.listen(PORT, () => {
  console.log(`API сервер запущен на порту ${PORT}`);
});

module.exports = app;