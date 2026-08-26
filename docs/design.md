# Pi + tmux 子代理设计

## 实现

当前实现位于：

```text
bin/pi-tmux
extensions/pi-tmux/index.ts
tests/pi-tmux.test.mjs
```

Pi package 加载 extension 时会把仓库的 `bin/` 加入当前 Pi 进程的 `PATH`，父 Pi 与子 Pi 使用同一份 CLI。

## 目标

只支持 Pi 和 tmux，为父 Pi 提供一套可发现、可恢复的命令行工作流：

```text
启动 → 命名 → 提示 → 检查 → 等待 → 恢复 → 发送按键
```

子代理必须在可见的 tmux window 中运行，不抢父窗口焦点；父代理通过一个自描述 CLI 操作它们。

## 结论

最佳的最小方案不是复制 `edxeth/pi-subagents`，也不是在父 Pi 中注册一组长期驻留的工具，而是两个小部件：

1. `pi-tmux`：无依赖的 Node CLI，唯一的 tmux 控制入口，并通过 `--skill` 输出内置 Agent 指南。
2. `pi-tmux/index.ts`：仅在子 Pi 中启用的全局 extension，发布结构化状态和最终结果。

这与 Herdr 的“自描述 CLI + 显式 ID”体验一致，同时避免单独安装 skill，以及多 multiplexer adapter、agent profile、后台 worker、worktree、嵌套代理、超时调度、结果 steer 和复杂 TUI。

预估运行时代码约 320～420 行；测试约 200 行。若运行时代码明显超过 500 行，应先检查是否把非目标能力带进了第一版。

## Agent 如何发现工作流

Herdr 不要求预先安装独立 skill。它的 `--help` 在 AI 专用段落中指向 `herdr --skill`，后者把完整的控制规范输出到 stdout。`pi-tmux` 采用同一机制：

```text
$ pi-tmux --help
...
Are you an AI?
  To control Pi subagents in tmux, run: pi-tmux --skill

$ pi-tmux --skill
<完整的启动、等待、读取、恢复和安全规则>
```

父 Pi extension 会为 session 持久化一条隐藏的发现提示，要求 Agent 在需要委派时先运行 `pi-tmux --skill`。指南内嵌在 CLI 中，不创建独立 skill，也不占用 Pi 的常驻 skill 列表。

## 为什么选择自描述 CLI

