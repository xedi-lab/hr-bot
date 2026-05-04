require('dotenv').config();
require('./api');
const { Telegraf, Markup } = require('telegraf');
const db = require('./database');
const { registerAdmin, adminMenu } = require('./admin');
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const { registerNotifications } = require('./notifications');

const SHIFT_START_HOUR = 9;
const SHIFT_END_HOUR = 21;
const TIMEZONE_OFFSET = 7;

function getNowNSK() {
  const now = new Date();
  now.setHours(now.getUTCHours() + TIMEZONE_OFFSET);
  return now;
}

function getEmployee(telegram_id) {
  return db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(telegram_id);
}

function mainMenu(isAdmin = false) {
  const buttons = [
    [{ text: '📱 Открыть приложение', web_app: { url: 'https://твой-домен.com' } }],
    ['🟢 Открыть смену', '🔴 Закрыть смену'],
    ['📅 График', '👤 Профиль'],
    ['📞 Поддержка']
  ];
  if (isAdmin) buttons.push(['👑 Админ панель']);
  return Markup.keyboard(buttons).resize();
}

bot.start((ctx) => {
  const employee = getEmployee(ctx.from.id);
  const admin = ctx.from.id === ADMIN_ID;

  if (employee) {
    ctx.reply(`С возвращением, ${employee.first_name}!`, mainMenu(admin));
  } else if (admin) {
    ctx.reply('Добро пожаловать, администратор!', mainMenu(true));
  } else {
    const pending = db.prepare('SELECT * FROM pending_employees WHERE telegram_id = ?').get(ctx.from.id);
    if (pending) {
      ctx.reply('⏳ Твоя заявка уже отправлена. Ожидай одобрения администратора.');
    } else {
      ctx.reply(
        'Привет! Ты не зарегистрирован в системе.\n\n' +
        'Хочешь подать заявку на регистрацию?',
        Markup.keyboard([['📝 Подать заявку']]).resize()
      );
    }
  }
});

const userStates = {};

bot.hears('📝 Подать заявку', (ctx) => {
  const employee = getEmployee(ctx.from.id);
  if (employee) return ctx.reply('Ты уже зарегистрирован.', mainMenu(ctx.from.id === ADMIN_ID));

  userStates[ctx.from.id] = { step: 'first_name' };
  ctx.reply('Введи своё имя:');
});

