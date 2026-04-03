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

## 当前架构

- **公开协议：** A2A over HTTP JSON-RPC and SSE
- **运行形态：** plugin-first；由插件负责 host 启动与 session bridge
- **投递门控：** `session.status` 是主要调度信号
- **持久化：** 基于 SQLite 的 task、audit 与 session-link 存储
- **运维接口：** 仅保留内部 MCP，不作为公开的 agent-to-agent 接口

## 已实现能力

- Agent Card 暴露
- `sendMessage`、`getTask`、`cancelTask`、`sendMessageStream`
- SSE task event streaming
- 基于空闲状态的 OpenCode session 投递
- 去重、人类接管保护、重放路径与审计轨迹
- 面向公开响应 / 事件的任务元数据脱敏

## 验证

当前本地验证命令：

```bash
corepack pnpm test
corepack pnpm exec tsc -b --pretty false
```

在编写本 README 时，仓库可以通过完整本地测试集与 TypeScript 项目构建。

## 开发

安装依赖：

```bash
corepack pnpm install
```

运行测试：

```bash
corepack pnpm test
```

运行 typecheck：

```bash
corepack pnpm exec tsc -b --pretty false
```

## 仓库状态

这个仓库已经从原来的大工作区中拆分为独立仓库，便于单独发布和维护。

## 许可证

MIT