父 Pi 的 `bash` 工具已经向命令注入 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL` 和 `PI_REASONING_LEVEL`。CLI 可以据此：

- 用父 session ID 隔离命名空间；
- 默认继承当前模型和思考强度；
- 在父 session 恢复后重新找到原来的子代理。

来源：[Pi 环境变量](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md)

使用自描述 CLI 而不是常驻父 extension 还有三个直接收益：

- 不向每次模型请求增加七八个控制工具的 schema；
- 没有父进程 watcher、定时器和结果投递竞态；
- Agent 的执行路径保持可见：隐藏发现提示 → `pi-tmux --skill` → 后续 CLI 命令 → tmux。

## 命令体验

```sh
pi-tmux start <name> --title <title> --task <text> [--cwd <dir>] [--provider <id>] [--model <id>] [--thinking <level>] [--wait]
pi-tmux prompt <name> <text> [--wait]
pi-tmux get <name>
pi-tmux list
pi-tmux read <name> [--lines 120]
pi-tmux wait <name> [--timeout 600]
pi-tmux resume <name> [--prompt <text>] [--provider <id>] [--model <id>] [--thinking <level>] [--wait]
pi-tmux send-keys <name> <key...>
pi-tmux stop <name>
```

约定：

- 名称匹配 `[a-z][a-z0-9_-]{0,31}`，在同一父 session 中唯一。
- `start`、`resume` 和 `prompt` 返回 JSON；`read` 返回 pane 文本。
- `start` 默认异步，`--wait` 返回该轮最终回答。
- `start` 默认继承父 Pi 的 provider、model 和 thinking；显式参数覆盖对应值。
- `resume` 默认使用子 session 已保存的模型设置；只有显式参数才覆盖。
- `prompt` 默认只接受处于 `idle` 或 `done` 的子代理，避免把文本送进确认框或正在输入的 TUI。
- `send-keys` 只接受 `esc`、`enter`、`tab`、方向键和 `ctrl+a` 到 `ctrl+z` 等逻辑键；发送前必须先 `get` 或 `read`。
- 所有 tmux 操作使用明确的 pane ID，不依赖用户当前焦点。

## 人类操作体验

每个子代理使用独立 tmux window，而不是持续分割父 window：

- 父 Pi 保持完整宽度；
- `new-window -d` 不抢焦点；
- 当前 tmux footer 直接展示代理窗口；
- 用户仍可用普通 tmux 快捷键进入窗口并直接和子 Pi 交互。

窗口名称反映状态：

```text
·reviewer   idle
▶reviewer   working
?reviewer   blocked
✓reviewer   done
```

第一版不增加 Pi widget 或 overlay。tmux footer、`list/get` 和可见子窗口已经构成完整反馈环；只有实际使用证明信息仍不足时，再增加父 Pi widget。

## 状态模型

状态不能从 pane 文本或 session 文件增长推断。子 extension 使用 Pi 生命周期事件：

```text
session_start          → idle
agent_start            → working
tool_execution_start   → working / blocked
agent_settled          → done + result generation
session_shutdown       → exited
pane 不存在            → dead（由 CLI 推断）
```

`agent_settled` 在自动重试、自动压缩重试和 follow-up 全部结束后触发，适合作为“这一轮完成”的唯一边界。[Pi extension 生命周期](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#agent_start--agent_end--agent_settled)

已知询问工具（如 `ask_question`）执行期间可标记为 `blocked`。无法识别的自定义 UI 保持 `working`；`unknown` 比错误地宣称完成更安全。

## 持久状态

运行数据放在：

```text
~/.pi/agent/runtime/pi-tmux/<parent-session-id>/<name>/
├── control.json
├── state-<incarnation>.json
├── result-<incarnation>.json
└── task.md
```

- 根目录权限为 `0700`，文件为 `0600`。
- `control.json` 由 CLI 拥有：cwd、pane/window ID、子 session ID、模型和创建时间。
- 每次恢复使用新的 incarnation；子 extension 只写对应的 state/result 文件，旧进程不能覆盖新状态。
- 写入使用同目录临时文件加原子 rename。
- `result.json` 包含递增 generation；每次 `agent_settled` 生成一版结果。
- 最终文本从当前 session branch 中最后一条 assistant message 提取，不解析屏幕。

Pi session 是树结构；extension 应通过 `ctx.sessionManager.getBranch()` 读取当前分支，而不是直接假设 JSONL 最后一行就是结果。[Pi session 格式](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)

## 启动路径

`start` 的路径应保持短而显式：

```text
父 Pi bash
  → pi-tmux start
  → 验证名称、cwd 和 TMUX/PI_SESSION_ID
  → 写 task.md 与初始 control.json
  → tmux new-window -d -P -F ...
  → 直接执行绝对路径的 pi argv
  → 子 extension 写 state/result
