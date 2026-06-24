'use strict';

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const Database    = require('better-sqlite3');
const winston     = require('winston');
const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');
const axios       = require('axios');
const agentCore   = require('./agent_core');

// ─── Logger ───────────────────────────────────────────────────────────────────

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'logs/bot.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// ─── Startup validation ───────────────────────────────────────────────────────

function validateEnv() {
  const required = [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
    'WP_URL', 'WP_USER', 'WP_AUTH_KEY', 'HMAC_SECRET',
    'AI_PROVIDER', 'NODE_ENV', 'DEFAULT_POST_STATUS',
    'SESSION_TIMEOUT_SECONDS', 'HTTP_TIMEOUT_MS', 'MAX_RETRIES',
    'MAX_IMAGES_PER_SESSION', 'MAX_IMAGE_SIZE_MB',
  ];

  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Variabile d'ambiente mancante: ${key}`);
      process.exit(1);
    }
  }

  if (!process.env.WP_URL.startsWith('https://')) {
    logger.error('WP_URL deve usare https://');
    process.exit(1);
  }

  const env    = process.env.NODE_ENV;
  const status = process.env.DEFAULT_POST_STATUS;

  if (env === 'staging' && status !== 'draft') {
    logger.error('NODE_ENV=staging richiede DEFAULT_POST_STATUS=draft');
    process.exit(1);
  }

  if (env === 'production' && status !== 'publish') {
    logger.error('NODE_ENV=production richiede DEFAULT_POST_STATUS=publish');
    process.exit(1);
  }

  if (env === 'staging') {
    const url = process.env.WP_URL.toLowerCase();
    const looksLikeStaging = ['staging', 'test', 'dev', 'local'].some(kw => url.includes(kw));
    if (!looksLikeStaging) {
      logger.error('SICUREZZA: NODE_ENV=staging ma WP_URL non contiene "staging", "test", "dev" o "local".');
      process.exit(1);
    }
  }

  const provider = process.env.AI_PROVIDER;
  if (provider !== 'openai' && provider !== 'anthropic') {
    logger.error('AI_PROVIDER deve essere "openai" o "anthropic"');
    process.exit(1);
  }

  if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
    logger.error('AI_PROVIDER=openai richiede OPENAI_API_KEY');
    process.exit(1);
  }

  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    logger.error('AI_PROVIDER=anthropic richiede ANTHROPIC_API_KEY');
    process.exit(1);
  }

  if (process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY) {
    logger.error('Entrambe OPENAI_API_KEY e ANTHROPIC_API_KEY sono impostate. Solo un provider alla volta.');
    process.exit(1);
  }

  const intVars = ['SESSION_TIMEOUT_SECONDS', 'HTTP_TIMEOUT_MS', 'MAX_RETRIES', 'MAX_IMAGES_PER_SESSION', 'MAX_IMAGE_SIZE_MB'];
  for (const key of intVars) {
    const val = parseInt(process.env[key], 10);
    if (!Number.isInteger(val) || val <= 0) {
      logger.error(`${key} deve essere un intero positivo`);
      process.exit(1);
    }
  }

  for (const dir of ['storage', 'logs', 'images']) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  logger.info('Validazione avvio OK', {
    env:        process.env.NODE_ENV,
    wpUrl:      process.env.WP_URL,
    postStatus: process.env.DEFAULT_POST_STATUS,
    aiProvider: process.env.AI_PROVIDER,
  });
}

// ─── SQLite ───────────────────────────────────────────────────────────────────

let db;

