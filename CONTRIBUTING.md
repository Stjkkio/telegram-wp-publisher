# Contributing

Contributions are welcome. Please read this before opening a pull request.

## Ground rules

- **No breaking changes to the security model.** HMAC signing, Application Password auth, and the staging/production guard are non-negotiable.
- **No new runtime dependencies without discussion.** Open an issue first if you need to add a package.
- **Keep it single-user.** Multi-user support is out of scope for v1.
- **Test on staging before PRing.** The bot has a built-in test suite (`node test_staging.js`). All tests must pass.

## Getting started

1. Fork the repository and clone your fork.
2. Create a staging WordPress environment (local or remote).
3. Copy `.env.example` to `.env` and fill in staging credentials.
4. Install the plugin in staging WordPress.
5. Run `npm install`.
6. Run `node test_staging.js` — all automated tests must pass before you start coding.

## What we welcome

- Bug fixes
- Support for additional languages (beyond IT/EN) via WPML
- Support for other SEO plugins (Yoast, etc.) alongside RankMath
- PM2 / systemd service examples
- Docker setup for the bot server
- Support for Anthropic's newer models as they are released
- Improved error messages and user-facing copy

## What is out of scope for v1

- Multi-user support
- Scheduled publishing
- Auto-insertion of images into the post body
- Updating existing posts
- Support for custom post types

If you want to discuss a larger feature, open an issue first so we can align before you invest time coding it.

## Pull request checklist

- [ ] `node test_staging.js` passes with zero failures
- [ ] No secrets, credentials, or personal URLs in the code
- [ ] No new packages added without prior discussion
- [ ] Commit messages are clear and describe the *why*, not just the *what*

## Reporting bugs

Open a GitHub issue with:
1. What you did
2. What you expected to happen
3. What actually happened
4. Relevant log lines (from `logs/bot.log` or `logs/agent.log`) — make sure to redact any tokens or passwords
