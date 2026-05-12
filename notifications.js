const cron = require('node-cron');
const { pool } = require('./database');

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

function registerNotifications(bot) {

  // 09:30 НСК (02:30 UTC) — кто не открыл смену
  cron.schedule('30 2 * * *', async () => {
    try {
      const { rows: employees } = await pool.query('SELECT * FROM employees');
      const notOnShift = [];
      for (const emp of employees) {
        const { rows: openShift } = await pool.query(
          'SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp.id]
        );
        if (openShift.length === 0) notOnShift.push(emp);
      }
      if (notOnShift.length === 0) return;
      let text = `🔔 Напоминание (09:30 НСК)\n\nСледующие сотрудники не открыли смену:\n\n`;
      notOnShift.forEach(emp => { text += `• ${emp.first_name} ${emp.last_name}\n`; });
      await bot.telegram.sendMessage(ADMIN_ID, text);
    } catch (e) {
      console.error('Ошибка уведомления:', e.message);
    }
  });

  // 21:00 НСК (14:00 UTC) — итог дня
  cron.schedule('0 14 * * *', async () => {
    try {
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

      // Напоминание о завтрашних сменах сотрудникам
      await sendTomorrowReminders(bot);
    } catch (e) {
      console.error('Ошибка итога дня:', e.message);
    }
  });

  // Каждые 15 минут — напоминания и алёрты
  cron.schedule('*/15 2-14 * * *', async () => {
    try {
      await sendShiftSoonReminders(bot);
      await checkLateEmployees(bot);
    } catch (e) {
      console.error('Ошибка напоминания за 15 минут:', e.message);
    }
  });

  // Тест уведомлений
  bot.command('test_notify', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const { rows: employees } = await pool.query('SELECT * FROM employees');
    const notOnShift = [];
    for (const emp of employees) {
      const { rows: openShift } = await pool.query(
        'SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [emp.id]
      );
      if (openShift.length === 0) notOnShift.push(emp);
    }
    if (notOnShift.length === 0) return ctx.reply('✅ Все сотрудники сейчас на смене.');
    let text = `🔔 Напоминание (тест)\n\nСледующие сотрудники не открыли смену:\n\n`;
    notOnShift.forEach(emp => { text += `• ${emp.first_name} ${emp.last_name}\n`; });
    ctx.reply(text);
  });

  console.log('Планировщик уведомлений запущен.');
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

// Напоминание за 15 минут до смены
async function sendShiftSoonReminders(bot) {
  try {
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);

    const todayStr = now.toISOString().slice(0, 10);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const { rows: shifts } = await pool.query(`
      SELECT ps.*, e.telegram_id, e.first_name, e.last_name
      FROM planned_shifts ps
      JOIN employees e ON ps.employee_id = e.id
      WHERE ps.planned_date = $1
    `, [todayStr]);

    for (const shift of shifts) {
      const [sh, sm] = shift.shift_start.split(':').map(Number);
      const shiftMinutes = sh * 60 + sm;
      const diff = shiftMinutes - currentMinutes;

      // Отправляем если до смены от 14 до 16 минут
      if (diff >= 14 && diff <= 16) {
        const text = `⏰ Смена начинается через 15 минут!\n\n🕐 ${shift.shift_start} — ${shift.shift_end}${shift.note ? `\n📍 ${shift.note}` : ''}\n\nОткрой приложение и отметь начало смены.`;
        try {
          await bot.telegram.sendMessage(shift.telegram_id, text);
        } catch (e) {
          console.error(`Ошибка отправки за 15 минут ${shift.telegram_id}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('Ошибка sendShiftSoonReminders:', e.message);
  }
}

// Алёрты админу об опозданиях
async function checkLateEmployees(bot) {
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

      // Опоздал — прошло от 15 до 17 минут после начала смены
      if (diff >= 15 && diff <= 17) {
        // Проверяем открыл ли смену
        const { rows: openShift } = await pool.query(
          'SELECT * FROM shifts WHERE employee_id = $1 AND end_time IS NULL', [shift.emp_id]
        );
        const { rows: todayShift } = await pool.query(
          'SELECT * FROM shifts WHERE employee_id = $1 AND start_time >= $2',
          [shift.emp_id, new Date(now.getFullYear(), now.getMonth(), now.getDate())]
        );

        if (openShift.length === 0 && todayShift.length === 0) {
          const text = `⚠️ Опоздание!\n\n👤 ${shift.first_name} ${shift.last_name}\n🕐 Плановое начало: ${shift.shift_start}\n⏱ Опаздывает на 15+ минут\n\nСмена не открыта.`;
          try {
            await bot.telegram.sendMessage(ADMIN_ID, text);
          } catch (e) {
            console.error('Ошибка алёрта опоздания:', e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('Ошибка checkLateEmployees:', e.message);
  }
}

module.exports = { registerNotifications, sendTomorrowReminders, checkLateEmployees };