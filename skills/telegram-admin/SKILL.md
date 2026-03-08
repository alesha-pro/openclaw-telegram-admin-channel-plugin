# Telegram Admin Channel — AI Agent Guide

You have access to Telegram channel management tools. Use these to publish posts, manage scheduled content, view analytics, read and reply to comments, and administer the channel.

## How Comments Work

The channel has a linked discussion group. Comments are read **on demand via MTProto** using the `tg_channel_comments` tool — they are NOT stored locally and NOT polled in the background.

- Use `tg_channel_comments` with `action: "list_comments"` to fetch recent comments from the discussion group.
- Use `tg_channel_comments` with `action: "reply_comment"` to reply to a specific comment.
- Comments are threaded by channel post. Use `postMessageId` to filter comments for a specific post.
- Replies are sent via Bot API into the correct discussion thread.

### What you should NOT do:
- Don't try to send messages directly to the discussion group — use `tg_channel_comments` instead.
- Don't expect to receive comments as incoming messages — fetch them on demand with `list_comments`.

## Available Tools

### tg_channel_post — Post Operations
- `post` — Publish text to the channel. Requires `text`. Optional: `parseMode` (HTML/Markdown/MarkdownV2), `silent`.
- `edit_post` — Edit a published post. Requires `messageId`, `text`. Dangerous action.
- `delete_post` — Delete messages. Requires `messageIds` array. Dangerous action.
- `forward_post` — Forward messages. Requires `messageIds`, `toChatId`.
- `sync` — Fetch existing posts from the channel (MTProto preferred, HTML fallback).
- `list_recent_activity` — Show recent posts. Optional: `limit`.
- `create_template` / `list_templates` / `use_template` / `delete_template` — Manage post templates.

### tg_channel_comments — Comments (MTProto required)
- `list_comments` — List recent discussion comments. Optional: `postMessageId` (filter by channel post thread), `limit`.
- `reply_comment` — Reply to a specific comment. Requires `commentMessageId`, `replyText`. Optional: `postMessageId` (thread context), `parseMode`.
- `post_comment` — Post a new top-level comment under a channel post. Requires `postMessageId`, `replyText`. Optional: `parseMode`.

Comments are fetched on demand from the linked discussion group via MTProto. They are not stored locally. Replies and new comments are sent through the Bot API into the discussion thread.

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
- `search` — Search posts. Requires `query`. Optional: `limit`.
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

### Reading and Replying to Comments
1. Fetch comments: `tg_channel_comments` `action: "list_comments"`. Optionally pass `postMessageId` to see comments for a specific channel post.
2. Reply to a comment: `action: "reply_comment"` with `commentMessageId` and `replyText`. The reply goes to the correct discussion thread automatically.
3. Post a new comment: `action: "post_comment"` with `postMessageId` and `replyText`. Posts a top-level comment under the channel post.

### Using Templates
1. Create: `tg_channel_post` `action: "create_template"` with `templateName` and `text`.
2. List: `action: "list_templates"`.
3. Publish: `action: "use_template"` with `templateName` or `templateId`.

## Limitations

- **Dangerous actions** require `dangerousActions.enabled: true` in plugin config.
- **MTProto actions** (comments, stats, schedule, reactions, admins) require MTProto to be configured and authorized.
- **Bot API fallback** is used for post/edit/delete/pin/forward when MTProto is unavailable.
- **parseMode** is NOT supported for scheduled posts via MTProto.
- **Reactions** (react) are MTProto-only — Bot API does not support them.
- **Admin management** (list_admins, edit_admin) is MTProto-only and edit_admin is a dangerous action.
- **Comments** require both MTProto and `discussion.chatId` in plugin config.
