# Pi + tmux 子代理方案调研

## 最终决定

不安装第三方 package。仓库采用仅支持 Pi + tmux 的本地 `pi-tmux`，保留自描述 CLI、显式 pane、结构化状态、等待和恢复，删除多 multiplexer、profile、worktree、嵌套代理和自动 steer。实现契约见 [`pi-tmux-subagents-design.md`](pi-tmux-subagents-design.md)。

## 最接近的现有项目

[`edxeth/pi-subagents`](https://github.com/edxeth/pi-subagents/tree/v2.8.0) 是最接近完整需求的现有实现。它是 MIT 许可的 Pi package，直接支持 tmux 中的可见子代理，也覆盖当前需要的大部分生命周期。

临时比较时应固定到 `v2.8.0`：

```sh
pi -e git:github.com/edxeth/pi-subagents@v2.8.0
```

Pi 的 Git package 支持 tag 或 commit 固定；固定引用不会被普通 package update 移动。第三方 extension 具有当前用户的完整权限，因此正式安装前仍需审查源码。[Pi package 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

## 与目标工作流的对应关系

| 目标 | `edxeth/pi-subagents` |
|---|---|
| 启动 | `subagent` 启动独立 Pi；交互模式会创建 tmux window 或 split |
| 命名 | 每次启动要求机器名和展示标题；可设置子会话标题 |
| 发送消息 | 启动任务直接发送给子代理；恢复时可附带后续任务 |
| 检查 | 父 Pi 的实时 widget 显示运行状态、耗时、活动和上下文用量 |
| 等待 | 支持同步等待；异步结果通过 steer 返回父 Pi |
| 恢复 | `subagent_resume` 恢复原 session，并保留模型、cwd、工具和生命周期设置 |
| 按键 | 内部 tmux backend 使用 `send-keys` 投递启动命令，但没有公开的任意按键工具 |

这些行为由项目的[生命周期说明](https://github.com/edxeth/pi-subagents/blob/v2.8.0/README.md#the-model)、[等待模型](https://github.com/edxeth/pi-subagents/blob/v2.8.0/README.md#launching-and-waiting)、[恢复说明](https://github.com/edxeth/pi-subagents/blob/v2.8.0/README.md#resuming-child-sessions)和[实时 UI](https://github.com/edxeth/pi-subagents/blob/v2.8.0/README.md#ui)定义。tmux adapter 直接调用 `new-window`、`split-window`、`send-keys` 和 `capture-pane`；实现可见于 [`src/mux/surfaces.ts`](https://github.com/edxeth/pi-subagents/blob/v2.8.0/src/mux/surfaces.ts) 与 [`src/mux/io.ts`](https://github.com/edxeth/pi-subagents/blob/v2.8.0/src/mux/io.ts)。

如果需要让父代理发送任意 `Esc`、`Ctrl-C` 等按键，仍需补一个很小的本地工具。先验证现有的启动、等待、结果返回和恢复是否已覆盖实际工作流，再决定是否增加该能力。

## 其他候选

### `HazAT/pi-interactive-subagents`

[`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents) 是 `edxeth/pi-subagents` 的上游起点，采用 MIT 许可，社区使用量更大。它支持 tmux、实时状态、异步结果和恢复，但当前功能与维护进度落后于上述 fork；新部署没有必要退回旧实现。

### `offline-ant/pi-tmux`

[`offline-ant/pi-tmux`](https://github.com/offline-ant/pi-tmux) 的工具表与原始需求最接近：创建、捕获、发送文本或按键、终止以及启动 Pi。它依赖另一个 `pi-semaphore` package 来等待，并且仓库已经归档、GitHub 未识别出许可证。它适合作为简洁 API 的参考，不适合成为当前配置的新依赖。

### `skyfallsin/pi-boss`

[`skyfallsin/pi-boss`](https://github.com/skyfallsin/pi-boss) 提供 tmux split、监控与 steer，但还依赖 `pi-room`，恢复和持久生命周期弱于 `edxeth/pi-subagents`。它更像一个特定的 boss-mode 工作流，而不是通用的 Pi 子代理基础设施。

### Pi 官方示例

Pi 自带的 [`subagent` extension 示例](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)展示独立 Pi 进程、并行与串行调度，但不负责 tmux 可见 pane、状态恢复或人工接管。它适合用来核对 Pi API，不满足完整需求。

## 风险与试用边界

- `edxeth/pi-subagents` 功能面较大，不是一个薄 tmux wrapper；正式采用后应让它拥有子代理生命周期，避免再维护一套平行脚本。
- 子代理与父代理共享当前用户权限；工具 allowlist 不是操作系统沙箱。项目 README 也明确说明这一点。
- tmux 启动依赖当前 Pi 能看到 `TMUX` 和 pane 上下文。可用 `PI_SUBAGENT_MUX=tmux` 强制后端。
- 第一轮只应临时加载固定 tag，验证一个端到端切片：启动命名子代理、等待完成、读取返回结果、附带后续任务恢复。
