const { Telegraf, Markup } = require('telegraf');
const { pool, getAllCompanies } = require('./database');

const MASTER_ADMIN_IDS = [
  parseInt(process.env.ADMIN_ID),
  961116530,
];

function isMasterAdmin(ctx) {
  return MASTER_ADMIN_IDS.includes(ctx.from.id);
}

// Called from index.js after a company bot is live
// so we can register its webhook on the fly
let registerCompanyBotFn = null;
function setRegisterFn(fn) { registerCompanyBotFn = fn; }

function registerMasterBot(app) {
  const token = process.env.MASTER_BOT_TOKEN;
  if (!token) {
    console.log('⚠️  MASTER_BOT_TOKEN не задан — мастер-бот не запущен');
    return null;
  }

  const bot = new Telegraf(token);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(ctx => {
    if (!isMasterAdmin(ctx)) return ctx.reply('Нет доступа.');
    ctx.reply(
      '🤖 *Мастер-бот HR-Bot*\n\n' +
      'Команды:\n' +
      '`/provision [название] [токен] [@telegram]` — подключить компанию\n' +
      '`/companies` — список всех компаний\n' +
      '`/suspend [id]` — приостановить компанию\n' +
      '`/resume [id]` — восстановить компанию',
      { parse_mode: 'Markdown' }
    );
  });

  // ── /provision [название] [токен] [admin_telegram_id или @username] ────────
  bot.command('provision', async ctx => {
    if (!isMasterAdmin(ctx)) return ctx.reply('Нет доступа.');

    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 3) {
      return ctx.reply(
        '❌ Формат:\n`/provision Название_компании ТОКЕН_БОТА TELEGRAM_ID_АДМИНА`',
        { parse_mode: 'Markdown' }
      );
    }

    const [companyName, botToken, adminRaw] = parts;
    const adminTelegramId = parseInt(adminRaw.replace('@', ''));

    if (isNaN(adminTelegramId)) {
      return ctx.reply('❌ admin_telegram_id должен быть числом (не @username). Узнать ID можно через @userinfobot.');
    }

    // Проверить что токен рабочий
    let botInfo;
    try {
      const testBot = new Telegraf(botToken);
      botInfo = await testBot.telegram.getMe();
    } catch (e) {
      return ctx.reply(`❌ Токен не работает: ${e.message}`);
    }

    // Проверить что компании с таким токеном нет
    const { rows: existing } = await pool.query(
      'SELECT id FROM companies WHERE bot_token = $1', [botToken]
    );
    if (existing[0]) return ctx.reply('⚠️ Компания с этим токеном уже существует.');

    // Создать компанию
    const { rows } = await pool.query(
      'INSERT INTO companies (name, bot_token, admin_telegram_id) VALUES ($1, $2, $3) RETURNING *',
      [companyName, botToken, adminTelegramId]
    );
    const company = rows[0];

    // Зарегистрировать бота в рантайме
    if (registerCompanyBotFn) {
      await registerCompanyBotFn(company);
    }

    await ctx.reply(
      `✅ *Компания подключена!*\n\n` +
      `🏢 *Название:* ${companyName}\n` +
      `🤖 *Бот:* @${botInfo.username}\n` +
      `👤 *Админ ID:* ${adminTelegramId}\n` +
      `🆔 *Company ID:* ${company.id}`,
      { parse_mode: 'Markdown' }
    );

    // Уведомить нового админа
    try {
      await bot.telegram.sendMessage(
        adminTelegramId,
        `👋 Привет! Ваша компания *${companyName}* подключена к HR-Bot.\n\n` +
        `Ваш корпоративный бот: @${botInfo.username}\n\n` +
        `Откройте бота и нажмите /start чтобы начать работу.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      await ctx.reply(`⚠️ Не удалось уведомить админа компании (${e.message}). Сообщите ему вручную.`);
    }
  });

  // ── /companies ────────────────────────────────────────────────────────────
  bot.command('companies', async ctx => {
    if (!isMasterAdmin(ctx)) return ctx.reply('Нет доступа.');

    const { rows } = await pool.query(`
      SELECT c.*, COUNT(e.id) as employee_count
      FROM companies c
      LEFT JOIN employees e ON e.company_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);

    if (rows.length === 0) return ctx.reply('Компаний пока нет.');

    let text = `🏢 *Компании (${rows.length}):*\n\n`;
    for (const c of rows) {
      const status = c.active ? '🟢' : '🔴';
      text += `${status} *${c.name}*\n`;
      text += `   ID: ${c.id} · 👥 ${c.employee_count} сотр.\n`;
      text += `   Админ: ${c.admin_telegram_id}\n`;
      text += `   Дата: ${new Date(c.created_at).toLocaleDateString('ru-RU')}\n\n`;
    }

    ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // ── /suspend [id] ─────────────────────────────────────────────────────────
  bot.command('suspend', async ctx => {
    if (!isMasterAdmin(ctx)) return ctx.reply('Нет доступа.');
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('Формат: /suspend [company_id]');

    const { rows } = await pool.query(
      'UPDATE companies SET active = FALSE WHERE id = $1 RETURNING name', [id]
    );
    if (!rows[0]) return ctx.reply('Компания не найдена.');
    ctx.reply(`🔴 Компания *${rows[0].name}* приостановлена.`, { parse_mode: 'Markdown' });
  });

  // ── /resume [id] ──────────────────────────────────────────────────────────
  bot.command('resume', async ctx => {
    if (!isMasterAdmin(ctx)) return ctx.reply('Нет доступа.');
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('Формат: /resume [company_id]');

    const { rows } = await pool.query(
      'UPDATE companies SET active = TRUE WHERE id = $1 RETURNING name', [id]
    );
    if (!rows[0]) return ctx.reply('Компания не найдена.');
    ctx.reply(`🟢 Компания *${rows[0].name}* восстановлена.`, { parse_mode: 'Markdown' });
  });

  // ── Уведомление о новой заявке с лендинга (вызывается из api.js) ──────────
  bot.notifyNewLead = async (lead) => {
    const text =
      `🆕 *Новая заявка с лендинга*\n\n` +
      `👤 *Имя:* ${lead.name}\n` +
      `🏢 *Компания:* ${lead.company}\n` +
      `📱 *Telegram:* ${lead.telegram}\n` +
      (lead.employees ? `👥 *Сотрудников:* ${lead.employees}\n` : '') +
      (lead.comment ? `💬 *Комментарий:* ${lead.comment}\n` : '') +
      `\n_Чтобы подключить:_\n` +
      `\`/provision ${lead.company.replace(/ /g, '_')} ТОКЕН ID_АДМИНА\``;

    for (const adminId of MASTER_ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(adminId, text, { parse_mode: 'Markdown' });
      } catch {}
    }
  };

  // Регистрируем webhook мастер-бота
  app.post('/master-webhook', (req, res) => {
    res.sendStatus(200);
    bot.handleUpdate(req.body).catch(e => console.error('Master bot error:', e));
  });

  console.log('✅ Мастер-бот зарегистрирован');
  return bot;
}

module.exports = { registerMasterBot, setRegisterFn };
