require('dotenv').config();
const app = require('./api');
const { Telegraf, Markup } = require('telegraf');
const { pool, initDB } = require('./database');
const { registerNotifications } = require('./notifications');
const { registerAdmin } = require('./admin');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

function getMiniAppButton(userId) {
  const url = `https://mini-app-xedi11.vercel.app?uid=${userId}`;
  return Markup.inlineKeyboard([
    [Markup.button.webApp('📱 Открыть приложение', url)]
  ]);
}

async function getEmployee(telegram_id) {
  const { rows } = await pool.query('SELECT * FROM employees WHERE telegram_id = $1', [telegram_id]);
  return rows[0] || null;
}

bot.start(async (ctx) => {
  const employee = await getEmployee(ctx.from.id);
  const admin = ctx.from.id === ADMIN_ID;

  if (employee || admin) {
    const name = employee ? employee.first_name : 'Администратор';
    await ctx.reply(`👋 С возвращением, ${name}!`);
    await ctx.reply('Открой рабочее приложение:', getMiniAppButton(ctx.from.id));
  } else {
    await ctx.reply('👋 Привет!\n\nТы не зарегистрирован в системе. Воспользуйся удобным приложением чтобы подать заявку на доступ.');
    await ctx.reply('👇 Открыть приложение:', getMiniAppButton(ctx.from.id));
  }
});

bot.command('app', async (ctx) => {
  await ctx.reply('Открой рабочее приложение:', getMiniAppButton(ctx.from.id));
});

bot.action(/approve_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== ADMIN_ID) return;
  const telegram_id = parseInt(ctx.match[1]);

  try {
    const { rows } = await pool.query('SELECT * FROM pending_employees WHERE telegram_id = $1', [telegram_id]);
    if (!rows[0]) return ctx.reply('Заявка не найдена или уже обработана.');

    await pool.query(
      'INSERT INTO employees (telegram_id, first_name, last_name, hourly_rate, workplace) VALUES ($1, $2, $3, $4, $5)',
      [rows[0].telegram_id, rows[0].first_name, rows[0].last_name, 0, 'Не указано']
    );
    await pool.query('DELETE FROM pending_employees WHERE telegram_id = $1', [telegram_id]);

    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}

    await ctx.reply(`✅ Сотрудник ${rows[0].first_name} ${rows[0].last_name} добавлен!`);

    await ctx.telegram.sendMessage(telegram_id, '✅ Твоя заявка одобрена! Открой приложение и начни работу:');
    await ctx.telegram.sendMessage(telegram_id, 'Твоё приложение:', getMiniAppButton(telegram_id));
  } catch (e) {
    console.error('Ошибка при одобрении:', e.message);
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
});

bot.action(/reject_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== ADMIN_ID) return;
  const telegram_id = parseInt(ctx.match[1]);

  try {
    await pool.query('DELETE FROM pending_employees WHERE telegram_id = $1', [telegram_id]);
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
    await ctx.reply('Заявка отклонена.');
    await ctx.telegram.sendMessage(telegram_id, '❌ Твоя заявка отклонена. Обратись к администратору.');
  } catch (e) {
    console.error('Ошибка при отклонении:', e.message);
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
});

initDB().then(async () => {
  registerAdmin(bot);
  registerNotifications(bot);

  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const webhookPath = '/bot-webhook';

  // Webhook роут на существующем Express сервере
  app.post(webhookPath, (req, res) => bot.handleUpdate(req.body, res));

  if (domain) {
    const webhookUrl = `https://${domain}${webhookPath}`;
    await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
    console.log('Webhook установлен:', webhookUrl);
  } else {
    // Локальная разработка — polling
    await bot.launch({ dropPendingUpdates: true });
    console.log('Бот запущен в режиме polling (локально)');
  }

  console.log('Бот запущен...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
