import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ChildState = "idle" | "working" | "blocked" | "done" | "exited";

interface StateRecord {
  version: 1;
  name: string;
  state: ChildState;
  activity?: string;
  generation: number;
  incarnation: number;
  pid: number;
  paneId?: string;
  sessionId?: string;
  sessionFile?: string;
  updatedAt: string;
}

interface ResultRecord {
  version: 1;
  name: string;
  generation: number;
  sourceEntryId?: string;
  text: string;
  usage?: unknown;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  updatedAt: string;
}

interface ControlRecord {
  incarnation: number;
}

const runDir = process.env.PI_TMUX_RUN_DIR;
const name = process.env.PI_TMUX_NAME;
const paneId = process.env.TMUX_PANE;
const incarnation = Number(process.env.PI_TMUX_INCARNATION ?? "0");
const BLOCKING_TOOLS = new Set(["ask_question", "ask_user", "question"]);
const PARENT_SOCKET = "parent.sock";

function exposeCli(): void {
  const binDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin");
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!paths.includes(binDir)) process.env.PATH = [binDir, ...paths].join(delimiter);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function latestAssistant(ctx: ExtensionContext): { entryId?: string; message?: AssistantMessage } {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message.role === "assistant") {
      return { entryId: entry.id, message: entry.message };
    }
  }
  return {};
}

function assistantText(message?: AssistantMessage): string {
  if (!message) return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function resultMessage(result: ResultRecord): string {
  const lines = ["[pi-tmux 子任务结果]", `子 Agent：${result.name}`, `轮次：${result.generation}`];
  if (result.errorMessage) lines.push(`错误：${result.errorMessage}`);
  lines.push("结果：", result.text);
  return lines.join("\n");
}

// 父 Pi 在 tmux 中为当前会话监听 socket，把子 Agent 推送的最终结果交给主 Agent。
function listenForResults(pi: ExtensionAPI): void {
  let server: Server | undefined;
  let socketPath: string | undefined;

  const close = async () => {
    server?.close();
    if (socketPath) await rm(socketPath, { force: true });
    server = undefined;
    socketPath = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!process.env.TMUX) return;
    // 与 CLI 的 parentRoot() 保持同一路径，子 Agent 运行目录的上一级就是这里。
    const root = join(
      process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
      "runtime",
      "pi-tmux",
      ctx.sessionManager.getSessionId(),
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    socketPath = join(root, PARENT_SOCKET);
    await rm(socketPath, { force: true });
    server = createServer((socket) => {
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => (body += chunk));
      socket.on("end", () => {
        const result = JSON.parse(body) as ResultRecord;
        pi.sendMessage(
          { customType: "pi-tmux-result", content: resultMessage(result), display: true },
          { deliverAs: "followUp", triggerTurn: true },
        );
      });
    });
    const listening = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      listening.once("error", rejectListen);
      listening.listen(socketPath, resolveListen);
    });
    await chmod(socketPath, 0o600);
  });

  pi.on("session_shutdown", close);
}

export default function (pi: ExtensionAPI) {
  exposeCli();

  if (!runDir || !name) {
    listenForResults(pi);
    return;
  }

  const statePath = join(runDir, `state-${incarnation}.json`);
  const resultPath = join(runDir, `result-${incarnation}.json`);
  const controlPath = join(runDir, "control.json");
  let generation = 0;
  let lastResultEntryId: string | undefined;
  let currentState: StateRecord = {
    version: 1,
    name,
    state: "idle",
    generation,
    incarnation,
    pid: process.pid,
    paneId,
    updatedAt: new Date().toISOString(),
  };
  let writes = Promise.resolve();
  const activeTools = new Map<string, string>();

  const ownsIncarnation = async () => {
    const control = await readJson<ControlRecord>(controlPath);
    return control?.incarnation === incarnation;
  };

  const renameWindow = async (state: ChildState) => {
    if (!paneId) return;
    const marker = state === "working" ? "▶" : state === "blocked" ? "?" : state === "done" ? "✓" : "·";
    await pi.exec("tmux", ["rename-window", "-t", paneId, `${marker}${name}`]).catch(() => undefined);
  };

  const publishState = (
    state: ChildState,
    ctx: ExtensionContext,
    activity?: string,
  ): Promise<void> => {
    currentState = {
      ...currentState,
      state,
      generation,
      activity,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      updatedAt: new Date().toISOString(),
    };
    const snapshot = { ...currentState };
    writes = writes.then(async () => {
      if (!(await ownsIncarnation())) return;
      await writeJsonAtomic(statePath, snapshot);
      await renameWindow(state);
    });
    return writes;
  };

  pi.on("session_start", async (_event, ctx) => {
    const previous = await readJson<ResultRecord>(resultPath);
    generation = previous?.generation ?? 0;
    lastResultEntryId = previous?.sourceEntryId;
    await publishState("idle", ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeTools.clear();
    await publishState("working", ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    activeTools.set(event.toolCallId, event.toolName);
    const blocked = [...activeTools.values()].some((toolName) => BLOCKING_TOOLS.has(toolName));
    await publishState(blocked ? "blocked" : "working", ctx, event.toolName);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    activeTools.delete(event.toolCallId);
    const blocked = [...activeTools.values()].some((toolName) => BLOCKING_TOOLS.has(toolName));
    const activity = [...activeTools.values()].at(-1);
    await publishState(blocked ? "blocked" : "working", ctx, activity);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const { entryId, message } = latestAssistant(ctx);
    let result: ResultRecord | undefined;
    if (entryId && entryId !== lastResultEntryId) {
      generation++;
      lastResultEntryId = entryId;
      const record: ResultRecord = {
        version: 1,
        name,
        generation,
        sourceEntryId: entryId,
        text: assistantText(message),
        usage: message.usage,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        provider: message.provider,
        model: message.model,
        updatedAt: new Date().toISOString(),
      };
      writes = writes.then(async () => {
        if (!(await ownsIncarnation())) return;
        await writeJsonAtomic(resultPath, record);
        result = record;
      });
      await writes;
    }
    activeTools.clear();
    await publishState("done", ctx);
    // 先发布 done 再通知，主 Agent 收到结果后可以立即 prompt 同一个子 Agent。
    // 父 Pi 不在线时连接失败，结果仍可通过 wait 读取。
    if (result) {
      createConnection(join(dirname(runDir), PARENT_SOCKET))
        .on("error", () => undefined)
        .end(JSON.stringify(result));
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await publishState("exited", ctx);
  });
}
