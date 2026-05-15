const express = require('express');
const cors = require('cors');
const ExcelJS = require('exceljs');
const { pool } = require('./database');

const app = express();

function nsk() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ── Helpers ───────────────────────────────────────────────────────────────────

function cid(req) {
  return parseInt(req.query.cid || req.body?.cid);
}

async function getEmployee(telegram_id, company_id) {
  const { rows } = await pool.query(
    'SELECT * FROM employees WHERE telegram_id = $1 AND company_id = $2',
    [parseInt(telegram_id), company_id]
  );
  return rows[0] || null;
}

async function getCompanyToken(company_id) {
  const { rows } = await pool.query('SELECT bot_token FROM companies WHERE id = $1', [company_id]);
  return rows[0]?.bot_token || null;
}

function requireCid(req, res) {
  const id = cid(req);
  if (!id || isNaN(id)) {
    res.status(400).json({ error: 'cid (company_id) обязателен' });
    return null;
  }
  return id;
}

// ── Проверить является ли пользователь админом компании ──────────────────────

app.get('/admin/me', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const uid = parseInt(req.query.uid);
    if (!uid) return res.json({ is_admin: false });
    const { rows } = await pool.query(
      'SELECT id FROM companies WHERE id = $1 AND admin_telegram_id = $2 AND active = TRUE',
      [companyId, uid]
    );
    res.json({ is_admin: rows.length > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Получить сотрудника ───────────────────────────────────────────────────────

app.get('/employee/:telegram_id', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'Сотрудник не найден' });
    res.json(emp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Статистика сотрудника ─────────────────────────────────────────────────────

app.get('/employee/:telegram_id/stats', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'Сотрудник не найден' });

    const now = nsk();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const { rows: stats } = await pool.query(`
      SELECT COUNT(*) as shifts_count, SUM(hours_worked) as total_hours, SUM(earned) as total_earned
      FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL
    `, [emp.id, startOfMonth]);

    const { rows: openShift } = await pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp.id]);

    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const { rows: todayShifts } = await pool.query(
      'SELECT id FROM shifts WHERE employee_id = $1 AND start_time >= $2',
      [emp.id, startOfDay]
    );

    res.json({ ...stats[0], on_shift: openShift.length > 0, open_shift: openShift[0] || null, worked_today: todayShifts.length > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Смены сотрудника ──────────────────────────────────────────────────────────

app.get('/employee/:telegram_id/shifts', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'Сотрудник не найден' });

    const period = req.query.period || 'month';
    const now = nsk();

    let startDate;
    if (period === 'week') { startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); }
    else if (period === '3months') { startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate())); }
    else { startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); }

    const { rows } = await pool.query(`
      SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL
      ORDER BY start_time DESC
    `, [emp.id, startDate]);

    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Подтвердить смену ─────────────────────────────────────────────────────────

app.post('/employee/:telegram_id/shift/open', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'Сотрудник не найден' });

    const { rows: openShift } = await pool.query(
      'SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL AND confirmed_at IS NULL',
      [emp.id]
    );
    if (!openShift[0]) return res.status(400).json({ error: 'Нет активной смены для подтверждения' });

    const now = nsk();
    await pool.query('UPDATE shifts SET confirmed_at = $1 WHERE id = $2', [now, openShift[0].id]);

    res.json({ success: true, confirmed_at: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Закрыть смену ─────────────────────────────────────────────────────────────

app.post('/employee/:telegram_id/shift/close', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'Сотрудник не найден' });

    const { rows: openShift } = await pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp.id]);
    if (!openShift[0]) return res.status(400).json({ error: 'Нет открытой смены' });

    const now = nsk();
    const hour = now.getUTCHours();
    const startTime = new Date(openShift[0].start_time);
    const diffMinutes = (now - startTime) / (1000 * 60);

    if (diffMinutes < 30) {
      const remaining = Math.ceil(30 - diffMinutes);
      return res.status(400).json({ error: `Смену можно закрыть минимум через 30 минут. Осталось: ${remaining} мин.` });
    }

    let endTime = new Date(now);
    let warning = null;
    if (hour >= 21) {
      endTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 0, 0));
      warning = 'Переработка не учитывается. Оплата считается до 21:00.';
    }

    const hoursWorked = Math.max(0, (endTime - startTime) / (1000 * 60 * 60));
    const earned = parseFloat((hoursWorked * emp.hourly_rate).toFixed(2));

    await pool.query('UPDATE shifts SET end_time = $1, hours_worked = $2, earned = $3 WHERE id = $4',
      [endTime, hoursWorked.toFixed(2), earned, openShift[0].id]);

    res.json({ success: true, hours_worked: hoursWorked.toFixed(1), earned, warning });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Плановые смены сотрудника ─────────────────────────────────────────────────

