# Telegram Admin Channel — AI Agent Guide

You have access to Telegram channel management tools. Use these to publish posts, manage scheduled content, view analytics, handle comments, and administer the channel.

## Architecture — How Comments Work

The channel has a linked discussion group. Comments are collected **independently via MTProto polling** (not through bot mentions or hooks). This means:

- **You do NOT receive comments as incoming messages.** They are collected in the background every 5 minutes by the discussion-monitor service.
- **You do NOT need to be mentioned** to see or respond to comments. All messages in the discussion group are captured automatically.
- **Auto-reply** processes pending comments automatically — the AI generates responses and sends them to the correct thread.
- **Manual intervention**: you can review, reply to, or skip specific comments using `tg_channel_manage` actions.

### Auto-reply modes

The discussion monitor supports two auto-reply modes:

- **`simple`** (default) — one-shot text generation via `getReplyFromConfig()`. No tools, no session memory, no agent capabilities.
- **`agent`** — full agent sessions via the gateway's HTTP `/v1/chat/completions` endpoint. Each discussion thread gets its own persistent session (`discussion:thread:{threadId}`), with configurable tool restrictions, session history, and full agent context (IDENTITY.md, workspace).

Agent mode requires:
- `autoReply.mode: "agent"` in plugin config
- `autoReply.gatewayToken` — gateway auth token
- A configured agent (default: `discussion-responder`) in `agents.list`
- `gateway.http.endpoints.chatCompletions.enabled: true` in server config

### Comment lifecycle:
1. Someone writes in the discussion group (comment on a post or general message)
2. Discussion-monitor picks it up via MTProto polling (every 5 min)
3. Stored as comment with `status: "pending"` (owner messages have no status)
4. Notification sent to owner (rate-limited)
5. Auto-reply processes pending:
   - **Simple mode**: one-shot AI call → reply or skip
   - **Agent mode**: gateway agent turn (with tools + session history) → reply or skip
6. Comment marked as `"replied"` or `"skipped"`

### What you CAN do with comments:
- `list_pending_comments` — see unprocessed comments waiting for response
- `reply_comment` — manually reply to a specific comment (overrides auto-reply)
- `skip_comment` — mark a comment as intentionally skipped
- `search` with `searchType: "comment"` — find comments by text
- `list_recent_activity` — see recent posts AND comments together

### What you should NOT do:
- Don't try to send messages directly to the discussion group — use the comment tools instead.
- Don't expect to receive comments as incoming messages — they come through background polling.

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
- `list_pending_comments` — Show comments awaiting response. Optional: `limit`.
- `reply_comment` — Reply to a comment. Requires `messageId`, `replyText`. Optional: `chatId`.
- `skip_comment` — Mark comment as skipped. Requires `messageId`. Optional: `chatId`.

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

### Managing Comments
1. Check pending: `tg_channel_manage` `action: "list_pending_comments"`.
2. Review each comment and decide:
   - Reply: `action: "reply_comment"`, `messageId`, `replyText` — sends reply in the correct thread.
   - Skip: `action: "skip_comment"`, `messageId` — marks as intentionally ignored.
3. Auto-reply handles most comments automatically. Use manual actions for special cases.

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
- **Comments** are polled every 5 minutes — there may be a short delay before new comments appear.
- **Auto-reply cooldown** prevents replying to the same thread too frequently (default: 30 min per thread).