function initDb() {
  db = new Database('storage/sessions.db');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL,
      source_text     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      media_group_id  TEXT,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      preview_payload TEXT,
      processed_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_images (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      telegram_file_id TEXT NOT NULL,
      local_path       TEXT,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      idem_key   TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_session_images_session_sort ON session_images(session_id, sort_order);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_session ON idempotency_keys(session_id);
  `);

  logger.info('Database SQLite inizializzato');
}

// ─── Session helpers ──────────────────────────────────────────────────────────

const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT_SECONDS || '300', 10);
const MAX_IMAGES      = parseInt(process.env.MAX_IMAGES_PER_SESSION  || '10',  10);
const MAX_IMAGE_MB    = parseInt(process.env.MAX_IMAGE_SIZE_MB        || '15',  10);

// Image window debounce: wait this many seconds after the last image before
// triggering AI processing. Increased from 5s to 30s so the user has time
// to select and send a photo album (TC-20 fix).
const IMAGE_DEBOUNCE_MS = parseInt(process.env.IMAGE_WAIT_SECONDS || '30', 10) * 1000;

function createSession(chatId, text, mediaGroupId) {
  const now       = Math.floor(Date.now() / 1000);
  const id        = crypto.randomUUID();
  const expiresAt = now + SESSION_TIMEOUT;

  db.prepare(`
    INSERT INTO sessions (id, chat_id, source_text, status, media_group_id, created_at, expires_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
  `).run(id, chatId, text, mediaGroupId || null, now, expiresAt);

  logger.info('Sessione creata', { sessionId: id, chatId });
  return id;
}

function getSession(sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

function getSessionImages(sessionId) {
  return db.prepare('SELECT * FROM session_images WHERE session_id = ? ORDER BY sort_order ASC').all(sessionId);
}

function countSessionImages(sessionId) {
  return db.prepare('SELECT COUNT(*) as n FROM session_images WHERE session_id = ?').get(sessionId).n;
}

function addImageToSession(sessionId, telegramFileId, sortOrder) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO session_images (session_id, telegram_file_id, sort_order, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, telegramFileId, sortOrder, now);
}

function setSessionPreview(sessionId, payload) {
  db.prepare('UPDATE sessions SET preview_payload = ? WHERE id = ?').run(JSON.stringify(payload), sessionId);
}

function updatePreviewField(sessionId, lang, field, value) {
  const session = getSession(sessionId);
  if (!session || !session.preview_payload) return;
  const data = JSON.parse(session.preview_payload);
  data[lang][field] = value;
  db.prepare('UPDATE sessions SET preview_payload = ? WHERE id = ?').run(JSON.stringify(data), sessionId);
}

function setSessionStatus(sessionId, status) {
  db.prepare('UPDATE sessions SET status = ?, processed_at = ? WHERE id = ?')
    .run(status, Math.floor(Date.now() / 1000), sessionId);
}

function expireStaleSessions() {
  const now   = Math.floor(Date.now() / 1000);
  const stale = db.prepare("SELECT id FROM sessions WHERE status = 'pending' AND expires_at < ?").all(now);
  for (const row of stale) {
    db.prepare("UPDATE sessions SET status = 'expired' WHERE id = ?").run(row.id);
    logger.info('Sessione scaduta', { sessionId: row.id });
  }
}

// ─── Author config ────────────────────────────────────────────────────────────
// WP_AUTHORS=Nome:5,Redazione:3  (name:wp_user_id pairs)

function parseAuthors() {
  if (!process.env.WP_AUTHORS) return [];
  return process.env.WP_AUTHORS.split(',').map(pair => {
    const [name, id] = pair.split(':');
    return { name: (name || '').trim(), id: parseInt((id || '0').trim(), 10) };
  }).filter(a => a.name && a.id > 0);
}

const DEFINED_AUTHORS = parseAuthors();

// ─── Per-session transient state (lost on restart — acceptable for preview state) ──

// sessionMeta: sessionId → { status: 'draft'|'publish', authorId: int|null }
const sessionMeta = new Map();

function getSessionMeta(sessionId) {
  if (!sessionMeta.has(sessionId)) {
    sessionMeta.set(sessionId, {
      status:   process.env.DEFAULT_POST_STATUS,
      authorId: DEFINED_AUTHORS[0]?.id || null,
    });
  }
  return sessionMeta.get(sessionId);
}

// ─── Per-chat edit/chat state ─────────────────────────────────────────────────
// chatEditState: chatId → { mode: 'editing_field'|'ai_chat', sessionId, fieldKey?, history? }

const chatEditState = new Map();

// Field definitions (short keys to stay within Telegram's 64-char callback_data limit)
const FIELD_DEFS = {
  itc: { lang: 'it', key: 'content',          label: 'Testo IT',   maxLen: null,  isSlug: false },
  itt: { lang: 'it', key: 'title',             label: 'Titolo IT',  maxLen: 60,    isSlug: false },
  its: { lang: 'it', key: 'slug',              label: 'Slug IT',    maxLen: 60,    isSlug: true  },
  itm: { lang: 'it', key: 'meta_description',  label: 'Meta IT',    maxLen: 160,   isSlug: false },
  ent: { lang: 'en', key: 'title',             label: 'Titolo EN',  maxLen: 80,    isSlug: false },
  ens: { lang: 'en', key: 'slug',              label: 'Slug EN',    maxLen: 60,    isSlug: true  },
  enm: { lang: 'en', key: 'meta_description',  label: 'Meta EN',    maxLen: 160,   isSlug: false },
  enc: { lang: 'en', key: 'content',           label: 'Testo EN',   maxLen: null,  isSlug: false },
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

validateEnv();
initDb();

const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID);
const bot     = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

setInterval(expireStaleSessions, 60_000);

logger.info('Bot avviato, polling in ascolto...');

// ─── Auth guard ───────────────────────────────────────────────────────────────

function isAuthorized(chatId) {
  return String(chatId) === CHAT_ID;
}

// ─── Image window: chatId → { sessionId, imageCount, timer } ─────────────────

const imageWindow = new Map();

function openImageWindow(chatId, sessionId) {
  if (imageWindow.has(chatId)) clearTimeout(imageWindow.get(chatId).timer);
  const timer = setTimeout(() => {
    imageWindow.delete(chatId);
    triggerProcessing(sessionId, chatId);
  }, IMAGE_DEBOUNCE_MS);
  imageWindow.set(chatId, { sessionId, imageCount: 0, timer });
}

function refreshImageWindow(chatId) {
  const win = imageWindow.get(chatId);
  if (!win) return;
  clearTimeout(win.timer);
  win.timer = setTimeout(() => {
    imageWindow.delete(chatId);
    triggerProcessing(win.sessionId, chatId);
  }, IMAGE_DEBOUNCE_MS);
}

// ─── Message handler ──────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;

  const chatId = String(msg.chat.id);

  // ── Check edit/chat state first ──────────────────────────────────────────
  const editState = chatEditState.get(chatId);

  if (editState?.mode === 'editing_field') {
    const text = msg.text || msg.caption;
    if (!text) return;
    await handleFieldInput(chatId, text, editState);
    return;
  }

  if (editState?.mode === 'ai_chat') {
    const text = msg.text || msg.caption;
    if (!text) return;
    if (text.trim() === '/fine') {
      await finalizeAiChat(chatId, editState);
    } else {
      await handleAiChatMessage(chatId, text, editState);
    }
    return;
  }

  // ── Normal flow ──────────────────────────────────────────────────────────
  if (msg.photo && !msg.caption) return; // handled by photo handler

  const text = msg.text || msg.caption;
  if (!text) return;

  if (imageWindow.has(chatId)) {
    const old = imageWindow.get(chatId);
    clearTimeout(old.timer);
    imageWindow.delete(chatId);
    setSessionStatus(old.sessionId, 'cancelled');
    await bot.sendMessage(chatId, 'Sessione precedente annullata: nuovo testo ricevuto.');
  }

  const mediaGroupId = msg.media_group_id || null;
  const sessionId    = createSession(chatId, text, mediaGroupId);

  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    addImageToSession(sessionId, photo.file_id, 0);
    openImageWindow(chatId, sessionId);
    imageWindow.get(chatId).imageCount = 1;
    await bot.sendMessage(chatId, `Testo e immagine ricevuti. Puoi inviare altre immagini (attendo ${IMAGE_DEBOUNCE_MS / 1000}s dall\'ultima).`);
  } else {
    openImageWindow(chatId, sessionId);
    await bot.sendMessage(chatId, `Testo ricevuto. Puoi inviare immagini ora (attendo ${IMAGE_DEBOUNCE_MS / 1000}s dall\'ultima prima di elaborare).`);
  }
});

// ─── Photo handler ────────────────────────────────────────────────────────────

bot.on('photo', async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  if (msg.caption) return; // handled by message handler

  const chatId = String(msg.chat.id);

  if (!imageWindow.has(chatId)) {
    await bot.sendMessage(chatId, 'Nessun testo attivo. Invia prima il testo dell\'articolo.');
    return;
  }

  const win       = imageWindow.get(chatId);
  const sessionId = win.sessionId;
  const photo     = msg.photo[msg.photo.length - 1];

  if (win.imageCount >= MAX_IMAGES) {
    await bot.sendMessage(chatId, `Limite massimo di ${MAX_IMAGES} immagini raggiunto. Immagine ignorata.`);
    return;
  }

  if (photo.file_size && photo.file_size > MAX_IMAGE_MB * 1024 * 1024) {
    await bot.sendMessage(chatId, `Immagine troppo grande (max ${MAX_IMAGE_MB} MB). Ignorata.`);
    return;
  }

  addImageToSession(sessionId, photo.file_id, win.imageCount);
  win.imageCount++;
  refreshImageWindow(chatId);
});