app.get('/employee/:telegram_id/planned', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });
    const { rows } = await pool.query('SELECT * FROM planned_shifts WHERE employee_id = $1 ORDER BY planned_date ASC', [emp.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Отработанные смены для календаря ─────────────────────────────────────────

app.get('/employee/:telegram_id/shifts/calendar', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });

    const _now = nsk();
    const threeMonthsAgo = new Date(Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth() - 3, _now.getUTCDate()));

    const { rows } = await pool.query(
      `SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL ORDER BY start_time DESC`,
      [emp.id, threeMonthsAgo]
    );

    const result = rows.map(s => {
      const start = new Date(s.start_time);
      const end = new Date(s.end_time);
      const dateStr = `${start.getUTCFullYear()}-${String(start.getUTCMonth()+1).padStart(2,'0')}-${String(start.getUTCDate()).padStart(2,'0')}`;
      return {
        id: s.id,
        date: dateStr,
        start_time: `${String(start.getUTCHours()).padStart(2,'0')}:${String(start.getUTCMinutes()).padStart(2,'0')}`,
        end_time: `${String(end.getUTCHours()).padStart(2,'0')}:${String(end.getUTCMinutes()).padStart(2,'0')}`,
        hours_worked: parseFloat(s.hours_worked).toFixed(1),
        earned: parseFloat(s.earned).toFixed(0)
      };
    });

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Аналитика сотрудника ──────────────────────────────────────────────────────

