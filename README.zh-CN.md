# OpenCode A2A Plugin Relay

[English README](./README.md)

这是一个面向 OpenCode 的 plugin-first A2A relay 仓库。它对外暴露 A2A HTTP/JSON-RPC/SSE 接口，把请求桥接到 OpenCode 会话内部，并把 MCP 保持为内部运维能力，而不是公共协议面。

仓库地址：<PRIVATE_URL>

## 仓库内容

- `packages/a2a-protocol` —— A2A 协议、JSON-RPC、任务/消息/事件契约
- `packages/relay-plugin` —— 插件运行时、A2A host、请求路由、持久化、重放与防护逻辑
- `packages/relay-shared` —— 小型共享工具与常量
- `tests/` —— protocol、plugin、端到端验证
- `docs/plans/2026-04-03-opencode-a2a-plugin-relay-implementation-plan.md` —— 当前实现所依据的实施方案
- `.opencode/skills/relay-room/SKILL.md` —— 仓库内置的 relay-room 执行型 skill

## 当前架构

- **公共协议面：** A2A over HTTP JSON-RPC 和 SSE
- **运行时形态：** plugin-first，由插件自己负责 host 启动和会话桥接
- **调度门控：** 以 `session.status` 作为主调度信号
- **状态存储：** 本地 SQLite 保存 task、audit、session-link 和房间状态
- **运维能力面：** MCP 仅作为内部能力，不对外承担 agent-to-agent 协议职责

## 已实现能力

- Agent Card 暴露
- `sendMessage`、`getTask`、`cancelTask`、`sendMessageStream`
- 房间码配对流程：`relay_room_create`、`relay_room_join`、`relay_room_status`、`relay_room_send`
- SSE 任务事件流
- 基于 idle 的 OpenCode 会话调度
- 去重、防循环、人工接管、重放、审计链路
- 对公共返回与事件里的 task metadata 做脱敏

## OpenCode skill 与本地插件工作流

- 项目内 skill：`.opencode/skills/relay-room/SKILL.md`
- 本地测试时使用的全局安装目标：`~/.config/opencode/plugins/opencode-a2a-relay.js`
- 为兼容 OpenCode 1.3.6，本地路径插件采用 `default export { id, server }` 形状

典型房间码流程：
1. 会话 A 创建房间
2. 会话 B 用房间码加入
3. 任一侧把消息转发给配对会话

## 验证

当前本地验证方式：

```bash
corepack pnpm test
corepack pnpm exec tsc -b --pretty false
```

截至当前版本，仓库可以通过完整本地测试集和 TypeScript 构建检查。

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

这个仓库的设计明显受到了 OhMyOpenCode / OMO 插件生态的启发，尤其是在插件能力暴露、skill 行为收敛、以及“房间式双会话工作流”这些方面。

最终落到代码里的几个关键认识是：
- plugin tools 和 MCP tools 是两条不同的运行时暴露链，不能混为一谈
- 房间码这种执行型工作流，skill 文案必须强调“先调工具，再基于工具结果回复”
- OpenCode 1.3.6 对本地路径插件的兼容要求，决定了安装 bundle 必须使用 `default export { id, server }`

## 致谢

感谢 OMO / OhMyOpenCode 生态提供的插件实践、运维交互经验和工作流启发，这些内容直接影响了本仓库 relay-room 方案的设计方式。

## 仓库状态

这个目录已经从更大的父级工作区中拆分成了独立仓库，可以单独开源发布与维护。

## License

MIT
