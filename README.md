# opencode-telegram

A Telegram bot plugin for [opencode](https://github.com/opencode-ai/opencode) that bridges Telegram chats to opencode. Send prompts and receive streamed responses directly in Telegram.

## Features

- **Streaming responses** — responses are streamed with real-time edit-in-place updates
- **Session management** — create, list, and switch between opencode sessions
- **Agent switching** — list available agents or switch to a specific one
- **Permission handling** — inline keyboard buttons to allow/deny tool execution requests
- **Tool output formatting** — tool calls rendered as code blocks with name, target, and truncated output
- **Message splitting** — long responses are split respecting Telegram's 4096-char limit and code block boundaries
- **Auth** — only allowed Telegram user IDs can interact with the bot

### Bot commands

| Command         | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `/new`          | Create a new opencode session                                 |
| `/sessions`     | List all sessions with inline keyboard to switch between them |
| `/abort`        | Abort the current in-flight prompt                            |
| `/agent [name]` | List available agents or switch to a specific one             |
| _(text)_        | Send as a prompt to the active opencode session               |

## Installation

Add the plugin to your opencode config (`~/.config/opencode/config.json`):

```json
{
	"plugin": ["@theedgeofrage/opencode-telegram@latest"]
}
```

## Configuration

Create `~/.config/opencode/telegram.json`:

```json
{
	"token": "<telegram-bot-token>",
	"allowedUsers": [123456789]
}
```

- `token` — Telegram Bot API token from [@BotFather](https://t.me/BotFather)
- `allowedUsers` — array of numeric Telegram user IDs authorized to use the bot

## Usage

Once installed and configured, ask opencode to connect to Telegram:

> Connect telegram

This starts the bot and attaches it to the current opencode session. All messages sent to the bot in Telegram will be routed to this session.

Alternatively, set the `TELEGRAM_AUTOCONNECT=1` environment variable to start the bot automatically when the plugin loads. Useful when starting opencode as a headless server.

## Limitations

- Connecting multiple opencode sessions to one bot is not supported
- Text-only — no support for photos, files, voice messages, or other media; only text messages are handled
- MarkdownV2 rendering — some LLM outputs with complex formatting may render incorrectly in Telegram
- Tool output truncation — tool outputs are truncated to 3000 characters
- Agent selection not persisted — per-chat agent choice is lost on restart
