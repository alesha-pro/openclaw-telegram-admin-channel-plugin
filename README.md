<div align="center">

# Telegram Admin Channel Plugin for OpenClaw

**Turn your OpenClaw bot into a full-featured Telegram channel admin**

Publishing · Comments · Editing · Scheduling · Analytics · Templates · Admin Management

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D8-orange.svg)](https://pnpm.io/)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-plugin-blueviolet.svg)](https://github.com/nicepkg/openclaw)

</div>

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [MTProto Setup](#mtproto-setup)
- [Tools](#tools)
- [Slash Commands & CLI](#slash-commands--cli)
- [How It Works](#how-it-works)
- [Development](#development)
- [Quick Start](#quick-start-tldr)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### Bot API (always available)

| Feature | Description |
|---------|-------------|
| **Post Publishing** | Publish posts to your channel (HTML, Markdown, MarkdownV2) |
| **Edit / Delete Posts** | Edit published posts or delete them (requires `dangerousActions`) |
| **Pin / Unpin** | Pin and unpin channel messages |
| **Forward** | Forward messages to other chats (batch supported) |
| **Sync** | Synchronize existing posts from a public channel (HTML scraping) |
| **Search** | Full-text search across stored posts |
| **Templates** | Create, list, use, and delete reusable post templates |
| **Activity Feed** | View recent activity (posts) |
| **Retry with Backoff** | Automatic retry with exponential backoff + Telegram 429 handling |
| **File Locking** | Concurrent-safe JSON storage with file locks |

### MTProto (requires user account authorization)

| Feature | Description |
|---------|-------------|
| **Views & Forwards** | Get view/forward counts for specific messages |
| **Comments** | Read discussion comments for posts and reply manually |
| **Channel Stats** | Subscribers, reach, growth, engagement analytics |
| **Post Stats** | Per-post statistics with view/reaction graphs |
| **Engagement Dashboard** | Top posts, best posting hours, growth trends |
| **Message History** | Channel message history with reactions |
| **Scheduled Posts** | Schedule text, photos, videos, documents (albums supported) |
| **Manage Scheduled** | List, delete, or instantly send scheduled posts |
| **Reactions** | Set emoji reactions on messages |
| **Admin Management** | List admins, edit admin rights and ranks |

---

## Requirements

- [OpenClaw](https://github.com/nicepkg/openclaw) >= 2026.2.0
- Node.js >= 18
- pnpm
- A Telegram bot added as an admin to your channel
- (For comments, stats, scheduling, reactions, admin management) MTProto user account authorization
- (For comment tools) a discussion group linked to the channel

---

## Installation

### 1. Clone and build

```bash
git clone https://github.com/alesha-pro/openclaw-telegram-admin-channel-plugin.git
cd openclaw-telegram-admin-channel-plugin
pnpm install
pnpm build
```

### 2. Connect the plugin to OpenClaw

In your OpenClaw config (`~/.openclaw/openclaw.json`):

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

Make sure your OpenClaw config has a Telegram bot token:

```jsonc
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "123456:ABC-DEF..."
    }
  }
}
```

If you use multiple accounts, specify via `telegramAccountId` in the plugin config (defaults to `"default"`).

### 4. Configure the plugin

```jsonc
{
  "plugins": {
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

### 5. Allow tools in OpenClaw policy

The plugin registers 6 tools. Allow the ones you need:

```jsonc
{
  "tools": {
    "allow": [
      "tg_channel_admin",
      "tg_channel_post",
      "tg_channel_comments",
      "tg_channel_stats",
      "tg_channel_schedule",
      "tg_channel_manage"
    ]
  }
}
```

`tg_channel_admin` is the legacy monolithic tool for core channel actions. The five specialized tools (`post`, `comments`, `stats`, `schedule`, `manage`) provide the full functionality split by domain. `comments`, `stats`, and `schedule` are only registered when MTProto is enabled.

---

## Configuration

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `channel.chatId` | string | Channel ID: `@username` or `-100...` |
| `discussion.chatId` | string | Discussion group ID for comment tools |
| `ownerAllowFrom` | string[] | Allowed sender IDs (user/agent account IDs) |

### Full configuration

```jsonc
{
  "telegram-admin-channel": {
    "enabled": true,
    "config": {
      // Telegram account from OpenClaw (defaults to "default")
      "telegramAccountId": "default",

      // Channel
      "channel": {
        "chatId": "@your_channel"         // or "-1001234567890"
      },

      // Discussion group linked to the channel (required for comment tools)
      "discussion": {
        "chatId": "-1001234567890"
      },

      // Allowed sender IDs
      "ownerAllowFrom": ["123456789", "987654321"],

      // Default settings
      "defaults": {
        "silent": false,                   // send without notification
        "parseMode": "HTML"                // default parse mode (HTML/Markdown/MarkdownV2)
      },

      // Destructive actions (edit, delete, pin/unpin, edit_admin)
      "dangerousActions": {
        "enabled": false
      },

      // Storage
      "storage": {
        "mode": "json"
      },

      // MTProto — required for comments, stats, scheduling, reactions, admin management
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

### Dangerous actions

Some actions are gated behind `dangerousActions.enabled`:
`edit_post`, `delete_post`, `pin_post`, `unpin_post`, `delete_scheduled`, `send_scheduled_now`, `edit_admin`.

Set `"dangerousActions": { "enabled": true }` to unlock them.

---

## MTProto Setup

MTProto unlocks comments, statistics, scheduled posts, reactions, and admin management. It uses a Telegram **user account** (not the bot).

### 1. Get API credentials

Go to [my.telegram.org/apps](https://my.telegram.org/apps) and create an application to get `api_id` and `api_hash`.

### 2. Authorize

```bash
pnpm build
pnpm mtproto:auth
```

The script will prompt for your phone number, verification code, and optional 2FA password.

### 3. Update config

```jsonc
"discussion": {
  "chatId": "-100XXXXXXXXXX"
},
"mtproto": {
  "enabled": true,
  "apiId": 12345678,
  "apiHash": "abcdef1234567890abcdef1234567890"
}
```

---

## Tools

The plugin registers 6 tools. The legacy `tg_channel_admin` covers core channel actions. The five specialized tools split the full feature set by domain.

### `tg_channel_post` — Post Operations

| Action | Parameters | Description |
|--------|------------|-------------|
| `post` | `text`, `parseMode?`, `silent?` | Publish a text post |
| `edit_post` | `messageId`, `text`, `parseMode?` | Edit a published post |
| `delete_post` | `messageIds` | Delete messages (batch) |
| `forward_post` | `messageIds`, `toChatId`, `silent?` | Forward messages to another chat |
| `sync` | — | Sync posts (MTProto preferred, HTML fallback) |
| `list_recent_activity` | `limit?` | Show recent posts |
| `create_template` | `templateName`, `text`, `parseMode?` | Create a reusable template |
| `list_templates` | — | List all templates |
| `use_template` | `templateId` or `templateName`, `silent?` | Post from a template |
| `delete_template` | `templateId` | Delete a template |

### `tg_channel_comments` — Comments (MTProto)

| Action | Parameters | Description |
|--------|------------|-------------|
| `list_comments` | `postMessageId?`, `limit?` | List recent comments, optionally only for a specific channel post |
| `reply_comment` | `commentMessageId`, `replyText`, `postMessageId?`, `parseMode?` | Reply to a specific discussion comment |

`tg_channel_comments` reads comments on demand from the linked discussion group via MTProto. Comments are not stored locally; replies are sent through the Bot API into the same discussion thread.

### `tg_channel_stats` — Statistics (MTProto)

| Action | Parameters | Description |
|--------|------------|-------------|
| `get_views` | `messageIds` | View/forward counts |
| `get_channel_stats` | — | Subscribers, reach, growth |
| `get_post_stats` | `messageId` | Per-post stats with graphs |
| `get_history` | `limit?`, `offsetId?` | Channel message history |
| `engagement_dashboard` | `periodDays?`, `limit?` | Top posts, best hours, growth trend |

### `tg_channel_schedule` — Scheduled Posts (MTProto)

| Action | Parameters | Description |
|--------|------------|-------------|
| `schedule_post` | `text?`, `scheduleDate`, media params, `silent?` | Schedule text or media post |
| `list_scheduled` | — | List pending scheduled messages |
| `delete_scheduled` | `messageIds` | Delete scheduled posts |
| `send_scheduled_now` | `messageIds` | Publish scheduled posts immediately |

Media parameters for `schedule_post`: `photoFileIds`, `photoPaths`, `videoFileIds`, `videoPaths`, `documentFileIds`, `documentPaths`. Multiple files = album. `text` becomes the caption.

> Note: `parseMode` is not supported for scheduled posts via MTProto.

### `tg_channel_manage` — Channel Management

| Action | Parameters | Description |
|--------|------------|-------------|
| `pin_post` | `messageId`, `silent?` | Pin a message |
| `unpin_post` | `messageId` | Unpin a message |
| `react` | `messageId`, `emoji` | Set a reaction (MTProto only) |
| `search` | `query`, `limit?` | Search posts |
| `status` | — | Plugin connection status |
| `list_admins` | — | List channel admins (MTProto only) |
| `edit_admin` | `userId`, `adminRights` | Edit admin rights (MTProto only) |

### Chat with the Agent — Examples

```
> Publish a post: "Hello, world! This is a test post."
> Edit post #42 to say "Updated text"
> Pin post #42
> Show me the recent activity in the channel
> Show recent comments for post #42
> Reply to comment #135 with "Thanks for the feedback!"
> How many views did posts 42, 43, 44 get?
> What are the channel stats lately?
> Show me an engagement dashboard for the last 30 days
> Schedule a post "See you soon!" for tomorrow at 10:00 UTC
> Search for "product launch" in channel posts
> Create a template "weekly-digest" with text "Weekly digest:\n..."
> List channel admins
```

---

## Slash Commands & CLI

### Slash Commands

Available in the OpenClaw chat interface (require auth):

| Command | Description |
|---------|-------------|
| `/tgstatus` | Bot/MTProto connection status, post counts |
| `/tgscheduled` | List all pending scheduled posts |
| `/tgstats` | Channel statistics (subscribers, views, shares, reactions) |

### CLI

```bash
openclaw telegram-admin auth     # Interactive MTProto authorization guide
openclaw telegram-admin status   # Posts count, MTProto status
```

---

## How It Works

### Architecture

```
Plugin (src/index.ts)
├── Tools
│   ├── tg_channel_admin        ← legacy monolithic (backward compat)
│   ├── tg_channel_post         ← post, edit, delete, forward, sync, templates
│   ├── tg_channel_comments     ← list comments, reply to comments (MTProto)
│   ├── tg_channel_stats        ← views, channel/post stats, engagement (MTProto)
│   ├── tg_channel_schedule     ← schedule, list, delete, send now (MTProto)
│   └── tg_channel_manage       ← pin, react, search, status, admins
├── Hooks
│   └── message_received        ← auto-collect channel posts
├── Services
│   └── telegram-admin-mtproto  ← MTProto lifecycle (connect/disconnect)
├── Commands
│   ├── /tgstatus
│   ├── /tgscheduled
│   └── /tgstats
├── CLI
│   └── telegram-admin auth|status
└── Storage
    ├── PostStorage     (JSON, max 5000, file-locked)
    └── TemplateStorage (JSON, file-locked)
```

### Message Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ CHANNEL POSTS                                                   │
│                                                                 │
│ Channel post → Bot API → OpenClaw → message_received hook       │
│                                     → posts.upsertPost()        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ DISCUSSION COMMENTS                                             │
│                                                                 │
│ Comment tool → MTProto getHistory(discussion group)             │
│              → filter by thread/post                            │
│              → Bot API reply_to_message for manual replies      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ DMs to bot                                                      │
│                                                                 │
│ DM → Bot API → OpenClaw → normal AI processing (unaffected)     │
└─────────────────────────────────────────────────────────────────┘
```

### Data Storage

Plugin data is stored in `~/.openclaw/plugins/telegram-admin-channel/`:

| File | Description |
|------|-------------|
| `posts.json` | Published and synced posts (max 5000, auto-rotated) |
| `templates.json` | Reusable post templates |
| `mtproto.session` | MTProto session (if enabled) |

### Retry & Rate Limiting

All Telegram API calls (both Bot API and MTProto) are wrapped in `withRetry()`:
- Exponential backoff with jitter
- Automatic handling of Telegram 429 (Too Many Requests) with `retry_after`
- GramJS `FloodWaitError` support
- Retries on network errors and 5xx server errors

### Authorization

The `ownerAllowFrom` config restricts tool access by sender ID (`agentAccountId` or `sessionKey`). Destructive actions require `dangerousActions.enabled`.

---

## Development

```bash
pnpm dev          # Watch mode (recompile on changes)
pnpm build        # Build
pnpm test         # Run tests
pnpm test:watch   # Watch tests
pnpm mtproto:auth # MTProto authorization
```

### Project Structure

```
src/
├── index.ts               # Plugin entry: registers tools, hooks, services, commands, CLI
├── schema.ts              # TypeBox config schema
├── tool.ts                # Legacy monolithic tg_channel_admin (backward compat)
├── tool-shared.ts         # Shared types, auth/dangerous checks, getConfig()
├── tool-post.ts           # tg_channel_post (post, edit, delete, forward, sync, templates)
├── tool-comments.ts       # tg_channel_comments (list comments, reply to comments)
├── tool-stats.ts          # tg_channel_stats (views, channel/post stats, engagement)
├── tool-schedule.ts       # tg_channel_schedule (schedule, list, delete, send now)
├── tool-manage.ts         # tg_channel_manage (pin, react, search, status, admins)
├── hooks.ts               # message_received hook (channel posts only)
├── retry.ts               # withRetry() exponential backoff + Telegram 429 handling
├── storage.ts             # JSON file storage with file locking and auto-rotation
├── telegram-api.ts        # Bot API wrapper with retry + HTML channel scraper
├── mtproto-client.ts      # GramJS MTProto client with retry
└── mtproto-auth.ts        # MTProto authorization CLI script

skills/
└── telegram-admin/
    └── SKILL.md           # AI agent guide for using all tools
```

---

## Quick Start (TL;DR)

```bash
# 1. Clone and build
git clone https://github.com/alesha-pro/openclaw-telegram-admin-channel-plugin.git
cd openclaw-telegram-admin-channel-plugin
pnpm install && pnpm build
```

```jsonc
// 2. Add to openclaw.json — minimal config (channel management only):
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
  }
}
```

```jsonc
// 3. Full setup with MTProto (comments, stats, scheduling, reactions, admin management):
{
  "plugins": {
    "entries": {
      "telegram-admin-channel": {
        "enabled": true,
        "config": {
          "channel": { "chatId": "@your_channel" },
          "discussion": { "chatId": "-100XXXXXXXXXX" },
          "ownerAllowFrom": ["your_telegram_id"],
          "dangerousActions": { "enabled": true },
          "mtproto": {
            "enabled": true,
            "apiId": 12345678,
            "apiHash": "your_api_hash"
          }
        }
      }
    }
  }
}
```

---

## Contributing

Contributions are welcome!

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

---

## License

[MIT](LICENSE)

---

<div align="center">

**[Back to Top](#telegram-admin-channel-plugin-for-openclaw)**

</div>
