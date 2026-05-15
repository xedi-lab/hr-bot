const { Telegraf, Markup } = require('telegraf');
const { pool, getAllCompanies } = require('./database');

const MASTER_ADMIN_IDS = [
  parseInt(process.env.ADMIN_ID),
  961116530,
];

function isMasterAdmin(ctx) {
  return MASTER_ADMIN_IDS.includes(ctx.from.id);
}

// Состояния ожидания ввода: { userId: { action, data } }
const userStates = {};

let registerCompanyBotFn = null;
function setRegisterFn(fn) { registerCompanyBotFn = fn; }

// ── Главное меню ──────────────────────────────────────────────────────────────
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🏢 Компании', 'companies')],
    [Markup.button.callback('➕ Подключить компанию', 'provision_start')],
  ]);
}

async function showMainMenu(ctx) {
  const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM companies');
  const text = `🤖 *Мастер-бот HR-Bot*\n\nВсего компаний: *${rows[0].cnt}*`;
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
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
    `🏢 *Компании (${rows.length}):*`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
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
    `🏢 *${c.name}*\n\n` +
    `Статус: ${status}\n` +
    `Бот: ${botUsername}\n` +
    `Сотрудников: ${c.employee_count}\n` +
    `Подключена: ${date}`;

  const buttons = [
    [Markup.button.callback('✏️ Переименовать', `rename_start_${c.id}`)],
    [Markup.button.callback(
      c.active ? '🔴 Заморозить' : '🟢 Восстановить',
      c.active ? `suspend_${c.id}` : `resume_${c.id}`
    )],
    [Markup.button.callback('🗑 Удалить компанию', `delete_confirm_${c.id}`)],
    [Markup.button.callback('◀️ К списку', 'companies')],
  ];

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
}

