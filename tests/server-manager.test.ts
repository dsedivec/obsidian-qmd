import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerManager, type OwnedRecord, type ServerDeps, type SpawnExit } from "../src/server-manager";

const MIN = 60_000;
const QMD_CMD = "node /x/bin/qmd mcp --http --port 8181";

interface FakeOptions {
  healthy: boolean;
  /** A spawned server starts answering health on this many polls after its spawn. */
  healthyAfterPolls: number | undefined;
  spawnPid: number | undefined;
  record: OwnedRecord | null;
  log: string;
  alive: number[];
  cmd: string | null;
}

interface FakeState extends FakeOptions {
  settings: { port: number; idleTimeoutMinutes: number };
  spawned: number[];
  killed: Array<[number, "SIGTERM" | "SIGKILL"]>;
  /** Resolves the running server's `exit`, or the next server's when none has been spawned yet. */
  exit(result: SpawnExit): void;
}

function fake(over: Partial<FakeOptions> = {}): { deps: ServerDeps; s: FakeState } {
  let pollsLeft: number | undefined;
  let resolveExit: ((result: SpawnExit) => void) | undefined;
  let earlyExit: SpawnExit | undefined;
  const s: FakeState = {
    healthy: false,
    healthyAfterPolls: undefined,
    spawnPid: 4242,
    record: null,
    log: "",
    alive: [],
    cmd: null,
    ...over,
    settings: { port: 8181, idleTimeoutMinutes: 60 },
    spawned: [],
    killed: [],
    exit(result) {
      if (!resolveExit) {
        earlyExit = result;
        return;
      }
      resolveExit(result);
      resolveExit = undefined;
    },
  };
  const deps: ServerDeps = {
    getSettings: () => s.settings,
    health: async () => {
      if (!s.healthy && pollsLeft !== undefined && --pollsLeft <= 0) {
        s.healthy = true;
        pollsLeft = undefined;
      }
      return s.healthy;
    },
    spawnServer: (port) => {
      s.spawned.push(port);
      pollsLeft = s.healthyAfterPolls;
      const exit = new Promise<SpawnExit>((resolve) => {
        resolveExit = resolve;
      });
      if (earlyExit) s.exit(earlyExit);
      earlyExit = undefined;
      return { pid: s.spawnPid, exit };
    },
    logTail: () => s.log,
    isAlive: (pid) => s.alive.includes(pid),
    commandLine: () => s.cmd,
    killGroup: (pid, signal) => {
      s.killed.push([pid, signal]);
    },
    loadRecord: () => s.record,
    saveRecord: (record) => {
      s.record = record;
    },
  };
  return { deps, s };
}

/** A manager whose spawned server (pid 4242 by default) has just become healthy. */
async function started(over: Partial<FakeOptions> = {}): Promise<{ m: ServerManager; s: FakeState }> {
  const { deps, s } = fake({ healthy: false, healthyAfterPolls: 1, ...over });
  const m = new ServerManager(deps);
  const done = m.ensureRunning();
  await vi.advanceTimersByTimeAsync(250);
  await done;
  return { m, s };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ServerManager", () => {
  it("uses a healthy server it did not start and never stops it", async () => {
    const { deps, s } = fake({ healthy: true });
    const m = new ServerManager(deps);
    await m.ensureRunning();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.spawned).toEqual([]); expect(s.killed).toEqual([]);
  });
  it("spawns when nothing answers, waits for health, and records ownership", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 3 });
    const onStatus = vi.fn();
    const done = new ServerManager(deps).ensureRunning(onStatus);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(onStatus).toHaveBeenCalledWith("starting");
    expect(s.spawned).toEqual([8181]); expect(s.record).toEqual({ pid: 4242, port: 8181 });
  });
  it("shares one spawn between concurrent calls", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 2 });
    const m = new ServerManager(deps);
    const both = Promise.all([m.ensureRunning(), m.ensureRunning()]);
    await vi.advanceTimersByTimeAsync(1000); await both;
    expect(s.spawned).toHaveLength(1);
  });
  it.each([
    [{ code: 1 }, "Port 8181 already in use. Try a different port with --port.\n", "port-in-use"],
    [{ code: 127 }, "env: node: No such file or directory\n", "node-not-found"],
    [{ code: null, errorCode: "ENOENT" }, "", "qmd-not-found"],
    [{ code: 1 }, "weird\n", "server-start"],
  ])("fails with the log tail when the launcher exits: %j", async (exit, log, kind) => {
    const { deps, s } = fake({ healthy: false, log });
    const done = new ServerManager(deps).ensureRunning();
    s.exit(exit);
    await expect(done).rejects.toMatchObject({ kind, detail: log });
    expect(s.record).toBeNull();
  });
  it("gives up after 60 seconds and kills what it spawned", async () => {
    const { deps, s } = fake({ healthy: false });
    const done = new ServerManager(deps).ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    expect(s.killed).toContainEqual([4242, "SIGTERM"]); expect(s.record).toBeNull();
  });
  it("stops an owned server after the idle timeout, then force-kills", async () => {
    const { m, s } = await started();          // helper: spawn and become healthy
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });
  it("noteActivity restarts the idle timer", async () => {
    const { m, s } = await started();
    await vi.advanceTimersByTimeAsync(59 * MIN); m.noteActivity();
    await vi.advanceTimersByTimeAsync(59 * MIN); expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 * MIN); expect(s.killed).toContainEqual([4242, "SIGTERM"]);
  });
  it("stopIfOwned signals at once, clears the record, and is idempotent", async () => {
    const { m, s } = await started();
    m.stopIfOwned(); m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
  });
  it("starts a new server after an owned one dies", async () => {
    const { m, s } = await started();
    s.healthy = false; s.healthyAfterPolls = 1;
    const again = m.ensureRunning(); await vi.advanceTimersByTimeAsync(500); await again;
    expect(s.spawned).toHaveLength(2);
  });
  it("adopts a recorded server that is still ours", async () => {
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777], cmd: "node /x/bin/qmd mcp --http --port 8181" });
    const m = new ServerManager(deps);
    await m.adoptIfOurs();
    expect(s.record).toEqual({ pid: 777, port: 8181 });
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toContainEqual([777, "SIGTERM"]);
  });
  it.each([
    ["a different port", { record: { pid: 777, port: 9000 } }],
    ["a dead pid", { alive: [] }],
    ["another program", { cmd: "vim notes.md" }],
    ["an unreadable command line", { cmd: null }],
    ["no health answer", { healthy: false }],
  ])("does not adopt with %s, clears the record, and signals nothing", async (_name, over) => {
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777], cmd: "node /x/bin/qmd mcp --http --port 8181", ...over });
    const m = new ServerManager(deps);
    await m.adoptIfOurs(); m.stopIfOwned();
    expect(s.record).toBeNull(); expect(s.killed).toEqual([]);
  });
});