// ─── AI processing trigger ────────────────────────────────────────────────────

async function triggerProcessing(sessionId, chatId) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'pending') return;

  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at < now) {
    setSessionStatus(sessionId, 'expired');
    await bot.sendMessage(chatId, 'La sessione è scaduta. Invia di nuovo il testo.');
    return;
  }

  const images = getSessionImages(sessionId);
  await bot.sendMessage(chatId, `⏳ Elaborazione AI in corso (${images.length} immagine/i)...`);

  try {
    const result = await agentCore.processText(session.source_text);

    if (!result.success) {
      await bot.sendMessage(chatId, `❌ Errore AI: ${result.error}`);
      return;
    }

    setSessionPreview(sessionId, result.data);

    // Init session meta with defaults
    getSessionMeta(sessionId);

    await sendPreview(chatId, sessionId, result.data, images.length);

  } catch (err) {
    logger.error('Errore elaborazione AI', { sessionId, error: err.message });
    await bot.sendMessage(chatId, '❌ Errore imprevisto durante l\'elaborazione. Riprova.');
  }
}

// ─── Preview builder ──────────────────────────────────────────────────────────

function buildPreviewText(data, imageCount, meta) {
  const words     = data.it.content.split(/\s+/);
  const preview   = words.slice(0, 100).join(' ');
  const truncated = words.length > 100 ? '...' : '';

  const statusLabel  = meta.status === 'publish' ? '🟢 Pubblica' : '📋 Bozza';
  const authorName   = DEFINED_AUTHORS.find(a => a.id === meta.authorId)?.name;
  const authorLine   = authorName ? `\n<b>👤 Firma:</b> ${esc(authorName)}` : '';

  return [
    '<b>📝 ANTEPRIMA POST</b>',
    '',
    `<b>🇮🇹 Titolo IT:</b> ${esc(data.it.title)}`,
    `<b>🔗 Slug IT:</b> ${esc(data.it.slug)}`,
    `<b>📋 Meta IT:</b> ${esc(data.it.meta_description)}`,
    '',
    `<b>🇬🇧 Titolo EN:</b> ${esc(data.en.title)}`,
    `<b>🔗 Slug EN:</b> ${esc(data.en.slug)}`,
    `<b>📋 Meta EN:</b> ${esc(data.en.meta_description)}`,
    '',
    '<b>Anteprima testo (IT):</b>',
    esc(preview) + truncated,
    '',
    `<b>🖼️ Immagini allegate:</b> ${imageCount}`,
    `<b>Stato:</b> ${statusLabel}${authorLine}`,
    '',
    'Cosa vuoi fare?',
  ].join('\n');
}

