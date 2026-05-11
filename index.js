require('dotenv').config();
require('./api');
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

async function getPending(telegram_id) {
  const { rows } = await pool.query('SELECT * FROM pending_employees WHERE telegram_id = $1', [telegram_id]);
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
    await ctx.reply(
      '👋 Привет!\n\nТы не зарегистрирован в системе. Воспользуйся удобным приложением чтобы подать заявку на доступ.'
    );
    await ctx.reply('👇 Открыть приложение:', getMiniAppButton(ctx.from.id));
  }
});

bot.command('app', async (ctx) => {
  await ctx.reply('Открой рабочее приложение:', getMiniAppButton(ctx.from.id));
});

const userStates = {};

  if (state.step === 'last_name') {
    const { first_name } = userStates[ctx.from.id];
    const last_name = ctx.message.text;
    delete userStates[ctx.from.id];

    const existing = await getPending(ctx.from.id);
    if (existing) return ctx.reply('⏳ Твоя заявка уже на рассмотрении.');

    await pool.query(
      'INSERT INTO pending_employees (telegram_id, first_name, last_name) VALUES ($1, $2, $3)',
      [ctx.from.id, first_name, last_name]
    );

    await ctx.reply('✅ Заявка отправлена! Ожидай одобрения администратора.');

    await ctx.telegram.sendMessage(ADMIN_ID,
      `📥 Новая заявка на регистрацию:\n\nИмя: ${first_name} ${last_name}\nTG ID: ${ctx.from.id}\nUsername: @${ctx.from.username || 'нет'}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Одобрить', `approve_${ctx.from.id}`),
          Markup.button.callback('❌ Отклонить', `reject_${ctx.from.id}`)
        ]
      ])
    );
    return;
  }

  return next();
});

bot.action(/approve_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const telegram_id = parseInt(ctx.match[1]);

  const { rows } = await pool.query('SELECT * FROM pending_employees WHERE telegram_id = $1', [telegram_id]);
  if (!rows[0]) return ctx.reply('Заявка не найдена.');

  await pool.query(
    'INSERT INTO employees (telegram_id, first_name, last_name, hourly_rate, workplace) VALUES ($1, $2, $3, $4, $5)',
    [rows[0].telegram_id, rows[0].first_name, rows[0].last_name, 0, 'Не указано']
  );
  await pool.query('DELETE FROM pending_employees WHERE telegram_id = $1', [telegram_id]);

  await ctx.telegram.sendMessage(telegram_id,
    `✅ Твоя заявка одобрена!\n\nОткрой приложение и начни работу:`,
  );
  await ctx.telegram.sendMessage(telegram_id, 'Твоё приложение:', getMiniAppButton(telegram_id));
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(`✅ Сотрудник ${rows[0].first_name} ${rows[0].last_name} добавлен!`);
});

bot.action(/reject_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const telegram_id = parseInt(ctx.match[1]);

  await pool.query('DELETE FROM pending_employees WHERE telegram_id = $1', [telegram_id]);
  await ctx.telegram.sendMessage(telegram_id, '❌ Твоя заявка отклонена. Обратись к администратору.');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('Заявка отклонена.');
});

initDB().then(() => {
  registerAdmin(bot);
  registerNotifications(bot);
  bot.launch();
  console.log('Бот запущен...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));