const cron = require('node-cron');
const { pool } = require('./database');

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

function registerNotifications(bot) {

  // Каждые 15 минут — авто-открытие смен и алёрты опозданий
  cron.schedule('*/15 * * * *', async () => {
    try {
      await autoOpenPlannedShifts(bot);
      await checkLateEmployees(bot);
    } catch (e) {
      console.error('Ошибка планировщика:', e.message);
    }
  });

  // 21:00 НСК (14:00 UTC) — авто-закрытие смен и итог дня
  cron.schedule('0 14 * * *', async () => {
    try {
      await autoCloseShifts();
      const now = new Date();
      now.setHours(now.getUTCHours() + 7);
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const { rows: employees } = await pool.query('SELECT * FROM employees');

      let text = `📊 Итог дня (${now.getDate()}.${String(now.getMonth() + 1).padStart(2, '0')}):\n\n`;
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
      await bot.telegram.sendMessage(ADMIN_ID, text);

      await sendTomorrowReminders(bot);
    } catch (e) {
      console.error('Ошибка итога дня:', e.message);
    }
  });

  // Тест уведомлений
  bot.command('test_notify', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const { rows: unconfirmed } = await pool.query(`
      SELECT s.*, e.first_name, e.last_name
      FROM shifts s JOIN employees e ON s.employee_id = e.id
      WHERE s.end_time IS NULL AND s.confirmed_at IS NULL AND s.start_time >= $1
    `, [startOfDay]);
    if (unconfirmed.length === 0) return ctx.reply('✅ Все активные смены подтверждены.');
    let text = `🔔 Не подтверждены смены (тест):\n\n`;
    unconfirmed.forEach(s => {
      const minutesLate = Math.floor((now - new Date(s.start_time)) / (1000 * 60));
      text += `• ${s.first_name} ${s.last_name} — опаздывает ${minutesLate} мин.\n`;
    });
    ctx.reply(text);
  });

  console.log('Планировщик уведомлений запущен.');
}

// Авто-открытие плановых смен (вызывается каждые 15 минут)
async function autoOpenPlannedShifts(bot) {
  try {
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const todayStr = now.toISOString().slice(0, 10);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const { rows: shifts } = await pool.query(`
      SELECT ps.*, e.telegram_id, e.first_name, e.last_name, e.id as emp_id
      FROM planned_shifts ps
      JOIN employees e ON ps.employee_id = e.id
      WHERE ps.planned_date = $1
    `, [todayStr]);

    for (const shift of shifts) {
      const [sh, sm] = shift.shift_start.split(':').map(Number);
      const shiftMinutes = sh * 60 + sm;
      const diff = currentMinutes - shiftMinutes;

      // Открываем в окне ±7 минут от начала смены
      if (diff < -7 || diff > 7) continue;

      // Проверяем, не открыта ли уже смена
      const { rows: existing } = await pool.query(
        'SELECT id FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [shift.emp_id]
      );
      if (existing.length > 0) continue;

      // Создаём смену с плановым временем начала
      const startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0);
      await pool.query(
        'INSERT INTO shifts (employee_id, start_time) VALUES ($1, $2)',
        [shift.emp_id, startTime]
      );

      try {
        await bot.telegram.sendMessage(shift.telegram_id,
          `🟢 Твоя смена началась!\n\n🕐 ${shift.shift_start} — ${shift.shift_end}${shift.note ? `\n📍 ${shift.note}` : ''}\n\nПодтверди присутствие в приложении.`
        );
      } catch (e) {
        console.error(`Ошибка уведомления о старте смены ${shift.telegram_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Ошибка autoOpenPlannedShifts:', e.message);
  }
}

// Авто-закрытие незакрытых смен в 21:00 НСК
async function autoCloseShifts() {
  try {
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 21, 0, 0);

    const { rows: openShifts } = await pool.query(`
      SELECT s.*, e.hourly_rate
      FROM shifts s JOIN employees e ON s.employee_id = e.id
      WHERE s.end_time IS NULL
    `);

    for (const shift of openShifts) {
      const startTime = new Date(shift.start_time);
      const endTime = cutoff < now ? cutoff : now;
      const hoursWorked = Math.max(0, (endTime - startTime) / (1000 * 60 * 60));
      const earned = parseFloat((hoursWorked * shift.hourly_rate).toFixed(2));

      await pool.query(
        'UPDATE shifts SET end_time = $1, hours_worked = $2, earned = $3 WHERE id = $4',
        [endTime, hoursWorked.toFixed(2), earned, shift.id]
      );
    }
  } catch (e) {
    console.error('Ошибка autoCloseShifts:', e.message);
  }
}

// Напоминание за день до смены (вызывается в 21:00 НСК)
async function sendTomorrowReminders(bot) {
  try {
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const { rows: shifts } = await pool.query(`
      SELECT ps.*, e.telegram_id, e.first_name, e.last_name
      FROM planned_shifts ps
      JOIN employees e ON ps.employee_id = e.id
      WHERE ps.planned_date = $1
    `, [tomorrowStr]);

    for (const shift of shifts) {
      const dateFormatted = `${tomorrow.getDate()}.${String(tomorrow.getMonth() + 1).padStart(2, '0')}`;
      const text = `📅 Напоминание о смене\n\nЗавтра (${dateFormatted}) у тебя смена:\n🕐 ${shift.shift_start} — ${shift.shift_end}${shift.note ? `\n📍 ${shift.note}` : ''}\n\nНе забудь открыть смену вовремя!`;
      try {
        await bot.telegram.sendMessage(shift.telegram_id, text);
      } catch (e) {
        console.error(`Ошибка отправки напоминания ${shift.telegram_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Ошибка sendTomorrowReminders:', e.message);
  }
}

// Алёрты админу о неподтверждённых сменах (15+ минут без подтверждения)
async function checkLateEmployees(bot) {
  try {
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const { rows: unconfirmed } = await pool.query(`
      SELECT s.*, e.first_name, e.last_name
      FROM shifts s JOIN employees e ON s.employee_id = e.id
      WHERE s.end_time IS NULL
        AND s.confirmed_at IS NULL
        AND s.start_time >= $1
        AND s.start_time <= $2
    `, [startOfDay, new Date(now.getTime() - 15 * 60 * 1000)]);

    for (const shift of unconfirmed) {
      const minutesLate = Math.floor((now - new Date(shift.start_time)) / (1000 * 60));
      const text = `⚠️ Смена не подтверждена!\n\n👤 ${shift.first_name} ${shift.last_name}\n🕐 Начало: ${new Date(shift.start_time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}\n⏱ Без подтверждения: ${minutesLate} мин.`;
      try {
        await bot.telegram.sendMessage(ADMIN_ID, text);
      } catch (e) {
        console.error('Ошибка алёрта опоздания:', e.message);
      }
    }
  } catch (e) {
    console.error('Ошибка checkLateEmployees:', e.message);
  }
}

module.exports = { registerNotifications, sendTomorrowReminders, checkLateEmployees, autoOpenPlannedShifts, autoCloseShifts };