function buildPreviewKeyboard(sessionId, meta) {
  const approveLabel = meta.status === 'publish' ? '✅ Pubblica ora' : '📋 Salva bozza';
  const toggleLabel  = meta.status === 'publish' ? '→ 📋 Salva come bozza' : '→ 🟢 Pubblica subito';

  const rows = [
    [
      { text: approveLabel,    callback_data: `approve:${sessionId}` },
      { text: '❌ Annulla',    callback_data: `cancel:${sessionId}`  },
    ],
    [
      { text: '✏️ Modifica',   callback_data: `edit:${sessionId}`    },
      { text: '💬 Chat AI',    callback_data: `ai_chat:${sessionId}` },
    ],
    [
      { text: toggleLabel,     callback_data: `toggle_status:${sessionId}` },
    ],
  ];

  // Author selector: only if multiple authors are defined
  if (DEFINED_AUTHORS.length > 1) {
    const authorName = DEFINED_AUTHORS.find(a => a.id === meta.authorId)?.name || '?';
    rows[2].push({ text: `👤 ${authorName} ▾`, callback_data: `author:${sessionId}` });
  }

  return { inline_keyboard: rows };
}

async function sendPreview(chatId, sessionId, data, imageCount) {
  const meta    = getSessionMeta(sessionId);
  const text    = buildPreviewText(data, imageCount, meta);
  const keyboard = buildPreviewKeyboard(sessionId, meta);

  await bot.sendMessage(chatId, text, {
    parse_mode:   'HTML',
    reply_markup: keyboard,
  });
}

