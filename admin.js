const { pool } = require('./database');

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

function isAdmin(ctx) {
  return ctx.from.id === ADMIN_ID;
}

function registerAdmin(bot) {

  bot.command('add_employee', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 5) {
      return ctx.reply('Формат:\n/add_employee [telegram_id] [имя] [фамилия] [ставка] [место работы]');
    }

    const [telegram_id, first_name, last_name, hourly_rate, ...workplaceParts] = parts;
    const workplace = workplaceParts.join(' ');

    const { rows } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(telegram_id)]);
    if (rows[0]) return ctx.reply(`⚠️ Сотрудник с ID ${telegram_id} уже существует.`);

    await pool.query(
      'INSERT INTO employees (telegram_id, first_name, last_name, hourly_rate, workplace) VALUES ($1, $2, $3, $4, $5)',
      [parseInt(telegram_id), first_name, last_name, parseFloat(hourly_rate), workplace]
    );

    ctx.reply(`✅ Сотрудник ${first_name} ${last_name} добавлен!`);
  });

  bot.command('delete_employee', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (!parts[0]) return ctx.reply('Формат: /delete_employee [telegram_id]');

    const telegram_id = parseInt(parts[0]);
    const { rows } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [telegram_id]);
    if (!rows[0]) return ctx.reply(`⚠️ Сотрудник с ID ${telegram_id} не найден.`);

    await pool.query('DELETE FROM employees WHERE telegram_id = $1', [telegram_id]);
    ctx.reply(`✅ Сотрудник ${rows[0].first_name} ${rows[0].last_name} удалён.`);
  });

  bot.command('set_rate', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 2) return ctx.reply('Формат: /set_rate [telegram_id] [ставка]');

    const [telegram_id, new_rate] = parts;
    const { rows } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [parseInt(telegram_id)]);
    if (!rows[0]) return ctx.reply(`⚠️ Сотрудник не найден.`);

    await pool.query('UPDATE employees SET hourly_rate = $1 WHERE telegram_id = $2', [parseFloat(new_rate), parseInt(telegram_id)]);
    ctx.reply(`✅ Ставка ${rows[0].first_name} ${rows[0].last_name} обновлена: ${new_rate} ₽/час`);
  });

  bot.command('employees', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const { rows } = await pool.query('SELECT * FROM employees');
    if (rows.length === 0) return ctx.reply('Сотрудников пока нет.');

    let text = '👥 Сотрудники:\n\n';
    rows.forEach((emp, i) => {
      text += `${i + 1}. ${emp.first_name} ${emp.last_name}\n`;
      text += `   Ставка: ${emp.hourly_rate} ₽/час\n`;
      text += `   ID: ${emp.telegram_id}\n\n`;
    });

    ctx.reply(text);
  });
}

module.exports = { registerAdmin };