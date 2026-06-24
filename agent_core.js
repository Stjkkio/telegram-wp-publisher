'use strict';

require('dotenv').config();

const axios    = require('axios');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const FormData = require('form-data');
const winston  = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'logs/agent.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

const HTTP_TIMEOUT = parseInt(process.env.HTTP_TIMEOUT_MS || '30000', 10);
const MAX_RETRIES  = parseInt(process.env.MAX_RETRIES || '3', 10);

// ─── AI prompt ────────────────────────────────────────────────────────────────

const AI_PROMPT = `You are a professional Italian editor. You receive raw text written by the author.

Task:
1. Correct grammatical and punctuation errors while maintaining EXACTLY the style, tone and voice of the author
2. Generate an SEO-friendly title in Italian (max 60 characters)
3. Generate a URL-friendly slug in Italian (lowercase letters, numbers, and hyphens only, max 60 characters)
4. Generate a meta description in Italian (max 160 characters)
5. Translate title, slug, meta description and entire text into English (British English)

Return JSON with this exact structure and no other text:
{
  "it": { "title": "", "slug": "", "meta_description": "", "content": "" },
  "en": { "title": "", "slug": "", "meta_description": "", "content": "" }
}
Do not include markdown code fences or any text outside the JSON object.

Author's text:
`;

// ─── AI call ──────────────────────────────────────────────────────────────────

async function callAI(text) {
  const provider = process.env.AI_PROVIDER;

  if (provider === 'openai') {
    const { OpenAI } = require('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model:       'gpt-4o',
      temperature: 0.2,
      max_tokens:  4096,
      messages:    [{ role: 'user', content: AI_PROMPT + text }],
    });
    return response.choices[0].message.content;
  }

  if (provider === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens:  4096,
      temperature: 0.2,
      messages:    [{ role: 'user', content: AI_PROMPT + text }],
    });
    return response.content[0].text;
  }

  throw new Error(`Unknown AI_PROVIDER: ${provider}`);
}

// ─── JSON extraction ──────────────────────────────────────────────────────────

function extractJson(raw) {
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first === -1 || last === -1) return null;
  try {
    return JSON.parse(raw.substring(first, last + 1));
  } catch {
    return null;
  }
}

// ─── Slug normalization ───────────────────────────────────────────────────────

const ACCENT_MAP = {
  à:'a', á:'a', â:'a', ã:'a', ä:'a', å:'a',
  è:'e', é:'e', ê:'e', ë:'e',
  ì:'i', í:'i', î:'i', ï:'i',
  ò:'o', ó:'o', ô:'o', õ:'o', ö:'o',
  ù:'u', ú:'u', û:'u', ü:'u',
  ý:'y', ÿ:'y', ñ:'n', ç:'c',
};

function normalizeSlug(slug) {
  let s = String(slug).toLowerCase();
  s = s.replace(/[àáâãäåèéêëìíîïòóôõöùúûüýÿñç]/g, c => ACCENT_MAP[c] || c);
  s = s.replace(/[\s_]+/g, '-');
  s = s.replace(/[^a-z0-9-]/g, '');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

function slugFromTitle(title) {
  return normalizeSlug(title);
}

// ─── AI response validation ───────────────────────────────────────────────────

function validateAiData(data) {
  if (!data || typeof data !== 'object') return 'Risposta AI non valida';
  if (!data.it || !data.en) return 'Struttura JSON mancante (it/en)';

  const checks = [
    ['it.title',            data.it.title,            60],
    ['en.title',            data.en.title,            80],
    ['it.slug',             data.it.slug,             60],
    ['en.slug',             data.en.slug,             60],
    ['it.meta_description', data.it.meta_description, 160],
    ['en.meta_description', data.en.meta_description, 160],
  ];

  for (const [field, value, maxLen] of checks) {
    if (!value || typeof value !== 'string' || value.trim() === '') return `Campo vuoto: ${field}`;
    if (value.length > maxLen) return `Campo troppo lungo: ${field} (max ${maxLen} caratteri)`;
  }

  if (!data.it.content || data.it.content.trim() === '') return 'Campo vuoto: it.content';
  if (!data.en.content || data.en.content.trim() === '') return 'Campo vuoto: en.content';

  if (data.en.content.length < data.it.content.length * 0.3) {
    return 'en.content è implausibilmente corto rispetto a it.content';
  }

  return null;
}

// ─── Public: process text ─────────────────────────────────────────────────────

async function processText(text) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw    = await callAI(text);
      const parsed = extractJson(raw);

      if (!parsed) {
        return { success: false, error: 'La risposta AI non contiene JSON valido.' };
      }

      parsed.it.slug = normalizeSlug(parsed.it.slug || slugFromTitle(parsed.it.title || ''));
      parsed.en.slug = normalizeSlug(parsed.en.slug || slugFromTitle(parsed.en.title || ''));

      if (!parsed.it.slug) parsed.it.slug = 'articolo-' + Date.now();
      if (!parsed.en.slug) parsed.en.slug = 'article-'  + Date.now();

      const validationError = validateAiData(parsed);
      if (validationError) {
        return { success: false, error: `Validazione fallita: ${validationError}` };
      }

      return { success: true, data: parsed };

    } catch (err) {
      lastError = err;
      logger.warn('AI call failed', { attempt, error: err.message });
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }

  return { success: false, error: `Errore AI dopo ${MAX_RETRIES} tentativi: ${lastError.message}` };
}

