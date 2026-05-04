const cron = require('node-cron');
const db = require('./database');

const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const NOTIFY_DELAY_MINUTES = 30;

function registerNotifications(bot) {

  // Каждый день в 09:30 по НСК (02:30 UTC) проверяем кто не открыл смену
  cron.schedule('30 2 * * *', async () => {
    const employees = db.prepare('SELECT * FROM employees').all();

    const notOnShift = employees.filter(emp => {
      const onShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(emp.id);
      return !onShift;
    });

    if (notOnShift.length === 0) return;

    let text = `🔔 Напоминание (09:30 НСК)\n\nСледующие сотрудники не открыли смену:\n\n`;
    notOnShift.forEach(emp => {
      text += `• ${emp.first_name} ${emp.last_name}\n`;
    });

    try {
      await bot.telegram.sendMessage(ADMIN_ID, text);
    } catch (e) {
      console.error('Ошибка отправки уведомления:', e.message);
    }
  });

  // Каждый день в 21:00 по НСК (14:00 UTC) — итог дня
  cron.schedule('0 14 * * *', async () => {
    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const employees = db.prepare('SELECT * FROM employees').all();

    let text = `📊 Итог дня (${now.getDate()}.${String(now.getMonth() + 1).padStart(2, '0')}):\n\n`;
    let hasData = false;

    employees.forEach(emp => {
      const shifts = db.prepare(`
        SELECT * FROM shifts
        WHERE employee_id = ? AND start_time >= ? AND end_time IS NOT NULL
      `).all(emp.id, startOfDay);

      if (shifts.length > 0) {
        hasData = true;
        const totalHours = shifts.reduce((sum, s) => sum + parseFloat(s.hours_worked), 0);
        const totalEarned = shifts.reduce((sum, s) => sum + parseFloat(s.earned), 0);
        text += `👤 ${emp.first_name} ${emp.last_name}\n`;
        text += `   Часов: ${totalHours.toFixed(1)} | Заработано: ${totalEarned.toFixed(2)} ₽\n\n`;
      }
    });

    if (!hasData) {
      text += 'Никто не работал сегодня.';
    }

    try {
      await bot.telegram.sendMessage(ADMIN_ID, text);
    } catch (e) {
      console.error('Ошибка отправки итога дня:', e.message);
    }
  });

  console.log('Планировщик уведомлений запущен.');
  bot.command('test_notify', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const employees = db.prepare('SELECT * FROM employees').all();
    const notOnShift = employees.filter(emp => {
      const onShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(emp.id);
      return !onShift;
    });

    if (notOnShift.length === 0) {
      return ctx.reply('✅ Все сотрудники сейчас на смене.');
    }

    let text = `🔔 Напоминание (тест)\n\nСледующие сотрудники не открыли смену:\n\n`;
    notOnShift.forEach(emp => {
      text += `• ${emp.first_name} ${emp.last_name}\n`;
    });

    ctx.reply(text);
  });
}

module.exports = { registerNotifications };