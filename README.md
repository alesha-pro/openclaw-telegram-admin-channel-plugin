<div align="center">

# 📡 Telegram Admin Channel Plugin for OpenClaw

**Turn your OpenClaw bot into a full-featured Telegram channel admin**

Publishing · Comments · Analytics · Scheduled Posts · MTProto Power

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D8-orange.svg)](https://pnpm.io/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-plugin-blueviolet.svg)](https://github.com/nicepkg/openclaw)

<br />

> *"Why hire a social media manager when you have an AI agent?"* — probably someone, 2026

</div>

---

## Table of Contents

- [Features](#-features)
- [Requirements](#-requirements)
- [Installation](#-installation)
- [MTProto Setup (Optional)](#-mtproto-setup-optional)
- [Usage](#-usage)
- [How It Works](#-how-it-works)
- [Development](#-development)
- [Quick Start (TL;DR)](#-quick-start-tldr)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Features

### Bot API (always available)

| Feature | Description |
|---------|-------------|
| 📝 **Post Publishing** | Publish posts to your channel (HTML, Markdown, MarkdownV2) |
| 🔄 **Sync** | Synchronize existing posts from a public channel |
| 💬 **Comments** | Collect and store comments from the discussion group |
| 📊 **Activity Feed** | View recent activity (posts + comments) |

### MTProto (requires user account authorization)

| Feature | Description |
|---------|-------------|
| 👀 **Views & Forwards** | Get view/forward counts for specific messages |
| 📈 **Channel Stats** | Subscribers, reach, growth, engagement |
| 📉 **Post Stats** | Per-post statistics with graphs |
| 📜 **Message History** | Channel message history with reactions |
| ⏰ **Scheduled Posts** | Create, view, delete, and instantly send scheduled posts |

---

## 📋 Requirements

- [OpenClaw](https://github.com/nicepkg/openclaw) >= 2026.2.0
- Node.js >= 18
- pnpm
- A Telegram bot added as an admin to your channel

---

## 🚀 Installation

### 1. Clone and build the plugin

```bash
git clone https://github.com/alesha-pro/openclaw-telegram-admin-channel-plugin.git
cd openclaw-telegram-admin-channel-plugin
pnpm install
pnpm build
```

### 2. Connect the plugin to OpenClaw

Open your OpenClaw config (`openclaw.json` in your project root or global `~/.openclaw/config.json`) and add the plugin path:

```jsonc
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/openclaw-telegram-admin-channel-plugin"
      ]
    }
  }
}
```

### 3. Configure Telegram account

Make sure your OpenClaw config has the Telegram channel set up with a bot token:

```jsonc
{
  "channels": {
    "telegram": {
      "botToken": "123456:ABC-DEF..."
    }
  }
}
```

If you use multiple accounts, specify the desired one via `telegramAccountId` in the plugin config (defaults to `"default"`).

### 4. Configure the plugin

In the same `openclaw.json`, add a `plugins.entries` section:

```jsonc
{
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/openclaw-telegram-admin-channel-plugin"]
    },
    "entries": {
      "telegram-admin-channel": {
        "enabled": true,
        "config": {
          "channel": {
            "chatId": "@your_channel"
          },
          "ownerAllowFrom": ["123456789"]
        }
      }
    }
  }
}
```

#### Minimum configuration

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `channel.chatId` | string | ✅ | Channel ID: `@username` or `-100...` |
| `ownerAllowFrom` | string[] | ✅ | Telegram user IDs with admin rights |

#### Full configuration

<details>
<summary>Click to expand full config example</summary>

```jsonc
{
  "telegram-admin-channel": {
    "enabled": true,
    "config": {
      // Telegram account from OpenClaw (defaults to "default")
      "telegramAccountId": "default",

      // Channel
      "channel": {
        "chatId": "@your_channel"       // or "-1001234567890"
      },

      // Discussion group (for collecting comments)
      "discussion": {
        "chatId": "-1001234567890"
      },

      // User IDs with admin rights
      "ownerAllowFrom": ["123456789", "987654321"],

      // Default settings
      "defaults": {
        "silent": false                  // send without notification
      },

      // Dangerous actions (delete, edit, pin)
      "dangerousActions": {
        "enabled": false
      },

      // Storage
      "storage": {
        "mode": "json"                   // "json" or "sqlite" (not yet implemented)
      },

      // MTProto — extended stats and scheduled posts
      "mtproto": {
        "enabled": false,
        "apiId": 12345678,
        "apiHash": "abcdef1234567890abcdef1234567890",
        "sessionPath": "~/.openclaw/plugins/telegram-admin-channel/mtproto.session"
      }
    }
  }
}
```

</details>

### 5. Allow the tool in OpenClaw policy

The plugin registers an **optional** tool `tg_channel_admin`. To let the agent use it, add it to the tool allowlist:

```jsonc
{
  "tools": {
    "allow": ["tg_channel_admin"]
  }
}
```

---

## 🔐 MTProto Setup (Optional)

MTProto provides access to extended statistics and scheduled posts. It requires user account authorization (not a bot).

### 1. Get API ID and API Hash

Go to [my.telegram.org/apps](https://my.telegram.org/apps) and create an application. You will receive an `api_id` and `api_hash`.

### 2. Run the authorization script

```bash
cd openclaw-telegram-admin-channel-plugin
pnpm build
pnpm mtproto:auth
```

The script will ask for:
1. **API ID** — number from my.telegram.org (or env var `TELEGRAM_API_ID`)
2. **API Hash** — string from my.telegram.org (or env var `TELEGRAM_API_HASH`)
3. **Session file path** — defaults to `~/.openclaw/plugins/telegram-admin-channel/mtproto.session`
4. **Phone number** — with country code (e.g., `+15551234567`)
5. **Verification code** — from Telegram
6. **2FA password** — if enabled

After successful authorization, the script outputs JSON to paste into your config.

### 3. Update config

Add to your plugin config:

```jsonc
"mtproto": {
  "enabled": true,
  "apiId": 12345678,
  "apiHash": "abcdef1234567890abcdef1234567890"
}
```

Or use environment variables `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` and just specify:

```jsonc
"mtproto": {
  "enabled": true
}
```

---

## 🎮 Usage

Once connected, the OpenClaw agent gets the `tg_channel_admin` tool with the following actions:

### Bot API Actions

| Action | Parameters | Description |
|--------|------------|-------------|
| `post` | `text`, `parseMode?`, `silent?` | Publish a post to the channel |
| `sync` | — | Sync posts from a public channel |
| `list_recent_activity` | `limit?` | Show recent posts and comments |

### MTProto Actions

| Action | Parameters | Description |
|--------|------------|-------------|
| `get_views` | `messageIds` | Get views and forwards |
| `get_channel_stats` | — | Channel stats (subscribers, reach, growth) |
| `get_post_stats` | `messageId` | Post stats (view and reaction graphs) |
| `get_history` | `limit?`, `offsetId?` | Channel message history |
| `schedule_post` | `text`, `scheduleDate`, `silent?` | Schedule a post (unix timestamp UTC) |
| `list_scheduled` | — | List scheduled posts |
| `delete_scheduled` | `messageIds` | Delete scheduled posts |
| `send_scheduled_now` | `messageIds` | Immediately publish scheduled posts |

### Chat with the Agent — Examples

```
> Publish a post: "Hello, world! This is a test post."

> Show me the recent activity in the channel

> How many views did post #42 get?

> What are the channel stats lately?

> Schedule a post "See you soon!" for tomorrow at 10:00 UTC

> Show all scheduled posts
```

---

## 🧠 How It Works

### Architecture

```
openclaw.json
├── channels.telegram.botToken      ← bot token
└── plugins.entries.telegram-admin-channel
    └── config                      ← plugin configuration
        ├── channel.chatId          ← channel ID
        ├── discussion.chatId       ← discussion group ID
        └── mtproto.*               ← MTProto settings

Plugin (src/index.ts)
├── registerTool(tg_channel_admin)  ← tool for the agent
├── registerHooks(message_received) ← auto-collect posts/comments
├── PostStorage (JSON)              ← post storage
├── CommentStorage (JSON)           ← comment storage
└── MtprotoClient (optional)        ← client for stats
```

### Data Storage

Plugin data is stored in `~/.openclaw/plugins/telegram-admin-channel/`:

| File | Description |
|------|-------------|
| `posts.json` | Published and synced posts |
| `comments.json` | Comments from the discussion group |
| `mtproto.session` | MTProto session (if enabled) |

### Hooks

The plugin automatically listens to all incoming Telegram messages via the `message_received` event. If a message comes from the configured channel or discussion group — it gets saved locally. This lets the agent see the latest activity context without extra API calls.

---

## 🛠️ Development

```bash
# Dev mode (recompile on changes)
pnpm dev

# Build
pnpm build

# Tests
pnpm test
pnpm test:watch

# MTProto authorization
pnpm mtproto:auth
```

### Project Structure

```
src/
├── index.ts          # Plugin entry point, registration
├── schema.ts         # TypeBox config schema
├── tool.ts           # Tool definition and handlers
├── hooks.ts          # Hooks for incoming messages
├── storage.ts        # JSON storage for posts and comments
├── telegram-api.ts   # Bot API wrapper + HTML parser
├── mtproto-client.ts # MTProto client (stats, scheduling)
└── mtproto-auth.ts   # MTProto authorization CLI script
```

---

## ⚡ Quick Start (TL;DR)

```bash
# 1. Clone and build
git clone <repo-url> && cd openclaw-telegram-admin-channel-plugin
pnpm install && pnpm build
```

```jsonc
// 2. Add to openclaw.json:
{
  "plugins": {
    "load": { "paths": ["/path/to/openclaw-telegram-admin-channel-plugin"] },
    "entries": {
      "telegram-admin-channel": {
        "enabled": true,
        "config": {
          "channel": { "chatId": "@your_channel" },
          "ownerAllowFrom": ["your_telegram_id"]
        }
      }
    }
  },
  "tools": {
    "allow": ["tg_channel_admin"]
  }
}
```

```bash
# 3. Done! The agent can now manage your channel. 🎉
```

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

1. **Fork** the repo
2. **Create** your feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

Please make sure to update tests as appropriate.

---

## 📄 License

[MIT](LICENSE) — do whatever you want, just don't blame us if your channel posts cat memes at 3 AM.

---

<div align="center">

**[⬆ Back to Top](#-telegram-admin-channel-plugin-for-openclaw)**

Made with ❤️ and way too much ☕

⭐ Star this repo if you find it useful!

</div>