// ─── Edit sub-menu ────────────────────────────────────────────────────────────

async function sendEditMenu(chatId, sessionId) {
  await bot.sendMessage(chatId, 'Quale campo vuoi modificare?', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Testo IT',   callback_data: `ef:${sessionId}:itc` },
          { text: '🇮🇹 Titolo IT', callback_data: `ef:${sessionId}:itt` },
        ],
        [
          { text: '🔗 Slug IT',    callback_data: `ef:${sessionId}:its` },
          { text: '📋 Meta IT',    callback_data: `ef:${sessionId}:itm` },
        ],
        [
          { text: '🇬🇧 Titolo EN', callback_data: `ef:${sessionId}:ent` },
          { text: '🔗 Slug EN',    callback_data: `ef:${sessionId}:ens` },
        ],
        [
          { text: '📋 Meta EN',    callback_data: `ef:${sessionId}:enm` },
          { text: '📝 Testo EN',   callback_data: `ef:${sessionId}:enc` },
        ],
        [
          { text: '↩️ Indietro',   callback_data: `back:${sessionId}`   },
        ],
      ],
    },
  });
}

// ─── Author selection menu ────────────────────────────────────────────────────

async function sendAuthorMenu(chatId, sessionId) {
  const rows = DEFINED_AUTHORS.map(a => [{
    text:          `👤 ${a.name}`,
    callback_data: `sa:${sessionId}:${a.id}`,
  }]);
  rows.push([{ text: '↩️ Indietro', callback_data: `back:${sessionId}` }]);

  await bot.sendMessage(chatId, 'Seleziona la firma per questo articolo:', {
    reply_markup: { inline_keyboard: rows },
  });
}

// ─── Handle field input ───────────────────────────────────────────────────────

