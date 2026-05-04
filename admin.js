const { Markup } = require('telegraf');
const db = require('./database');

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

function isAdmin(ctx) {
  return ctx.from.id === ADMIN_ID;
}

function adminMenu() {
  return Markup.keyboard([
    ['👥 Сотрудники', '📊 Статистика'],
    ['➕ Добавить сотрудника', '🗑 Удалить сотрудника'],
    ['🔔 Уведомления', '⚙️ Настройки'],
    ['🚪 Выйти из админки']
  ]).resize();
}

function registerAdmin(bot, mainMenu) {

  bot.hears('👑 Админ панель', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа к этой команде.');
    ctx.reply('Добро пожаловать в админ панель!', adminMenu());
  });

  bot.hears('🚪 Выйти из админки', (ctx) => {
    if (!isAdmin(ctx)) return;
    ctx.reply('Вышел из админ панели.', mainMenu(true));
  });

  bot.hears('👥 Сотрудники', (ctx) => {
    if (!isAdmin(ctx)) return;

    const employees = db.prepare('SELECT * FROM employees').all();

    if (employees.length === 0) {
      return ctx.reply('Сотрудников пока нет.', adminMenu());
    }

    let text = '👥 Список сотрудников:\n\n';
    employees.forEach((emp, i) => {
      const onShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(emp.id);
      text += `${i + 1}. ${emp.first_name} ${emp.last_name} ${onShift ? '🟢' : '⚪'}\n`;
      text += `   Место: ${emp.workplace}\n`;
      text += `   Ставка: ${emp.hourly_rate} ₽/час\n`;
      text += `   TG ID: ${emp.telegram_id}\n\n`;
    });

    ctx.reply(text, adminMenu());
  });

  bot.hears('📊 Статистика', (ctx) => {
    if (!isAdmin(ctx)) return;

    const now = new Date();
    now.setHours(now.getUTCHours() + 7);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const employees = db.prepare('SELECT * FROM employees').all();

    if (employees.length === 0) {
      return ctx.reply('Сотрудников пока нет.', adminMenu());
    }

    let text = '📊 Статистика за месяц:\n\n';

    employees.forEach((emp) => {
      const stats = db.prepare(`
        SELECT COUNT(*) as shifts_count, SUM(hours_worked) as total_hours, SUM(earned) as total_earned
        FROM shifts
        WHERE employee_id = ? AND start_time >= ? AND end_time IS NOT NULL
      `).get(emp.id, startOfMonth);

      const onShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(emp.id);

      text += `👤 ${emp.first_name} ${emp.last_name} ${onShift ? '🟢 на смене' : '⚪ не работает'}\n`;
      text += `   Смен: ${stats.shifts_count || 0}\n`;
      text += `   Часов: ${stats.total_hours ? parseFloat(stats.total_hours).toFixed(1) : '0.0'}\n`;
      text += `   Заработано: ${stats.total_earned ? parseFloat(stats.total_earned).toFixed(2) : '0.00'} ₽\n\n`;
    });

    ctx.reply(text, adminMenu());
  });

  bot.hears('➕ Добавить сотрудника', (ctx) => {
    if (!isAdmin(ctx)) return;
    ctx.reply(
      '➕ Добавление сотрудника\n\n' +
      'Отправь команду в формате:\n' +
      '/add_employee [telegram_id] [имя] [фамилия] [ставка] [место работы]\n\n' +
      'Пример:\n/add_employee 123456789 Иван Иванов 500 Кафе Центр',
      adminMenu()
    );
  });

  bot.hears('🗑 Удалить сотрудника', (ctx) => {
    if (!isAdmin(ctx)) return;
    ctx.reply(
      '🗑 Удаление сотрудника\n\n' +
      'Отправь команду в формате:\n' +
      '/delete_employee [telegram_id]\n\n' +
      'Пример:\n/delete_employee 123456789',
      adminMenu()
    );
  });

  bot.hears('⚙️ Настройки', (ctx) => {
    if (!isAdmin(ctx)) return;
    ctx.reply(
      '⚙️ Настройки\n\n' +
      'Доступные команды:\n\n' +
      '/set_rate [telegram_id] [ставка] — изменить ставку сотрудника\n\n' +
      'Пример:\n/set_rate 123456789 600',
      adminMenu()
    );
  });

  bot.hears('🔔 Уведомления', (ctx) => {
    if (!isAdmin(ctx)) return;

    const employees = db.prepare('SELECT * FROM employees').all();
    const notOnShift = employees.filter(emp => {
      const onShift = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL').get(emp.id);
      return !onShift;
    });

    if (notOnShift.length === 0) {
      return ctx.reply('✅ Все сотрудники сейчас на смене.', adminMenu());
    }

    let text = '🔔 Сотрудники не на смене:\n\n';
    notOnShift.forEach((emp) => {
      text += `• ${emp.first_name} ${emp.last_name}\n`;
    });

    ctx.reply(text, adminMenu());
  });

  bot.command('add_employee', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 5) {
      return ctx.reply('Недостаточно данных. Формат:\n/add_employee [telegram_id] [имя] [фамилия] [ставка] [место работы]');
    }

    const [telegram_id, first_name, last_name, hourly_rate, ...workplaceParts] = parts;
    const workplace = workplaceParts.join(' ');

    const existing = db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(parseInt(telegram_id));
    if (existing) {
      return ctx.reply(`⚠️ Сотрудник с ID ${telegram_id} уже существует.`);
    }

    db.prepare(`
      INSERT INTO employees (telegram_id, first_name, last_name, hourly_rate, workplace)
      VALUES (?, ?, ?, ?, ?)
    `).run(parseInt(telegram_id), first_name, last_name, parseFloat(hourly_rate), workplace);

    ctx.reply(`✅ Сотрудник ${first_name} ${last_name} добавлен!`, adminMenu());
  });

  bot.command('delete_employee', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 1) {
      return ctx.reply('Формат: /delete_employee [telegram_id]');
    }

    const telegram_id = parseInt(parts[0]);
    const employee = db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(telegram_id);

    if (!employee) {
      return ctx.reply(`⚠️ Сотрудник с ID ${telegram_id} не найден.`);
    }

    db.prepare('DELETE FROM employees WHERE telegram_id = ?').run(telegram_id);
    ctx.reply(`✅ Сотрудник удалён.`, adminMenu());
  });

  bot.command('set_rate', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 2) {
      return ctx.reply('Формат: /set_rate [telegram_id] [новая_ставка]');
    }

    const [telegram_id, new_rate] = parts;
    const employee = db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(parseInt(telegram_id));

    if (!employee) {
      return ctx.reply(`⚠️ Сотрудник с ID ${telegram_id} не найден.`);
    }

    db.prepare('UPDATE employees SET hourly_rate = ? WHERE telegram_id = ?').run(parseFloat(new_rate), parseInt(telegram_id));
    ctx.reply(`✅ Ставка ${employee.first_name} ${employee.last_name} обновлена: ${new_rate} ₽/час`, adminMenu());
  });

  bot.action(/approve_(\d+)/, (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegram_id = parseInt(ctx.match[1]);

    const pending = db.prepare('SELECT * FROM pending_employees WHERE telegram_id = ?').get(telegram_id);
    if (!pending) return ctx.reply('Заявка не найдена.');

    db.prepare(`
      INSERT INTO employees (telegram_id, first_name, last_name, hourly_rate, workplace)
      VALUES (?, ?, ?, ?, ?)
    `).run(pending.telegram_id, pending.first_name, pending.last_name, 0, 'Не указано');

    db.prepare('DELETE FROM pending_employees WHERE telegram_id = ?').run(telegram_id);

    ctx.telegram.sendMessage(telegram_id, '✅ Твоя заявка одобрена! Напиши /start чтобы начать работу.');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    ctx.reply(`✅ Сотрудник ${pending.first_name} ${pending.last_name} добавлен!`, adminMenu());
  });

  bot.action(/reject_(\d+)/, (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegram_id = parseInt(ctx.match[1]);

    db.prepare('DELETE FROM pending_employees WHERE telegram_id = ?').run(telegram_id);

    ctx.telegram.sendMessage(telegram_id, '❌ Твоя заявка отклонена. Обратись к администратору.');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    ctx.reply('Заявка отклонена.', adminMenu());
  });

}

module.exports = { registerAdmin, isAdmin, adminMenu };