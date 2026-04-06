# Team Workflow Quickstart

This repository now exposes a minimal relay-backed team workflow on top of the plugin-first relay runtime.

## What it does

- keeps the current conversation as the **manager**
- creates a relay **group room**
- creates three child worker sessions: `planner`, `implementer`, `reviewer`
- bootstraps those workers so they join the room and report status through relay messages

## Start a workflow

In an OpenCode conversation inside this repository, run:

```text
/team <your task>
```

Example:

```text
/team implement a stable relay workflow status surface
```

The workflow tool will return:

- `runId`
- `roomCode`
- `managerSessionID`
- the child worker sessions that were created

## Check workflow status

In the manager session, use:

```text
relay_team_status
```

or the namespaced plugin alias if that is what the session exposes:

```text
mcp__relay__team_status
```

This returns the current workflow state plus each worker's role, alias, and status.

`relay_team_status` also returns structured worker metadata when the worker reports it through a `[TEAM_*]` JSON payload, including:

- `workflowSource`
- `workflowPhase`
- `progress`
- `evidence`

It also returns a `recentEvents` timeline so the manager can see what actually happened recently instead of relying only on the latest worker snapshot.

## Worker message protocol

Workers use short relay room messages with these markers:

- `[TEAM_READY]` — joined and ready
- `[TEAM_PROGRESS] {"source":"openspec|superpowers|omo","phase":"...","note":"...","progress":40,"evidence":[...],"handoffTo":"manager","deliverables":[...]}` — real work is now underway
- `[TEAM_BLOCKER] {"source":"openspec|superpowers|omo","phase":"...","note":"blocked and needs help","evidence":[...],"handoffTo":"manager"}`
- `[TEAM_DONE] {"source":"openspec|superpowers|omo","phase":"...","note":"completed their part","evidence":[...],"handoffTo":"manager","deliverables":[...]}`

These signals are persisted in the workflow state and are also included in compaction context.

The runtime does **not** parse OMO, Superpowers, or OpenSpec native state machines directly. It only trusts the unified `[TEAM_*]` signals plus health/stale detection.

## Preferred role tooling

Use the workflow systems already exposed in the session environment like this:

1. **planner** → prefer OpenSpec commands/MCP/skills to create or update proposal/spec/design/tasks artifacts for the current change
2. **implementer** → prefer Superpowers execution skills such as writing-plans / executing-plans / subagent-driven-development style flows
3. **reviewer** → prefer OMO review/orchestration capabilities for structured review, escalation, and follow-up

If one of those systems is not actually exposed in the worker session, fall back to the normal local skills/tools in that session and keep reporting through `[TEAM_*]` signals.

## How to coordinate as manager

1. Start the team with `/team ...`
2. Watch `relay_team_status` until workers move from `bootstrapped` / `joined` to `ready`, and then to `in_progress` when real work begins
3. Use normal plugin relay tools for follow-up coordination:
   - `relay_room_send`
   - `relay_thread_create`
   - `relay_message_send`
   - `relay_transcript_export`
4. If a worker becomes `blocked` or `failed`, use `relay_team_status` to identify the role, note, and recent event trail, then coordinate the next action from the manager session

## Important boundary

Normal workflow usage must stay on the **plugin** surface.

- Use `relay_*` or `mcp__relay__*`
- Do **not** use `relay_compat_*` for normal workflow execution

The compatibility path is storage-oriented and does not provide the session-aware relay workflow behavior.