function registerMasterBot() {
  const token = process.env.MASTER_BOT_TOKEN;
  if (!token) {
    console.log('⚠️  MASTER_BOT_TOKEN не задан — мастер-бот не запущен');
    return null;
  }

  const bot = new Telegraf(token);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(async ctx => {
    if (!isMasterAdmin(ctx)) return ctx.reply('Нет доступа.');
    delete userStates[ctx.from.id];
    await showMainMenu(ctx);
  });

  // ── Навигация по кнопкам ──────────────────────────────────────────────────
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

  // ── Заморозить / Восстановить ─────────────────────────────────────────────
  bot.action(/^suspend_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1]);
    await pool.query('UPDATE companies SET active = FALSE WHERE id = $1', [id]);
    await showCompany(ctx, id);
  });

  bot.action(/^resume_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1]);
    await pool.query('UPDATE companies SET active = TRUE WHERE id = $1', [id]);
    await showCompany(ctx, id);
  });

  // ── Удалить компанию (подтверждение) ─────────────────────────────────────
  bot.action(/^delete_confirm_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1]);
    const { rows } = await pool.query('SELECT name FROM companies WHERE id = $1', [id]);
    if (!rows[0]) return ctx.answerCbQuery('Компания не найдена');
    await ctx.editMessageText(
      `⚠️ *Удалить компанию "${rows[0].name}"?*\n\nБудут удалены все сотрудники, смены и данные. Это действие необратимо.`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Да, удалить', `delete_do_${id}`)],
        [Markup.button.callback('◀️ Отмена', `company_${id}`)],
      ]) }
    );
  });

  bot.action(/^delete_do_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
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

    await ctx.editMessageText(`✅ Компания *${name}* удалена.`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
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
      '➕ *Подключение компании*\n\n' +
      'Отправь данные в формате:\n' +
      '`НазваниеКомпании ТОКЕН_БОТА TELEGRAM_ID_АДМИНА`\n\n' +
      '_Пример:_\n`Ромашка 123456789:AAF... 79112345678`',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Отмена', 'main_menu')]]) }
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
      delete userStates[ctx.from.id];
      const { rows } = await pool.query(
        'UPDATE companies SET name = $1 WHERE id = $2 RETURNING *', [newName, state.companyId]
      );
      if (!rows[0]) return ctx.reply('Компания не найдена.');
      await ctx.reply(`✅ Переименовано в *${newName}*`, { parse_mode: 'Markdown' });
      // Показываем карточку заново
      const msg = await ctx.reply('Загружаю...') ;
      const { rows: c } = await pool.query(`
        SELECT c.*, COUNT(e.id) as employee_count
        FROM companies c LEFT JOIN employees e ON e.company_id = c.id
        WHERE c.id = $1 GROUP BY c.id
      `, [state.companyId]);
      if (c[0]) {
        const date = new Date(c[0].created_at).toLocaleDateString('ru-RU');
        const status = c[0].active ? '🟢 Активна' : '🔴 Заморожена';
        let botUsername = '—';
        try { const tb = new Telegraf(c[0].bot_token); const info = await tb.telegram.getMe(); botUsername = `@${info.username}`; } catch {}
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
          `🏢 *${c[0].name}*\n\nСтатус: ${status}\nБот: ${botUsername}\nСотрудников: ${c[0].employee_count}\nПодключена: ${date}`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
            [Markup.button.callback('✏️ Переименовать', `rename_start_${c[0].id}`)],
            [Markup.button.callback(c[0].active ? '🔴 Заморозить' : '🟢 Восстановить', c[0].active ? `suspend_${c[0].id}` : `resume_${c[0].id}`)],
            [Markup.button.callback('◀️ К списку', 'companies')],
          ]) }
        );
      }
      return;
    }

    // Подключение компании
    if (state.action === 'awaiting_provision') {
      const parts = ctx.message.text.trim().split(' ');
      if (parts.length < 3) {
        return ctx.reply('❌ Неверный формат. Нужно: `НазваниеКомпании ТОКЕН TELEGRAM_ID`', { parse_mode: 'Markdown' });
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

      const botLink = `https://t.me/${botInfo.username}`;

      await ctx.reply(
        `✅ *Компания подключена!*\n\n` +
        `🏢 Название: *${companyName}*\n` +
        `🤖 Бот: @${botInfo.username}\n` +
        `👤 Админ ID: \`${adminTelegramId}\`\n` +
        `🆔 Company ID: ${company.id}\n\n` +
        `📲 *Отправь заказчику эту ссылку:*\n${botLink}`,
        { parse_mode: 'Markdown', ...mainMenuKeyboard() }
      );
      return;
    }
  });

  // ── Глобальный обработчик ошибок ─────────────────────────────────────────
  bot.catch((err, ctx) => {
    console.error(`[Master Bot] Ошибка в ${ctx.updateType}:`, err.message);
    try {
      if (ctx.callbackQuery) {
        ctx.answerCbQuery('❌ Ошибка').catch(() => {});
        ctx.reply(`❌ Ошибка: ${err.message}`).catch(() => {});
      } else {
        ctx.reply(`❌ Ошибка: ${err.message}`).catch(() => {});
      }
    } catch {}
  });

  // ── Уведомление о новой заявке с лендинга ────────────────────────────────
  bot.notifyNewLead = async (lead) => {
    const text =
      `🆕 *Новая заявка с лендинга*\n\n` +
      `👤 *Имя:* ${lead.name}\n` +
      `🏢 *Компания:* ${lead.company}\n` +
      `📱 *Telegram:* ${lead.telegram}\n` +
      (lead.employees ? `👥 *Сотрудников:* ${lead.employees}\n` : '') +
      (lead.comment ? `💬 *Комментарий:* ${lead.comment}\n` : '');

    for (const adminId of MASTER_ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(adminId, text, { parse_mode: 'Markdown' });
      } catch {}
    }
  };

  console.log('✅ Мастер-бот зарегистрирован');
  return bot;
}

module.exports = { registerMasterBot, setRegisterFn };
