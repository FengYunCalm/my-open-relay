# OpenCode A2A Plugin Relay

[English](README.md) | 简体中文

这是一个面向 OpenCode 的插件优先 A2A relay。仓库对外暴露 A2A 风格的 HTTP / JSON-RPC / SSE 接口，把请求桥接到 OpenCode session，并将 MCP 保持为内部运维能力，而不是公开协议。

仓库地址：https://github.com/FengYunCalm/opencode-peer-session-relay

## 仓库内容

- `packages/a2a-protocol` — 共享的 A2A schema，以及 JSON-RPC / task / message / event 合约
- `packages/relay-plugin` — 插件运行时、A2A host、请求路由、持久化、重放与保护逻辑
- `packages/relay-shared` — 小型共享工具与常量
- `tests/` — 协议、插件与端到端验证
- `docs/plans/2026-04-03-opencode-a2a-plugin-relay-implementation-plan.md` — 当前设计所依据的实现计划
- `.opencode/commands/` — 项目内置的 OpenCode commands，用于 team 和 relay ops 工作流
- `.opencode/skills/relay-room/SKILL.md` — 项目内置的 relay-room 执行型 skill
- `assets/skills/relay-ops/SKILL.md` — 面向 operator 的内部 relay ops skill 元数据

## Graphify

- `graphify-out/` 是刻意提交到仓库中的可导航知识库
- 图谱由项目的 graphify watch 工作流刷新，而不是当成可随时丢弃的构建产物

## 当前架构

- **公开协议：** A2A over HTTP JSON-RPC and SSE
- **运行形态：** plugin-first 负责 session hook、room 操作、workflow orchestration 和 session-aware delivery；独立 MCP 仅作为 compatibility-only 能力面
- **投递门控：** `session.status` 是主要调度信号
- **持久化：** 基于本地 SQLite 的 task、audit、session-link、room、thread、message 与 team-run 状态
- **能力暴露面：** plugin relay tools 是主要操作面；独立 MCP 仅作为 compatibility-only 路径，并使用独立 `compat_*` 工具名

## 已实现能力

- Agent Card 暴露
- `sendMessage`、`getTask`、`cancelTask`、`sendMessageStream`
- 私聊 / 群聊房间流程：`relay_room_create`、`relay_room_join`、`relay_room_status`、`relay_room_send`
- 团队治理：`relay_room_members`、`relay_room_set_role`
- durable 线程 / 消息能力：`relay_thread_create`、`relay_thread_list`、`relay_message_list`、`relay_message_send`、`relay_message_mark_read`、`relay_transcript_export`
- workflow 启动与管理：`relay_team_start`、`relay_team_status`、`relay_team_intervene`、`relay_team_apply_policy`
- SSE task event streaming
- 基于空闲状态的 OpenCode session 投递
- 去重、人类接管保护、重放路径、审计轨迹与 worker 进度治理
- 面向公开响应 / 事件的任务元数据脱敏

## OpenCode skill 与本地插件工作流

- 项目内 skill：`.opencode/skills/relay-room/SKILL.md`
- 项目内 commands：`.opencode/commands/team.md`、`.opencode/commands/relay-status.md`、`.opencode/commands/relay-pause.md`、`.opencode/commands/relay-resume.md`、`.opencode/commands/relay-replay.md`
- operator skill 资源：`assets/skills/relay-ops/SKILL.md`
- 本地测试时使用的全局安装目标：
  - plugin bundle：`~/.config/opencode/plugins/opencode-a2a-relay.js`
  - relay MCP bundle：`~/.config/opencode/plugins/opencode-a2a-relay-mcp.js`
- 全局 OpenCode 配置已经包含本地 `relay` MCP server
- 为兼容 OpenCode 1.3.6，本地路径 plugin bundle 采用 `default export { id, server }` 形状

### 仓库内 command 入口

- `/team <task>` — 通过本地 `relay-room` skill 启动或协调 relay-backed workflow
- `/relay-status [taskId]` — 查看 relay 运维状态和最近诊断事件
- `/relay-pause <sessionID> [reason]` — 暂停某个 session 的自动 relay 投递
- `/relay-resume <sessionID>` — 恢复某个 session 的自动 relay 投递
- `/relay-replay <taskId>` — 通过内部 ops surface 重放可恢复任务