```

tmux 3.6 支持 `new-window [shell-command [argument ...]]` 和 `-e KEY=value`。已经用隔离 tmux server 验证：参数、空格、cwd 和环境变量可以直接传递，因此不需要先启动 shell、等待 prompt，再用 `send-keys` 注入启动命令。

子 Pi 启动参数：

- `--session-id <uuid>` 创建稳定、可恢复的 session；
- `--name <title>` 设置 Pi session 名称；
- `--provider`、`--model` 与 `--thinking` 默认取父 Pi 的 `PI_PROVIDER`、`PI_MODEL` 和 `PI_REASONING_LEVEL`，也可由 `start` 参数覆盖；
- `@task.md` 避免把长任务拼进 shell 命令；
- `-e pi-tmux/index.ts` 不需要，因为该 extension 已在全局目录，环境变量决定它是否启用。

## 提示和按键

普通提示与按键必须分开：

- `prompt` 使用命名 tmux buffer、`paste-buffer -p` 和延迟后的 `Enter`，正确处理空格、换行和 bracketed paste。
- `send-keys` 只发送经过映射的逻辑键。
- `prompt` 在 `working`、`blocked` 或 `unknown` 状态下拒绝执行；用户明确需要打断时，先 `read`，再使用 `send-keys esc`。

这一点沿用 Herdr 的安全边界：普通工作走 prompt，交互式控制走受验证的逻辑键；不能把任意字符串解释为 tmux key token。

## 等待与恢复

`wait` 每 250 ms 读取当前 incarnation 的状态文件，等待 `done` 且 generation 达到目标值：

- 已完成时立即返回；
- timeout 只停止等待，不终止子代理；
- pane 消失且没有新结果时返回 `dead`；
- Ctrl-C 中止 CLI 等待，不影响子代理。

`resume`：

1. 若原 pane 仍存在，返回当前状态，不重复启动；
2. 若 pane 已消失，从当前状态文件读取子 session 文件；
3. 在新的 detached tmux window 中执行 `pi --session <file>`；
4. 更新 `control.json` 的 pane/window ID；
5. 可选 prompt 作为恢复后的首条消息。

父 Pi 退出不影响 tmux 中的子 Pi。父 session 恢复后，`PI_SESSION_ID` 不变，因此同一组命名子代理仍然可见。

## 从现有项目保留什么

从 [`edxeth/pi-subagents@v2.8.0`](https://github.com/edxeth/pi-subagents/tree/v2.8.0) 保留：

- 子进程使用独立 Pi session；
- 通过显式 pane ID 创建、读取和关闭 surface；
- 使用 Pi 生命周期状态，而不是 session 文件增长判断活跃度；
- task 写入权限受限的文件；
- 恢复同一个子 session；
- async 与 blocking 两种等待体验。

相关实现：

- [`src/mux/surfaces.ts`](https://github.com/edxeth/pi-subagents/blob/v2.8.0/src/mux/surfaces.ts)
- [`src/mux/io.ts`](https://github.com/edxeth/pi-subagents/blob/v2.8.0/src/mux/io.ts)
- [`src/launch/interactive.ts`](https://github.com/edxeth/pi-subagents/blob/v2.8.0/src/launch/interactive.ts)
- [`src/runtime/result-router.ts`](https://github.com/edxeth/pi-subagents/blob/v2.8.0/src/runtime/result-router.ts)

明确不实现：

- cmux、Herdr、Zellij 和 WezTerm adapter；
- background/headless 子代理；
- agent profile 与项目 agent discovery；
- worktree、自动合并和 verifier；
- 子代理嵌套；
- token/time budget 与自动 wrap-up；
- child-to-parent steer、exactly-once delivery lease；
- 父 Pi overlay 和复杂 widget。

## 内置 Agent 指南的关键规则

`--skill` 输出应要求控制代理：

1. 只在任务可独立委派时启动子代理。
2. task 必须自包含，并显式传入 cwd。
3. 默认不抢焦点。
4. 同步依赖使用 `--wait`；并行任务先全部 `start`，再逐个 `wait`。
5. 不重复执行已经委派的工作。
6. 发送按键前先 `get` 和 `read`。
7. `blocked` 时不得自行回答确认或问题，必须询问用户。
8. 同一工作树只并行执行只读任务或修改范围明确不重叠的任务。
9. 不关闭并非当前父 session 创建的 pane。

## 实现切片

### 1. tmux 控制闭环

实现 `start/list/get/read/send-keys/stop`，用一个假子进程验证：

- window 不抢焦点；
- 名称和 pane ID 稳定；
- 文本读取与逻辑键正确；
- 命令参数不经过 shell 拼接。

预估：CLI 180～220 行，测试 100 行。

### 2. Pi 状态与等待

实现子 extension、`wait` 和 `result`：

- 生命周期状态正确；
- 一轮完成只增加一次 generation；
- 最终文本来自当前 branch；
- timeout、dead pane 和取消可区分。

预估：extension 100～130 行，CLI 增量 50 行，测试 100 行。

### 3. 提示、恢复与 Agent 指南

实现 `prompt/resume` 和内置 `--skill` 输出，并在本机与远端 tmux 各跑一个真实端到端流程：

```text
start --wait → prompt --wait → stop → resume → prompt --wait
```

预估：CLI 增量与内置指南 70～100 行，端到端脚本 50 行。

## 完成标准

- 父 Pi 可以仅依据 `pi-tmux --skill` 的输出完成启动、命名、提示、检查、等待、恢复和按键发送。
- 用户始终能在 tmux 中看到并接管子 Pi。
- 普通操作不改变用户焦点。
- 状态判断不解析 TUI 文本。
- 子代理完成后，`wait` 返回结构化最终结果。
- 父 Pi 和 tmux 客户端重连后仍可恢复同一子 session。
- 本机与远端使用同一实现，不新增运行时依赖。
