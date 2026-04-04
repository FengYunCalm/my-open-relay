---
name: relay-room
description: Immediately execute two-session relay room operations by directly calling relay_room_create, relay_room_join, relay_room_status, or relay_room_send with no exploratory preamble.
license: MIT
compatibility: opencode
metadata:
  audience: operators
  workflow: room-relay
---

# Relay Room Skill

Use this skill when the user wants two OpenCode conversations to communicate through the local relay plugin with a room code.

## Core rule

Do not ask the user to manually edit session IDs or configuration files for routine pairing.
The current conversation session is identified automatically by the plugin tools.

## Execution contract

When the user's intent clearly matches one of the room operations below, your **first action must be the matching tool call**.

Do **not** before the first tool call:
- search for tools
- explain the workflow
- restate the request
- ask for confirmation
- check room status unless the user explicitly asked for status
- ask broad follow-up questions

Only stop immediate execution if:
- a required argument is missing
- the current session truly does not expose the relay room tools
- the tool call itself fails

## Reply contract

When a relay room tool exists for the requested action, do not answer from assumption.
Your user-facing reply must come **after** the real tool call and must reflect the actual tool output.

Do **not**:
- say that a room was created before `relay_room_create` returns
- say that a room was joined before `relay_room_join` returns
- say that a message was sent before `relay_room_send` returns
- fabricate room codes, peer session IDs, or delivery results

If the tool is unavailable in the current session, say that plainly and stop.

## Required tool mapping

### 1. Create room
If the user says things like:
- 创建房间
- 开个房间
- 建房
- create room
- start room

Your **first action** must be:
- call `relay_room_create`

After the tool call:
1. return the room code
2. tell the user to give the room code to the second conversation

### 2. Join room
If the user gives a room code and wants to connect this conversation:
- 加入房间 821053
- 连接房间 821053
- join room 821053

Your **first action** must be:
- call `relay_room_join`

Required input:
- `roomCode`

If the room code is missing, ask **only** for the room code.

After the tool call:
1. confirm whether pairing is active
2. if not active yet, explain exactly what is missing

### 3. Check current room status
If the user asks whether this conversation is connected, paired, or bound to a room:
- 看看连上没有
- 查看房间状态
- 当前配对状态
- room status

Your **first action** must be:
- call `relay_room_status`

After the tool call:
1. summarize room code, current session, peer session, and room status

### 4. Send message to paired peer
If the user wants to send content to the paired conversation:
- 把这句话发给对端：你好
- 发给对方：xxx
- send this to the peer: hello

Your **first action** must be:
- call `relay_room_send`

Required input:
- `message`

If message content is missing, ask **only** for the message text.

After the tool call:
1. report the peer session
2. report whether delivery was accepted
3. if not accepted, report the reason directly

## Fast-path examples

### Example: create room
User: 创建房间
Your first action: call `relay_room_create`

### Example: join room
User: 加入房间 821053
Your first action: call `relay_room_join` with `roomCode="821053"`

### Example: send message
User: 把这句话发给对端：你好
Your first action: call `relay_room_send` with `message="你好"`

### Example: check status
User: 看看现在连上没有
Your first action: call `relay_room_status`

## Failure fallback

If this session does not expose the relay room tools, say that plainly.
Do not pretend the room was created or joined.
Do not invent a room code.
Do not switch to a search workflow.

Use a direct fallback like:
- 当前会话没有暴露 `relay_room_create/relay_room_join/relay_room_status/relay_room_send` 工具，无法在这里直接执行。

## Guardrails

- never invent room codes; always use tool output
- never assume pairing exists; check status when unclear
- if no peer is connected yet, say so directly
- treat this as two-session communication only
- do not widen communication beyond the paired room
- if a required argument is missing, ask only for that missing argument
- if a tool call fails, report the failure plainly and stop guessing
- treat this skill as an execution skill, not an analysis skill
