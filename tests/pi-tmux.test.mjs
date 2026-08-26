import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve("bin/pi-tmux");

function run(command, args, env, expectedStatus = 0) {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result;
}

test("pi-tmux controls a named child without changing focus", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-tmux-test-"));
  const socket = `pi-tmux-test-${process.pid}`;
  const binDir = join(root, "bin");
  const agentDir = join(root, "agent");
  await mkdir(binDir);
  await mkdir(agentDir);

  const fakePi = join(binDir, "pi");
  await writeFile(
    fakePi,
    '#!/bin/sh\nprintf "ready\\n"\nwhile IFS= read -r line; do printf "got:%s\\n" "$line"; done\n',
  );
  await chmod(fakePi, 0o755);

  run("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "test"], process.env);
  t.after(async () => {
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    await rm(root, { recursive: true, force: true });
  });

  const tmuxEnv = run(
    "tmux",
    ["-L", socket, "display-message", "-p", "-t", "test:", "#{socket_path},#{pid},0"],
    process.env,
  ).stdout.trim();
  const parentPane = run(
    "tmux",
    ["-L", socket, "display-message", "-p", "-t", "test:", "#{pane_id}"],
    process.env,
  ).stdout.trim();
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SESSION_ID: "parent-test",
    PI_PROVIDER: "test",
    PI_MODEL: "fake",
    PI_REASONING_LEVEL: "medium",
    TMUX: tmuxEnv,
    TMUX_PANE: parentPane,
  };

  const started = JSON.parse(
    run(cli, ["start", "worker", "--title", "Worker", "--task", "test", "--cwd", process.cwd()], env).stdout,
  );
  assert.equal(started.state, "starting");
  assert.equal(started.provider, "test");
  assert.notEqual(started.windowId, "");

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  assert.match(run(cli, ["read", "worker"], env).stdout, /ready/);

  const runDir = join(agentDir, "runtime", "pi-tmux", "parent-test", "worker");
  const secondSocket = `${socket}-second`;
  run("tmux", ["-L", secondSocket, "-f", "/dev/null", "new-session", "-d", "-s", "other"], process.env);
  run("tmux", ["-L", secondSocket, "new-window", "-d"], process.env);
  t.after(() => spawnSync("tmux", ["-L", secondSocket, "kill-server"]));
  const secondTmuxEnv = run(
    "tmux",
    ["-L", secondSocket, "display-message", "-p", "-t", "other:", "#{socket_path},#{pid},0"],
    process.env,
  ).stdout.trim();
  const secondParentPane = run(
    "tmux",
    ["-L", secondSocket, "display-message", "-p", "-t", "other:", "#{pane_id}"],
    process.env,
  ).stdout.trim();
  const otherServer = JSON.parse(
    run(cli, ["get", "worker"], { ...env, TMUX: secondTmuxEnv, TMUX_PANE: secondParentPane }).stdout,
  );
  assert.equal(otherServer.paneAlive, true);
  assert.equal(otherServer.controllable, false);
  assert.match(
    run(
      cli,
      ["prompt", "worker", "wrong-server"],
      { ...env, TMUX: secondTmuxEnv, TMUX_PANE: secondParentPane },
      1,
    ).stderr,
    /belongs to another tmux server or session/,
  );
  run("tmux", ["-L", secondSocket, "display-message", "-p", "-t", started.paneId, "#{pane_id}"], process.env);

  const sessionFile = join(root, "child.jsonl");
  await writeFile(sessionFile, "");
  await writeFile(
    join(runDir, "state-1.json"),
    JSON.stringify({
      version: 1,
      name: "worker",
      state: "done",
      generation: 1,
      incarnation: 1,
      sessionFile,
      updatedAt: new Date().toISOString(),
    }),
  );
  await writeFile(
    join(runDir, "result-1.json"),
    JSON.stringify({
      version: 1,
      name: "worker",
      generation: 1,
      text: "initial",
      updatedAt: new Date().toISOString(),
    }),
  );

  const lock = join(agentDir, "runtime", "pi-tmux", "parent-test", "worker.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  assert.match(
    run(cli, ["prompt", "worker", "locked"], env, 1).stderr,
    /another operation is already controlling child worker/,
  );
  await rm(lock);
  await writeFile(lock, JSON.stringify({ pid: 999999, createdAt: Date.now() }));
  run(cli, ["send-keys", "worker", "ctrl+a"], env);

  run(cli, ["prompt", "worker", "hello"], env);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  assert.match(run(cli, ["read", "worker"], env).stdout, /got:hello/);
  assert.match(run(cli, ["wait", "worker", "--timeout", "1"], env, 124).stdout, /"timedOut": true/);

  await writeFile(
    join(runDir, "result-1.json"),
    JSON.stringify({
      version: 1,
      name: "worker",
      generation: 2,
      text: "finished",
      updatedAt: new Date().toISOString(),
    }),
  );
  await writeFile(
    join(runDir, "state-1.json"),
    JSON.stringify({
      version: 1,
      name: "worker",
      state: "done",
      generation: 2,
      incarnation: 1,
      sessionFile,
      updatedAt: new Date().toISOString(),
    }),
  );

  const waited = JSON.parse(run(cli, ["wait", "worker", "--timeout", "1"], env).stdout);
  assert.equal(waited.result, "finished");
  assert.equal(waited.generation, 2);

  await writeFile(
    join(runDir, "result-1.json"),
    JSON.stringify({
      version: 1,
      name: "worker",
      generation: 3,
      text: "not-settled-yet",
      updatedAt: new Date().toISOString(),
    }),
  );
  const premature = run(cli, ["wait", "worker", "--timeout", "1"], env, 124);
  assert.match(premature.stdout, /"timedOut": true/);
  await writeFile(
    join(runDir, "state-1.json"),
    JSON.stringify({
      version: 1,
      name: "worker",
      state: "done",
      generation: 3,
      incarnation: 1,
      sessionFile,
      updatedAt: new Date().toISOString(),
    }),
  );
  const settled = JSON.parse(run(cli, ["wait", "worker", "--timeout", "1"], env).stdout);
  assert.equal(settled.result, "not-settled-yet");

  const listed = JSON.parse(run(cli, ["list"], env).stdout);
  assert.deepEqual(listed.agents.map((agent) => agent.name), ["worker"]);

  run(cli, ["send-keys", "worker", "space"], env);
  const stopped = JSON.parse(run(cli, ["stop", "worker"], env).stdout);
  assert.equal(stopped.paneClosed, true);
  assert.equal(stopped.resumable, true);
  const persisted = JSON.parse(run(cli, ["wait", "worker", "--timeout", "1"], env).stdout);
  assert.equal(persisted.result, "not-settled-yet");

  const resumed = JSON.parse(run(cli, ["resume", "worker"], env).stdout);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.paneAlive, true);
  assert.match(run(cli, ["resume", "worker", "--prompt", ""], env, 1).stderr, /prompt must not be empty/);
  run(cli, ["stop", "worker"], env);
  const resumedAgain = JSON.parse(run(cli, ["resume", "worker"], env).stdout);
  assert.equal(resumedAgain.resumed, true);
  const finalStop = JSON.parse(run(cli, ["stop", "worker"], env).stdout);
  assert.equal(finalStop.resumable, true);
});