app.get('/employee/:telegram_id/analytics', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });

    const now = nsk();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const threeMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate()));

    const [{ rows: weekShifts }, { rows: monthShifts }, { rows: threeMonthShifts }] = await Promise.all([
      pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL', [emp.id, weekStart]),
      pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL', [emp.id, monthStart]),
      pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL', [emp.id, threeMonthStart])
    ]);

    const monthEarned = monthShifts.reduce((sum, s) => sum + parseFloat(s.earned || 0), 0);
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const daysPassed = now.getUTCDate();
    const avgDaily = daysPassed > 0 ? monthEarned / daysPassed : 0;
    const forecast = Math.round(monthEarned + avgDaily * (daysInMonth - daysPassed));

    const todayStr = now.toISOString().slice(0, 10);
    const monthStartStr = monthStart.toISOString().slice(0, 10);
    const { rows: plannedThisMonth } = await pool.query(
      'SELECT * FROM planned_shifts WHERE employee_id = $1 AND planned_date >= $2 AND planned_date <= $3',
      [emp.id, monthStartStr, todayStr]
    );

    const plannedCount = plannedThisMonth.length;
    const workedCount = monthShifts.length;
    const attendanceRate = plannedCount > 0 ? Math.round((workedCount / plannedCount) * 100) : null;

    res.json({
      week: {
        shifts_count: weekShifts.length,
        hours: weekShifts.reduce((sum, s) => sum + parseFloat(s.hours_worked || 0), 0).toFixed(1),
        earned: weekShifts.reduce((sum, s) => sum + parseFloat(s.earned || 0), 0).toFixed(0)
      },
      month: {
        shifts_count: monthShifts.length,
        hours: monthShifts.reduce((sum, s) => sum + parseFloat(s.hours_worked || 0), 0).toFixed(1),
        earned: monthEarned.toFixed(0)
      },
      three_months: {
        shifts_count: threeMonthShifts.length,
        hours: threeMonthShifts.reduce((sum, s) => sum + parseFloat(s.hours_worked || 0), 0).toFixed(1),
        earned: threeMonthShifts.reduce((sum, s) => sum + parseFloat(s.earned || 0), 0).toFixed(0)
      },
      forecast,
      attendance_rate: attendanceRate,
      planned_count: plannedCount,
      worked_count: workedCount
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Регистрация (мини-апп) ────────────────────────────────────────────────────

app.post('/register', async (req, res) => {
  try {
    const { telegram_id, first_name, last_name, cid: company_id } = req.body;
    if (!telegram_id || !first_name || !last_name || !company_id) {
      return res.status(400).json({ error: 'Заполни все поля (telegram_id, first_name, last_name, cid)' });
    }

    const companyId = parseInt(company_id);

    const { rows: existing } = await pool.query(
      'SELECT * FROM employees WHERE telegram_id = $1 AND company_id = $2',
      [parseInt(telegram_id), companyId]
    );
    if (existing[0]) return res.status(400).json({ error: 'Ты уже зарегистрирован' });

    const { rows: pending } = await pool.query(
      'SELECT * FROM pending_employees WHERE telegram_id = $1 AND company_id = $2',
      [parseInt(telegram_id), companyId]
    );
    if (pending[0]) return res.status(400).json({ status: 'pending' });

    await pool.query(
      'INSERT INTO pending_employees (company_id, telegram_id, first_name, last_name) VALUES ($1, $2, $3, $4)',
      [companyId, parseInt(telegram_id), first_name.trim(), last_name.trim()]
    );

    // Уведомить администратора через бота компании
    try {
      const { rows: company } = await pool.query(
        'SELECT bot_token, admin_telegram_id FROM companies WHERE id = $1', [companyId]
      );
      if (company[0]) {
        const { bot_token, admin_telegram_id } = company[0];
        await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: admin_telegram_id,
            text: `📥 Новая заявка:\n\nИмя: ${first_name} ${last_name}\nTG ID: ${telegram_id}`,
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Одобрить', callback_data: `approve_${telegram_id}` },
                { text: '❌ Отклонить', callback_data: `reject_${telegram_id}` }
              ]]
            }
          })
        });
      }
    } catch {}

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Проверить статус регистрации ──────────────────────────────────────────────

