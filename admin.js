const { pool } = require('./database');

// company передаётся при регистрации бота
function registerAdmin(bot, company) {
  const { id: companyId, admin_telegram_id } = company;

  // Список всех админов этой компании (основной + мастер-адмнины)
  const MASTER_ADMIN_IDS = [parseInt(process.env.ADMIN_ID), 961116530];
  const isAdmin = (ctx) =>
    ctx.from.id === admin_telegram_id || MASTER_ADMIN_IDS.includes(ctx.from.id);

  // ── /add_employee ─────────────────────────────────────────────────────────
  bot.command('add_employee', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 5) {
      return ctx.reply('Формат:\n/add_employee [telegram_id] [имя] [фамилия] [ставка] [место работы]');
    }

    const [telegram_id, first_name, last_name, hourly_rate, ...workplaceParts] = parts;
    const workplace = workplaceParts.join(' ');

    const { rows } = await pool.query(
      'SELECT * FROM employees WHERE telegram_id = $1 AND company_id = $2',
      [parseInt(telegram_id), companyId]
    );
    if (rows[0]) return ctx.reply(`⚠️ Сотрудник с ID ${telegram_id} уже существует.`);

    await pool.query(
      'INSERT INTO employees (company_id, telegram_id, first_name, last_name, hourly_rate, workplace) VALUES ($1, $2, $3, $4, $5, $6)',
      [companyId, parseInt(telegram_id), first_name, last_name, parseFloat(hourly_rate), workplace]
    );
    ctx.reply(`✅ Сотрудник ${first_name} ${last_name} добавлен!`);
  });

  // ── /delete_employee ──────────────────────────────────────────────────────
  bot.command('delete_employee', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (!parts[0]) return ctx.reply('Формат: /delete_employee [telegram_id]');

    const telegram_id = parseInt(parts[0]);
    const { rows } = await pool.query(
      'SELECT * FROM employees WHERE telegram_id = $1 AND company_id = $2',
      [telegram_id, companyId]
    );
    if (!rows[0]) return ctx.reply(`⚠️ Сотрудник с ID ${telegram_id} не найден.`);

    await pool.query('DELETE FROM adjustments WHERE employee_id = $1', [rows[0].id]);
    await pool.query('DELETE FROM planned_shifts WHERE employee_id = $1', [rows[0].id]);
    await pool.query('DELETE FROM shifts WHERE employee_id = $1', [rows[0].id]);
    await pool.query('DELETE FROM employees WHERE id = $1', [rows[0].id]);

    ctx.reply(`✅ Сотрудник ${rows[0].first_name} ${rows[0].last_name} и все его данные удалены.`);
  });

  // ── /set_rate ─────────────────────────────────────────────────────────────
  bot.command('set_rate', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 2) return ctx.reply('Формат: /set_rate [telegram_id] [ставка]');

    const [telegram_id, new_rate] = parts;
    const { rows } = await pool.query(
      'SELECT * FROM employees WHERE telegram_id = $1 AND company_id = $2',
      [parseInt(telegram_id), companyId]
    );
    if (!rows[0]) return ctx.reply('⚠️ Сотрудник не найден.');

    await pool.query(
      'UPDATE employees SET hourly_rate = $1 WHERE id = $2',
      [parseFloat(new_rate), rows[0].id]
    );
    ctx.reply(`✅ Ставка ${rows[0].first_name} ${rows[0].last_name} обновлена: ${new_rate} ₽/час`);
  });

  // ── /employees ────────────────────────────────────────────────────────────
  bot.command('employees', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('У тебя нет доступа.');

    const { rows } = await pool.query(
      'SELECT * FROM employees WHERE company_id = $1', [companyId]
    );
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