async function handleFieldInput(chatId, value, editState) {
  const { sessionId, fieldKey } = editState;
  const def = FIELD_DEFS[fieldKey];

  chatEditState.delete(chatId);

  const session = getSession(sessionId);
  if (!session || session.status !== 'pending') {
    await bot.sendMessage(chatId, 'Sessione non più attiva.');
    return;
  }

  let finalValue = value.trim();

  // Slug normalization
  if (def.isSlug) {
    finalValue = agentCore.normalizeSlug(finalValue);
    if (!finalValue) {
      await bot.sendMessage(chatId, '❌ Slug non valido dopo normalizzazione. Riprova.');
      return;
    }
  }

  // Length check
  if (def.maxLen && finalValue.length > def.maxLen) {
    await bot.sendMessage(chatId, `❌ Testo troppo lungo per "${def.label}" (max ${def.maxLen} caratteri, ricevuti ${finalValue.length}).`);
    return;
  }

  if (!finalValue) {
    await bot.sendMessage(chatId, `❌ Il campo non può essere vuoto.`);
    return;
  }

  updatePreviewField(sessionId, def.lang, def.key, finalValue);

  await bot.sendMessage(chatId, `✅ <b>${esc(def.label)}</b> aggiornato.`, { parse_mode: 'HTML' });

  const updatedSession = getSession(sessionId);
  const images         = getSessionImages(sessionId);
  const data           = JSON.parse(updatedSession.preview_payload);
  await sendPreview(chatId, sessionId, data, images.length);
}

// ─── AI chat ──────────────────────────────────────────────────────────────────

