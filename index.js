require('dotenv').config();
const app = require('./api');
const { Telegraf, Markup } = require('telegraf');
const { pool, initDB, getAllCompanies } = require('./database');
const { registerNotifications } = require('./notifications');
const { registerAdmin } = require('./admin');
const { registerMasterBot, setRegisterFn } = require('./master-bot');

const MASTER_ADMIN_IDS = [parseInt(process.env.ADMIN_ID), 961116530];
const domain = process.env.RAILWAY_PUBLIC_DOMAIN;

// ── Создать и запустить бота для одной компании ────────────────────────────
async function spawnCompanyBot(company) {
  const { id: companyId, bot_token, admin_telegram_id, name } = company;

  const bot = new Telegraf(bot_token);

  function getMiniAppButton(userId) {
    const url = `https://mini-app-xedi11.vercel.app?uid=${userId}&cid=${companyId}`;
    return Markup.inlineKeyboard([[Markup.button.webApp('📱 Открыть приложение', url)]]);
  }

  async function getEmployee(telegram_id) {
    const { rows } = await pool.query(
      'SELECT * FROM employees WHERE telegram_id = $1 AND company_id = $2',
      [telegram_id, companyId]
    );
    return rows[0] || null;
  }

  const isAdmin = (id) => id === admin_telegram_id || MASTER_ADMIN_IDS.includes(id);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const employee = await getEmployee(ctx.from.id);
    const admin = isAdmin(ctx.from.id);

    if (employee || admin) {
      const greetName = employee ? employee.first_name : 'Администратор';
      await ctx.reply(`👋 С возвращением, ${greetName}!`);
      await ctx.reply('Открой рабочее приложение:', getMiniAppButton(ctx.from.id));
    } else {
      await ctx.reply('👋 Привет!\n\nТы не зарегистрирован в системе. Подай заявку через приложение:');
      await ctx.reply('👇 Открыть приложение:', getMiniAppButton(ctx.from.id));
    }
  });

  // ── /app ──────────────────────────────────────────────────────────────────
  bot.command('app', async (ctx) => {
    await ctx.reply('Открой рабочее приложение:', getMiniAppButton(ctx.from.id));
  });

  // ── Одобрение заявки ─────────────────────────────────────────────────────
  bot.action(/approve_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    const telegram_id = parseInt(ctx.match[1]);

    try {
      const { rows } = await pool.query(
        'SELECT * FROM pending_employees WHERE telegram_id = $1 AND company_id = $2',
        [telegram_id, companyId]
      );
      if (!rows[0]) return ctx.reply('Заявка не найдена или уже обработана.');

      await pool.query(
        'INSERT INTO employees (company_id, telegram_id, first_name, last_name, hourly_rate, workplace) VALUES ($1, $2, $3, $4, $5, $6)',
        [companyId, rows[0].telegram_id, rows[0].first_name, rows[0].last_name, 0, 'Не указано']
      );
      await pool.query('DELETE FROM pending_employees WHERE telegram_id = $1 AND company_id = $2', [telegram_id, companyId]);

      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      await ctx.reply(`✅ Сотрудник ${rows[0].first_name} ${rows[0].last_name} добавлен!`);
      await ctx.telegram.sendMessage(telegram_id, '✅ Твоя заявка одобрена! Открой приложение:');
      await ctx.telegram.sendMessage(telegram_id, 'Твоё приложение:', getMiniAppButton(telegram_id));
    } catch (e) {
      console.error(`[company ${companyId}] Ошибка approve:`, e.message);
      await ctx.reply(`❌ Ошибка: ${e.message}`);
    }
  });

  // ── Отклонение заявки ────────────────────────────────────────────────────
  bot.action(/reject_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    const telegram_id = parseInt(ctx.match[1]);

    try {
      await pool.query('DELETE FROM pending_employees WHERE telegram_id = $1 AND company_id = $2', [telegram_id, companyId]);
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      await ctx.reply('Заявка отклонена.');
      await ctx.telegram.sendMessage(telegram_id, '❌ Твоя заявка отклонена. Обратись к администратору.');
    } catch (e) {
      console.error(`[company ${companyId}] Ошибка reject:`, e.message);
    }
  });

  // ── Регистрируем admin-команды и уведомления ─────────────────────────────
  registerAdmin(bot, company);
  registerNotifications(bot, company);

  // ── Webhook ───────────────────────────────────────────────────────────────
  if (domain) {
    const webhookPath = `/bot/${companyId}`;
    const webhookUrl = `https://${domain}${webhookPath}`;

    app.post(webhookPath, (req, res) => {
      res.sendStatus(200);
      bot.handleUpdate(req.body).catch(e =>
        console.error(`[company ${companyId}] handleUpdate error:`, e.message)
      );
    });

    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query', 'edited_message'],
    });

    console.log(`✅ Бот компании #${companyId} (${name}) → webhook ${webhookUrl}`);
  } else {
    // Локальная разработка — polling (только для одного бота)
    console.log(`⚡ Бот компании #${companyId} (${name}) запущен в режиме polling`);
  }

  return bot;
}

// ── Старт ─────────────────────────────────────────────────────────────────
initDB().then(async () => {

  // Мастер-бот
  const masterBot = registerMasterBot(app);

  // Регистрируем функцию динамического добавления ботов
  setRegisterFn(spawnCompanyBot);

  // Загружаем все компании и поднимаем их ботов
  const companies = await getAllCompanies();
  console.log(`📦 Найдено компаний: ${companies.length}`);

  if (companies.length === 0) {
    console.warn('⚠️  Компаний нет. Добавьте через мастер-бот: /provision');
  }

  for (const company of companies) {
    try {
      await spawnCompanyBot(company);
    } catch (e) {
      console.error(`❌ Ошибка запуска бота компании #${company.id} (${company.name}):`, e.message);
    }
  }

  // Webhook мастер-бота
  if (domain && masterBot) {
    const masterWebhookUrl = `https://${domain}/master-webhook`;
    await masterBot.telegram.setWebhook(masterWebhookUrl, {
      allowed_updates: ['message', 'callback_query'],
    });
    console.log(`✅ Мастер-бот → webhook ${masterWebhookUrl}`);
  } else if (masterBot) {
    await masterBot.launch({ dropPendingUpdates: true });
  }

  console.log('🚀 Все боты запущены');
});

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