describe("ServerManager starting", () => {
  it("does not report starting when a server already answers", async () => {
    const { deps } = fake({ healthy: true });
    const onStatus = vi.fn();
    await new ServerManager(deps).ensureRunning(onStatus);
    expect(onStatus).not.toHaveBeenCalled();
  });
  it("reports starting once to every caller waiting on the same spawn", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 2 });
    const m = new ServerManager(deps);
    const [first, second, late] = [vi.fn(), vi.fn(), vi.fn()];
    const early = Promise.all([m.ensureRunning(first), m.ensureRunning(second)]);
    await vi.advanceTimersByTimeAsync(250);
    const joined = m.ensureRunning(late);
    expect(late).toHaveBeenCalledWith("starting");
    await vi.advanceTimersByTimeAsync(250);
    await Promise.all([early, joined]);
    for (const onStatus of [first, second, late]) expect(onStatus).toHaveBeenCalledTimes(1);
    expect(s.spawned).toHaveLength(1);
  });
  it("polls health every 250 ms", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 3 });
    const done = new ServerManager(deps).ensureRunning();
    await vi.advanceTimersByTimeAsync(749);
    expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.record).toEqual({ pid: 4242, port: 8181 });
    await done;
  });
  it("accepts a server that answers just inside the 60 second limit", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 239 });
    const done = new ServerManager(deps).ensureRunning();
    await vi.advanceTimersByTimeAsync(59_750);
    await done;
    expect(s.killed).toEqual([]); expect(s.record).toEqual({ pid: 4242, port: 8181 });
  });
  it("spawns on the port set when the call is made", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 1 });
    s.settings.port = 9000;
    const done = new ServerManager(deps).ensureRunning();
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(s.spawned).toEqual([9000]); expect(s.record).toEqual({ pid: 4242, port: 9000 });
  });
  it("records nothing when the spawn has no pid and a server answers anyway", async () => {
    const { m, s } = await started({ spawnPid: undefined });
    expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([]);
  });
  it("has nothing to kill when a spawn with no pid never answers", async () => {
    const { deps, s } = fake({ healthy: false, spawnPid: undefined });
    const done = new ServerManager(deps).ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    expect(s.killed).toEqual([]); expect(s.record).toBeNull();
  });
  it("leaves no timer and signals nothing when the launcher exits", async () => {
    const { deps, s } = fake({ healthy: false, log: "weird\n" });
    const done = new ServerManager(deps).ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(1000);
    s.exit({ code: 1 });
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
  });
  it("leaves no timer after giving up, and signals the server only once", async () => {
    const { deps, s } = fake({ healthy: false });
    const done = new ServerManager(deps).ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("starts again on the next call after a failed start", async () => {
    const { deps, s } = fake({ healthy: false });
    const m = new ServerManager(deps);
    const first = m.ensureRunning();
    s.exit({ code: 1 });
    await expect(first).rejects.toMatchObject({ kind: "server-start" });
    s.healthyAfterPolls = 1;
    const second = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(250);
    await second;
    expect(s.spawned).toHaveLength(2); expect(s.record).toEqual({ pid: 4242, port: 8181 });
  });
  it("stopIfOwned during startup stops the spawned server and fails the waiting call", async () => {
    const { deps, s } = fake({ healthy: false });
    const m = new ServerManager(deps);
    const done = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(1000);
    m.stopIfOwned();
    await expect(done).rejects.toMatchObject({ kind: "server-start" });
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });
  it("dispose during startup clears the startup timers and signals nothing", async () => {
    const { deps, s } = fake({ healthy: false });
    const m = new ServerManager(deps);
    const done = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(1000);
    m.dispose();
    await expect(done).rejects.toMatchObject({ kind: "server-start" });
    expect(vi.getTimerCount()).toBe(0); expect(s.killed).toEqual([]);
  });
});

