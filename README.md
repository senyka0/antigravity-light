# Antigravity Light

A high-performance, lightweight, cross-platform (Linux & Windows) companion for **Google Antigravity 2.0**.

## Features

- **Google OAuth Multi-Account Manager**: Add multiple accounts via browser OAuth loopback or direct refresh tokens.
- **Quota Tracking for Gemini Flash 3.8 High**: Real-time checking of the **5-Hour** and **5-Day / Weekly** rolling limits.
- **Antigravity 2.0 Active Account Detection**: Automatically detects what account is currently used in the Antigravity desktop app or IDE (`state.vscdb` / `app_storage.json`).
- **Seamless Hot-Switching (<= 5% Quota)**: If the active account's 5-hour or 5-day limit drops to **5% or less**, it automatically switches credentials and hot-restarts the AI language server without closing your IDE window.
- **Interrupted Chat Resumption**: If an AI prompt was actively generating when the account was switched, automatically triggers `agy --conversation <id> -p "continue"` to pick up right where it left off.
- **Telegram Bot Notifications**: Sends instant alerts whenever an account is switched, showing old account, new account, remaining quotas, and chat status.
- **Local OpenAI-Compatible API Proxy**: Exposes `http://127.0.0.1:8080/v1` so Cursor, Cline, Continue.dev, Claude Code, Open WebUI, and Python scripts can use your account pool with automatic failover!

---

## Zero-Dependency Architecture

Built with 100% native Node.js APIs (`node:sqlite`, `node:http`, `node:crypto`, `node:child_process`, `fetch`).
- **No external npm packages required**.
- Starts in ~15 ms.
- Uses < 25 MB RAM.
- Identical code runs on Linux and Windows.

---

## Quickstart

### 1. Run the CLI
```bash
cd antigravity-light
node src/index.js help
```

### 2. Add an Account
```bash
node src/index.js login
```
*Opens your browser to authenticate with Google. Credentials and refresh tokens are stored in `~/.antigravity-light/accounts.json`.*

Alternatively, add manually with a refresh token:
```bash
node src/index.js add-token <REFRESH_TOKEN> <EMAIL>
```

### 3. Check Detected Active Account in Antigravity
```bash
node src/index.js active
```

### 4. Configure Telegram Bot Alerts (Optional)
```bash
node src/index.js config telegramBotToken 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
node src/index.js config telegramChatId 987654321
```

### 5. Start the Daemon & OpenAI Proxy
```bash
node src/index.js start
```
This runs the background monitor (auto-switching depleted accounts) and hosts the OpenAI proxy at `http://127.0.0.1:8080/v1`.

---

## Connecting External Apps (OpenAI Interface)

Point any app expecting an OpenAI API to `http://127.0.0.1:8080/v1`:

### Python
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8080/v1",
    api_key="any-string"
)

response = client.chat.completions.create(
    model="gemini-3.8-flash",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### Cursor / Cline / Continue.dev
- **Provider**: OpenAI
- **Base URL**: `http://127.0.0.1:8080/v1`
- **API Key**: `dummy-key`
- **Model**: `gemini-3.8-flash` (or `gemini-3.1-pro`)

---


### 6. Open the Web Dashboard in Chrome
```bash
node src/index.js ui
```
Or start the daemon (`node src/index.js start`) and navigate to `http://127.0.0.1:8080` in your browser.
From the Web UI, you can:
- View all added accounts and their live 5-hour & 5-day Flash 3.8 quotas with progress bars.
- See the currently active Antigravity account and running conversations.
- Switch accounts with 1 click.
- Add new accounts via OAuth or paste tokens.
- Configure Telegram Bot token, chat ID, and switch thresholds without restarting.
- Test your accounts in the built-in AI Playground / Prompt tester.
- Copy preconfigured setup snippets for Cursor, Cline, Continue.dev, and Python.

---

## Testing

Run the included automated test suite:
```bash
node --test test/app.test.js
```

