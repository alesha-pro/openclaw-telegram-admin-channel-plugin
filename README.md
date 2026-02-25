<div align="center">

# Telegram Admin Channel Plugin for OpenClaw

**Turn your OpenClaw bot into a full-featured Telegram channel admin**

Publishing · Editing · Scheduling · Analytics · Comments · Auto-Reply · Templates · Admin Management

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
- [Discussion Monitor & Auto-Reply](#discussion-monitor--auto-reply)
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
| **Search** | Full-text search across stored posts and comments |
| **Templates** | Create, list, use, and delete reusable post templates |
| **Activity Feed** | View recent activity (posts + comments) |
| **Retry with Backoff** | Automatic retry with exponential backoff + Telegram 429 handling |
| **File Locking** | Concurrent-safe JSON storage with file locks |

### MTProto (requires user account authorization)

| Feature | Description |
|---------|-------------|
| **Discussion Monitor** | Independent MTProto polling of the discussion group for comments |
| **Auto-Reply** | AI-powered automatic responses to comments with per-thread cooldown |
| **Comment Notifications** | Throttled notifications on new comments to a configured chat |
| **Comment Management** | List pending, reply, skip — manual control over comment processing |
| **Views & Forwards** | Get view/forward counts for specific messages |
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
- (For discussion monitor) MTProto user account authorization

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

The plugin registers 5 tools. Allow the ones you need:

```jsonc
{
  "tools": {
    "allow": [
      "tg_channel_admin",
      "tg_channel_post",
      "tg_channel_stats",
      "tg_channel_schedule",
      "tg_channel_manage"
    ]
  }
}
```

`tg_channel_admin` is the legacy monolithic tool (backward compatible). The four specialized tools (`post`, `stats`, `schedule`, `manage`) provide the same functionality split by domain. `stats` and `schedule` are only registered when MTProto is enabled.

---

## Configuration

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `channel.chatId` | string | Channel ID: `@username` or `-100...` |
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

      // Discussion group linked to the channel (for comment monitoring)
      "discussion": {
        "chatId": "-1001234567890"        // the linked supergroup ID
      },

      // Allowed sender IDs
      "ownerAllowFrom": ["123456789", "987654321"],

      // Default settings
      "defaults": {
        "silent": false                    // send without notification
      },

      // Destructive actions (edit, delete, pin/unpin, edit_admin)
      "dangerousActions": {
        "enabled": false
      },

      // Storage
      "storage": {
        "mode": "json"
      },

      // MTProto — required for stats, scheduling, reactions, admin, discussion monitor
      "mtproto": {
        "enabled": false,
        "apiId": 12345678,
        "apiHash": "abcdef1234567890abcdef1234567890",
        "sessionPath": "~/.openclaw/plugins/telegram-admin-channel/mtproto.session"
      },

      // Auto-reply to comments (requires discussion.chatId + mtproto)
      "autoReply": {
        "enabled": false,
        "intervalMinutes": 5,              // polling interval (min 3, default 5)
        "maxRepliesPerBatch": 5,           // max LLM calls per tick
        "cooldownPerThreadMinutes": 30     // don't reply to same thread within this window
      },

      // Comment notifications
      "notifications": {
        "onComment": {
          "enabled": false,
          "notifyChatId": "123456789",     // chat ID to receive notifications
          "minInterval": 60                // throttle: min seconds between notifications
        }
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

MTProto unlocks statistics, scheduled posts, reactions, admin management, and the discussion monitor. It uses a Telegram **user account** (not the bot).

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
"mtproto": {
  "enabled": true,
  "apiId": 12345678,
  "apiHash": "abcdef1234567890abcdef1234567890"
}
```

---

## Discussion Monitor & Auto-Reply

### The Problem

OpenClaw's native `message_received` hook requires `requireMention: true` for groups, which means comments without @bot mentions are never seen. Setting `requireMention: false` causes the AI to reply to everything in the group.

### The Solution

The plugin runs an **independent discussion monitor** that polls the discussion group via MTProto (user account). OpenClaw's native processing is disabled for the discussion group — clean separation.

```
OpenClaw owns: channel + DMs
Plugin owns:   discussion group (via MTProto)
```

### How It Works

```
Every N minutes (default: 5):
  1. MTProto polls discussion group history (getHistory with minId tracking)
  2. Filters: skip auto-forwarded posts, skip bot's own messages
  3. Stores new messages as comments (upsertComment with dedup)
  4. Sends notification to owner (rate-limited)
  5. If autoReply enabled: processes pending comments through AI
     → AI generates reply → sent via Bot API to correct thread
     → or AI returns nothing → marked as "skipped"
```

### Comment Lifecycle

```
New message in discussion group
  → discussion-monitor picks up via MTProto
  → stored with status: "pending" (owner messages: no status)
  → auto-reply processes:
      → AI reply generated → status: "replied" (replyMessageId saved)
      → AI returns nothing → status: "skipped"
  → or manually via tools:
      → reply_comment → status: "replied"
      → skip_comment → status: "skipped"
```

### Server Config Requirement

**Disable OpenClaw's native processing** for the discussion group to avoid conflicts:

```jsonc
{
  "channels": {
    "telegram": {
      "groups": {
        "-100XXXXXXXXXX": {        // your discussion group ID
          "enabled": false
        }
      }
    }
  }
}
```

This makes OpenClaw ignore all messages from the discussion group. The plugin takes full ownership via MTProto.

### Auto-Reply Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `intervalMinutes` | 5 | How often to poll for new messages. Min ~3 (MTProto rate limits) |
| `maxRepliesPerBatch` | 5 | Max LLM calls per tick. Remaining pending wait for next tick |
| `cooldownPerThreadMinutes` | 30 | After replying in a thread, skip it for this duration |

Most ticks are lightweight (one MTProto call + empty pending check). LLM is only invoked when there are actual pending comments.

---

## Tools

The plugin registers 5 tools. The legacy `tg_channel_admin` contains all actions. The four specialized tools split them by domain.

### `tg_channel_post` — Post Operations

| Action | Parameters | Description |
|--------|------------|-------------|
| `post` | `text`, `parseMode?`, `silent?` | Publish a text post |
| `edit_post` | `messageId`, `text`, `parseMode?` | Edit a published post |
| `delete_post` | `messageIds` | Delete messages (batch) |
| `forward_post` | `messageIds`, `toChatId`, `silent?` | Forward messages to another chat |
| `sync` | — | Sync posts (MTProto preferred, HTML fallback) |
| `list_recent_activity` | `limit?` | Show recent posts and comments |
| `create_template` | `templateName`, `text`, `parseMode?` | Create a reusable template |
| `list_templates` | — | List all templates |
| `use_template` | `templateId` or `templateName`, `silent?` | Post from a template |
| `delete_template` | `templateId` | Delete a template |

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
| `search` | `query`, `searchType?`, `limit?` | Search posts/comments (`searchType`: post/comment/all) |
| `status` | — | Plugin connection status |
| `list_admins` | — | List channel admins (MTProto only) |
| `edit_admin` | `userId`, `adminRights` | Edit admin rights (MTProto only) |
| `list_pending_comments` | `limit?` | Show comments awaiting response |
| `reply_comment` | `messageId`, `replyText`, `chatId?` | Reply to a specific comment |
| `skip_comment` | `messageId`, `chatId?` | Mark a comment as skipped |

### Chat with the Agent — Examples

```
> Publish a post: "Hello, world! This is a test post."
> Edit post #42 to say "Updated text"
> Pin post #42
> Show me the recent activity in the channel
> How many views did posts 42, 43, 44 get?
> What are the channel stats lately?
> Show me an engagement dashboard for the last 30 days
> Schedule a post "See you soon!" for tomorrow at 10:00 UTC
> Search for "product launch" in channel posts
> Create a template "weekly-digest" with text "Weekly digest:\n..."
> List pending comments
> Reply to comment #135 with "Thanks for the feedback!"
> Skip comment #136
> List channel admins
```

---

## Slash Commands & CLI

### Slash Commands

Available in the OpenClaw chat interface (require auth):

| Command | Description |
|---------|-------------|
| `/tgstatus` | Bot/MTProto connection status, post/comment counts |
| `/tgscheduled` | List all pending scheduled posts |
| `/tgstats` | Channel statistics (subscribers, views, shares, reactions) |

### CLI

```bash
openclaw telegram-admin auth     # Interactive MTProto authorization guide
openclaw telegram-admin status   # Posts/comments count, MTProto status
```

---

## How It Works

### Architecture

```
Plugin (src/index.ts)
├── Tools
│   ├── tg_channel_admin        ← legacy monolithic (backward compat)
│   ├── tg_channel_post         ← post, edit, delete, forward, sync, templates
│   ├── tg_channel_stats        ← views, channel/post stats, engagement (MTProto)
│   ├── tg_channel_schedule     ← schedule, list, delete, send now (MTProto)
│   └── tg_channel_manage       ← pin, react, search, status, admins, comments
├── Hooks
│   └── message_received        ← auto-collect channel posts
├── Services
│   ├── discussion-monitor      ← MTProto polling + comments + notifications + auto-reply
│   └── telegram-admin-mtproto  ← MTProto lifecycle (connect/disconnect)
├── Commands
│   ├── /tgstatus
│   ├── /tgscheduled
│   └── /tgstats
├── CLI
│   └── telegram-admin auth|status
└── Storage
    ├── PostStorage     (JSON, max 5000, file-locked)
    ├── CommentStorage  (JSON, max 10000, file-locked, upsert with dedup)
    └── TemplateStorage (JSON, file-locked)
```

### Message Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ CHANNEL POSTS                                                   │
│                                                                 │
│ Channel post → Bot API → OpenClaw → message_received hook       │
│                                     → posts.upsertPost()        │
│                                                                 │
│ Auto-forwarded copy in discussion group                         │
│                  → discussion-monitor sees isForward → SKIP     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ DISCUSSION GROUP (comments)                                     │
│                                                                 │
│ Comment → Bot API → OpenClaw → enabled: false → DROP            │
│                                                                 │
│ Meanwhile, every 5 min:                                         │
│ discussion-monitor → MTProto getHistory(minId) → new messages   │
│   → filter (skip forwards, skip bot, skip empty)                │
│   → comments.upsertComment() (dedup by messageId)               │
│   → notify owner (rate-limited)                                 │
│   → auto-reply: AI generates response → Bot API sendMessage     │
│     (replyToMessageId + messageThreadId = correct thread)       │
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
| `comments.json` | Comments from the discussion group (max 10000, auto-rotated) |
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
├── tool-stats.ts          # tg_channel_stats (views, channel/post stats, engagement)
├── tool-schedule.ts       # tg_channel_schedule (schedule, list, delete, send now)
├── tool-manage.ts         # tg_channel_manage (pin, react, search, status, admins, comments)
├── discussion-monitor.ts  # MTProto polling + comment storage + notifications + auto-reply
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
// 3. Full setup with discussion monitor + auto-reply:
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
          },
          "autoReply": {
            "enabled": true,
            "intervalMinutes": 5,
            "maxRepliesPerBatch": 5,
            "cooldownPerThreadMinutes": 30
          },
          "notifications": {
            "onComment": {
              "enabled": true,
              "notifyChatId": "your_telegram_id",
              "minInterval": 60
            }
          }
        }
      }
    }
  },
  // IMPORTANT: disable OpenClaw for the discussion group
  "channels": {
    "telegram": {
      "groups": {
        "-100XXXXXXXXXX": { "enabled": false }
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