async function handleAiChatMessage(chatId, userMessage, editState) {
  const { sessionId, history } = editState;

  history.push({ role: 'user', content: userMessage });

  try {
    const reply = await agentCore.chatWithAI(history);
    history.push({ role: 'assistant', content: reply });
    chatEditState.set(chatId, { ...editState, history });
    await bot.sendMessage(chatId, reply + '\n\n<i>(Scrivi /fine per applicare le modifiche e rigenerare la preview)</i>', { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Errore AI chat', { sessionId, error: err.message });
    await bot.sendMessage(chatId, '❌ Errore durante la chat AI. Riprova.');
  }
}

async function finalizeAiChat(chatId, editState) {
  const { sessionId, history, originalContent } = editState;
  chatEditState.delete(chatId);

  const session = getSession(sessionId);
  if (!session || session.status !== 'pending') {
    await bot.sendMessage(chatId, 'Sessione non più attiva.');
    return;
  }

  await bot.sendMessage(chatId, '⏳ Applico le modifiche discusse e rigenero la preview...');

  try {
    // Ask AI to produce the final revised text incorporating all discussed changes
    const revisedText = await agentCore.applyEditsFromChat(originalContent, history);

    // Update source text and reprocess
    db.prepare('UPDATE sessions SET source_text = ? WHERE id = ?').run(revisedText, sessionId);

    const result = await agentCore.processText(revisedText);
    if (!result.success) {
      await bot.sendMessage(chatId, `❌ Errore rigenerazione AI: ${result.error}`);
      return;
    }

    setSessionPreview(sessionId, result.data);

    const images = getSessionImages(sessionId);
    await sendPreview(chatId, sessionId, result.data, images.length);

  } catch (err) {
    logger.error('Errore finalizeAiChat', { sessionId, error: err.message });
    await bot.sendMessage(chatId, '❌ Errore imprevisto. Riprova.');
  }
}

// ─── Callback query handler ───────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  if (!isAuthorized(query.message.chat.id)) return;

  const chatId = String(query.message.chat.id);
  const parts  = query.data.split(':');
  const action = parts[0];

  await bot.answerCallbackQuery(query.id);

  // ── Actions that need session validation ──────────────────────────────────
  const actionsNeedingSession = ['approve', 'cancel', 'edit', 'ai_chat', 'toggle_status', 'author', 'back', 'ef', 'sa'];
  if (!actionsNeedingSession.includes(action)) return;

  const sessionId = parts[1];
  const session   = getSession(sessionId);

  if (!session) {
    await bot.sendMessage(chatId, 'Sessione non trovata.');
    return;
  }

  if (session.status !== 'pending') {
    await bot.sendMessage(chatId, 'Questa sessione è già stata processata o annullata.');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at < now) {
    setSessionStatus(sessionId, 'expired');
    await bot.sendMessage(chatId, 'La sessione è scaduta. Invia di nuovo il testo.');
    return;
  }

  // ── cancel ────────────────────────────────────────────────────────────────
  if (action === 'cancel') {
    setSessionStatus(sessionId, 'cancelled');
    chatEditState.delete(chatId);
    sessionMeta.delete(sessionId);
    await bot.sendMessage(chatId, '❌ Pubblicazione annullata. Nessun post è stato creato.');
    return;
  }

  // ── approve ───────────────────────────────────────────────────────────────
  if (action === 'approve') {
    setSessionStatus(sessionId, 'processing');
    await handleApproval(session, chatId);
    return;
  }

  // ── toggle_status ─────────────────────────────────────────────────────────
  if (action === 'toggle_status') {
    const meta      = getSessionMeta(sessionId);
    meta.status     = meta.status === 'publish' ? 'draft' : 'publish';
    const data      = JSON.parse(session.preview_payload);
    const images    = getSessionImages(sessionId);
    await sendPreview(chatId, sessionId, data, images.length);
    return;
  }

  // ── author menu ───────────────────────────────────────────────────────────
  if (action === 'author') {
    await sendAuthorMenu(chatId, sessionId);
    return;
  }

  // ── select author ─────────────────────────────────────────────────────────
  if (action === 'sa') {
    const authorId  = parseInt(parts[2], 10);
    const meta      = getSessionMeta(sessionId);
    if (DEFINED_AUTHORS.find(a => a.id === authorId)) {
      meta.authorId = authorId;
    }
    const data   = JSON.parse(session.preview_payload);
    const images = getSessionImages(sessionId);
    await sendPreview(chatId, sessionId, data, images.length);
    return;
  }

  // ── edit menu ─────────────────────────────────────────────────────────────
  if (action === 'edit') {
    await sendEditMenu(chatId, sessionId);
    return;
  }

  // ── back to preview ───────────────────────────────────────────────────────
  if (action === 'back') {
    chatEditState.delete(chatId);
    const data   = JSON.parse(session.preview_payload);
    const images = getSessionImages(sessionId);
    await sendPreview(chatId, sessionId, data, images.length);
    return;
  }

  // ── edit field selected ───────────────────────────────────────────────────
  if (action === 'ef') {
    const fieldKey = parts[2];
    const def      = FIELD_DEFS[fieldKey];
    if (!def) {
      await bot.sendMessage(chatId, 'Campo non riconosciuto.');
      return;
    }
    chatEditState.set(chatId, { mode: 'editing_field', sessionId, fieldKey });
    const hint = def.maxLen ? ` (max ${def.maxLen} caratteri)` : '';
    await bot.sendMessage(chatId, `✏️ Invia il nuovo valore per <b>${esc(def.label)}</b>${hint}:`, { parse_mode: 'HTML' });
    return;
  }

  // ── ai chat ───────────────────────────────────────────────────────────────
  if (action === 'ai_chat') {
    const data = JSON.parse(session.preview_payload);
    const systemContext = `Sei un assistente editoriale. Stai aiutando a rifinire questo articolo italiano:\n\n${data.it.content}\n\nPuoi discutere modifiche al testo, al tono, allo stile o ai contenuti. Quando l'utente scrive /fine, le modifiche discusse verranno applicate.`;

    chatEditState.set(chatId, {
      mode:            'ai_chat',
      sessionId,
      originalContent: data.it.content,
      history:         [{ role: 'user', content: systemContext }],
    });

    await bot.sendMessage(chatId,
      '💬 <b>Chat AI attiva.</b>\n\nDimmi cosa vorresti cambiare nel testo: tono, stile, contenuti, struttura. Quando sei soddisfatto scrivi <code>/fine</code> per applicare le modifiche e rigenerare la preview.',
      { parse_mode: 'HTML' }
    );
    return;
  }
});

