const { Telegraf, Markup } = require('telegraf');
const { pool } = require('./database');

const MASTER_ADMIN_IDS = [
  parseInt(process.env.ADMIN_ID),
  961116530,
];

function isMasterAdmin(ctx) {
  return MASTER_ADMIN_IDS.includes(ctx.from.id);
}

function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const userStates = {};

let registerCompanyBotFn = null;
function setRegisterFn(fn) { registerCompanyBotFn = fn; }

// ── Клавиатуры ────────────────────────────────────────────────────────────────
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🏢 Компании', 'companies')],
    [Markup.button.callback('➕ Подключить компанию', 'provision_start')],
  ]);
}

// ── Главное меню ──────────────────────────────────────────────────────────────
async function showMainMenu(ctx) {
  const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM companies');
  const text = `🤖 <b>Мастер-бот HR-Bot</b>\n\nВсего компаний: <b>${rows[0].cnt}</b>`;
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...mainMenuKeyboard() });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...mainMenuKeyboard() });
  }
}

// ── Список компаний ───────────────────────────────────────────────────────────
async function showCompanies(ctx) {
  const { rows } = await pool.query(`
    SELECT c.*, COUNT(e.id) as employee_count
    FROM companies c
    LEFT JOIN employees e ON e.company_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `);

  if (rows.length === 0) {
    return ctx.editMessageText('Компаний пока нет.', Markup.inlineKeyboard([
      [Markup.button.callback('◀️ Назад', 'main_menu')]
    ]));
  }

  const buttons = rows.map(c => [
    Markup.button.callback(
      `${c.active ? '🟢' : '🔴'} ${c.name} · ${c.employee_count} сотр.`,
      `company_${c.id}`
    )
  ]);
  buttons.push([Markup.button.callback('◀️ Назад', 'main_menu')]);

  await ctx.editMessageText(
    `🏢 <b>Компании (${rows.length}):</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
}

// ── Карточка компании ─────────────────────────────────────────────────────────
async function showCompany(ctx, companyId) {
  const { rows } = await pool.query(`
    SELECT c.*, COUNT(e.id) as employee_count
    FROM companies c
    LEFT JOIN employees e ON e.company_id = c.id
    WHERE c.id = $1
    GROUP BY c.id
  `, [companyId]);

  if (!rows[0]) return ctx.answerCbQuery('Компания не найдена');
  const c = rows[0];

  let botUsername = '—';
  try {
    const testBot = new Telegraf(c.bot_token);
    const info = await testBot.telegram.getMe();
    botUsername = `@${info.username}`;
  } catch {}

  const date = new Date(c.created_at).toLocaleDateString('ru-RU');
  const status = c.active ? '🟢 Активна' : '🔴 Заморожена';

  const text =
    `🏢 <b>${esc(c.name)}</b>\n\n` +
    `Статус: ${status}\n` +
    `Бот: ${esc(botUsername)}\n` +
    `Сотрудников: ${c.employee_count}\n` +
    `Подключена: ${date}`;

  const buttons = [
    [Markup.button.callback('📊 Статистика', `stats_${c.id}`)],
    [Markup.button.callback('✏️ Переименовать', `rename_start_${c.id}`)],
    [Markup.button.callback(
      c.active ? '🔴 Заморозить' : '🟢 Восстановить',
      c.active ? `suspend_${c.id}` : `resume_${c.id}`
    )],
    [Markup.button.callback('🗑 Удалить компанию', `delete_confirm_${c.id}`)],
    [Markup.button.callback('◀️ К списку', 'companies')],
  ];

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

// ── Статистика компании ───────────────────────────────────────────────────────
async function showStats(ctx, companyId) {
  const { rows: company } = await pool.query('SELECT name FROM companies WHERE id = $1', [companyId]);
  if (!company[0]) return ctx.answerCbQuery('Компания не найдена');

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const { rows: emps } = await pool.query(`
    SELECT
      e.first_name, e.last_name, e.hourly_rate, e.workplace, e.telegram_id,
      COUNT(s.id) AS shifts_count,
      COALESCE(SUM(s.hours_worked), 0) AS total_hours,
      COALESCE(SUM(s.earned), 0) AS total_earned,
      MAX(CASE WHEN s.end_time IS NULL THEN 1 ELSE 0 END) AS on_shift
    FROM employees e
    LEFT JOIN shifts s ON s.employee_id = e.id
      AND TO_CHAR(s.start_time AT TIME ZONE 'UTC', 'YYYY-MM') = $2
    WHERE e.company_id = $1
    GROUP BY e.id, e.first_name, e.last_name, e.hourly_rate, e.workplace, e.telegram_id
    ORDER BY total_earned DESC
  `, [companyId, month]);

  const { rows: pending } = await pool.query(
    'SELECT COUNT(*) as cnt FROM pending_employees WHERE company_id = $1', [companyId]
  );

  let text = `📊 <b>Статистика: ${esc(company[0].name)}</b>\n`;
  text += `📅 Месяц: ${month}\n\n`;

  if (emps.length === 0) {
    text += 'Сотрудников пока нет.';
  } else {
    let totalPayroll = 0;
    let onShiftCount = 0;

    emps.forEach((e, i) => {
      const earned = parseFloat(e.total_earned).toFixed(0);
      const hours = parseFloat(e.total_hours).toFixed(1);
      const shifts = parseInt(e.shifts_count);
      const onShift = parseInt(e.on_shift) === 1;
      if (onShift) onShiftCount++;
      totalPayroll += parseFloat(e.total_earned);

      text += `${i + 1}. <b>${esc(e.first_name)} ${esc(e.last_name)}</b>${onShift ? ' 🟢' : ''}\n`;
      text += `   📍 ${esc(e.workplace)} · ${e.hourly_rate} ₽/ч\n`;
      text += `   Смен: ${shifts} · ${hours}ч · <b>${earned} ₽</b>\n\n`;
    });

    text += `💰 <b>Итого ФОТ: ${totalPayroll.toFixed(0)} ₽</b>\n`;
    text += `🟢 На смене сейчас: ${onShiftCount}\n`;
  }

  if (parseInt(pending[0].cnt) > 0) {
    text += `\n⏳ Заявок на рассмотрении: ${pending[0].cnt}`;
  }

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', `company_${companyId}`)]])
  });
}

function registerMasterBot() {
  const token = process.env.MASTER_BOT_TOKEN;
  if (!token) {
    console.log('⚠️  MASTER_BOT_TOKEN не задан — мастер-бот не запущен');
    return null;
  }

  const bot = new Telegraf(token);

  // ── Глобальный обработчик ошибок ─────────────────────────────────────────
  bot.catch((err, ctx) => {
    console.error(`[Master Bot] Ошибка в ${ctx.updateType}:`, err.message);
    try {
      if (ctx.callbackQuery) ctx.answerCbQuery('❌ Ошибка').catch(() => {});
      ctx.reply(`❌ Ошибка: ${err.message}`).catch(() => {});
    } catch {}
  });

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(async ctx => {
    if (!isMasterAdmin(ctx)) return ctx.reply('Нет доступа.');
    delete userStates[ctx.from.id];
    await showMainMenu(ctx);
  });

  // ── Навигация ─────────────────────────────────────────────────────────────
  bot.action('main_menu', async ctx => {
    await ctx.answerCbQuery();
    delete userStates[ctx.from.id];
    await showMainMenu(ctx);
  });

  bot.action('companies', async ctx => {
    await ctx.answerCbQuery();
    await showCompanies(ctx);
  });

  bot.action(/^company_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    await showCompany(ctx, parseInt(ctx.match[1]));
  });

  // ── Статистика ────────────────────────────────────────────────────────────
  bot.action(/^stats_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    await showStats(ctx, parseInt(ctx.match[1]));
  });

  // ── Заморозить / Восстановить ─────────────────────────────────────────────
  bot.action(/^suspend_(\d+)$/, async ctx => {
    await ctx.answerCbQuery('🔴 Заморожено');
    const id = parseInt(ctx.match[1]);
    await pool.query('UPDATE companies SET active = FALSE WHERE id = $1', [id]);
    await showCompany(ctx, id);
  });

  bot.action(/^resume_(\d+)$/, async ctx => {
    await ctx.answerCbQuery('🟢 Восстановлено');
    const id = parseInt(ctx.match[1]);
    await pool.query('UPDATE companies SET active = TRUE WHERE id = $1', [id]);
    await showCompany(ctx, id);
  });

  // ── Удалить компанию ──────────────────────────────────────────────────────
  bot.action(/^delete_confirm_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1]);
    const { rows } = await pool.query('SELECT name FROM companies WHERE id = $1', [id]);
    if (!rows[0]) return;
    await ctx.editMessageText(
      `⚠️ <b>Удалить компанию &quot;${esc(rows[0].name)}&quot;?</b>\n\nБудут удалены все сотрудники, смены и данные. Это действие необратимо.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Да, удалить', `delete_do_${id}`)],
        [Markup.button.callback('◀️ Отмена', `company_${id}`)],
      ]) }
    );
  });

  bot.action(/^delete_do_(\d+)$/, async ctx => {
    await ctx.answerCbQuery('🗑 Удалено');
    const id = parseInt(ctx.match[1]);
    const { rows } = await pool.query('SELECT name FROM companies WHERE id = $1', [id]);
    const name = rows[0]?.name || `#${id}`;

    const empRows = await pool.query('SELECT id FROM employees WHERE company_id = $1', [id]);
    for (const emp of empRows.rows) {
      await pool.query('DELETE FROM adjustments WHERE employee_id = $1', [emp.id]);
      await pool.query('DELETE FROM planned_shifts WHERE employee_id = $1', [emp.id]);
      await pool.query('DELETE FROM shifts WHERE employee_id = $1', [emp.id]);
    }
    await pool.query('DELETE FROM employees WHERE company_id = $1', [id]);
    await pool.query('DELETE FROM pending_employees WHERE company_id = $1', [id]);
    await pool.query('DELETE FROM companies WHERE id = $1', [id]);

    await ctx.editMessageText(`✅ Компания <b>${esc(name)}</b> удалена.`, { parse_mode: 'HTML', ...mainMenuKeyboard() });
  });

  // ── Переименовать ─────────────────────────────────────────────────────────
  bot.action(/^rename_start_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1]);
    userStates[ctx.from.id] = { action: 'awaiting_rename', companyId: id };
    await ctx.editMessageText(
      '✏️ Введи новое название компании:',
      Markup.inlineKeyboard([[Markup.button.callback('◀️ Отмена', `company_${id}`)]])
    );
  });

  // ── Подключить компанию ───────────────────────────────────────────────────
  bot.action('provision_start', async ctx => {
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = { action: 'awaiting_provision' };
    await ctx.editMessageText(
      '➕ <b>Подключение компании</b>\n\n' +
      'Отправь данные в формате:\n' +
      '<code>НазваниеКомпании ТОКЕН_БОТА TELEGRAM_ID_АДМИНА</code>\n\n' +
      'Пример:\n<code>Ромашка 123456789:AAF... 79112345678</code>',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Отмена', 'main_menu')]]) }
    );
  });

  // ── Обработка текстового ввода ────────────────────────────────────────────
  bot.on('text', async ctx => {
    if (!isMasterAdmin(ctx)) return;
    const state = userStates[ctx.from.id];
    if (!state) return;

    // Переименование
    if (state.action === 'awaiting_rename') {
      const newName = ctx.message.text.trim();
      const companyId = state.companyId;
      delete userStates[ctx.from.id];
      await pool.query('UPDATE companies SET name = $1 WHERE id = $2', [newName, companyId]);
      await ctx.reply(
        `✅ Переименовано в <b>${esc(newName)}</b>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.callback('◀️ К карточке компании', `company_${companyId}`)],
          [Markup.button.callback('🏢 Все компании', 'companies')],
        ]) }
      );
      return;
    }

    // Подключение компании
    if (state.action === 'awaiting_provision') {
      const parts = ctx.message.text.trim().split(' ');
      if (parts.length < 3) {
        return ctx.reply('❌ Неверный формат. Нужно: <code>НазваниеКомпании ТОКЕН TELEGRAM_ID</code>', { parse_mode: 'HTML' });
      }

      const [companyName, botToken, adminRaw] = parts;
      const adminTelegramId = parseInt(adminRaw);
      if (isNaN(adminTelegramId)) {
        return ctx.reply('❌ TELEGRAM_ID должен быть числом.');
      }

      let botInfo;
      try {
        const testBot = new Telegraf(botToken);
        botInfo = await testBot.telegram.getMe();
      } catch (e) {
        return ctx.reply(`❌ Токен не работает: ${e.message}`);
      }

      const { rows: existing } = await pool.query('SELECT id FROM companies WHERE bot_token = $1', [botToken]);
      if (existing[0]) return ctx.reply('⚠️ Компания с этим токеном уже существует.');

      const { rows } = await pool.query(
        'INSERT INTO companies (name, bot_token, admin_telegram_id) VALUES ($1, $2, $3) RETURNING *',
        [companyName, botToken, adminTelegramId]
      );
      const company = rows[0];
      delete userStates[ctx.from.id];

      if (registerCompanyBotFn) await registerCompanyBotFn(company);

      await ctx.reply(
        `✅ <b>Компания подключена!</b>\n\n` +
        `🏢 Название: <b>${esc(companyName)}</b>\n` +
        `🤖 Бот: @${esc(botInfo.username)}\n` +
        `👤 Админ ID: <code>${adminTelegramId}</code>\n` +
        `🆔 Company ID: ${company.id}\n\n` +
        `📲 <b>Отправь заказчику эту ссылку:</b>\nhttps://t.me/${botInfo.username}`,
        { parse_mode: 'HTML', ...mainMenuKeyboard() }
      );
      return;
    }
  });

  // ── Уведомление о новой заявке с лендинга ────────────────────────────────
  bot.notifyNewLead = async (lead) => {
    const text =
      `🆕 <b>Новая заявка с лендинга</b>\n\n` +
      `👤 <b>Имя:</b> ${esc(lead.name)}\n` +
      `🏢 <b>Компания:</b> ${esc(lead.company)}\n` +
      `📱 <b>Telegram:</b> ${esc(lead.telegram)}\n` +
      (lead.employees ? `👥 <b>Сотрудников:</b> ${lead.employees}\n` : '') +
      (lead.comment ? `💬 <b>Комментарий:</b> ${esc(lead.comment)}\n` : '');

    for (const adminId of MASTER_ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(adminId, text, { parse_mode: 'HTML' });
      } catch {}
    }
  };

  console.log('✅ Мастер-бот зарегистрирован');
  return bot;
}

module.exports = { registerMasterBot, setRegisterFn };
