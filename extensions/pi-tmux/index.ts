import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
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
const GUIDE_TYPE = "pi-tmux-guide";
const GUIDE =
  "Do tasks yourself by default. Use a visible Pi subagent in tmux only when the user asks for one, or when a substantial, self-contained task can run in parallel while you continue other work. Before using one, run `pi-tmux --skill` and follow its output.";

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

export default function (pi: ExtensionAPI) {
  exposeCli();

  if (!runDir || !name) {
    pi.on("before_agent_start", (_event, ctx) => {
      const alreadyAdded = ctx.sessionManager
        .buildContextEntries()
        .some((entry) => entry.type === "custom_message" && entry.customType === GUIDE_TYPE);
      if (alreadyAdded) return;
      return {
        message: { customType: GUIDE_TYPE, content: GUIDE, display: false },
      };
    });
    return;
  }

  // 普通 Pi 不承担父端 watcher；只有 pi-tmux 启动的子进程发布状态。
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
    if (entryId && entryId !== lastResultEntryId) {
      generation++;
      lastResultEntryId = entryId;
      const result: ResultRecord = {
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
        await writeJsonAtomic(resultPath, result);
      });
      await writes;
    }
    activeTools.clear();
    await publishState("done", ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await publishState("exited", ctx);
  });
}