// ─── Approval + publish ───────────────────────────────────────────────────────

async function handleApproval(session, chatId) {
  const sessionId   = session.id;
  const previewData = JSON.parse(session.preview_payload);
  const meta        = getSessionMeta(sessionId);
  const images      = getSessionImages(sessionId);

  await bot.sendMessage(chatId, '⏳ Pubblicazione in corso...');

  let localImages = [];
  try {
    localImages = await downloadImages(images, sessionId, chatId);

    const result = await agentCore.publish({
      sessionId,
      chatId,
      aiData:     previewData,
      sourceText: session.source_text,
      images:     localImages,
      db,
      postStatus: meta.status,
      authorId:   meta.authorId,
    });

    if (result.success) {
      setSessionStatus(sessionId, 'completed');
      sessionMeta.delete(sessionId);
      const statusLabel = meta.status === 'publish' ? 'Pubblicato' : 'Salvato in bozza';
      let msg = `✅ ${statusLabel} con successo!\n\n🇮🇹 Post italiano: ${result.itUrl}\n🇬🇧 Post inglese: ${result.enUrl}`;
      if (result.wpmlWarning) msg += `\n\n⚠️ ${result.wpmlWarning}`;
      await bot.sendMessage(chatId, msg);
    } else {
      setSessionStatus(sessionId, 'failed');
      await bot.sendMessage(chatId, `❌ Errore durante la pubblicazione:\n${result.error}`);
    }

  } catch (err) {
    logger.error('Errore imprevisto in handleApproval', { sessionId, error: err.message });
    setSessionStatus(sessionId, 'failed');
    await bot.sendMessage(chatId, `❌ Errore imprevisto: ${err.message}`);
  } finally {
    cleanupLocalImages(localImages);
  }
}

// ─── Image download ───────────────────────────────────────────────────────────

async function downloadImages(images, sessionId, chatId) {
  const localImages = [];

  for (const img of images) {
    try {
      const fileInfo  = await bot.getFile(img.telegram_file_id);
      const fileUrl   = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
      const localPath = path.join('images', `${sessionId}_${img.sort_order}.jpg`);

      const response = await axios({
        method:       'GET',
        url:          fileUrl,
        responseType: 'stream',
        timeout:      parseInt(process.env.HTTP_TIMEOUT_MS, 10),
      });

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(localPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      const stat = fs.statSync(localPath);
      if (stat.size > MAX_IMAGE_MB * 1024 * 1024) {
        fs.unlinkSync(localPath);
        logger.warn('Immagine troppo grande dopo download, ignorata', { sessionId });
        await bot.sendMessage(chatId, `⚠️ Un'immagine era troppo grande dopo il download ed è stata ignorata.`);
        continue;
      }

      db.prepare('UPDATE session_images SET local_path = ? WHERE id = ?').run(localPath, img.id);
      localImages.push({ ...img, local_path: localPath });

    } catch (err) {
      logger.warn('Download immagine fallito, ignorata', { sessionId, error: err.message });
      await bot.sendMessage(chatId, `⚠️ Un'immagine non è stata scaricata ed è stata ignorata.`);
    }
  }

  return localImages;
}

function cleanupLocalImages(images) {
  for (const img of images) {
    try {
      if (img.local_path && fs.existsSync(img.local_path)) fs.unlinkSync(img.local_path);
    } catch (err) {
      logger.warn('Cleanup immagine locale fallito', { path: img.local_path, error: err.message });
    }
  }
}

// ─── HTML escape ──────────────────────────────────────────────────────────────

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Polling error handler ────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
  logger.error('Errore polling Telegram', { error: err.message });
});
