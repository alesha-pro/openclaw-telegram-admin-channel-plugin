# Telegram Admin Channel — AI Agent Guide

You have access to Telegram channel management tools. Use these to publish posts, manage scheduled content, view analytics, and administer the channel.

## Available Tools

### tg_channel_post — Post Operations
- `post` — Publish text to the channel. Requires `text`. Optional: `parseMode` (HTML/Markdown/MarkdownV2), `silent`.
- `edit_post` — Edit a published post. Requires `messageId`, `text`. Dangerous action.
- `delete_post` — Delete messages. Requires `messageIds` array. Dangerous action.
- `forward_post` — Forward messages. Requires `messageIds`, `toChatId`.
- `sync` — Fetch existing posts from the channel (MTProto preferred, HTML fallback).
- `list_recent_activity` — Show recent posts and comments. Optional: `limit`.
- `create_template` / `list_templates` / `use_template` / `delete_template` — Manage post templates.

### tg_channel_stats — Analytics (MTProto required)
- `get_views` — View/forward counts. Requires `messageIds`.
- `get_channel_stats` — Subscribers, growth, reach analytics.
- `get_post_stats` — Per-post views/reactions. Requires `messageId`.
- `get_history` — Channel message history. Optional: `limit`, `offsetId`.
- `engagement_dashboard` — Aggregated analytics: top posts, best hours, growth. Optional: `periodDays`, `limit`.

### tg_channel_schedule — Scheduled Posts (MTProto required)
- `schedule_post` — Schedule text or media. Requires `scheduleDate` (unix UTC). Supports `photoPaths`/`photoFileIds`, `videoPaths`/`videoFileIds`, `documentPaths`/`documentFileIds`.
- `list_scheduled` — List pending scheduled messages.
- `delete_scheduled` — Delete scheduled messages. Requires `messageIds`. Dangerous action.
- `send_scheduled_now` — Publish scheduled immediately. Requires `messageIds`. Dangerous action.

### tg_channel_manage — Channel Management
- `pin_post` / `unpin_post` — Pin/unpin messages. Requires `messageId`. Dangerous action.
- `react` — Set emoji reaction. Requires `messageId`, `emoji`. MTProto only.
- `search` — Search posts/comments. Requires `query`. Optional: `searchType` (post/comment/all), `limit`.
- `status` — Check bot, MTProto, storage status.
- `list_admins` — List channel admins. MTProto only.
- `edit_admin` — Edit admin rights. Requires `userId`, `adminRights`. MTProto only. Dangerous action.

## Workflows

### Publishing a Post
1. Use `tg_channel_post` with `action: "post"`, `text`, and optional `parseMode`.
2. The tool returns `messageId` and `permalink`.

### Scheduling Content
1. Use `tg_channel_schedule` with `action: "schedule_post"`, `text` (or media params), `scheduleDate`.
2. Check schedule with `action: "list_scheduled"`.
3. Send early with `action: "send_scheduled_now"` if needed.

### Checking Analytics
1. Start with `tg_channel_stats` `action: "engagement_dashboard"` for an overview.
2. Drill into specific posts with `action: "get_post_stats"`.
3. Use `action: "get_channel_stats"` for subscriber growth data.

### Using Templates
1. Create: `tg_channel_post` `action: "create_template"` with `templateName` and `text`.
2. List: `action: "list_templates"`.
3. Publish: `action: "use_template"` with `templateName` or `templateId`.

## Limitations

- **Dangerous actions** require `dangerousActions.enabled: true` in plugin config.
- **MTProto actions** require MTProto to be configured and authorized.
- **Bot API fallback** is used for post/edit/delete/pin/forward when MTProto is unavailable.
- **parseMode** is NOT supported for scheduled posts via MTProto.
- **Reactions** (react) are MTProto-only — Bot API does not support them.
- **Admin management** (list_admins, edit_admin) is MTProto-only and edit_admin is a dangerous action.
- **Comment notifications** are configured separately in `notifications.onComment` config section.

## Config Requirements

```yaml
channel:
  chatId: "@your_channel"  # or -100...
ownerAllowFrom:
  - "user_id_1"
dangerousActions:
  enabled: true  # for edit/delete/pin operations
mtproto:
  enabled: true  # for stats, scheduled posts, reactions, admin management
  apiId: 12345
  apiHash: "abc..."
notifications:
  onComment:
    enabled: true
    notifyChatId: "123456789"  # your personal chat ID
```