### 为什么坚持 plugin-first
普通 room / thread / message 操作必须走 relay plugin tool surface，才能真正触发 session-aware 注入、idle 唤醒和 workflow 状态汇总。
独立 MCP bridge 仍然保留，但只用于兼容和偏存储型操作，并使用独立 `compat_*` 工具名，避免和 plugin relay tools 混淆。
对于正常的 session-aware relay 使用，应优先调用 plugin tools：`relay_room_*`、`relay_thread_*`、`relay_message_*`、`relay_transcript_export`，以及 `relay_team_*`。任何 `relay_compat_*` 都不是标准自动注入路径。
仓库内的 `/relay-*` commands 只是内部 ops MCP surface 的 operator 快捷入口，不替代 plugin-first 的 relay 工具面。

### 私聊房间流程（保持不变）
1. 会话 A 创建一个房间
2. 会话 B 用房间码加入
3. 任一侧把消息转发给配对会话

### 群聊房间流程
1. 会话 A 创建一个**群聊房间**并自动成为 owner / 群主
2. 其他会话使用房间码 **并携带 alias** 加入
3. 群主可以广播给整个房间，也可以按 alias 私聊某个成员
4. agents 可以查看线程、读取 durable 消息、推进已读游标，并导出 transcript

### 团队工作流
1. manager session 运行 `/team <task>`
2. plugin 创建一个 group room 和三个 worker 主会话
3. workers 用固定 alias 入房，并通过 `[TEAM_READY]`、`[TEAM_PROGRESS]`、`[TEAM_BLOCKER]`、`[TEAM_DONE]` 汇报状态
4. manager 通过 `relay_team_status` 查看 ready / active / blocked / completed 状态和最近 workflow timeline
5. manager 使用 `relay_team_intervene` 执行标准化 retry / reassign / unblock 操作，并把结果写入 workflow timeline
6. 只有 reviewer 发出 `phase: "final-acceptance-pass"` 的最终验收完成信号后，team run 才会进入 `completed`
7. run 进入稳定状态后，manager 可以用 `relay_team_cleanup` 删除 worker 主会话，同时保留 relay 历史记录

快速教程：`docs/team-workflow-quickstart.md`

## Requirements

- Node.js `>= 22`
- pnpm `10.8.1`（见 `package.json` 中的 `packageManager`）
- 可运行本地 OpenCode plugin runtime 的 Windows / macOS / Linux 环境

## 获取源码

```bash
git clone https://github.com/FengYunCalm/opencode-peer-session-relay.git
cd opencode-peer-session-relay
```

## 验证

当前工作区的本地验证方式：

```bash
corepack pnpm test
corepack pnpm exec tsc -b --pretty false
```

当前仓库状态可以通过完整本地测试集和 TypeScript 项目构建检查。

## 开发

安装依赖：

```bash
corepack pnpm install
```

运行测试：

```bash
corepack pnpm test
```

运行类型检查：

```bash
corepack pnpm exec tsc -b --pretty false
```

## 我们从 OMO 插件机制里学到了什么

这个仓库的设计明显受到了 OhMyOpenCode / OMO 插件生态的启发，尤其是在插件能力暴露、skill 行为收敛，以及房间式工作流这些方面。

最终落到代码里的几个关键认识是：
- plugin tools 和 standalone MCP tools 是两条不同的运行时暴露链，不能混为一谈
- 执行型 room / team 工作流必须强调“先调工具，再基于工具结果回复”
- OpenCode 1.3.6 对本地路径插件的兼容要求，决定了安装 bundle 必须使用 `default export { id, server }`
- relay plugin 既可能暴露裸 `relay_*` 工具名，也可能暴露等价的 `mcp__relay__*` namespaced alias；这两者都属于 plugin surface，而不是 standalone compatibility path

## 致谢

感谢 OMO / OhMyOpenCode 生态提供的插件实践、运维交互经验和工作流启发，这些内容直接影响了本仓库 relay-room 方案的设计方式。

## 仓库状态

这个仓库以源码为中心，不声明 npm 包、托管部署或其他公开发布渠道。

## 许可证

MIT
