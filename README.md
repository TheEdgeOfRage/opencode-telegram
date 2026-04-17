# pi-telegram

A [pi](https://github.com/badlogic/pi-mono) extension that bridges your pi coding agent session to Telegram. Send prompts from Telegram and receive streaming responses with tool execution previews.

## Features

- **Remote access** — interact with your pi session from Telegram
- **Streaming responses** — see the assistant's reply update in real time
- **Tool execution tracking** — tool calls and results shown as code blocks
- **Channel support** — works in channels/supergroups (responses are quoted)
- **Access control** — allowlist of Telegram user IDs
- **Autoconnect** — optionally connect on startup via env var

## Setup

### 1. Install the extension

```bash
pi install npm:@theedgeofrage/pi-telegram
```

Or for development, clone and load locally:

```bash
pi -e /path/to/pi-telegram
```

### 2. Create a Telegram bot

Talk to [@BotFather](https://t.me/BotFather) on Telegram and create a new bot. Save the token.

### 3. Configure

Create `~/.config/pi/telegram.json`:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "allowedUsers": [123456789]
}
```

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

### 4. Connect

From pi's TUI, use the command:

```
/telegram connect
```

Or set `TELEGRAM_AUTOCONNECT=1` in your environment to connect on startup.

## Usage

### pi commands

| Command                           | Description            |
| --------------------------------- | ---------------------- |
| `/telegram connect`               | Start the Telegram bot |
| `/telegram disconnect`            | Stop the Telegram bot  |
| `/telegram` or `/telegram status` | Show connection status |

### Telegram bot commands

| Command  | Description                 |
| -------- | --------------------------- |
| `/abort` | Abort the current operation |

### LLM tool

The extension registers a `telegram` tool that the LLM can call with actions: `connect`, `disconnect`, `status`.

### Environment variables

| Variable                 | Description                         |
| ------------------------ | ----------------------------------- |
| `TELEGRAM_AUTOCONNECT=1` | Auto-connect the bot when pi starts |

## How it works

When connected, Telegram messages from authorized users are forwarded to the current pi session via `pi.sendUserMessage()`. The extension listens to pi's event system for streaming responses and routes them back to the originating Telegram chat with throttled message edits.

Only one prompt can be active at a time — if the agent is busy, new Telegram messages receive a "please wait" reply.

## Config

`~/.config/pi/telegram.json`:

```json
{
  "token": "string — Telegram bot token from BotFather",
  "allowedUsers": [12345, 67890]
}
```

## License

MIT
