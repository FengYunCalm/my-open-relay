---
name: relay-room
description: Immediately execute private or group relay room operations by directly calling relay room, thread, message, and transcript tools with no exploratory preamble.
license: MIT
compatibility: opencode
metadata:
  audience: operators
  workflow: room-relay
---

# Relay Room Skill

Use this skill when the user wants OpenCode conversations to coordinate through the local relay plugin.

## Core rule

Do not ask the user to manually edit session IDs or configuration files for routine room usage.
The current conversation session is identified automatically by the plugin tools.

## Execution contract

When the user's intent clearly matches one of the operations below, your **first action must be the matching tool call**.

Do **not** before the first tool call:
- search for tools
- explain the workflow
- restate the request
- ask for confirmation
- switch into analysis mode

Only stop immediate execution if:
- a required argument is missing
- the current session does not expose the needed relay tools
- the tool call itself fails

## Reply contract

Your user-facing reply must come **after** the real tool call and must reflect the actual tool output.
Do not fabricate room codes, aliases, thread IDs, peer sessions, or delivery results.

## Private room flow (old flow unchanged)

### Create a private room
If the user says things like:
- 创建一个房间
- 创建私聊房间
- 开个房间
- create room

Your first action must be:
- call `relay_room_create`
- omit `kind` or use `kind="private"`

### Join a private room
If the user wants to join a private room:
- call `relay_room_join`
- pass `roomCode`
- do not require alias

### Send inside a private room
If the user wants to send to the other side in a private room:
- call `relay_room_send`
- pass only `message`

## Group room flow

### Create a group room
If the user says things like:
- 创建一个群聊房间
- 创建群房间
- create group room

Your first action must be:
- call `relay_room_create` with `kind="group"`

After the tool call:
1. return the room code
2. make clear that the creator is the room owner
3. tell the user other conversations must join with an alias

### Join a group room with alias
If the user says things like:
- 加入 123456 房间，扮演 alpha
- 加入房间 123456，代号 beta

Your first action must be:
- call `relay_room_join`
- pass `roomCode`
- pass `alias`

If alias is missing for a group room, ask only for the alias.

### View room members
If the user asks who is in the room:
- call `relay_room_members`

### Change a member role
If the user wants to make someone observer/member:
- call `relay_room_set_role`
- only the room owner can do this

## Group messaging behavior

### Broadcast to the whole group
If the user wants everyone in the group to see the message:
- call `relay_room_send`
- pass `message`
- do not pass `targetAlias`

### Direct message a specific group member
If the user wants to privately message one member inside a group room:
- call `relay_room_send`
- pass `message`
- pass `targetAlias`

## Thread/message warehouse tools

Use these when the user explicitly wants durable message/thread operations rather than simple room send:

- `relay_thread_create`
- `relay_thread_list`
- `relay_message_list`
- `relay_message_send`
- `relay_message_mark_read`
- `relay_transcript_export`

### Create a durable thread
- direct/private thread: `relay_thread_create`
- group thread: `relay_thread_create`

### Inspect threads
- call `relay_thread_list`

### Read thread messages
- call `relay_message_list`

### Send into a thread directly
- call `relay_message_send`

### Mark thread read cursor
- call `relay_message_mark_read`

### Export full transcript
- call `relay_transcript_export`

## Fast-path examples

### Example: private room creation
User: 创建一个房间
Your first action: call `relay_room_create`

### Example: group room creation
User: 创建一个群聊房间
Your first action: call `relay_room_create` with `kind="group"`

### Example: join group with alias
User: 加入 821053 房间，扮演 alpha
Your first action: call `relay_room_join` with `roomCode="821053"`, `alias="alpha"`

### Example: group broadcast
User: 给房间所有人发：今天先做 API
Your first action: call `relay_room_send` with `message="今天先做 API"`

### Example: direct message in group
User: 私聊 alpha：你负责接口联调
Your first action: call `relay_room_send` with `message="你负责接口联调"`, `targetAlias="alpha"`

### Example: export transcript
User: 导出 thread_xxx 的完整 transcript
Your first action: call `relay_transcript_export` with `threadId="thread_xxx"`

## Failure fallback

If this session does not expose the required relay tools, say that plainly and stop.
Do not pretend the room or thread operation succeeded.

## Guardrails

- private room flow must remain unchanged
- group room join must require alias
- creator of a group room is the room owner
- room send in group mode may broadcast or direct-message a specific alias
- use durable thread/message tools when the user is explicitly operating on warehouse history
- if a required argument is missing, ask only for that missing argument
- if a tool call fails, report the failure plainly and stop guessing
- treat this as an execution skill, not an analysis skill