describe("ServerManager signals only what it owns", () => {
  it("leaves a healthy server alone even when a saved record names it", async () => {
    const saved = { pid: 999, port: 8181 };
    const { deps, s } = fake({ healthy: true, record: saved, alive: [999], cmd: QMD_CMD });
    const m = new ServerManager(deps);
    await m.ensureRunning();
    m.noteActivity();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    m.dispose();
    expect(s.killed).toEqual([]); expect(s.record).toEqual(saved);
  });
  it("forgets an owned server that stops answering, without signalling it", async () => {
    const { m, s } = await started();
    s.healthy = false; s.healthyAfterPolls = undefined;
    const again = m.ensureRunning();
    const failed = expect(again).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.spawned).toHaveLength(2); expect(s.record).toBeNull();
    s.exit({ code: 1 });
    await failed;
    expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([]);
  });
  it("treats a server that still answers after its own was stopped as external", async () => {
    const { m, s } = await started();
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    const stopped = [[4242, "SIGTERM"], [4242, "SIGKILL"]];
    expect(s.killed).toEqual(stopped);
    await m.ensureRunning();
    m.noteActivity();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.spawned).toHaveLength(1); expect(s.killed).toEqual(stopped);
  });
  it("stops the server it started even after the port setting changes", async () => {
    const { m, s } = await started();
    s.settings.port = 9000;
    m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
  });
  it("never signals a pid whose adoption was refused", async () => {
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777], cmd: "vim notes.md" });
    const m = new ServerManager(deps);
    await m.adoptIfOurs();
    await m.ensureRunning();
    m.noteActivity();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([]);
  });
});

describe("ServerManager stopping", () => {
  it("reads the idle timeout each time the timer starts", async () => {
    const { m, s } = await started();
    s.settings.idleTimeoutMinutes = 5;
    m.noteActivity();
    await vi.advanceTimersByTimeAsync(5 * MIN - 1); expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("dispose cancels the idle stop, keeps the record, and signals nothing", async () => {
    const { m, s } = await started();
    m.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]); expect(s.record).toEqual({ pid: 4242, port: 8181 });
  });
  it("dispose after stopIfOwned cancels the force-kill, as on unload", async () => {
    const { m, s } = await started();
    m.stopIfOwned(); m.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
});

describe("ServerManager adopting", () => {
  it("does nothing when no record was saved", async () => {
    const { deps, s } = fake({ healthy: true, alive: [777], cmd: QMD_CMD });
    const m = new ServerManager(deps);
    await m.adoptIfOurs();
    m.noteActivity();
    expect(vi.getTimerCount()).toBe(0);
    m.stopIfOwned();
    expect(s.killed).toEqual([]); expect(s.record).toBeNull();
  });
  it.each(["qmd query notes", "node /x/mcp-server --http"])("does not adopt a command line of %j", async (cmd) => {
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777], cmd });
    const m = new ServerManager(deps);
    await m.adoptIfOurs(); m.stopIfOwned();
    expect(s.record).toBeNull(); expect(s.killed).toEqual([]);
  });
  it("force-kills an adopted server five seconds after stopping it", async () => {
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777], cmd: QMD_CMD });
    const m = new ServerManager(deps);
    await m.adoptIfOurs();
    m.stopIfOwned();
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]);
  });
  it("keeps the record of a server it started when adoptIfOurs runs afterwards", async () => {
    const { m, s } = await started(); // pid 4242 is not in `alive`, so the adoption checks alone would refuse it
    await m.adoptIfOurs();
    expect(s.record).toEqual({ pid: 4242, port: 8181 });
    m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("does not adopt while its own spawn is still starting", async () => {
    const saved = { pid: 777, port: 8181 };
    const { deps, s } = fake({ healthy: false, record: saved, alive: [777], cmd: QMD_CMD });
    const m = new ServerManager(deps);
    const done = m.ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(0);
    s.healthy = true; // the recorded server answers after all, while pid 4242 is starting
    await m.adoptIfOurs();
    m.stopIfOwned();
    await failed;
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toEqual(saved);
  });
});