// ─── AI chat ──────────────────────────────────────────────────────────────────

async function chatWithAI(history) {
  const provider = process.env.AI_PROVIDER;

  if (provider === 'openai') {
    const { OpenAI } = require('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model:       'gpt-4o',
      temperature: 0.5,
      max_tokens:  2048,
      messages:    history,
    });
    return response.choices[0].message.content;
  }

  if (provider === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const systemMsg = history[0]?.role === 'user' ? history[0].content : '';
    const msgs      = history.slice(systemMsg ? 1 : 0);
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens:  2048,
      system:     systemMsg,
      messages:   msgs,
    });
    return response.content[0].text;
  }

  throw new Error(`Unknown AI_PROVIDER: ${provider}`);
}

async function applyEditsFromChat(originalContent, history) {
  const conversationSummary = history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Autore' : 'AI'}: ${m.content}`)
    .join('\n\n');

  const prompt = `Hai discusso modifiche a questo articolo italiano con l'autore.

TESTO ORIGINALE:
${originalContent}

CONVERSAZIONE:
${conversationSummary}

Ora produci il testo italiano finale incorporando tutte le modifiche discusse. Mantieni lo stile e la voce dell'autore. Restituisci SOLO il testo finale, senza commenti, intestazioni o spiegazioni.`;

  const provider = process.env.AI_PROVIDER;

  if (provider === 'openai') {
    const { OpenAI } = require('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model:       'gpt-4o',
      temperature: 0.3,
      max_tokens:  4096,
      messages:    [{ role: 'user', content: prompt }],
    });
    return response.choices[0].message.content.trim();
  }

  if (provider === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens:  4096,
      messages:    [{ role: 'user', content: prompt }],
    });
    return response.content[0].text.trim();
  }

  throw new Error(`Unknown AI_PROVIDER: ${provider}`);
}

// ─── WordPress HMAC helpers ───────────────────────────────────────────────────

function buildJsonHeaders(method, urlPath, bodyStr) {
  const timestamp  = Math.floor(Date.now() / 1000).toString();
  const requestId  = crypto.randomUUID();
  const bodyHash   = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const canonical  = `${method}\n${urlPath}\n${timestamp}\n${bodyHash}`;
  const signature  = crypto.createHmac('sha256', process.env.HMAC_SECRET).update(canonical).digest('hex');
  const wpAuth     = Buffer.from(`${process.env.WP_USER}:${process.env.WP_AUTH_KEY}`).toString('base64');

  // Some hosting providers place HTTP Basic Auth in front of WordPress at the
  // server level (separate from WP Application Passwords). When WP_SERVER_HTTP_USER
  // and WP_SERVER_HTTP_PASS are set, the server-level credentials go into the
  // standard Authorization header and the WP Application Password goes into the
  // custom X-Bot-Credential header, which the plugin reads and uses for WP auth.
  const serverUser = process.env.WP_SERVER_HTTP_USER;
  const serverPass = process.env.WP_SERVER_HTTP_PASS;
  const hasServerAuth = serverUser && serverPass;
  const serverAuth = hasServerAuth
    ? Buffer.from(`${serverUser}:${serverPass}`).toString('base64')
    : null;

  return {
    'Authorization':          `Basic ${hasServerAuth ? serverAuth : wpAuth}`,
    ...(hasServerAuth && { 'X-Bot-Credential': `Basic ${wpAuth}` }),
    'X-TGWP-Timestamp':       timestamp,
    'X-TGWP-Signature':       signature,
    'X-TGWP-Request-Id':      requestId,
    'Content-Type':           'application/json',
  };
}