bot.on('text', (ctx, next) => {
  const state = userStates[ctx.from.id];
  if (!state) return next();

  if (state.step === 'first_name') {
    userStates[ctx.from.id].first_name = ctx.message.text;
    userStates[ctx.from.id].step = 'last_name';
    return ctx.reply('Введи свою фамилию:');
  }

  if (state.step === 'last_name') {
    userStates[ctx.from.id].last_name = ctx.message.text;
    userStates[ctx.from.id].step = null;

    const { first_name, last_name } = userStates[ctx.from.id];
    delete userStates[ctx.from.id];

    const existing = db.prepare('SELECT * FROM pending_employees WHERE telegram_id = ?').get(ctx.from.id);
    if (existing) return ctx.reply('⏳ Твоя заявка уже на рассмотрении.');

    db.prepare('INSERT INTO pending_employees (telegram_id, first_name, last_name) VALUES (?, ?, ?)').run(ctx.from.id, first_name, last_name);

    ctx.reply('✅ Заявка отправлена! Ожидай одобрения администратора.');

    ctx.telegram.sendMessage(ADMIN_ID,
      `📥 Новая заявка на регистрацию:\n\n` +
      `Имя: ${first_name} ${last_name}\n` +
      `TG ID: ${ctx.from.id}\n` +
      `Username: @${ctx.from.username || 'нет'}`,
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

bot.hears('🟢 Открыть смену', (ctx) => {
  const employee = getEmployee(ctx.from.id);
  if (!employee) return ctx.reply('Ты не зарегистрирован. Обратись к администратору.');

  const now = getNowNSK();
  const hour = now.getHours();

  if (hour < SHIFT_START_HOUR) {
    return ctx.reply(`⛔ Смену можно открыть только с ${SHIFT_START_HOUR}:00 по новосибирскому времени.\nСейчас ${hour}:${String(now.getMinutes()).padStart(2, '0')}.`);
  }

  if (hour >= SHIFT_END_HOUR) {
    return ctx.reply(`⛔ Рабочий день уже закончился. Смена недоступна после ${SHIFT_END_HOUR}:00.`);
  }

  const openShift = db.prepare(`
    SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL
  `).get(employee.id);

  if (openShift) {
    return ctx.reply('У тебя уже открыта смена. Сначала закрой текущую.');
  }

  db.prepare(`
    INSERT INTO shifts (employee_id, start_time) VALUES (?, ?)
  `).run(employee.id, now.toISOString());

  ctx.reply(`✅ Смена открыта!\nВремя: ${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} (НСК)`, mainMenu());
});

bot.hears('🔴 Закрыть смену', (ctx) => {
  const employee = getEmployee(ctx.from.id);
  if (!employee) return ctx.reply('Ты не зарегистрирован. Обратись к администратору.');

  const now = getNowNSK();
  const hour = now.getHours();

  const openShift = db.prepare(`
    SELECT * FROM shifts WHERE employee_id = ? AND end_time IS NULL
  `).get(employee.id);

  if (!openShift) {
    return ctx.reply('У тебя нет открытой смены.');
  }

  let endTime = now;
  let warning = '';

  if (hour >= SHIFT_END_HOUR) {
    endTime = new Date(now);
    endTime.setHours(SHIFT_END_HOUR, 0, 0, 0);
    warning = `⚠️ Переработка не учитывается. Оплата считается до ${SHIFT_END_HOUR}:00.\n\n`;
  }

  const startTime = new Date(openShift.start_time);
  const diffMs = endTime - startTime;
  const hoursWorked = Math.max(0, diffMs / (1000 * 60 * 60));
  const earned = parseFloat((hoursWorked * employee.hourly_rate).toFixed(2));

  db.prepare(`
    UPDATE shifts SET end_time = ?, hours_worked = ?, earned = ? WHERE id = ?
  `).run(endTime.toISOString(), hoursWorked.toFixed(2), earned, openShift.id);

  ctx.reply(
    `${warning}✅ Смена закрыта!\n` +
    `⏱ Отработано: ${hoursWorked.toFixed(1)} ч.\n` +
    `💰 Заработано: ${earned} ₽`,
    mainMenu()
  );
});

bot.hears('👤 Профиль', (ctx) => {
  const employee = getEmployee(ctx.from.id);
  if (!employee) return ctx.reply('Ты не зарегистрирован. Обратись к администратору.');

  const now = getNowNSK();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const stats = db.prepare(`
    SELECT COUNT(*) as shifts_count, SUM(earned) as total_earned
    FROM shifts
    WHERE employee_id = ? AND start_time >= ? AND end_time IS NOT NULL
  `).get(employee.id, startOfMonth);

  ctx.reply(
    `👤 Профиль\n\n` +
    `Имя: ${employee.first_name} ${employee.last_name}\n` +
    `Место работы: ${employee.workplace}\n` +
    `Ставка: ${employee.hourly_rate} ₽/час\n\n` +
    `📊 За этот месяц:\n` +
    `Смен: ${stats.shifts_count || 0}\n` +
    `Заработано: ${stats.total_earned ? stats.total_earned.toFixed(2) : '0.00'} ₽`,
    mainMenu()
  );
});

bot.hears('📅 График', (ctx) => {
  const employee = getEmployee(ctx.from.id);
  if (!employee) return ctx.reply('Ты не зарегистрирован. Обратись к администратору.');

  const now = getNowNSK();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const shifts = db.prepare(`
    SELECT * FROM shifts
    WHERE employee_id = ? AND start_time >= ? AND end_time IS NOT NULL
    ORDER BY start_time DESC
    LIMIT 20
  `).all(employee.id, startOfMonth);

  if (shifts.length === 0) {
    return ctx.reply('В этом месяце смен пока нет.', mainMenu());
  }

  let text = '📅 Твои смены за месяц:\n\n';
  shifts.forEach((shift) => {
    const start = new Date(shift.start_time);
    const end = new Date(shift.end_time);
    const date = `${start.getDate()}.${String(start.getMonth() + 1).padStart(2, '0')}`;
    const startStr = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    const endStr = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
    text += `${date}: ${startStr} — ${endStr} | ${parseFloat(shift.hours_worked).toFixed(1)}ч | ${shift.earned} ₽\n`;
  });

  ctx.reply(text, mainMenu());
});

bot.hears('📞 Поддержка', (ctx) => {
  ctx.reply(
    '📞 Поддержка\n\n' +
    'По всем вопросам обращайтесь:\n' +
    'Администратор: @твой_юзернейм\n' +
    'Разработчик: @твой_юзернейм',
    mainMenu()
  );
});
registerAdmin(bot, mainMenu);
registerNotifications(bot);
bot.launch();
console.log('Бот запущен...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));