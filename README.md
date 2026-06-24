# Telegram WP Publisher

A private Telegram bot that turns raw text into bilingual WordPress posts — corrected, SEO-optimised, and translated by AI — with explicit human approval before anything is published.

## What it does

1. You send raw Italian text (and optionally images) to your Telegram bot.
2. The bot calls OpenAI or Anthropic to:
   - correct grammar and style while preserving your voice
   - generate an SEO title, URL slug, and meta description in Italian
   - translate everything into British English
3. You receive a full preview on Telegram with inline buttons:
   - **✅ Publish now** or **📋 Save as draft**
   - **✏️ Edit** — modify any field (title, slug, meta, body) inline
   - **💬 Chat AI** — discuss changes with the AI before publishing
   - **👤 Author** — choose the post author (if configured)
   - **❌ Cancel**
4. On approval, the bot creates two linked WordPress posts (IT + EN), uploads images to the Media Library, sets the RankMath meta description, and links them via WPML.

Nothing is written to WordPress without your explicit confirmation.

## Features

- **AI-powered editorial pipeline** — GPT-4o or Claude, configurable
- **Bilingual by default** — Italian source, British English translation, WPML-linked
- **Inline editing** — modify any AI-generated field directly in Telegram before publishing
- **AI chat** — have a conversation with the AI to refine the article, then regenerate the preview
- **Per-session author selection** — choose the post author from a list defined in `.env`
- **Per-session publish/draft toggle** — decide at approval time, not at configuration time
- **HMAC-SHA256 on every WP request** — prevents unauthorised writes even if credentials leak
- **Replay protection** — requests outside a ±5 minute window are rejected
- **Idempotency** — duplicate submissions and repeated button presses never create duplicate posts
- **Session persistence** — pending sessions survive bot restarts (SQLite)
- **Automatic cleanup** — if the English post fails after the Italian is created, the Italian post is deleted
- **Staging-first enforcement** — startup refuses to run production config against a staging URL and vice versa
- **Safe logging** — secrets, auth headers, and article bodies are never written to log files

## Requirements

