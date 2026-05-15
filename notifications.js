const cron = require('node-cron');
const { pool } = require('./database');

// UTC+7 (НСК)
function nsk() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

// Вызывается один раз для каждой компании при старте
function registerNotifications(bot, company) {
  const adminId = company.admin_telegram_id;
  const companyId = company.id;

  // ── Каждые 15 минут: авто-открытие смен + алёрт опозданий ────────────────
  cron.schedule('*/15 * * * *', async () => {
    try {
      await autoOpenPlannedShifts(bot, companyId);
      await checkLateEmployees(bot, adminId, companyId);
    } catch (e) {
      console.error(`[company ${companyId}] Ошибка планировщика:`, e.message);
    }
  });

  // ── 21:00 НСК: авто-закрытие + итог дня + напоминания ────────────────────
  cron.schedule('0 14 * * *', async () => {
    try {
      await autoCloseShifts(companyId);

      const now = nsk();
      const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

      const { rows: employees } = await pool.query(
        'SELECT * FROM employees WHERE company_id = $1', [companyId]
      );

      let text = `📊 Итог дня (${now.getUTCDate()}.${String(now.getUTCMonth() + 1).padStart(2, '0')}):\n\n`;
      let hasData = false;

      for (const emp of employees) {
        const { rows: shifts } = await pool.query(
          'SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2 AND end_time IS NOT NULL',
          [emp.id, startOfDay]
        );
        if (shifts.length > 0) {
          hasData = true;
          const totalHours = shifts.reduce((sum, s) => sum + parseFloat(s.hours_worked), 0);
          const totalEarned = shifts.reduce((sum, s) => sum + parseFloat(s.earned), 0);
          text += `👤 ${emp.first_name} ${emp.last_name}\n`;
          text += `   Часов: ${totalHours.toFixed(1)} | Заработано: ${totalEarned.toFixed(2)} ₽\n\n`;
        }
      }

      if (!hasData) text += 'Никто не работал сегодня.';
      await bot.telegram.sendMessage(adminId, text);

      await sendTomorrowReminders(bot, companyId);
    } catch (e) {
      console.error(`[company ${companyId}] Ошибка итога дня:`, e.message);
    }
  });

  // ── /test_notify: тестовая команда ───────────────────────────────────────
  bot.command('test_notify', async (ctx) => {
    if (ctx.from.id !== adminId) return;
    const now = nsk();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const { rows: unconfirmed } = await pool.query(`
      SELECT s.*, e.first_name, e.last_name
      FROM shifts s
      JOIN employees e ON s.employee_id = e.id
      WHERE s.end_time IS NULL AND s.confirmed_at IS NULL
        AND s.start_time >= $1 AND e.company_id = $2
    `, [startOfDay, companyId]);

    if (unconfirmed.length === 0) return ctx.reply('✅ Все активные смены подтверждены.');
    let text = `🔔 Не подтверждены смены (тест):\n\n`;
    unconfirmed.forEach(s => {
      const minutesLate = Math.floor((now - new Date(s.start_time)) / (1000 * 60));
      text += `• ${s.first_name} ${s.last_name} — ${minutesLate} мин.\n`;
    });
    ctx.reply(text);
  });

  console.log(`✅ Уведомления зарегистрированы для компании #${companyId}`);
}

// ── Авто-открытие плановых смен ───────────────────────────────────────────
async function autoOpenPlannedShifts(bot, companyId) {
  const now = nsk();
  const todayStr = now.toISOString().slice(0, 10);
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  const { rows: shifts } = await pool.query(`
    SELECT ps.*, e.telegram_id, e.first_name, e.last_name, e.id as emp_id
    FROM planned_shifts ps
    JOIN employees e ON ps.employee_id = e.id
    WHERE ps.planned_date = $1 AND e.company_id = $2
  `, [todayStr, companyId]);

  for (const shift of shifts) {
    const [sh, sm] = shift.shift_start.split(':').map(Number);
    const shiftMinutes = sh * 60 + sm;
    const diff = currentMinutes - shiftMinutes;
    if (diff < -7 || diff > 7) continue;

    const { rows: existing } = await pool.query(
      'SELECT id FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [shift.emp_id]
    );
    if (existing.length > 0) continue;

    const startTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), sh, sm, 0));
    await pool.query('INSERT INTO shifts (employee_id, start_time) VALUES ($1, $2)', [shift.emp_id, startTime]);

    try {
      await bot.telegram.sendMessage(shift.telegram_id,
        `🟢 Твоя смена началась!\n\n🕐 ${shift.shift_start} — ${shift.shift_end}${shift.note ? `\n📍 ${shift.note}` : ''}\n\nПодтверди присутствие в приложении.`
      );
    } catch (e) {
      console.error(`[company ${companyId}] Уведомление старта смены ${shift.telegram_id}:`, e.message);
    }
  }
}

