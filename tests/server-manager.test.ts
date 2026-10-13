import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerManager, type OwnedRecord, type ServerDeps, type SpawnExit } from "../src/server-manager";

const MIN = 60_000;
const QMD_CMD = "node /x/bin/qmd mcp --http --port 8181";
const CANCELLED = "The QMD server start was cancelled.";
const SHUT_DOWN = "The QMD server manager was shut down.";

interface FakeOptions {
  healthy: boolean;
  /** A spawned server starts answering health on this many polls after its spawn. */
  healthyAfterPolls: number | undefined;
  spawnPid: number | undefined;
  record: OwnedRecord | null;
  log: string;
  /** PIDs that are running. A spawned server is added, and removed again when it exits. */
  alive: number[];
  /** The command line reported for every PID. */
  cmd: string | null;
  /** While true, each health check stays unanswered until `answerHealth` is called for it. */
  deferHealth: boolean;
  /** While true, `saveRecord` throws. */
  saveThrows: boolean;
}

interface FakeState extends FakeOptions {
  settings: { port: number; idleTimeoutMinutes: number };
  spawned: number[];
  killed: Array<[number, "SIGTERM" | "SIGKILL"]>;
  /** Spawns and signals in the order they happened, as "spawn 4242" and "SIGTERM 4242". */
  events: string[];
  healthCalls: number;
  /** Answers the oldest health check that `deferHealth` is holding open. */
  answerHealth(healthy: boolean): void;
  /**
   * Makes a spawned server exit: the latest one, or the one at index `which` in spawn order.
   * Called before any spawn, it applies to the first server as soon as it is spawned.
   */
  exit(result: SpawnExit, which?: number): void;
}