function buildMultipartHeaders(urlPath, fileBuffer) {
  const timestamp  = Math.floor(Date.now() / 1000).toString();
  const requestId  = crypto.randomUUID();
  const bodyHash   = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const canonical  = `POST\n${urlPath}\n${timestamp}\n${bodyHash}`;
  const signature  = crypto.createHmac('sha256', process.env.HMAC_SECRET).update(canonical).digest('hex');
  const wpAuth     = Buffer.from(`${process.env.WP_USER}:${process.env.WP_AUTH_KEY}`).toString('base64');
  const serverUser = process.env.WP_SERVER_HTTP_USER;
  const serverPass = process.env.WP_SERVER_HTTP_PASS;
  const hasServerAuth = serverUser && serverPass;
  const serverAuth = hasServerAuth
    ? Buffer.from(`${serverUser}:${serverPass}`).toString('base64')
    : null;

  return {
    'Authorization':     `Basic ${hasServerAuth ? serverAuth : wpAuth}`,
    ...(hasServerAuth && { 'X-Bot-Credential': `Basic ${wpAuth}` }),
    'X-TGWP-Timestamp':  timestamp,
    'X-TGWP-Signature':  signature,
    'X-TGWP-Request-Id': requestId,
  };
}

// ─── WordPress JSON request ───────────────────────────────────────────────────