// ── Авто-закрытие смен в 21:00 НСК ───────────────────────────────────────
async function autoCloseShifts(companyId) {
  const now = nsk();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 0, 0));

  const { rows: openShifts } = await pool.query(`
    SELECT s.*, e.hourly_rate
    FROM shifts s
    JOIN employees e ON s.employee_id = e.id
    WHERE s.end_time IS NULL AND e.company_id = $1
  `, [companyId]);

  for (const shift of openShifts) {
    const endTime = cutoff < now ? cutoff : now;
    const hoursWorked = Math.max(0, (endTime - new Date(shift.start_time)) / (1000 * 60 * 60));
    const earned = parseFloat((hoursWorked * shift.hourly_rate).toFixed(2));
    await pool.query(
      'UPDATE shifts SET end_time = $1, hours_worked = $2, earned = $3 WHERE id = $4',
      [endTime, hoursWorked.toFixed(2), earned, shift.id]
    );
  }
}

// ── Напоминания за день до смены ─────────────────────────────────────────
async function sendTomorrowReminders(bot, companyId) {
  const tomorrow = new Date(Date.now() + 7 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const { rows: shifts } = await pool.query(`
    SELECT ps.*, e.telegram_id, e.first_name
    FROM planned_shifts ps
    JOIN employees e ON ps.employee_id = e.id
    WHERE ps.planned_date = $1 AND e.company_id = $2
  `, [tomorrowStr, companyId]);

  for (const shift of shifts) {
    const d = `${tomorrow.getUTCDate()}.${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}`;
    try {
      await bot.telegram.sendMessage(shift.telegram_id,
        `📅 Напоминание о смене\n\nЗавтра (${d}) у тебя смена:\n🕐 ${shift.shift_start} — ${shift.shift_end}${shift.note ? `\n📍 ${shift.note}` : ''}\n\nСмена откроется автоматически.`
      );
    } catch (e) {
      console.error(`[company ${companyId}] Напоминание ${shift.telegram_id}:`, e.message);
    }
  }
}

// ── Алёрт о неподтверждённых сменах ─────────────────────────────────────
async function checkLateEmployees(bot, adminId, companyId) {
  const now = nsk();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const { rows: unconfirmed } = await pool.query(`
    SELECT s.*, e.first_name, e.last_name
    FROM shifts s
    JOIN employees e ON s.employee_id = e.id
    WHERE s.end_time IS NULL AND s.confirmed_at IS NULL
      AND s.start_time >= $1
      AND s.start_time <= $2
      AND e.company_id = $3
  `, [startOfDay, new Date(now.getTime() - 15 * 60 * 1000), companyId]);

  for (const shift of unconfirmed) {
    const minutesLate = Math.floor((now - new Date(shift.start_time)) / (1000 * 60));
    const hh = String(new Date(shift.start_time).getUTCHours()).padStart(2, '0');
    const mm = String(new Date(shift.start_time).getUTCMinutes()).padStart(2, '0');
    try {
      await bot.telegram.sendMessage(adminId,
        `⚠️ Смена не подтверждена!\n\n👤 ${shift.first_name} ${shift.last_name}\n🕐 Начало: ${hh}:${mm}\n⏱ Без подтверждения: ${minutesLate} мин.`
      );
    } catch (e) {
      console.error(`[company ${companyId}] Алёрт опоздания:`, e.message);
    }
  }
}

module.exports = { registerNotifications };