**Bot server**
- Node.js 18+
- A Telegram bot token (create one via [@BotFather](https://t.me/BotFather))
- An OpenAI or Anthropic API key

**WordPress**
- WordPress with HTTPS
- [WPML](https://wpml.org) configured for Italian and English
- [RankMath SEO](https://rankmath.com) active
- The `tgwp-publisher.php` plugin installed and activated
- `TGWP_HMAC_SECRET` defined in `wp-config.php`
- A dedicated WordPress user with the `TGWP Publisher` role and an Application Password

## Installation

### 1 — Bot server

```bash
git clone https://github.com/your-username/telegram-wp-publisher.git
cd telegram-wp-publisher

npm install

cp .env.example .env
chmod 600 .env
# Edit .env with your credentials
```

### 2 — WordPress plugin

Copy `wp-plugin/tgwp-publisher.php` to your WordPress installation:

```
wp-content/plugins/tgwp-publisher/tgwp-publisher.php
```

Activate it in WP Admin → Plugins.

### 3 — WordPress configuration

Add to `wp-config.php` (before the `/* That's all, stop editing! */` line):

```php
define( 'TGWP_HMAC_SECRET', 'your-long-random-secret-here' );
```

Use a different secret for staging and production. The value must match `HMAC_SECRET` in `.env`.

### 4 — WordPress user

1. Go to WP Admin → Users → Add New
2. Username: `tgwp_api_user` (or any name you prefer)
3. Role: `TGWP Publisher` (created by the plugin on activation)
4. Open the user profile → **Application Passwords** → add a new one named `bot`
5. Copy the generated password (shown only once) into `WP_AUTH_KEY` in `.env`
6. Set `WP_USER` in `.env` to the username you chose

### 5 — Run the bot

```bash
node bot_telegram.js
```

For production use, run it as a persistent service with [PM2](https://pm2.keymetrics.io):

```bash
npm install -g pm2
pm2 start bot_telegram.js --name tgwp-bot
pm2 save
pm2 startup
```

## Configuration

All configuration lives in `.env`. Copy `.env.example` and fill in your values.

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Token from BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Your Telegram user ID (the only authorised sender) |
| `AI_PROVIDER` | Yes | `openai` or `anthropic` |
| `OPENAI_API_KEY` | If provider=openai | OpenAI API key |
| `ANTHROPIC_API_KEY` | If provider=anthropic | Anthropic API key |
| `WP_URL` | Yes | WordPress URL, must use `https://` |
| `WP_USER` | Yes | WordPress API username |
| `WP_AUTH_KEY` | Yes | WordPress Application Password |
| `HMAC_SECRET` | Yes | Shared secret for request signing (min 32 chars) |
| `NODE_ENV` | Yes | `staging` or `production` |
| `DEFAULT_POST_STATUS` | Yes | `draft` (staging) or `publish` (production) |
| `WP_AUTHORS` | No | `Name:WP_ID,Name2:WP_ID2` — enables author selection |
| `WP_SERVER_HTTP_USER` | No | Server-level HTTP Basic Auth user (see `.env.example`) |
| `WP_SERVER_HTTP_PASS` | No | Server-level HTTP Basic Auth password |
| `IMAGE_WAIT_SECONDS` | No | Seconds to wait for images after text (default: 30) |
| `SESSION_TIMEOUT_SECONDS` | No | Session lifetime in seconds (default: 300) |
| `HTTP_TIMEOUT_MS` | No | HTTP request timeout in ms (default: 30000) |
| `MAX_RETRIES` | No | Retries on transient failures (default: 3) |
| `MAX_IMAGES_PER_SESSION` | No | Max images per article (default: 10) |
| `MAX_IMAGE_SIZE_MB` | No | Max image size in MB (default: 15) |

### Finding your Telegram chat ID

Send any message to your bot, then open:
```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```
Your chat ID is in `result[0].message.chat.id`.

### Author selection

To enable per-article author selection, add to `.env`:
```
WP_AUTHORS=Alice:5,Editorial Team:3
```
Where `5` and `3` are WordPress user IDs (visible in WP Admin → Users → edit user → check the URL bar). If you define a single author, it is used automatically. If you define multiple, a `👤 Author ▾` button appears on the preview.

## Staging vs production

The bot enforces a strict separation between environments:

- `NODE_ENV=staging` requires `DEFAULT_POST_STATUS=draft` and a `WP_URL` that contains `staging`, `test`, `dev`, or `local`
- `NODE_ENV=production` requires `DEFAULT_POST_STATUS=publish`
- The bot refuses to start if these rules are violated

Always validate on staging before enabling production. Use separate `.env` files, separate WordPress users, and a different `HMAC_SECRET` for each environment.

## Plugin REST endpoints

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/wp-json/tgwp/v1/health` | Verify plugin reachability before any write |
| `POST` | `/wp-json/tgwp/v1/media` | Upload image to Media Library |
| `POST` | `/wp-json/tgwp/v1/posts` | Create IT or EN post with RankMath meta |
| `POST` | `/wp-json/tgwp/v1/wpml/link` | Link IT and EN posts as WPML translations |
| `DELETE` | `/wp-json/tgwp/v1/posts/{id}` | Delete a post (used for cleanup on partial failure) |

Every request must include `X-TGWP-Timestamp`, `X-TGWP-Signature`, and `X-TGWP-Request-Id` headers alongside `Authorization`.

## Security notes

- `.env` must never be committed. It is in `.gitignore`.
- Set `chmod 600 .env` on the server.
- Use a long random string (32+ characters) for `HMAC_SECRET`. Generate one with:
  ```bash
  openssl rand -hex 32
  ```
- The staging and production `HMAC_SECRET` must be different.
- Rotate `HMAC_SECRET` and `WP_AUTH_KEY` immediately if you suspect they have been exposed.
- The bot only responds to messages from `TELEGRAM_CHAT_ID`. All other senders are silently ignored.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