function fake(over: Partial<FakeOptions> = {}): { deps: ServerDeps; s: FakeState } {
  let pollsLeft: number | undefined;
  let earlyExit: SpawnExit | undefined;
  const servers: Array<{ pid: number | undefined; resolve(result: SpawnExit): void }> = [];
  const heldHealth: Array<(healthy: boolean) => void> = [];
  const s: FakeState = {
    healthy: false,
    healthyAfterPolls: undefined,
    spawnPid: 4242,
    record: null,
    log: "",
    cmd: QMD_CMD,
    deferHealth: false,
    saveThrows: false,
    ...over,
    alive: [...(over.alive ?? [])],
    settings: { port: 8181, idleTimeoutMinutes: 60 },
    spawned: [],
    killed: [],
    events: [],
    healthCalls: 0,
    answerHealth(healthy) {
      const answer = heldHealth.shift();
      if (!answer) throw new Error("no health check is waiting for an answer");
      answer(healthy);
    },
    exit(result, which = servers.length - 1) {
      const server = servers[which];
      if (!server) {
        earlyExit = result;
        return;
      }
      s.alive = s.alive.filter((pid) => pid !== server.pid);
      server.resolve(result);
    },
  };
  const deps: ServerDeps = {
    getSettings: () => s.settings,
    health: () => {
      s.healthCalls++;
      if (s.deferHealth) return new Promise<boolean>((resolve) => heldHealth.push(resolve));
      if (!s.healthy && pollsLeft !== undefined && --pollsLeft <= 0) {
        s.healthy = true;
        pollsLeft = undefined;
      }
      return Promise.resolve(s.healthy);
    },
    spawnServer: (port) => {
      const pid = s.spawnPid;
      s.spawned.push(port);
      s.events.push(`spawn ${pid}`);
      if (pid !== undefined) s.alive.push(pid);
      pollsLeft = s.healthyAfterPolls;
      const exit = new Promise<SpawnExit>((resolve) => {
        servers.push({ pid, resolve });
      });
      if (earlyExit) s.exit(earlyExit);
      earlyExit = undefined;
      return { pid, exit };
    },
    logTail: () => s.log,
    isAlive: (pid) => s.alive.includes(pid),
    commandLine: () => s.cmd,
    killGroup: (pid, signal) => {
      s.killed.push([pid, signal]);
      s.events.push(`${signal} ${pid}`);
    },
    loadRecord: () => s.record,
    saveRecord: (record) => {
      if (s.saveThrows) throw new Error("storage unavailable");
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

/** Follows a promise without awaiting it, so a test fails rather than hangs when it never settles. */
function watch(promise: Promise<void>): { state: "pending" | "resolved" | "rejected"; error?: unknown } {
  const seen: { state: "pending" | "resolved" | "rejected"; error?: unknown } = { state: "pending" };
  promise.then(
    () => { seen.state = "resolved"; },
    (error: unknown) => { seen.state = "rejected"; seen.error = error; },
  );
  return seen;
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

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
  it("force-kills five seconds after giving up, and leaves nothing else behind", async () => {
    const { deps, s } = fake({ healthy: false });
    const done = new ServerManager(deps).ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toHaveLength(2); expect(s.record).toBeNull();
  });
  it("dispose clears the force-kill that follows giving up", async () => {
    const { deps, s } = fake({ healthy: false });
    const m = new ServerManager(deps);
    const done = m.ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    m.dispose();
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
  it("stops an owned server that no longer answers before spawning its replacement", async () => {
    const { m, s } = await started();
    s.healthy = false; s.healthyAfterPolls = 1; s.spawnPid = 5151;
    const again = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.events).toEqual(["spawn 4242", "SIGTERM 4242", "spawn 5151"]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    await again;
    expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(4750);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
  it.each([
    ["is dead", (s: FakeState) => { s.alive = []; }],
    ["now belongs to another program", (s: FakeState) => { s.cmd = "vim notes.md"; }],
  ])("replaces an owned server that no longer answers without signalling a PID that %s", async (_name, change) => {
    const { m, s } = await started();
    change(s);
    s.healthy = false; s.healthyAfterPolls = 1; s.spawnPid = 5151;
    const again = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(250);
    await again;
    expect(s.events).toEqual(["spawn 4242", "spawn 5151"]); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(5000);
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

describe("ServerManager checks a PID is still its server before SIGTERM", () => {
  const owning = {
    spawned: () => started(),
    adopted: async () => {
      const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777] });
      const m = new ServerManager(deps);
      await m.adoptIfOurs();
      return { m, s };
    },
  };
  const problems = {
    "is not alive": (s: FakeState) => { s.alive = []; },
    "has the command line of another program": (s: FakeState) => { s.cmd = "vim notes.md"; },
    "has an unreadable command line": (s: FakeState) => { s.cmd = null; },
  };
  const cases: Array<["the idle timer" | "stopIfOwned", keyof typeof owning, keyof typeof problems]> = [];
  for (const trigger of ["the idle timer", "stopIfOwned"] as const)
    for (const source of ["spawned", "adopted"] as const)
      for (const problem of Object.keys(problems) as Array<keyof typeof problems>) cases.push([trigger, source, problem]);

  it.each(cases)("on %s, signals nothing and clears the record when the %s PID %s", async (trigger, source, problem) => {
    const { m, s } = await owning[source]();
    problems[problem](s);
    if (trigger === "stopIfOwned") m.stopIfOwned();
    else await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    m.stopIfOwned();
    expect(s.killed).toEqual([]);
  });
  it("gives up on a server that never answered without checking its PID first", async () => {
    const { deps, s } = fake({ healthy: false, cmd: "vim notes.md" });
    const done = new ServerManager(deps).ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("stops a server that is still starting without checking its PID first", async () => {
    const { deps, s } = fake({ healthy: false, cmd: "vim notes.md" });
    const m = new ServerManager(deps);
    const done = m.ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(1000);
    m.stopIfOwned();
    await failed;
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
});

describe("ServerManager when its server exits", () => {
  it("forgets a server whose launcher exits after it started, and signals nothing", async () => {
    const { m, s } = await started();
    s.exit({ code: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([]); expect(s.record).toBeNull();
  });
  it("does not signal the PID of an exited launcher even when another qmd server now has it", async () => {
    const { m, s } = await started();
    s.exit({ code: 0 });
    s.alive.push(4242);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([]);
  });
  it("keeps the replacement on record when the server it replaced exits later", async () => {
    const { m, s } = await started();
    s.healthy = false; s.healthyAfterPolls = 1; s.spawnPid = 5151;
    const again = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(250);
    await again;
    s.exit({ code: 0 }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toContainEqual([5151, "SIGTERM"]);
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
  it("force-kills the group even when the launcher exited on SIGTERM", async () => {
    const { m, s } = await started();
    m.stopIfOwned();
    s.exit({ code: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(s.record).toBeNull();
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
  // `stopIfOwned` clears the record of a PID that fails the identity test, so these assert before any stop.
  it.each([
    ["a different port", { record: { pid: 777, port: 9000 } }],
    ["a dead pid", { alive: [] }],
    ["another program", { cmd: "vim notes.md" }],
    ["an unreadable command line", { cmd: null }],
    ["a qmd command that is not the server", { cmd: "qmd query notes" }],
    ["an mcp server that is not qmd", { cmd: "node /x/mcp-server --http" }],
    ["no health answer", { healthy: false }],
  ])("refuses adoption with %s at once: no record and no idle timer", async (_name, over) => {
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777], cmd: QMD_CMD, ...over });
    const m = new ServerManager(deps);
    await m.adoptIfOurs();
    expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    m.stopIfOwned();
    expect(s.killed).toEqual([]);
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
    const { m, s } = await started();
    s.healthy = false; // one missed health answer, so the adoption checks alone would clear the record
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

describe("ServerManager overtaken while it waits for a health answer", () => {
  const interruptions = {
    "stopIfOwned": { act: (m: ServerManager) => { m.stopIfOwned(); }, message: CANCELLED },
    "dispose": { act: (m: ServerManager) => { m.dispose(); }, message: SHUT_DOWN },
    "stopIfOwned then dispose": { act: (m: ServerManager) => { m.stopIfOwned(); m.dispose(); }, message: SHUT_DOWN },
    "dispose then stopIfOwned": { act: (m: ServerManager) => { m.dispose(); m.stopIfOwned(); }, message: SHUT_DOWN },
  };
  const cases: Array<[keyof typeof interruptions, boolean]> = [];
  for (const name of Object.keys(interruptions) as Array<keyof typeof interruptions>) cases.push([name, false], [name, true]);

  it.each(cases)("%s during the first health check stops the start before it spawns (health then answers %j)", async (name, answer) => {
    const { deps, s } = fake({ deferHealth: true });
    const m = new ServerManager(deps);
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    interruptions[name].act(m);
    s.deferHealth = false;
    s.answerHealth(answer);
    await flush();
    expect(call.state).toBe("rejected");
    expect(call.error).toMatchObject({ kind: "server-start", message: interruptions[name].message });
    expect(s.spawned).toEqual([]); expect(onStatus).not.toHaveBeenCalled();
    expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.spawned).toEqual([]); expect(s.killed).toEqual([]);
  });
  it("gives a call made right after stopIfOwned a fresh attempt, not the cancelled one", async () => {
    const { deps, s } = fake({ deferHealth: true, healthyAfterPolls: 1 });
    const m = new ServerManager(deps);
    const first = watch(m.ensureRunning());
    m.stopIfOwned();
    const onStatus = vi.fn();
    const second = watch(m.ensureRunning(onStatus));
    expect(s.healthCalls).toBe(2);
    s.answerHealth(false);
    await flush();
    expect(first.state).toBe("rejected"); expect(first.error).toMatchObject({ kind: "server-start", message: CANCELLED });
    expect(second.state).toBe("pending"); expect(s.spawned).toEqual([]);
    const third = watch(m.ensureRunning());
    expect(s.healthCalls).toBe(2); // joined the fresh attempt: the cancelled one settling did not detach it
    s.deferHealth = false;
    s.answerHealth(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(second.state).toBe("resolved"); expect(third.state).toBe("resolved");
    expect(onStatus).toHaveBeenCalledTimes(1); expect(onStatus).toHaveBeenCalledWith("starting");
    expect(s.spawned).toEqual([8181]); expect(s.record).toEqual({ pid: 4242, port: 8181 });
  });
  it("spawns on the new port, not the old one, when the port changes during the first health check", async () => {
    const { deps, s } = fake({ deferHealth: true, healthyAfterPolls: 1 });
    const m = new ServerManager(deps);
    const first = watch(m.ensureRunning());
    s.settings.port = 9000;
    m.stopIfOwned();
    const second = watch(m.ensureRunning());
    expect(s.healthCalls).toBe(2);
    s.deferHealth = false;
    s.answerHealth(false); s.answerHealth(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(first.state).toBe("rejected"); expect(second.state).toBe("resolved");
    expect(s.spawned).toEqual([9000]); expect(s.record).toEqual({ pid: 4242, port: 9000 });
  });
  it("gives a call made right after stopIfOwned a fresh attempt when the stopped one had already spawned", async () => {
    const { deps, s } = fake({ healthy: false });
    const m = new ServerManager(deps);
    const first = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    m.stopIfOwned();
    s.healthyAfterPolls = 1; s.spawnPid = 5151;
    const second = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(250);
    expect(second.state).toBe("resolved");
    expect(s.events).toEqual(["spawn 4242", "SIGTERM 4242", "spawn 5151"]); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    expect(first.state).toBe("rejected"); expect(first.error).toMatchObject({ kind: "server-start", message: CANCELLED });
  });
  it.each(cases)("%s while adoption waits for health leaves the server unowned and its record alone (health then answers %j)", async (name, answer) => {
    const saved = { pid: 777, port: 8181 };
    const { deps, s } = fake({ deferHealth: true, record: saved, alive: [777] });
    const m = new ServerManager(deps);
    const adopting = watch(m.adoptIfOurs());
    interruptions[name].act(m);
    s.deferHealth = false; s.healthy = answer;
    s.answerHealth(answer);
    await flush();
    expect(adopting.state).toBe("resolved");
    expect(s.record).toEqual(saved); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([]); expect(s.record).toEqual(saved);
  });
});

describe("ServerManager shut down in the same tick as a call", () => {
  it("spawns nothing after ensureRunning, stopIfOwned, dispose", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 1 });
    const m = new ServerManager(deps);
    const call = watch(m.ensureRunning());
    m.stopIfOwned(); m.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(call.state).toBe("rejected");
    expect(s.spawned).toEqual([]); expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it("owns nothing after adoptIfOurs, stopIfOwned, dispose", async () => {
    const saved = { pid: 777, port: 8181 };
    const { deps, s } = fake({ healthy: true, record: saved, alive: [777] });
    const m = new ServerManager(deps);
    const adopting = m.adoptIfOurs();
    m.stopIfOwned(); m.dispose();
    await adopting;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toEqual([]); expect(s.record).toEqual(saved);
  });
});

describe("ServerManager after dispose", () => {
  it("rejects ensureRunning without checking health or spawning", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 1 });
    const m = new ServerManager(deps);
    m.dispose();
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await vi.advanceTimersByTimeAsync(1000);
    expect(call.state).toBe("rejected");
    expect(call.error).toMatchObject({ kind: "server-start", message: SHUT_DOWN });
    expect(s.healthCalls).toBe(0); expect(s.spawned).toEqual([]); expect(onStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("arms no idle timer on noteActivity", async () => {
    const { m, s } = await started();
    m.dispose(); m.noteActivity();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
  });
  it("does not adopt", async () => {
    const saved = { pid: 777, port: 8181 };
    const { deps, s } = fake({ healthy: true, record: saved, alive: [777] });
    const m = new ServerManager(deps);
    m.dispose();
    await m.adoptIfOurs();
    expect(s.healthCalls).toBe(0); expect(vi.getTimerCount()).toBe(0); expect(s.record).toEqual(saved);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toEqual([]);
  });
  it("still stops its server on stopIfOwned, as when dispose comes second, and arms no timer", async () => {
    const { m, s } = await started();
    m.dispose(); m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it.each([
    ["stopIfOwned then dispose", (m: ServerManager) => { m.stopIfOwned(); m.dispose(); }],
    ["dispose then stopIfOwned", (m: ServerManager) => { m.dispose(); m.stopIfOwned(); }],
  ])("stops a server that is still starting on %s", async (_name, shutDown) => {
    const { deps, s } = fake({ healthy: false });
    const m = new ServerManager(deps);
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    shutDown(m);
    await flush();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(vi.getTimerCount()).toBe(0);
    expect(call.state).toBe("rejected"); expect(call.error).toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
  });
  it("does not signal a server that was still starting at dispose and has exited since", async () => {
    const { deps, s } = fake({ healthy: false });
    const m = new ServerManager(deps);
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    m.dispose();
    s.exit({ code: 1 });
    await flush();
    m.stopIfOwned();
    expect(s.killed).toEqual([]);
    expect(call.state).toBe("rejected"); expect(call.error).toMatchObject({ kind: "server-start", message: SHUT_DOWN });
  });
  it("leaves the saved record alone when its server exits later", async () => {
    const { m, s } = await started();
    m.dispose();
    s.exit({ code: 0 });
    await flush();
    expect(s.record).toEqual({ pid: 4242, port: 8181 });
  });
});

describe("ServerManager with a failing store or a bad record", () => {
  it("signals its server even when clearing the record throws", async () => {
    const { m, s } = await started();
    s.saveThrows = true;
    expect(() => m.stopIfOwned()).toThrow("storage unavailable");
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
    s.saveThrows = false;
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });
  it.each([0, 1, -5, 1.5, NaN])("clears a record whose pid is %s without looking the process up or signalling", async (pid) => {
    const { deps, s } = fake({ healthy: true, record: { pid, port: 8181 }, alive: [pid] });
    const isAlive = vi.spyOn(deps, "isAlive");
    const commandLine = vi.spyOn(deps, "commandLine");
    const m = new ServerManager(deps);
    await m.adoptIfOurs();
    expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    expect(isAlive).not.toHaveBeenCalled(); expect(commandLine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([]);
  });
});
