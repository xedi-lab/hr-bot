const express = require('express');
const cors = require('cors');
const { pool } = require('./database');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Получить сотрудника
app.get('/employee/:telegram_id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(req.params.telegram_id)]);
    if (!rows[0]) return res.status(404).json({ error: 'Сотрудник не найден' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Статистика сотрудника
app.get('/employee/:telegram_id/stats', async (req, res) => {
  try {
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(req.params.telegram_id)]);
    if (!emp[0]) return res.status(404).json({ error: 'Сотрудник не найден' });

    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const { rows: stats } = await pool.query(`
      SELECT COUNT(*) as shifts_count, SUM(hours_worked) as total_hours, SUM(earned) as total_earned
      FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL
    `, [emp[0].id, startOfMonth]);

    const { rows: openShift } = await pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp[0].id]);

    res.json({ ...stats[0], on_shift: openShift.length > 0, open_shift: openShift[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Смены сотрудника
app.get('/employee/:telegram_id/shifts', async (req, res) => {
  try {
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(req.params.telegram_id)]);
    if (!emp[0]) return res.status(404).json({ error: 'Сотрудник не найден' });

    const period = req.query.period || 'month';
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);

    let startDate;
    if (period === 'week') { startDate = new Date(now); startDate.setDate(now.getDate() - 7); }
    else if (period === '3months') { startDate = new Date(now); startDate.setMonth(now.getMonth() - 3); }
    else { startDate = new Date(now.getFullYear(), now.getMonth(), 1); }

    const { rows } = await pool.query(`
      SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL
      ORDER BY start_time DESC
    `, [emp[0].id, startDate]);

    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Открыть смену
app.post('/employee/:telegram_id/shift/open', async (req, res) => {
  try {
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(req.params.telegram_id)]);
    if (!emp[0]) return res.status(404).json({ error: 'Сотрудник не найден' });

    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const hour = now.getHours();

    if (hour < 9) return res.status(400).json({ error: `Смену можно открыть только с 09:00 НСК. Сейчас ${hour}:${String(now.getMinutes()).padStart(2, '0')}` });
    if (hour >= 21) return res.status(400).json({ error: 'Рабочий день уже закончился' });

    const { rows: openShift } = await pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp[0].id]);
    if (openShift.length > 0) return res.status(400).json({ error: 'Смена уже открыта' });

    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const { rows: todayShift } = await pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL', [emp[0].id, startOfDay]);
    if (todayShift.length > 0) return res.status(400).json({ error: 'Ты уже отработал смену сегодня. До завтра! 👋' });

    await pool.query('INSERT INTO shifts (employee_id, start_time) VALUES ($1, $2)', [emp[0].id, now]);

    res.json({ success: true, time: `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Закрыть смену
app.post('/employee/:telegram_id/shift/close', async (req, res) => {
  try {
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(req.params.telegram_id)]);
    if (!emp[0]) return res.status(404).json({ error: 'Сотрудник не найден' });

    const { rows: openShift } = await pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp[0].id]);
    if (!openShift[0]) return res.status(400).json({ error: 'Нет открытой смены' });

    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const hour = now.getHours();

    const startTime = new Date(openShift[0].start_time);
    const diffMinutes = (now - startTime) / (1000 * 60);
    if (diffMinutes < 30) {
      const remaining = Math.ceil(30 - diffMinutes);
      return res.status(400).json({ error: `Смену можно закрыть минимум через 30 минут. Осталось: ${remaining} мин.` });
    }

    let endTime = new Date(now);
    let warning = null;
    if (hour >= 21) {
      endTime = new Date(now);
      endTime.setHours(21, 0, 0, 0);
      warning = 'Переработка не учитывается. Оплата считается до 21:00.';
    }

    const hoursWorked = Math.max(0, (endTime - startTime) / (1000 * 60 * 60));
    const earned = parseFloat((hoursWorked * emp[0].hourly_rate).toFixed(2));

    await pool.query('UPDATE shifts SET end_time = $1, hours_worked = $2, earned = $3 WHERE id = $4',
      [endTime, hoursWorked.toFixed(2), earned, openShift[0].id]);

    res.json({ success: true, hours_worked: hoursWorked.toFixed(1), earned, warning });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Плановые смены сотрудника
app.get('/employee/:telegram_id/planned', async (req, res) => {
  try {
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(req.params.telegram_id)]);
    if (!emp[0]) return res.status(404).json({ error: 'не найден' });
    const { rows } = await pool.query('SELECT * FROM planned_shifts WHERE employee_id = $1 ORDER BY planned_date ASC', [emp[0].id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Статистика всех сотрудников (админ)
app.get('/admin/stats', async (req, res) => {
  try {
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const { rows: employees } = await pool.query('SELECT * FROM employees');

    const result = await Promise.all(employees.map(async emp => {
      const { rows: stats } = await pool.query(`
        SELECT COUNT(*) as shifts_count, SUM(hours_worked) as total_hours, SUM(earned) as total_earned
        FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL
      `, [emp.id, startOfMonth]);

      const { rows: onShift } = await pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp.id]);

      return { ...emp, ...stats[0], on_shift: onShift.length > 0 };
    }));

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Добавить плановую смену
app.post('/admin/planned-shift', async (req, res) => {
  try {
    const { telegram_id, planned_date, shift_start, shift_end, note } = req.body;
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(telegram_id)]);
    if (!emp[0]) return res.status(404).json({ error: 'не найден' });
    await pool.query('INSERT INTO planned_shifts (employee_id, planned_date, shift_start, shift_end, note) VALUES ($1, $2, $3, $4, $5)',
      [emp[0].id, planned_date, shift_start, shift_end, note || '']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Удалить плановую смену
app.delete('/admin/planned-shift/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM planned_shifts WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Обновить сотрудника
app.patch('/admin/employee/:telegram_id', async (req, res) => {
  try {
    const { hourly_rate, workplace } = req.body;
    if (hourly_rate !== undefined) await pool.query('UPDATE employees SET hourly_rate = $1 WHERE telegram_id = $2', [parseFloat(hourly_rate), parseInt(req.params.telegram_id)]);
    if (workplace !== undefined) await pool.query('UPDATE employees SET workplace = $1 WHERE telegram_id = $2', [workplace, parseInt(req.params.telegram_id)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// История смен сотрудника (админ)
app.get('/admin/employee/:telegram_id/shifts', async (req, res) => {
  try {
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(req.params.telegram_id)]);
    if (!emp[0]) return res.status(404).json({ error: 'не найден' });
    const { rows } = await pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NOT NULL ORDER BY start_time DESC LIMIT 50', [emp[0].id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Плановые смены сотрудника (админ)
app.get('/admin/employee/:telegram_id/planned', async (req, res) => {
  try {
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(req.params.telegram_id)]);
    if (!emp[0]) return res.status(404).json({ error: 'не найден' });
    const { rows } = await pool.query('SELECT * FROM planned_shifts WHERE employee_id = $1 ORDER BY planned_date ASC', [emp[0].id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Сброс смены (утилита)
app.get('/admin/reset-shift/:telegram_id', async (req, res) => {
  try {
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(req.params.telegram_id)]);
    if (!emp[0]) return res.status(404).json({ error: 'не найден' });
    await pool.query('UPDATE shifts SET end_time = start_time, hours_worked = 0, earned = 0 WHERE employee_id = $1 AND end_time IS NULL', [emp[0].id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`API сервер запущен на порту ${PORT}`));

module.exports = app;