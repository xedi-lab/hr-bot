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

    await pool.query(
      'INSERT INTO planned_shifts (employee_id, planned_date, shift_start, shift_end, note) VALUES ($1, $2, $3, $4, $5)',
      [emp[0].id, planned_date, shift_start, shift_end, note || '']
    );

    // Уведомить сотрудника
    try {
      const botToken = process.env.BOT_TOKEN;
      const [year, month, day] = planned_date.split('-');
      const dateFormatted = `${day}.${month}.${year}`;
      const text = `📅 Тебе назначена смена!\n\n📆 ${dateFormatted}\n🕐 ${shift_start} — ${shift_end}${note ? `\n📍 ${note}` : ''}\n\nОткрой приложение чтобы посмотреть свой график.`;
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegram_id, text })
      });
    } catch {}

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

app.post('/register', async (req, res) => {
  try {
    const { telegram_id, first_name, last_name } = req.body;
    if (!telegram_id || !first_name || !last_name) {
      return res.status(400).json({ error: 'Заполни все поля' });
    }

    const { rows: existing } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(telegram_id)]);
    if (existing[0]) return res.status(400).json({ error: 'Ты уже зарегистрирован' });

    const { rows: pending } = await pool.query('SELECT * FROM pending_employees WHERE telegram_id = $1', [parseInt(telegram_id)]);
    if (pending[0]) return res.status(400).json({ status: 'pending' });

    await pool.query(
      'INSERT INTO pending_employees (telegram_id, first_name, last_name) VALUES ($1, $2, $3)',
      [parseInt(telegram_id), first_name.trim(), last_name.trim()]
    );

    // Уведомить администратора
    try {
      const botToken = process.env.BOT_TOKEN;
      const adminId = process.env.ADMIN_ID;
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminId,
          text: `📥 Новая заявка (мини-апп):\n\nИмя: ${first_name} ${last_name}\nTG ID: ${telegram_id}`,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Одобрить', callback_data: `approve_${telegram_id}` },
              { text: '❌ Отклонить', callback_data: `reject_${telegram_id}` }
            ]]
          }
        })
      });
    } catch {}

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Проверить статус регистрации
app.get('/register/status/:telegram_id', async (req, res) => {
  try {
    const id = parseInt(req.params.telegram_id);
    const { rows: emp } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [id]);
    if (emp[0]) return res.json({ status: 'approved' });

    const { rows: pending } = await pool.query('SELECT * FROM pending_employees WHERE telegram_id = $1', [id]);
    if (pending[0]) return res.json({ status: 'pending' });

    res.json({ status: 'none' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dashboard для админа
app.get('/admin/dashboard', async (req, res) => {
  try {
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const { rows: employees } = await pool.query('SELECT * FROM employees');

    const employeeStats = await Promise.all(employees.map(async emp => {
      const { rows: openShift } = await pool.query(
        'SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp.id]
      );
      const { rows: todayShift } = await pool.query(
        'SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL',
        [emp.id, startOfDay]
      );
      const { rows: monthStats } = await pool.query(
        'SELECT SUM(earned) as total_earned FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL',
        [emp.id, startOfMonth]
      );

      const onShift = openShift.length > 0;
      const workedToday = todayShift.length > 0;

      let status = 'not_working';
      if (onShift) status = 'on_shift';
      else if (workedToday) status = 'done';

      return {
        id: emp.id,
        telegram_id: emp.telegram_id,
        first_name: emp.first_name,
        last_name: emp.last_name,
        workplace: emp.workplace,
        hourly_rate: emp.hourly_rate,
        status,
        on_shift: onShift,
        open_shift: openShift[0] || null,
        worked_today: workedToday,
        today_earned: todayShift.reduce((sum, s) => sum + parseFloat(s.earned || 0), 0),
        today_hours: todayShift.reduce((sum, s) => sum + parseFloat(s.hours_worked || 0), 0),
        month_earned: parseFloat(monthStats[0]?.total_earned || 0)
      };
    }));

    const onShiftNow = employeeStats.filter(e => e.status === 'on_shift');
    const doneToday = employeeStats.filter(e => e.status === 'done');
    const notWorking = employeeStats.filter(e => e.status === 'not_working');

    const totalTodayEarned = employeeStats.reduce((sum, e) => sum + e.today_earned, 0);
    const totalMonthEarned = employeeStats.reduce((sum, e) => sum + e.month_earned, 0);

    // Лента активности — последние 20 событий за сегодня
    const { rows: activity } = await pool.query(`
      SELECT s.*, e.first_name, e.last_name
      FROM shifts s
      JOIN employees e ON s.employee_id = e.id
      WHERE s.start_time >= $1
      ORDER BY GREATEST(s.start_time, COALESCE(s.end_time, s.start_time)) DESC
      LIMIT 20
    `, [startOfDay]);

    res.json({
      summary: {
        on_shift_count: onShiftNow.length,
        done_today_count: doneToday.length,
        not_working_count: notWorking.length,
        total_employees: employees.length,
        today_payroll: parseFloat(totalTodayEarned.toFixed(2)),
        month_payroll: parseFloat(totalMonthEarned.toFixed(2))
      },
      employees: employeeStats,
      activity
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`API сервер запущен на порту ${PORT}`));

module.exports = app;