app.get('/register/status/:telegram_id', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const id = parseInt(req.params.telegram_id);

    const { rows: emp } = await pool.query(
      'SELECT * FROM employees WHERE telegram_id = $1 AND company_id = $2', [id, companyId]
    );
    if (emp[0]) return res.json({ status: 'approved' });

    const { rows: pending } = await pool.query(
      'SELECT * FROM pending_employees WHERE telegram_id = $1 AND company_id = $2', [id, companyId]
    );
    if (pending[0]) return res.json({ status: 'pending' });

    res.json({ status: 'none' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Статистика всех сотрудников (админ) ──────────────────────────────────────

app.get('/admin/stats', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const now = nsk();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const { rows: employees } = await pool.query('SELECT * FROM employees WHERE company_id = $1', [companyId]);

    const result = await Promise.all(employees.map(async emp => {
      const { rows: stats } = await pool.query(`
        SELECT COUNT(*) as shifts_count, SUM(hours_worked) as total_hours, SUM(earned) as total_earned
        FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL
      `, [emp.id, startOfMonth]);
      const { rows: onShift } = await pool.query('SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp.id]);
      return { ...emp, ...stats[0], on_shift: onShift.length > 0, open_shift: onShift[0] || null };
    }));

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard для админа ──────────────────────────────────────────────────────

app.get('/admin/dashboard', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const now = nsk();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const { rows: employees } = await pool.query('SELECT * FROM employees WHERE company_id = $1', [companyId]);

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

    const { rows: activity } = await pool.query(`
      SELECT s.*, e.first_name, e.last_name
      FROM shifts s
      JOIN employees e ON s.employee_id = e.id
      WHERE s.start_time >= $1 AND e.company_id = $2
      ORDER BY GREATEST(s.start_time, COALESCE(s.end_time, s.start_time)) DESC
      LIMIT 20
    `, [startOfDay, companyId]);

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

// ── Добавить плановую смену ───────────────────────────────────────────────────

app.post('/admin/planned-shift', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const { telegram_id, planned_date, shift_start, shift_end, note } = req.body;
    const emp = await getEmployee(telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });

    await pool.query(
      'INSERT INTO planned_shifts (employee_id, planned_date, shift_start, shift_end, note) VALUES ($1, $2, $3, $4, $5)',
      [emp.id, planned_date, shift_start, shift_end, note || '']
    );

    try {
      const botToken = await getCompanyToken(companyId);
      if (botToken) {
        const [year, month, day] = planned_date.split('-');
        const dateFormatted = `${day}.${month}.${year}`;
        const text = `📅 Тебе назначена смена!\n\n📆 ${dateFormatted}\n🕐 ${shift_start} — ${shift_end}${note ? `\n📍 ${note}` : ''}\n\nОткрой приложение чтобы посмотреть свой график.`;
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: telegram_id, text })
        });
      }
    } catch {}

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Удалить плановую смену ────────────────────────────────────────────────────

app.delete('/admin/planned-shift/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM planned_shifts WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Повторяющиеся смены ───────────────────────────────────────────────────────

app.post('/admin/planned-shift/repeat', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const { telegram_id, shift_start, shift_end, note, weeks } = req.body;
    const emp = await getEmployee(telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });

    const baseDate = new Date(req.body.planned_date);
    const created = [];

    for (let i = 0; i < (weeks || 4); i++) {
      const d = new Date(baseDate.getTime() + i * 7 * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const { rows: exists } = await pool.query(
        'SELECT id FROM planned_shifts WHERE employee_id = $1 AND planned_date = $2',
        [emp.id, dateStr]
      );
      if (exists.length > 0) continue;
      await pool.query(
        'INSERT INTO planned_shifts (employee_id, planned_date, shift_start, shift_end, note) VALUES ($1, $2, $3, $4, $5)',
        [emp.id, dateStr, shift_start, shift_end, note || '']
      );
      created.push(dateStr);
    }

    try {
      const botToken = await getCompanyToken(companyId);
      if (botToken) {
        const text = `📅 Вам назначены повторяющиеся смены!\n\n🕐 ${shift_start} — ${shift_end}\n📆 ${created.length} недель начиная с ${baseDate.toLocaleDateString('ru-RU')}${note ? `\n📍 ${note}` : ''}`;
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: telegram_id, text })
        });
      }
    } catch {}

    res.json({ success: true, created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Обновить сотрудника ───────────────────────────────────────────────────────

app.patch('/admin/employee/:telegram_id', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const { hourly_rate, workplace } = req.body;
    const telegram_id = parseInt(req.params.telegram_id);
    if (hourly_rate !== undefined) {
      await pool.query(
        'UPDATE employees SET hourly_rate = $1 WHERE telegram_id = $2 AND company_id = $3',
        [parseFloat(hourly_rate), telegram_id, companyId]
      );
    }
    if (workplace !== undefined) {
      await pool.query(
        'UPDATE employees SET workplace = $1 WHERE telegram_id = $2 AND company_id = $3',
        [workplace, telegram_id, companyId]
      );
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── История смен сотрудника (админ) ──────────────────────────────────────────

app.get('/admin/employee/:telegram_id/shifts', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });
    const { rows } = await pool.query(
      'SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NOT NULL ORDER BY start_time DESC LIMIT 50',
      [emp.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Плановые смены сотрудника (админ) ────────────────────────────────────────

app.get('/admin/employee/:telegram_id/planned', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });
    const { rows } = await pool.query(
      'SELECT * FROM planned_shifts WHERE employee_id = $1 ORDER BY planned_date ASC', [emp.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Сброс смены (утилита) ─────────────────────────────────────────────────────

app.get('/admin/reset-shift/:telegram_id', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });
    await pool.query(
      'UPDATE shifts SET end_time = start_time, hours_worked = 0, earned = 0 WHERE employee_id = $1 AND end_time IS NULL',
      [emp.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Бонусы / штрафы ──────────────────────────────────────────────────────────

app.get('/admin/employee/:telegram_id/adjustments', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });
    const month = req.query.month || nsk().toISOString().slice(0, 7);
    const { rows } = await pool.query(
      'SELECT * FROM adjustments WHERE employee_id = $1 AND month = $2 ORDER BY created_at DESC',
      [emp.id, month]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/adjustment', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const { telegram_id, amount, comment, month } = req.body;
    const emp = await getEmployee(telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });
    const m = month || nsk().toISOString().slice(0, 7);
    await pool.query(
      'INSERT INTO adjustments (employee_id, amount, comment, month) VALUES ($1, $2, $3, $4)',
      [emp.id, parseFloat(amount), comment || '', m]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/adjustment/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM adjustments WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Неявки ────────────────────────────────────────────────────────────────────

app.get('/admin/employee/:telegram_id/no-shows', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const emp = await getEmployee(req.params.telegram_id, companyId);
    if (!emp) return res.status(404).json({ error: 'не найден' });
    const now = nsk();
    const monthStart = req.query.month ? req.query.month + '-01' : now.toISOString().slice(0, 7) + '-01';

    const { rows } = await pool.query(`
      SELECT ps.planned_date, ps.shift_start, ps.shift_end
      FROM planned_shifts ps
      WHERE ps.employee_id = $1
        AND ps.planned_date >= $2
        AND ps.planned_date < $3
        AND NOT EXISTS (
          SELECT 1 FROM shifts s
          WHERE s.employee_id = ps.employee_id
            AND DATE(s.start_time) = ps.planned_date::date
            AND s.hours_worked > 0
        )
      ORDER BY ps.planned_date DESC
    `, [emp.id, monthStart, now.toISOString().slice(0, 10)]);

    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Расчётный лист ────────────────────────────────────────────────────────────

app.get('/admin/payroll', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const now = nsk();
    const month = req.query.month || now.toISOString().slice(0, 7);
    const [year, mon] = month.split('-').map(Number);
    const monthStart = new Date(Date.UTC(year, mon - 1, 1));
    const monthEnd = new Date(Date.UTC(year, mon, 1));

    const { rows: employees } = await pool.query(
      'SELECT * FROM employees WHERE company_id = $1', [companyId]
    );

    const result = await Promise.all(employees.map(async emp => {
      const { rows: shifts } = await pool.query(
        'SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND start_time < $3 AND end_time IS NOT NULL AND hours_worked > 0',
        [emp.id, monthStart, monthEnd]
      );
      const { rows: adjs } = await pool.query(
        'SELECT * FROM adjustments WHERE employee_id = $1 AND month = $2', [emp.id, month]
      );
      const monthStartStr = month + '-01';
      const todayStr = now.toISOString().slice(0, 10);
      const { rows: noShows } = await pool.query(`
        SELECT COUNT(*) as cnt FROM planned_shifts ps
        WHERE ps.employee_id = $1
          AND ps.planned_date >= $2 AND ps.planned_date < $3
          AND NOT EXISTS (
            SELECT 1 FROM shifts s
            WHERE s.employee_id = ps.employee_id
              AND DATE(s.start_time) = ps.planned_date::date
              AND s.hours_worked > 0
          )
      `, [emp.id, monthStartStr, todayStr]);

      const earned = shifts.reduce((s, r) => s + parseFloat(r.earned || 0), 0);
      const hours = shifts.reduce((s, r) => s + parseFloat(r.hours_worked || 0), 0);
      const adjTotal = adjs.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
      const total = earned + adjTotal;

      return {
        id: emp.id,
        telegram_id: emp.telegram_id,
        first_name: emp.first_name,
        last_name: emp.last_name,
        workplace: emp.workplace,
        hourly_rate: emp.hourly_rate,
        shifts_count: shifts.length,
        hours: parseFloat(hours.toFixed(2)),
        earned: parseFloat(earned.toFixed(2)),
        adjustments: adjs,
        adj_total: parseFloat(adjTotal.toFixed(2)),
        total: parseFloat(total.toFixed(2)),
        no_shows: parseInt(noShows[0].cnt)
      };
    }));

    res.json({ month, employees: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Excel экспорт ─────────────────────────────────────────────────────────────

app.get('/admin/export/payroll', async (req, res) => {
  try {
    const companyId = requireCid(req, res);
    if (!companyId) return;
    const now = nsk();
    const month = req.query.month || now.toISOString().slice(0, 7);
    const [year, mon] = month.split('-').map(Number);
    const monthStart = new Date(Date.UTC(year, mon - 1, 1));
    const monthEnd = new Date(Date.UTC(year, mon, 1));

    const { rows: employees } = await pool.query(
      'SELECT * FROM employees WHERE company_id = $1 ORDER BY first_name', [companyId]
    );
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HR-Bot';

    // ── Лист 1: Сводный расчётный лист ──────────────────────────────────────
    const summarySheet = workbook.addWorksheet('Расчётный лист');
    summarySheet.columns = [
      { header: 'Сотрудник', key: 'name', width: 22 },
      { header: 'Место работы', key: 'workplace', width: 18 },
      { header: 'Ставка ₽/ч', key: 'rate', width: 12 },
      { header: 'Смен', key: 'shifts', width: 8 },
      { header: 'Часов', key: 'hours', width: 10 },
      { header: 'Заработано ₽', key: 'earned', width: 14 },
      { header: 'Корр. ₽', key: 'adj', width: 12 },
      { header: 'Неявок', key: 'noshows', width: 9 },
      { header: 'К выплате ₽', key: 'total', width: 14 },
    ];

    const headerRow = summarySheet.getRow(1);
    headerRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C1C1E' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF3A3A3C' } } };
    });
    headerRow.height = 28;

    const todayStr = now.toISOString().slice(0, 10);
    const monthStartStr = month + '-01';

    for (const emp of employees) {
      const { rows: shifts } = await pool.query(
        'SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND start_time < $3 AND end_time IS NOT NULL AND hours_worked > 0',
        [emp.id, monthStart, monthEnd]
      );
      const { rows: adjs } = await pool.query('SELECT * FROM adjustments WHERE employee_id = $1 AND month = $2', [emp.id, month]);
      const { rows: noShows } = await pool.query(`
        SELECT COUNT(*) as cnt FROM planned_shifts ps
        WHERE ps.employee_id = $1 AND ps.planned_date >= $2 AND ps.planned_date < $3
          AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.employee_id = ps.employee_id AND DATE(s.start_time) = ps.planned_date::date AND s.hours_worked > 0)
      `, [emp.id, monthStartStr, todayStr]);

      const earned = shifts.reduce((s, r) => s + parseFloat(r.earned || 0), 0);
      const hours = shifts.reduce((s, r) => s + parseFloat(r.hours_worked || 0), 0);
      const adj = adjs.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
      const total = earned + adj;
      const noShowCount = parseInt(noShows[0].cnt);

      const row = summarySheet.addRow({
        name: `${emp.first_name} ${emp.last_name}`,
        workplace: emp.workplace || '—',
        rate: emp.hourly_rate,
        shifts: shifts.length,
        hours: parseFloat(hours.toFixed(2)),
        earned: parseFloat(earned.toFixed(2)),
        adj: adj !== 0 ? parseFloat(adj.toFixed(2)) : '—',
        noshows: noShowCount || '—',
        total: parseFloat(total.toFixed(2)),
      });

      row.height = 22;
      row.eachCell((cell, col) => {
        cell.alignment = { vertical: 'middle', horizontal: col <= 2 ? 'left' : 'center' };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E5EA' } } };
      });
      if (adj < 0) row.getCell('adj').font = { color: { argb: 'FFFF3B30' } };
      if (adj > 0) row.getCell('adj').font = { color: { argb: 'FF34C759' } };
      row.getCell('total').font = { bold: true };
    }

    const lastRow = summarySheet.lastRow.number + 1;
    const totalRow = summarySheet.addRow({
      name: 'ИТОГО',
      workplace: '', rate: '', shifts: { formula: `SUM(D2:D${lastRow - 1})` },
      hours: { formula: `SUM(E2:E${lastRow - 1})` },
      earned: { formula: `SUM(F2:F${lastRow - 1})` },
      adj: '', noshows: '',
      total: { formula: `SUM(I2:I${lastRow - 1})` },
    });
    totalRow.height = 24;
    totalRow.eachCell(cell => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F7' } };
      cell.border = { top: { style: 'thin', color: { argb: 'FFD1D1D6' } } };
    });

    // ── Лист 2: Детальный табель ─────────────────────────────────────────────
    const detailSheet = workbook.addWorksheet('Табель смен');
    detailSheet.columns = [
      { header: 'Сотрудник', key: 'name', width: 22 },
      { header: 'Место работы', key: 'workplace', width: 18 },
      { header: 'Дата', key: 'date', width: 12 },
      { header: 'Начало', key: 'start', width: 10 },
      { header: 'Конец', key: 'end', width: 10 },
      { header: 'Часов', key: 'hours', width: 10 },
      { header: 'Заработано ₽', key: 'earned', width: 14 },
      { header: 'Подтверждено', key: 'confirmed', width: 14 },
    ];
    const detailHeader = detailSheet.getRow(1);
    detailHeader.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C1C1E' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    detailHeader.height = 28;

    for (const emp of employees) {
      const { rows: shifts } = await pool.query(
        'SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND start_time < $3 AND end_time IS NOT NULL AND hours_worked > 0 ORDER BY start_time',
        [emp.id, monthStart, monthEnd]
      );
      for (const s of shifts) {
        const start = new Date(s.start_time);
        const end = new Date(s.end_time);
        const row = detailSheet.addRow({
          name: `${emp.first_name} ${emp.last_name}`,
          workplace: emp.workplace || '—',
          date: `${String(start.getUTCDate()).padStart(2,'0')}.${String(start.getUTCMonth()+1).padStart(2,'0')}`,
          start: `${String(start.getUTCHours()).padStart(2,'0')}:${String(start.getUTCMinutes()).padStart(2,'0')}`,
          end: `${String(end.getUTCHours()).padStart(2,'0')}:${String(end.getUTCMinutes()).padStart(2,'0')}`,
          hours: parseFloat(parseFloat(s.hours_worked).toFixed(2)),
          earned: parseFloat(parseFloat(s.earned).toFixed(2)),
          confirmed: s.confirmed_at ? 'Да' : 'Нет',
        });
        row.height = 20;
        row.eachCell((cell, col) => {
          cell.alignment = { vertical: 'middle', horizontal: col <= 2 ? 'left' : 'center' };
          cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E5EA' } } };
        });
      }
    }

    // ── Лист 3: Корректировки ────────────────────────────────────────────────
    const adjSheet = workbook.addWorksheet('Корректировки');
    adjSheet.columns = [
      { header: 'Сотрудник', key: 'name', width: 22 },
      { header: 'Сумма ₽', key: 'amount', width: 12 },
      { header: 'Тип', key: 'type', width: 12 },
      { header: 'Комментарий', key: 'comment', width: 30 },
      { header: 'Дата', key: 'date', width: 14 },
    ];
    const adjHeader = adjSheet.getRow(1);
    adjHeader.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C1C1E' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    adjHeader.height = 28;

    for (const emp of employees) {
      const { rows: adjs } = await pool.query(
        'SELECT * FROM adjustments WHERE employee_id = $1 AND month = $2 ORDER BY created_at',
        [emp.id, month]
      );
      for (const a of adjs) {
        const row = adjSheet.addRow({
          name: `${emp.first_name} ${emp.last_name}`,
          amount: Math.abs(parseFloat(a.amount)),
          type: a.amount > 0 ? 'Бонус' : 'Штраф',
          comment: a.comment || '—',
          date: new Date(a.created_at).toLocaleDateString('ru-RU'),
        });
        row.height = 20;
        row.getCell('type').font = { color: { argb: a.amount > 0 ? 'FF34C759' : 'FFFF3B30' }, bold: true };
        row.eachCell((cell, col) => {
          cell.alignment = { vertical: 'middle', horizontal: col <= 1 ? 'left' : 'center' };
          cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E5EA' } } };
        });
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_${month}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`API сервер запущен на порту ${PORT}`));

module.exports = app;
