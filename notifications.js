const cron = require('node-cron');
const { pool } = require('./database');

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

function registerNotifications(bot) {

  // Каждый день в 09:30 по НСК (02:30 UTC)
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

  // Каждый день в 21:00 по НСК (14:00 UTC) — итог дня
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
    } catch (e) {
      console.error('Ошибка итога дня:', e.message);
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

module.exports = { registerNotifications };