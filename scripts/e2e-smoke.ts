import { connectServer } from "../src/server.js";
import { nodeExec } from "../src/exec.js";
import { tmuxAdapter } from "../src/tmux.js";
import { PaneTracker } from "../src/tracker.js";
import { createWatcher } from "../src/watch.js";
import type { OpenCodeEvent } from "@opencode/client";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
  throw new Error(message);
}

const createdEvent = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.created", data: { sessionID, slug: "smoke", parentID: "ses_smoke" } }) as unknown as OpenCodeEvent;
const terminalEvent = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.idle", data: { sessionID } }) as unknown as OpenCodeEvent;

async function paneCount(run: ReturnType<typeof nodeExec>, session: string): Promise<number> {
  const result = await run.run("tmux", ["list-panes", "-t", session, "-F", "#{pane_id}"]);
  if (!result.ok) fail(`list-panes failed: ${result.stderr}`);
  return result.stdout.trim() === "" ? 0 : result.stdout.trim().split("\n").length;
}

async function main(): Promise<void> {
  const run = nodeExec();

  const tmuxCheck = await run.run("tmux", ["-V"]);
  if (!tmuxCheck.ok) {
    console.log("SMOKE SKIP: tmux not found on PATH");
    process.exit(0);
  }

  const session = `omux-smoke-${process.pid}`;
  const created = await run.run("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "50"]);
  if (!created.ok) fail(`new-session failed: ${created.stderr}`);

  try {
    const target = await run.run("tmux", ["display-message", "-p", "-t", session, "#{pane_id}"]);
    if (!target.ok) fail(`display-message failed: ${target.stderr}`);
    const targetPane = target.stdout.trim();
    if (targetPane === "") fail("no pane id returned for the scratch session");

    const conn = await connectServer();
    await conn.client.server.info();

    let first: OpenCodeEvent | null = null;
    for await (const event of conn.client.event.subscribe({ signal: AbortSignal.timeout(10_000) })) {
      first = event;
      break;
    }
    if (first === null) fail("no event received from the SSE stream within 10s");
    if (first.type !== "server.connected") fail(`expected first event server.connected, got ${first.type}`);

    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const watcher = createWatcher({
      client: conn.client,
      tmux: tmuxAdapter(run),
      tracker,
      log: () => {},
      targetPane,
      layout: "tiled",
      parentID: null,
      paneArgv: () => ["sh", "-c", "sleep 300"],
      tickEveryMs: 200,
    });

    const fakeId = `ses_smoke_${process.pid}`;
    const before = await paneCount(run, session);
    await watcher.dispatch(createdEvent(fakeId));
    await sleep(300);
    const afterOpen = await paneCount(run, session);
    if (afterOpen !== before + 1) fail(`expected ${before + 1} panes after created, got ${afterOpen}`);
    const open = tracker.snapshot().get(fakeId);
    if (open === undefined || open.phase !== "open") fail(`expected open phase, got ${JSON.stringify(open)}`);

    await watcher.dispatch(terminalEvent(fakeId));
    await sleep(1_300);
    await watcher.tick(Date.now());
    const afterClose = await paneCount(run, session);
    if (afterClose !== before) fail(`expected ${before} panes after close, got ${afterClose}`);
    if (tracker.snapshot().get(fakeId) !== undefined) fail("tracker state was not removed after close");
  } finally {
    // Unconditional cleanup: the scratch session dies on success and on failure alike.
    await run.run("tmux", ["kill-session", "-t", session]);
  }

  console.log("SMOKE PASS: real tmux + server connectivity + SSE server.connected + pane open/close");
}

try {
  await main();
} catch (error) {
  console.error(`SMOKE FAIL: ${String(error)}`);
  process.exit(1);
}
