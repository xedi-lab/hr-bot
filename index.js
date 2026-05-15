require('dotenv').config();
const app = require('./api');
const { Telegraf, Markup } = require('telegraf');
const { pool, initDB, getAllCompanies } = require('./database');
const { registerNotifications } = require('./notifications');
const { registerAdmin } = require('./admin');
const { registerMasterBot, setRegisterFn, setControllers } = require('./master-bot');

const MASTER_ADMIN_IDS = [parseInt(process.env.ADMIN_ID), 961116530];
const domain = process.env.RAILWAY_PUBLIC_DOMAIN;

// Карта запущенных ботов: companyId → { bot, webhookUrl }
const companyBots = new Map();

// ── Создать и запустить бота для одной компании ───────────────────────────────
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

  bot.command('app', async (ctx) => {
    await ctx.reply('Открой рабочее приложение:', getMiniAppButton(ctx.from.id));
  });

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

  registerAdmin(bot, company);
  registerNotifications(bot, company);

  if (domain) {
    const webhookPath = `/bot/${companyId}`;
    const webhookUrl = `https://${domain}${webhookPath}`;

    // Не регистрируем маршрут повторно если бот уже был в карте
    if (!companyBots.has(companyId)) {
      app.post(webhookPath, (req, res) => {
        res.sendStatus(200);
        bot.handleUpdate(req.body).catch(e =>
          console.error(`[company ${companyId}] handleUpdate error:`, e.message)
        );
      });
    }

    companyBots.set(companyId, { bot, webhookUrl });

    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query', 'edited_message'],
    });

    console.log(`✅ Бот компании #${companyId} (${name}) → webhook ${webhookUrl}`);
  } else {
    companyBots.set(companyId, { bot, webhookUrl: null });
    console.log(`⚡ Бот компании #${companyId} (${name}) запущен в режиме polling`);
  }

  return bot;
}

// ── Управление ботами компаний ────────────────────────────────────────────────
async function suspendCompanyBot(companyId) {
  const entry = companyBots.get(companyId);
  if (!entry) return;
  try {
    await entry.bot.telegram.deleteWebhook();
    console.log(`🔴 Бот компании #${companyId} остановлен (webhook удалён)`);
  } catch (e) {
    console.error(`Ошибка остановки бота #${companyId}:`, e.message);
  }
}

async function resumeCompanyBot(companyId) {
  const entry = companyBots.get(companyId);
  if (!entry) {
    // Бот не в памяти — перезапускаем из БД
    const { rows } = await pool.query('SELECT * FROM companies WHERE id = $1 AND active = TRUE', [companyId]);
    if (rows[0]) await spawnCompanyBot(rows[0]);
    return;
  }
  if (entry.webhookUrl) {
    await entry.bot.telegram.setWebhook(entry.webhookUrl, {
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query', 'edited_message'],
    });
    console.log(`🟢 Бот компании #${companyId} возобновлён (webhook восстановлен)`);
  }
}

async function deleteCompanyBot(companyId) {
  const entry = companyBots.get(companyId);
  if (entry) {
    try { await entry.bot.telegram.deleteWebhook(); } catch {}
    companyBots.delete(companyId);
    console.log(`🗑 Бот компании #${companyId} удалён из памяти`);
  }
}

// ── Старт ─────────────────────────────────────────────────────────────────────
initDB().then(async () => {

  const masterBot = registerMasterBot();

  setRegisterFn(spawnCompanyBot);
  setControllers({ suspend: suspendCompanyBot, resume: resumeCompanyBot, deleteInstance: deleteCompanyBot });

  const companies = await getAllCompanies();
  console.log(`📦 Найдено компаний: ${companies.length}`);

  for (const company of companies) {
    try {
      await spawnCompanyBot(company);
    } catch (e) {
      console.error(`❌ Ошибка запуска бота компании #${company.id} (${company.name}):`, e.message);
    }
  }

  if (masterBot) {
    await masterBot.launch({ dropPendingUpdates: true });
    console.log('✅ Мастер-бот → polling');
  }

  console.log('🚀 Все боты запущены');
});

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