async function wpRequest(method, endpoint, body = null) {
  const base    = process.env.WP_URL.replace(/\/$/, '');
  const urlPath = `/wp-json/tgwp/v1${endpoint}`;
  const url     = base + urlPath;
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = buildJsonHeaders(method, urlPath, bodyStr);

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios({
        method,
        url,
        headers,
        data:    body || undefined,
        timeout: HTTP_TIMEOUT,
      });
      return response.data;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (status === 401 || status === 403) throw err;
      logger.warn('WP request failed', { attempt, endpoint, error: err.message });
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

// ─── WordPress health check ───────────────────────────────────────────────────

async function wpHealthCheck() {
  try {
    await wpRequest('GET', '/health');
    return true;
  } catch {
    return false;
  }
}

// ─── WordPress media upload ───────────────────────────────────────────────────

async function uploadMedia(localPath) {
  const base       = process.env.WP_URL.replace(/\/$/, '');
  const urlPath    = '/wp-json/tgwp/v1/media';
  const url        = base + urlPath;
  const fileBuffer = fs.readFileSync(localPath);
  const hmacHdrs   = buildMultipartHeaders(urlPath, fileBuffer);

  const form = new FormData();
  form.append('file', fs.createReadStream(localPath), {
    filename:    path.basename(localPath),
    contentType: 'image/jpeg',
  });

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(url, form, {
        headers: { ...form.getHeaders(), ...hmacHdrs },
        timeout: HTTP_TIMEOUT,
      });
      return response.data;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (status === 401 || status === 403) throw err;
      logger.warn('Media upload failed', { attempt, localPath, error: err.message });
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

// ─── Idempotency ──────────────────────────────────────────────────────────────

function computeIdempotencyKey(chatId, sessionId, sourceText) {
  const textHash = crypto.createHash('sha256').update(sourceText.trim().toLowerCase()).digest('hex');
  return crypto.createHash('sha256').update(`${chatId}:${sessionId}:${textHash}`).digest('hex');
}

function checkIdempotency(db, key) {
  return db.prepare('SELECT id FROM idempotency_keys WHERE idem_key = ?').get(key);
}

function storeIdempotencyKey(db, sessionId, key) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO idempotency_keys (session_id, idem_key, created_at) VALUES (?, ?, ?)').run(sessionId, key, now);
}

// ─── Public: publish pipeline ─────────────────────────────────────────────────

async function publish({ sessionId, chatId, aiData, sourceText, images, db, postStatus, authorId }) {
  const status = postStatus || process.env.DEFAULT_POST_STATUS;

  // 1. Idempotency check
  const idemKey = computeIdempotencyKey(chatId, sessionId, sourceText);
  if (checkIdempotency(db, idemKey)) {
    return { success: false, error: 'Questo contenuto è già stato pubblicato.' };
  }

  // 2. WordPress health check
  const healthy = await wpHealthCheck();
  if (!healthy) {
    return { success: false, error: 'WordPress non è raggiungibile. Riprova più tardi.' };
  }

  // 3. Upload images
  const uploadedMedia = [];
  for (const img of images) {
    try {
      const result = await uploadMedia(img.local_path);
      uploadedMedia.push(result);
      logger.info('Image uploaded', { sessionId, mediaId: result.id });
    } catch (err) {
      logger.warn('Image upload failed, skipping', { sessionId, error: err.message });
    }
  }

  const featuredImageId    = uploadedMedia.length > 0 ? uploadedMedia[0].id : null;
  const additionalMediaIds = uploadedMedia.slice(1).map(m => m.id);

  // 4. Create Italian post
  let itPostId, itUrl;
  try {
    const itResult = await wpRequest('POST', '/posts', {
      lang:                 'it',
      title:                aiData.it.title,
      slug:                 aiData.it.slug,
      content:              aiData.it.content,
      meta_description:     aiData.it.meta_description,
      status,
      featured_image_id:    featuredImageId,
      additional_media_ids: additionalMediaIds,
      ...(authorId ? { author_id: authorId } : {}),
    });
    itPostId = itResult.id;
    itUrl    = itResult.url;
    logger.info('IT post created', { sessionId, postId: itPostId, slug: itResult.slug_final });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) return { success: false, error: 'Credenziali WordPress non valide (401).' };
    if (status === 403) return { success: false, error: 'Errore firma HMAC o permessi insufficienti (403).' };
    return { success: false, error: `Errore creazione post IT: ${err.response?.data?.message || err.message}` };
  }

  // 5. Create English post
  let enPostId, enUrl;
  try {
    const enResult = await wpRequest('POST', '/posts', {
      lang:                 'en',
      title:                aiData.en.title,
      slug:                 aiData.en.slug,
      content:              aiData.en.content,
      meta_description:     aiData.en.meta_description,
      status,
      featured_image_id:    featuredImageId,
      additional_media_ids: additionalMediaIds,
      ...(authorId ? { author_id: authorId } : {}),
    });
    enPostId = enResult.id;
    enUrl    = enResult.url;
    logger.info('EN post created', { sessionId, postId: enPostId, slug: enResult.slug_final });
  } catch (err) {
    // Cleanup: delete the Italian post to avoid orphan content
    logger.warn('EN post failed, deleting IT post', { sessionId, itPostId });
    try {
      await wpRequest('DELETE', `/posts/${itPostId}`);
      logger.info('IT post deleted after EN failure', { sessionId, itPostId });
    } catch (cleanupErr) {
      logger.error('Cleanup failed: could not delete IT post', { sessionId, itPostId, error: cleanupErr.message });
    }

    const httpStatus = err.response?.status;
    if (httpStatus === 401) return { success: false, error: 'Credenziali WordPress non valide (401).' };
    if (httpStatus === 403) return { success: false, error: 'Errore firma HMAC o permessi (403). Post IT eliminato.' };
    return { success: false, error: `Errore creazione post EN (post IT eliminato): ${err.response?.data?.message || err.message}` };
  }

  // 6. WPML linking (non-fatal)
  let wpmlWarning = null;
  try {
    await wpRequest('POST', '/wpml/link', { it_post_id: itPostId, en_post_id: enPostId });
    logger.info('WPML link created', { sessionId, itPostId, enPostId });
  } catch (err) {
    wpmlWarning = 'Attenzione: collegamento WPML non riuscito. I post esistono ma non sono collegati come traduzioni.';
    logger.warn('WPML linking failed', { sessionId, error: err.message });
  }

  // 7. Store idempotency key
  storeIdempotencyKey(db, sessionId, idemKey);

  return { success: true, itUrl, enUrl, itPostId, enPostId, wpmlWarning };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { processText, publish, chatWithAI, applyEditsFromChat, normalizeSlug };
