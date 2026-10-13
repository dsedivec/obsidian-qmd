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
  /**
   * PIDs whose process group still has a live member. A spawned server is added. It is removed
   * when its launcher exits, unless `groupSurvivesExit` says the server it spawned lives on.
   */
  alive: number[];
  groupSurvivesExit: boolean;
  /** The command lines reported for every process group. */
  cmd: string | null;
  /** While true, each health check stays unanswered until `answerHealth` is called for it. */
  deferHealth: boolean;
  /** While true, `saveRecord` throws. */
  saveThrows: boolean;
  /**
   * The signal that ends a process group the moment it is sent. By default none does: the group
   * stays in `alive` until a test takes it out.
   */
  diesOn: "SIGTERM" | "SIGKILL" | undefined;
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
    groupSurvivesExit: false,
    deferHealth: false,
    saveThrows: false,
    diesOn: undefined,
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
      if (!s.groupSurvivesExit) s.alive = s.alive.filter((pid) => pid !== server.pid);
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
      if (signal === s.diesOn) s.alive = s.alive.filter((member) => member !== pid);
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

/** The ways a stop or a shutdown can overtake a wait, and what the waiting `ensureRunning` call is then told. */
const interruptions = {
  "stopIfOwned": { act: (m: ServerManager) => { m.stopIfOwned(); }, message: CANCELLED },
  "dispose": { act: (m: ServerManager) => { m.dispose(); }, message: SHUT_DOWN },
  "stopIfOwned then dispose": { act: (m: ServerManager) => { m.stopIfOwned(); m.dispose(); }, message: SHUT_DOWN },
  "dispose then stopIfOwned": { act: (m: ServerManager) => { m.dispose(); m.stopIfOwned(); }, message: SHUT_DOWN },
};
type Interruption = keyof typeof interruptions;
const INTERRUPTIONS = Object.keys(interruptions) as Interruption[];
/**
 * For a recorded server that the adoption is still asking about: a stop that comes first settles
 * its record there and then, and `dispose` alone, or first, ends the adoption and leaves the
 * record for the next load.
 */
const STOP_FIRST = INTERRUPTIONS.filter((name) => name.startsWith("stopIfOwned"));
const DISPOSE_FIRST = INTERRUPTIONS.filter((name) => name.startsWith("dispose"));

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
    s.alive = []; // dead: with its group still there, the start would first wait for it to go
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
  ])("does not adopt with %s, clears the record, and signals nothing", async (_name, over) => {
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777], cmd: "node /x/bin/qmd mcp --http --port 8181", ...over });
    const m = new ServerManager(deps);
    await m.adoptIfOurs(); m.stopIfOwned();
    expect(s.record).toBeNull(); expect(s.killed).toEqual([]);
  });
  // The one refusal that does not end with nothing signalled: a recorded server that is identified
  // down to its port and does not answer is stopped, since nothing else ever would stop it.
  it("does not adopt with no health answer, clears the record, and stops the server it has identified", async () => {
    const { deps, s } = fake({ healthy: false, record: { pid: 777, port: 8181 }, alive: [777], cmd: "node /x/bin/qmd mcp --http --port 8181" });
    const m = new ServerManager(deps);
    const adopting = m.adoptIfOurs();
    await vi.advanceTimersByTimeAsync(3000);
    await adopting; m.stopIfOwned();
    expect(s.record).toBeNull(); expect(s.killed).toEqual([[777, "SIGTERM"]]);
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
  it("still force-kills five seconds after giving up when dispose follows", async () => {
    const { deps, s } = fake({ healthy: false });
    const m = new ServerManager(deps);
    const done = m.ensureRunning();
    const failed = expect(done).rejects.toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    m.dispose();
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toHaveLength(2);
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
  it.each([
    ["has the command line of another program", { cmd: "vim notes.md" }],
    ["has no live process group", { alive: [] }],
    ["has an unreadable command line", { cmd: null }],
  ])("uses a healthy server as an external one, and never signals it, when the saved record's PID %s", async (_name, over) => {
    const { deps, s } = fake({ healthy: true, record: { pid: 999, port: 8181 }, alive: [999], cmd: QMD_CMD, ...over });
    const m = new ServerManager(deps);
    await m.ensureRunning();
    // The record named something that is not the plugin's server, and is gone. The server that answers is another's.
    expect(s.record).toBeNull(); expect(s.spawned).toEqual([]);
    m.noteActivity();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    m.dispose();
    expect(s.killed).toEqual([]); expect(s.spawned).toEqual([]); expect(s.record).toBeNull();
  });
  it("adopts a healthy server that a saved record names when ensureRunning is the first call, and stops it at idle like any owned server", async () => {
    const saved = { pid: 999, port: 8181 };
    const { deps, s } = fake({ healthy: true, record: saved, alive: [999], cmd: QMD_CMD });
    const m = new ServerManager(deps);
    await m.ensureRunning();
    expect(s.spawned).toEqual([]); expect(s.killed).toEqual([]); expect(s.record).toEqual(saved);
    expect(vi.getTimerCount()).toBe(1); // its idle timer: it is owned
    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[999, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[999, "SIGTERM"], [999, "SIGKILL"]]); expect(s.spawned).toEqual([]);
  });
  it("checks that server's PID again before it stops it at idle, as for any owned server", async () => {
    const { deps, s } = fake({ healthy: true, record: { pid: 999, port: 8181 }, alive: [999], cmd: QMD_CMD });
    const m = new ServerManager(deps);
    await m.ensureRunning();
    s.cmd = "vim notes.md"; // the PID belongs to another program by the time the idle timer fires
    await vi.advanceTimersByTimeAsync(60 * MIN + 5000);
    expect(s.killed).toEqual([]); expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it("stops an owned server that no longer answers before spawning its replacement", async () => {
    const { m, s } = await started({ diesOn: "SIGTERM" });
    s.healthy = false; s.healthyAfterPolls = 1; s.spawnPid = 5151;
    const again = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    // In the same tick only because SIGTERM ends this group at once. One that lingers is waited for:
    // see "ServerManager replacing its own server that stopped answering".
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
    "has qmd and mcp only in different processes of its group": (s: FakeState) => { s.cmd = "vim qmd-notes.md\nnode mcp-inspector"; },
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
  it("forgets a server once its launcher has exited and its group is gone, and signals nothing", async () => {
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
  it("does not signal the PID of a group that is gone even when another qmd server has it later", async () => {
    const { m, s } = await started();
    s.exit({ code: 0 });
    await flush();
    s.alive.push(4242);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([]);
  });
  it("keeps owning a server whose launcher exits while its group lives on, and the idle timer still stops it", async () => {
    const { s } = await started({ groupSurvivesExit: true });
    s.exit({ code: null });
    await flush();
    expect(s.record).toEqual({ pid: 4242, port: 8181 }); expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });
  it("keeps owning a server whose launcher exits while its group lives on, and stopIfOwned still stops it", async () => {
    const { m, s } = await started({ groupSurvivesExit: true });
    s.exit({ code: null });
    await flush();
    m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });
  it("forgets without signalling when the surviving group has died by the time it is stopped", async () => {
    const { m, s } = await started({ groupSurvivesExit: true });
    s.exit({ code: null });
    await flush();
    s.alive = [];
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([]); expect(s.record).toBeNull();
  });
  it("stops the group left behind when the launcher exits during startup", async () => {
    const log = "Port 8181 already in use. Try a different port with --port.\n";
    // The command line is unreadable here: a live group is enough, since it was spawned moments ago.
    const { deps, s } = fake({ healthy: false, log, groupSurvivesExit: true, cmd: null });
    const call = watch(new ServerManager(deps).ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    s.exit({ code: 1 });
    await flush();
    expect(call.state).toBe("rejected"); expect(call.error).toMatchObject({ kind: "port-in-use", detail: log });
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
  });
  it("signals nothing when the launcher exits during startup and its group is gone", async () => {
    const { deps, s } = fake({ healthy: false, log: "weird\n" });
    const call = watch(new ServerManager(deps).ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    s.exit({ code: 1 });
    await flush();
    expect(call.state).toBe("rejected"); expect(call.error).toMatchObject({ kind: "server-start", detail: "weird\n" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]); expect(s.record).toBeNull();
  });
  it("signals nothing when a spawn with no pid reports its failure", async () => {
    const { deps, s } = fake({ healthy: false, spawnPid: undefined, groupSurvivesExit: true });
    const isAlive = vi.spyOn(deps, "isAlive");
    const call = watch(new ServerManager(deps).ensureRunning());
    s.exit({ code: null, errorCode: "ENOENT" });
    await flush();
    expect(call.state).toBe("rejected"); expect(call.error).toMatchObject({ kind: "qmd-not-found" });
    expect(isAlive).not.toHaveBeenCalled(); expect(s.killed).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the replacement on record when the server it replaced exits later", async () => {
    const { m, s } = await started();
    s.healthy = false; s.healthyAfterPolls = 1; s.spawnPid = 5151;
    const again = m.ensureRunning();
    // The replaced server is still there, so the replacement is spawned only once the six-second
    // wait for it has run out.
    await vi.advanceTimersByTimeAsync(6000 + 250);
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
  it("still force-kills five seconds after stopIfOwned when dispose follows, as on plugin unload", async () => {
    const { m, s } = await started();
    m.stopIfOwned(); m.dispose();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toHaveLength(2);
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
    ["qmd and mcp only in different processes of the group", { cmd: "vim qmd-notes.md\nnode mcp-inspector" }],
    // No health answer is not among these: that is decided only after three seconds. See
    // "ServerManager at load, with a recorded server that does not answer".
  ])("refuses adoption with %s at once: no record and no idle timer", async (_name, over) => {
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777], cmd: QMD_CMD, ...over });
    const m = new ServerManager(deps);
    await m.adoptIfOurs();
    expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    m.stopIfOwned();
    expect(s.killed).toEqual([]);
  });
  it.each([
    ["the idle timer", async () => { await vi.advanceTimersByTimeAsync(60 * MIN); }],
    ["stopIfOwned", async (m: ServerManager) => { m.stopIfOwned(); }],
  ])("adopts a group in which one process names both qmd and mcp, and %s stops it", async (_name, stop) => {
    const cmd = "/bin/sh wrapper\nnode /x/dist/cli/qmd.js mcp --http --port 8181";
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777], cmd });
    const m = new ServerManager(deps);
    await m.adoptIfOurs();
    expect(s.record).toEqual({ pid: 777, port: 8181 }); expect(vi.getTimerCount()).toBe(1);
    await stop(m);
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull();
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
    s.healthy = false; // one missed health answer
    await m.adoptIfOurs(); // the one adoption was made at the first start, and found no record: this call does nothing
    expect(s.record).toEqual({ pid: 4242, port: 8181 });
    m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
});

describe("ServerManager overtaken while it waits for a health answer", () => {
  const cases: Array<[Interruption, boolean]> = [];
  for (const name of INTERRUPTIONS) cases.push([name, false], [name, true]);

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
    // SIGTERM ends the stopped group at once here. One that lingers is waited for: see
    // "ServerManager spawning on a port where it has stopped a server".
    const { deps, s } = fake({ healthy: false, diesOn: "SIGTERM" });
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
  it.each(cases.filter(([name]) => DISPOSE_FIRST.includes(name)))("%s while adoption waits for health leaves the server unowned and its record alone (health then answers %j)", async (name, answer) => {
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
  it.each(cases.filter(([name]) => STOP_FIRST.includes(name)))("%s while adoption waits for health leaves the server unowned, stops it as the plugin's own, and clears its record (health then answers %j)", async (name, answer) => {
    const saved = { pid: 777, port: 8181 };
    const { deps, s } = fake({ deferHealth: true, record: saved, alive: [777] });
    const m = new ServerManager(deps);
    const adopting = watch(m.adoptIfOurs());
    interruptions[name].act(m);
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull();
    s.deferHealth = false; s.healthy = answer;
    s.answerHealth(answer);
    await flush();
    expect(adopting.state).toBe("resolved");
    expect(vi.getTimerCount()).toBe(1); // the force-kill alone: no idle timer, so it is not owned
    await vi.advanceTimersByTimeAsync(60 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]); expect(s.record).toBeNull();
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
  it("owns nothing after adoptIfOurs, stopIfOwned, dispose, and has stopped the recorded server", async () => {
    const saved = { pid: 777, port: 8181 };
    const { deps, s } = fake({ healthy: true, record: saved, alive: [777] });
    const m = new ServerManager(deps);
    const adopting = m.adoptIfOurs();
    m.stopIfOwned(); m.dispose();
    await adopting;
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull();
    expect(vi.getTimerCount()).toBe(1); // the force-kill alone: no idle timer
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]); expect(s.record).toBeNull();
  });
  it("owns nothing and signals nothing after adoptIfOurs, dispose", async () => {
    const saved = { pid: 777, port: 8181 };
    const { deps, s } = fake({ healthy: true, record: saved, alive: [777] });
    const m = new ServerManager(deps);
    const adopting = m.adoptIfOurs();
    m.dispose();
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
  it("still stops its server on stopIfOwned, force-kill included, as when dispose comes second", async () => {
    const { m, s } = await started();
    m.dispose(); m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toHaveLength(2);
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
    // One timer is left: the force-kill. The startup poll and deadline are gone.
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(vi.getTimerCount()).toBe(1);
    expect(call.state).toBe("rejected"); expect(call.error).toMatchObject({ kind: "server-start" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toHaveLength(2); expect(s.record).toBeNull();
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

describe("ServerManager held in use", () => {
  it("does not stop a held server at the idle timeout, and counts the whole timeout again from the release", async () => {
    const { m, s } = await started();
    await vi.advanceTimersByTimeAsync(59 * MIN);
    const release = m.hold();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(180 * MIN);
    expect(s.killed).toEqual([]); expect(s.record).toEqual({ pid: 4242, port: 8181 });
    release();
    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });
  it("starts the idle timer only when the last of two overlapping holds is released", async () => {
    const { m, s } = await started();
    const first = m.hold();
    const second = m.hold();
    first();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
    second();
    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("takes a second call of the same release for nothing: another hold still holds", async () => {
    const { m, s } = await started();
    const first = m.hold();
    const second = m.hold();
    first(); first();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
    second();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("takes a second call of the same release for nothing: the count does not go below zero", async () => {
    const { m, s } = await started();
    const first = m.hold();
    first(); first();
    const second = m.hold();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
    second();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("takes a second call of the same release for nothing: the idle timer is not started again", async () => {
    const { m, s } = await started();
    const release = m.hold();
    release();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    release();
    await vi.advanceTimersByTimeAsync(30 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("still stops the server on stopIfOwned during a hold, and the release then arms nothing", async () => {
    const { m, s } = await started();
    const release = m.hold();
    m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    release();
    expect(vi.getTimerCount()).toBe(1); // the force-kill
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start the idle timer on noteActivity during a hold", async () => {
    const { m, s } = await started();
    const release = m.hold();
    m.noteActivity();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("reads the idle timeout when the last hold is released", async () => {
    const { m, s } = await started();
    const release = m.hold();
    s.settings.idleTimeoutMinutes = 5;
    release();
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("defers the first idle timer of a server spawned during a hold until the release", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 1 });
    const m = new ServerManager(deps);
    const release = m.hold();
    const done = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(s.record).toEqual({ pid: 4242, port: 8181 }); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
  });
  it("defers the idle timer of a server adopted during two holds until the second release", async () => {
    const { deps, s } = fake({ healthy: true, record: { pid: 777, port: 8181 }, alive: [777] });
    const m = new ServerManager(deps);
    const first = m.hold();
    const second = m.hold();
    await m.adoptIfOurs();
    expect(s.record).toEqual({ pid: 777, port: 8181 }); expect(vi.getTimerCount()).toBe(0);
    first();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
    second();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.killed).toEqual([[777, "SIGTERM"]]);
  });
  it("counts a hold on a server it does not own, arms nothing, and never signals it", async () => {
    const { deps, s } = fake({ healthy: true });
    const m = new ServerManager(deps);
    await m.ensureRunning();
    const release = m.hold();
    release();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.spawned).toEqual([]); expect(s.killed).toEqual([]);
  });
  it("does not keep ensureRunning from stopping a held server that no longer answers, and holds its replacement", async () => {
    const { m, s } = await started({ diesOn: "SIGTERM" });
    const release = m.hold();
    s.healthy = false; s.healthyAfterPolls = 1; s.spawnPid = 5151;
    const again = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(250);
    await again;
    expect(s.events).toEqual(["spawn 4242", "SIGTERM 4242", "spawn 5151"]); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    release();
    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(s.killed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"], [5151, "SIGTERM"]]);
  });
  it("arms nothing when a hold is released after its server has exited", async () => {
    const { m, s } = await started();
    const release = m.hold();
    s.exit({ code: 1 });
    await flush();
    expect(s.record).toBeNull();
    release();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
  });
  it("gives a no-op after dispose, which arms nothing", async () => {
    const { m, s } = await started();
    m.dispose();
    const release = m.hold();
    release(); release();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]); expect(s.record).toEqual({ pid: 4242, port: 8181 });
  });
  it("arms nothing when a hold taken before dispose is released after it", async () => {
    const { m, s } = await started();
    const release = m.hold();
    m.dispose();
    release();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]); expect(s.record).toEqual({ pid: 4242, port: 8181 });
  });
  it("still stops the server on stopIfOwned after dispose during a hold, force-kill included", async () => {
    const { m, s } = await started();
    const release = m.hold();
    m.dispose(); m.stopIfOwned();
    release();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ServerManager replacing its own server that stopped answering", () => {
  const BEFORE_SPAWN = ["spawn 4242", "SIGTERM 4242"];

  /** A manager whose own server (pid 4242) no longer answers health. Its replacement will be pid 5151. */
  async function unresponsive(over: Partial<FakeOptions> = {}): Promise<{ m: ServerManager; s: FakeState }> {
    const { m, s } = await started(over);
    s.healthy = false; s.healthyAfterPolls = 1; s.spawnPid = 5151;
    return { m, s };
  }

  it("says it is starting, then spawns only once the old group is gone, and records the new server", async () => {
    const { m, s } = await unresponsive();
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await flush();
    expect(s.events).toEqual(BEFORE_SPAWN); expect(s.record).toBeNull();
    expect(onStatus).toHaveBeenCalledTimes(1); expect(onStatus).toHaveBeenCalledWith("starting");
    await vi.advanceTimersByTimeAsync(999);
    expect(s.events).toEqual(BEFORE_SPAWN); expect(call.state).toBe("pending");
    s.alive = [];
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...BEFORE_SPAWN, "spawn 5151"]); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    expect(onStatus).toHaveBeenCalledTimes(1);
    // The old server's force-kill still comes, and reaches the old PID alone.
    await vi.advanceTimersByTimeAsync(3750);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    // The replacement is owned like any other: its idle timer began when it answered.
    await vi.advanceTimersByTimeAsync(60 * MIN - 3750 - 1);
    expect(s.killed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"], [5151, "SIGTERM"]]);
  });
  it("looks for the old group every 250 ms", async () => {
    const { m, s } = await unresponsive();
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(100);
    s.alive = [];
    await vi.advanceTimersByTimeAsync(149);
    expect(s.events).toEqual(BEFORE_SPAWN);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...BEFORE_SPAWN, "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved");
  });
  it("spawns in the same tick when SIGTERM ends the old group at once", async () => {
    const { m, s } = await unresponsive({ diesOn: "SIGTERM" });
    const call = watch(m.ensureRunning());
    await flush();
    expect(s.events).toEqual([...BEFORE_SPAWN, "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved");
  });
  it("spawns right after the force-kill when only that ends the old group", async () => {
    const { m, s } = await unresponsive({ diesOn: "SIGKILL" });
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.events).toEqual(BEFORE_SPAWN); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...BEFORE_SPAWN, "SIGKILL 4242", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
  it("spawns anyway after six seconds when the old group never goes, and the start then fails as before", async () => {
    const log = "Port 8181 already in use. Try a different port with --port.\n";
    const { m, s } = await unresponsive({ log });
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(5999);
    expect(s.events).toEqual([...BEFORE_SPAWN, "SIGKILL 4242"]); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...BEFORE_SPAWN, "SIGKILL 4242", "spawn 5151"]);
    s.exit({ code: 1 });
    await flush();
    expect(call.state).toBe("rejected"); expect(call.error).toMatchObject({ kind: "port-in-use", detail: log });
    expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    ["is dead", (s: FakeState) => { s.alive = []; }],
    ["now belongs to another program", (s: FakeState) => { s.cmd = "vim notes.md"; }],
    ["has an unreadable command line", (s: FakeState) => { s.cmd = null; }],
  ])("spawns at once, with no wait and no signal, when the PID it owned %s", async (_name, change) => {
    const { m, s } = await unresponsive();
    change(s);
    const call = watch(m.ensureRunning());
    await flush();
    expect(s.events).toEqual(["spawn 4242", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(s.killed).toEqual([]);
  });
  it.each(INTERRUPTIONS)("%s during the wait ends the start without spawning, and leaves only the old server's force-kill", async (name) => {
    const { m, s } = await unresponsive();
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await vi.advanceTimersByTimeAsync(1000);
    interruptions[name].act(m);
    await flush();
    expect(call.state).toBe("rejected");
    expect(call.error).toMatchObject({ kind: "server-start", message: interruptions[name].message });
    expect(s.events).toEqual(BEFORE_SPAWN); expect(vi.getTimerCount()).toBe(1);
    s.alive = []; // the old group goes now: nothing may be spawned in its place
    await vi.advanceTimersByTimeAsync(3999);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.events).toEqual([...BEFORE_SPAWN, "SIGKILL 4242"]); expect(s.record).toBeNull();
    expect(onStatus).toHaveBeenCalledTimes(1);
  });
  it("shares the wait between callers, and tells one that joins during it at once that a server is starting", async () => {
    const { m, s } = await unresponsive();
    const [early, late] = [vi.fn(), vi.fn()];
    const first = watch(m.ensureRunning(early));
    await vi.advanceTimersByTimeAsync(1000);
    const healthCalls = s.healthCalls;
    const second = watch(m.ensureRunning(late));
    expect(late).toHaveBeenCalledTimes(1); expect(late).toHaveBeenCalledWith("starting");
    expect(s.healthCalls).toBe(healthCalls); // it joined the attempt: no health check of its own
    s.alive = [];
    await vi.advanceTimersByTimeAsync(500);
    expect(first.state).toBe("resolved"); expect(second.state).toBe("resolved");
    expect(s.events).toEqual([...BEFORE_SPAWN, "spawn 5151"]);
    for (const onStatus of [early, late]) expect(onStatus).toHaveBeenCalledTimes(1);
  });
  it("gives a call made right after stopIfOwned during the wait a fresh attempt, which waits for the old group in its turn", async () => {
    const { m, s } = await unresponsive();
    const first = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    m.stopIfOwned();
    const onStatus = vi.fn();
    const second = watch(m.ensureRunning(onStatus));
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.state).toBe("rejected"); expect(first.error).toMatchObject({ kind: "server-start", message: CANCELLED });
    expect(second.state).toBe("pending"); expect(onStatus).toHaveBeenCalledTimes(1); expect(s.events).toEqual(BEFORE_SPAWN);
    s.alive = [];
    await vi.advanceTimersByTimeAsync(500);
    expect(second.state).toBe("resolved");
    expect(s.events).toEqual([...BEFORE_SPAWN, "spawn 5151"]); expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
});

describe("ServerManager at load, with a recorded server that does not answer", () => {
  const SERVER_CMD = "node /x/dist/cli/qmd.js mcp --http --port 8181";
  const saved = { pid: 777, port: 8181 };

  /** A manager with a record of a live server, pid 777, that is the plugin's by its command line and does not answer health. */
  function recorded(over: Partial<FakeOptions> = {}): { m: ServerManager; s: FakeState } {
    const { deps, s } = fake({ healthy: false, record: saved, alive: [777], cmd: SERVER_CMD, ...over });
    return { m: new ServerManager(deps), s };
  }

  it("stops it after three seconds, clears the record, owns nothing, and force-kills five seconds later", async () => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(2999);
    expect(s.killed).toEqual([]); expect(s.record).toEqual(saved); expect(adopting.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull(); expect(adopting.state).toBe("resolved");
    expect(vi.getTimerCount()).toBe(1); // the force-kill alone: there is no idle timer, so nothing is owned
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.killed).toEqual([[777, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
    m.noteActivity();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toHaveLength(2); expect(s.record).toBeNull();
  });
  it("asks for health every 250 ms, and adopts it when the answer comes two seconds in", async () => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.healthCalls).toBe(5);
    await vi.advanceTimersByTimeAsync(999);
    expect(adopting.state).toBe("pending");
    s.healthy = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(adopting.state).toBe("resolved"); expect(s.record).toEqual(saved); expect(s.killed).toEqual([]);
    expect(vi.getTimerCount()).toBe(1); // the idle timer of a server that is now owned
    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull();
  });
  it("does not wait past three seconds for a health check that is still unanswered", async () => {
    const { m, s } = recorded({ deferHealth: true });
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(2999);
    expect(s.killed).toEqual([]); expect(adopting.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(adopting.state).toBe("resolved"); expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull();
    s.answerHealth(true); // too late to count
    await flush();
    expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(1);
  });
  it.each([
    ["names no port", "node /x/dist/cli/qmd.js mcp --http"],
    ["names port 81810", "node /x/dist/cli/qmd.js mcp --http --port 81810"],
    ["names port 818", "node /x/dist/cli/qmd.js mcp --http --port 818"],
    ["names the port as the value of another option", "node /x/dist/cli/qmd.js mcp --http --port 9000 --limit 8181"],
    ["names the port for an option that only ends in --port", "node /x/dist/cli/qmd.js mcp --http --export-port 8181"],
    ["has qmd and mcp on one line and the port on another", "node /x/dist/cli/qmd.js mcp --http\n/bin/sh wrapper --port 8181"],
  ])("clears the record after the three seconds and signals nothing when its command line %s", async (_name, cmd) => {
    const { m, s } = recorded({ cmd });
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(2999);
    expect(s.record).toEqual(saved); expect(adopting.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(adopting.state).toBe("resolved"); expect(s.record).toBeNull();
    expect(s.killed).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([]);
  });
  it.each([
    ["its group is gone", (s: FakeState) => { s.alive = []; }],
    ["its PID belongs to another program", (s: FakeState) => { s.cmd = "vim notes.md"; }],
    ["its command line cannot be read", (s: FakeState) => { s.cmd = null; }],
  ])("clears the record and signals nothing when %s by the end of the three seconds", async (_name, change) => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(1000);
    change(s);
    await vi.advanceTimersByTimeAsync(1999);
    expect(s.record).toEqual(saved);
    await vi.advanceTimersByTimeAsync(1);
    expect(adopting.state).toBe("resolved"); expect(s.record).toBeNull();
    expect(s.killed).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([]);
  });
  it("stops it all the same when the port setting is another by the end of the three seconds: whose server it is does not depend on that", async () => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(1000);
    s.settings.port = 9000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(adopting.state).toBe("resolved"); expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(STOP_FIRST)("%s during the three seconds stops it, clears the record, owns nothing, and force-kills five seconds later", async (name) => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(1000);
    interruptions[name].act(m);
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull();
    await flush();
    expect(adopting.state).toBe("resolved"); expect(vi.getTimerCount()).toBe(1); // the force-kill
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.killed).toEqual([[777, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toHaveLength(2); expect(s.record).toBeNull();
  });
  it.each([
    ["names no port", "node /x/dist/cli/qmd.js mcp --http"],
    ["names port 81810", "node /x/dist/cli/qmd.js mcp --http --port 81810"],
    ["has qmd and mcp on one line and the port on another", "node /x/dist/cli/qmd.js mcp --http\n/bin/sh wrapper --port 8181"],
  ])("stopIfOwned during the three seconds clears the record and signals nothing when its command line %s", async (_name, cmd) => {
    const { m, s } = recorded({ cmd });
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(1000);
    m.stopIfOwned();
    expect(s.killed).toEqual([]); expect(s.record).toBeNull();
    await flush();
    expect(adopting.state).toBe("resolved"); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.killed).toEqual([]);
  });
  it.each(DISPOSE_FIRST)("%s during the three seconds signals nothing, owns nothing, and leaves the record", async (name) => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(1000);
    interruptions[name].act(m);
    await flush();
    expect(adopting.state).toBe("resolved"); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([]); expect(s.record).toEqual(saved);
  });
  it("signals it even when clearing the record throws, and still owns nothing", async () => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(2000);
    s.saveThrows = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(adopting.state).toBe("rejected");
    s.saveThrows = false;
    m.stopIfOwned();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ServerManager spawning on a port where it has stopped a server", () => {
  const SERVER_CMD = "node /x/dist/cli/qmd.js mcp --http --port 8181";
  const STOPPED = ["spawn 4242", "SIGTERM 4242"];

  /** Makes the next start find no server answering, and spawn pid 5151, which answers at its first poll. */
  function nextStart(s: FakeState): void {
    s.healthy = false; s.healthyAfterPolls = 1; s.spawnPid = 5151;
  }

  /** A manager whose own server (pid 4242) the idle timer has just sent SIGTERM. */
  async function idleStopped(over: Partial<FakeOptions> = {}): Promise<{ m: ServerManager; s: FakeState }> {
    const { m, s } = await started(over);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.events).toEqual(STOPPED);
    nextStart(s);
    return { m, s };
  }

  it("after an idle-timer stop of a server that does not exit, says it is starting and spawns only once that group is gone", async () => {
    const { m, s } = await idleStopped();
    await vi.advanceTimersByTimeAsync(1000);
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await flush();
    expect(onStatus).toHaveBeenCalledTimes(1); expect(onStatus).toHaveBeenCalledWith("starting");
    expect(s.events).toEqual(STOPPED); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(999);
    expect(s.events).toEqual(STOPPED);
    s.alive = [];
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...STOPPED, "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    expect(onStatus).toHaveBeenCalledTimes(1);
  });
  it("after an idle-timer stop, spawns right after the force-kill when only that ends the group", async () => {
    const { m, s } = await idleStopped({ diesOn: "SIGKILL" });
    await vi.advanceTimersByTimeAsync(1000);
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(3999);
    expect(s.events).toEqual(STOPPED); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
  it("after an idle-timer stop, spawns six seconds after the SIGTERM when the group never goes, however late the call came", async () => {
    const { m, s } = await idleStopped();
    // Not a multiple of 250 ms after the SIGTERM: the six seconds end between two looks at the group.
    await vi.advanceTimersByTimeAsync(1100);
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(4899);
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242"]); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved");
  });
  it("does not wait for a group whose six seconds have passed, alive or not", async () => {
    const { m, s } = await idleStopped();
    await vi.advanceTimersByTimeAsync(6000);
    const call = watch(m.ensureRunning());
    await flush();
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved");
  });
  it("after stopIfOwned, with the stopped group still alive on the same port, waits for it", async () => {
    const { m, s } = await started();
    m.stopIfOwned();
    nextStart(s);
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await vi.advanceTimersByTimeAsync(749);
    expect(s.events).toEqual(STOPPED); expect(call.state).toBe("pending");
    expect(onStatus).toHaveBeenCalledTimes(1); expect(onStatus).toHaveBeenCalledWith("starting");
    s.alive = [];
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...STOPPED, "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
  it("after stopIfOwned for a port change, does not wait for the group on the old port", async () => {
    const { m, s } = await started();
    s.settings.port = 9000;
    m.stopIfOwned();
    nextStart(s);
    const call = watch(m.ensureRunning());
    await flush();
    expect(s.events).toEqual([...STOPPED, "spawn 5151"]); expect(s.spawned).toEqual([8181, 9000]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 9000 });
  });
  it("waits again for the group on the old port when the port is set back while it is still alive", async () => {
    const { m, s } = await started();
    s.settings.port = 9000;
    m.stopIfOwned();
    s.settings.port = 8181;
    nextStart(s);
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(5999);
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242"]); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242", "spawn 5151"]);
  });
  it("after stopIfOwned of a server that was still starting, waits for that group", async () => {
    const { deps, s } = fake({ healthy: false });
    const m = new ServerManager(deps);
    const first = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    m.stopIfOwned();
    nextStart(s);
    const second = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.state).toBe("rejected"); expect(s.events).toEqual(STOPPED); expect(second.state).toBe("pending");
    s.alive = [];
    await vi.advanceTimersByTimeAsync(250);
    expect(s.events).toEqual([...STOPPED, "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(second.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
  it("after a start that ran out of time, a new start waits for the group it gave up on", async () => {
    const { deps, s } = fake({ healthy: false, diesOn: "SIGKILL" });
    const m = new ServerManager(deps);
    const first = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.state).toBe("rejected"); expect(s.events).toEqual(STOPPED);
    nextStart(s);
    const second = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.events).toEqual(STOPPED); expect(second.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(second.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
  it("after a start whose launcher exited and left its group behind, a new start waits for that group", async () => {
    const { deps, s } = fake({ healthy: false, groupSurvivesExit: true, diesOn: "SIGKILL" });
    const m = new ServerManager(deps);
    const first = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    s.exit({ code: 1 });
    await flush();
    expect(first.state).toBe("rejected"); expect(s.events).toEqual(STOPPED);
    nextStart(s);
    const second = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.events).toEqual(STOPPED); expect(second.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242", "spawn 5151"]);
  });
  it("in the five seconds after a hung recorded server is stopped at load, waits for it, then spawns, and the call succeeds", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 1, record: { pid: 777, port: 8181 }, alive: [777], cmd: SERVER_CMD, diesOn: "SIGKILL" });
    const m = new ServerManager(deps);
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(3000);
    expect(adopting.state).toBe("resolved"); expect(s.events).toEqual(["SIGTERM 777"]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await vi.advanceTimersByTimeAsync(3999);
    expect(s.events).toEqual(["SIGTERM 777"]); expect(call.state).toBe("pending");
    expect(onStatus).toHaveBeenCalledTimes(1); expect(onStatus).toHaveBeenCalledWith("starting");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual(["SIGTERM 777", "SIGKILL 777", "spawn 4242"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 4242, port: 8181 });
  });

  it("forgets a group once it has seen it gone: the same PID alive again later holds nothing up", async () => {
    const { m, s } = await started({ diesOn: "SIGTERM" });
    m.stopIfOwned();
    nextStart(s);
    const second = m.ensureRunning();
    await vi.advanceTimersByTimeAsync(250);
    await second;
    s.alive.push(4242); // the PID belongs to some other process now
    m.stopIfOwned();
    nextStart(s); s.spawnPid = 6161;
    const third = watch(m.ensureRunning());
    await flush();
    expect(s.events).toEqual([...STOPPED, "spawn 5151", "SIGTERM 5151", "spawn 6161"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(third.state).toBe("resolved"); expect(s.record).toEqual({ pid: 6161, port: 8181 });
  });
  it.each(INTERRUPTIONS)("%s during the wait after an idle-timer stop ends the start without spawning", async (name) => {
    const { m, s } = await idleStopped();
    await vi.advanceTimersByTimeAsync(1000);
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    interruptions[name].act(m);
    await flush();
    expect(call.state).toBe("rejected");
    expect(call.error).toMatchObject({ kind: "server-start", message: interruptions[name].message });
    expect(s.events).toEqual(STOPPED); expect(vi.getTimerCount()).toBe(1); // the force-kill of the stopped server
    s.alive = [];
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242"]); expect(s.record).toBeNull();
  });
  it("shares the wait between callers", async () => {
    const { m, s } = await idleStopped();
    const [early, late] = [vi.fn(), vi.fn()];
    const first = watch(m.ensureRunning(early));
    await vi.advanceTimersByTimeAsync(1000);
    const second = watch(m.ensureRunning(late));
    expect(late).toHaveBeenCalledTimes(1); expect(late).toHaveBeenCalledWith("starting");
    s.alive = [];
    await vi.advanceTimersByTimeAsync(500);
    expect(first.state).toBe("resolved"); expect(second.state).toBe("resolved");
    expect(s.events).toEqual([...STOPPED, "spawn 5151"]);
    for (const onStatus of [early, late]) expect(onStatus).toHaveBeenCalledTimes(1);
  });
});

describe("ServerManager after it has waited for a stopped group", () => {
  const SERVER_CMD = "node /x/dist/cli/qmd.js mcp --http --port 8181";
  const STOPPED = ["spawn 4242", "SIGTERM 4242"];

  /** Makes the next start find no server answering, and spawn pid 5151, which answers at its first poll. */
  function nextStart(s: FakeState): void {
    s.healthy = false; s.healthyAfterPolls = 1; s.spawnPid = 5151;
  }

  /** A manager whose own server (pid 4242) the idle timer has just sent SIGTERM, and which does not exit. */
  async function idleStopped(): Promise<{ m: ServerManager; s: FakeState }> {
    const { m, s } = await started();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    nextStart(s);
    return { m, s };
  }

  it("asks for health once more, and spawns once when still nothing answers and nothing is owned", async () => {
    const { m, s } = await idleStopped();
    const asked = s.healthCalls;
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.healthCalls).toBe(asked + 1); // during the wait only the group is looked at
    s.alive = [];
    await vi.advanceTimersByTimeAsync(250);
    expect(s.events).toEqual([...STOPPED, "spawn 5151"]); expect(s.healthCalls).toBe(asked + 2);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.spawned).toHaveLength(2);
  });
  it("uses a server that another program started during the wait: it spawns nothing, owns nothing, and signals nothing more", async () => {
    const { m, s } = await idleStopped();
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    s.alive = []; s.healthy = true; // the stopped group is gone, and something else now answers on the port
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved");
    expect(s.events).toEqual(STOPPED); expect(s.record).toBeNull();
    expect(vi.getTimerCount()).toBe(1); // the force-kill of the group stopped earlier: no idle timer, so nothing is owned
    m.noteActivity();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242"]); expect(s.spawned).toHaveLength(1);
  });

  it.each(INTERRUPTIONS)("%s during the wait itself ends the start with no further health check", async (name) => {
    const { m, s } = await idleStopped();
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    const asked = s.healthCalls;
    interruptions[name].act(m);
    await flush();
    expect(call.state).toBe("rejected"); expect(s.healthCalls).toBe(asked);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.healthCalls).toBe(asked); expect(s.spawned).toHaveLength(1);
  });

  const interrupted: Array<[Interruption, boolean]> = [];
  for (const name of INTERRUPTIONS) interrupted.push([name, false], [name, true]);
  it.each(interrupted)("%s during that health check ends the start without spawning (health then answers %j)", async (name, answer) => {
    const { m, s } = await idleStopped();
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    s.deferHealth = true; s.alive = [];
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("pending"); expect(s.events).toEqual(STOPPED);
    interruptions[name].act(m);
    s.deferHealth = false;
    s.answerHealth(answer);
    await flush();
    expect(call.state).toBe("rejected");
    expect(call.error).toMatchObject({ kind: "server-start", message: interruptions[name].message });
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.events).toEqual([...STOPPED, "SIGKILL 4242"]); expect(s.record).toBeNull();
  });

  it.each([
    ["it has stopped nothing", async () => {
      const { deps, s } = fake({ healthy: false, healthyAfterPolls: 1 });
      return { m: new ServerManager(deps), s };
    }],
    ["the server it owned has died", async () => {
      const { m, s } = await started();
      s.alive = []; nextStart(s);
      return { m, s };
    }],
    ["the only group it stopped is on another port", async () => {
      const { m, s } = await started();
      s.settings.port = 9000; m.stopIfOwned(); nextStart(s);
      return { m, s };
    }],
    ["the group it stopped is gone already", async () => {
      const { m, s } = await started({ diesOn: "SIGTERM" });
      m.stopIfOwned(); nextStart(s);
      return { m, s };
    }],
  ])("checks health exactly once before it spawns when there is nothing to wait for: %s", async (_name, setUp) => {
    const { m, s } = await setUp();
    const [asked, spawned] = [s.healthCalls, s.spawned.length];
    const call = watch(m.ensureRunning());
    await flush();
    expect(s.spawned).toHaveLength(spawned + 1); expect(s.healthCalls).toBe(asked + 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved");
  });
});

describe("ServerManager forgetting a server", () => {
  const other = { pid: 999, port: 8181 };

  // No public path reaches this: a recorded server is stopped only by the one adoption, or by a
  // stop that overtakes it, and both come before any start, so nothing is owned then. The guard is
  // for the next caller of `stopRecorded`, so this one test reaches past the public interface.
  it("stopping a recorded server that is not the owned one leaves the owned server owned and its record saved", async () => {
    const { m, s } = await started();
    const stopRecorded = (m as unknown as { stopRecorded(record: OwnedRecord, identity: "qmd-server"): void }).stopRecorded.bind(m);
    stopRecorded(other, "qmd-server"); // pid 999 is not alive, so nothing is signalled
    expect(s.killed).toEqual([]); expect(s.record).toEqual({ pid: 4242, port: 8181 });
    m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
  });

  it.each([
    ["stopIfOwned", async (m: ServerManager) => { m.stopIfOwned(); }],
    ["the idle timer", async () => { await vi.advanceTimersByTimeAsync(60 * MIN); }],
  ])("on %s, stops its server and leaves a saved record that is no longer that server's", async (_name, stop) => {
    const { m, s } = await started();
    s.record = other; // saved by something else since: this manager's own record is gone from storage
    await stop(m);
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toEqual(other);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.killed).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); expect(vi.getTimerCount()).toBe(0);
    m.stopIfOwned();
    expect(s.killed).toHaveLength(2); expect(s.record).toEqual(other);
  });
  it("leaves a saved record that is no longer its server's when that server exits", async () => {
    const { m, s } = await started();
    s.record = other;
    s.exit({ code: 1 });
    await flush();
    expect(s.record).toEqual(other); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([]); expect(s.record).toEqual(other);
  });
  it("clears a saved record that is equal to its server's, whatever object holds it", async () => {
    const { m, s } = await started();
    s.record = { pid: 4242, port: 8181 }; // as a real store returns it: a copy, not the object that was saved
    m.stopIfOwned();
    expect(s.killed).toEqual([[4242, "SIGTERM"]]); expect(s.record).toBeNull();
  });
  it.each([
    ["stops the hung recorded server", "node /x/dist/cli/qmd.js mcp --http --port 8181", [[777, "SIGTERM"]]],
    ["signals nothing for a PID that is not this port's server", "node /x/dist/cli/qmd.js mcp --http", []],
  ])("at load, %s and leaves a saved record that was replaced during the three seconds", async (_name, cmd, killed) => {
    const { deps, s } = fake({ healthy: false, record: { pid: 777, port: 8181 }, alive: [777], cmd });
    const m = new ServerManager(deps);
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(1000);
    s.record = other;
    await vi.advanceTimersByTimeAsync(2000);
    expect(adopting.state).toBe("resolved"); expect(s.killed).toEqual(killed); expect(s.record).toEqual(other);
    m.stopIfOwned();
    expect(s.killed).toEqual(killed); expect(s.record).toEqual(other);
  });
});

describe("ServerManager settling the saved record before any start", () => {
  const SERVER_CMD = "node /x/dist/cli/qmd.js mcp --http --port 8181";
  const saved = { pid: 777, port: 8181 };

  /** A manager with a record of a live server, pid 777, that is the plugin's by its command line and does not answer health yet. */
  function recorded(over: Partial<FakeOptions> = {}): { m: ServerManager; s: FakeState } {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 1, record: saved, alive: [777], cmd: SERVER_CMD, spawnPid: 5151, ...over });
    return { m: new ServerManager(deps), s };
  }

  it("asks nothing and spawns nothing until the adoption has settled, and uses the server it adopts", async () => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.healthCalls).toBe(5); // the adoption's own, every 250 ms: the start has not asked
    expect(s.spawned).toEqual([]); expect(call.state).toBe("pending"); expect(adopting.state).toBe("pending");
    s.healthy = true; // the recorded server answers after all
    await vi.advanceTimersByTimeAsync(250);
    expect(adopting.state).toBe("resolved"); expect(call.state).toBe("resolved");
    expect(s.spawned).toEqual([]); expect(s.killed).toEqual([]); expect(s.record).toEqual(saved);
    expect(onStatus).not.toHaveBeenCalled();
    // It is owned: its idle timer, started when it was adopted, stops it.
    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull(); expect(s.spawned).toEqual([]);
  });
  it("waits for the adoption to stop a recorded server that never answers, then for that group to be gone, and spawns once", async () => {
    const { m, s } = recorded({ diesOn: "SIGKILL" });
    const adopting = watch(m.adoptIfOurs());
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await vi.advanceTimersByTimeAsync(2999);
    expect(s.events).toEqual([]); expect(call.state).toBe("pending"); expect(onStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(adopting.state).toBe("resolved"); expect(s.events).toEqual(["SIGTERM 777"]); expect(s.record).toBeNull();
    // Only now does the start find that nothing answers, and that there is a group to wait for.
    expect(onStatus).toHaveBeenCalledTimes(1); expect(onStatus).toHaveBeenCalledWith("starting");
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.events).toEqual(["SIGTERM 777"]); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual(["SIGTERM 777", "SIGKILL 777", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.spawned).toHaveLength(1); expect(onStatus).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["names another program", { cmd: "vim notes.md" }],
    ["names a group that is gone", { alive: [] }],
    ["is for another port", { record: { pid: 777, port: 9000 } }],
    ["has a PID that cannot be signalled", { record: { pid: 1, port: 8181 } }],
  ])("starts as usual once the adoption has cleared a record that %s", async (_name, over) => {
    const { m, s } = recorded(over);
    const adopting = watch(m.adoptIfOurs());
    const call = watch(m.ensureRunning());
    await flush();
    expect(adopting.state).toBe("resolved"); expect(s.record).toBeNull();
    expect(s.events).toEqual(["spawn 5151"]); expect(s.healthCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    expect(s.killed).toEqual([]);
  });
  it("starts as usual when the adoption found no record", async () => {
    const { m, s } = recorded({ record: null });
    const adopting = watch(m.adoptIfOurs());
    const call = watch(m.ensureRunning());
    await flush();
    expect(adopting.state).toBe("resolved"); expect(s.events).toEqual(["spawn 5151"]); expect(s.healthCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved");
  });
  it.each(DISPOSE_FIRST)("%s while a start waits for the adoption ends the start without a health check or a spawn", async (name) => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    const asked = s.healthCalls;
    interruptions[name].act(m);
    await flush();
    expect(call.state).toBe("rejected");
    expect(call.error).toMatchObject({ kind: "server-start", message: interruptions[name].message });
    expect(adopting.state).toBe("resolved"); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.healthCalls).toBe(asked); expect(s.spawned).toEqual([]); expect(s.killed).toEqual([]);
    expect(s.record).toEqual(saved);
  });
  it.each(STOP_FIRST)("%s while a start waits for the adoption ends the start without a health check or a spawn, and stops the recorded server", async (name) => {
    const { m, s } = recorded();
    const adopting = watch(m.adoptIfOurs());
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(1000);
    const asked = s.healthCalls;
    interruptions[name].act(m);
    await flush();
    expect(call.state).toBe("rejected");
    expect(call.error).toMatchObject({ kind: "server-start", message: interruptions[name].message });
    expect(adopting.state).toBe("resolved"); expect(vi.getTimerCount()).toBe(1); // the force-kill of the recorded server
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(s.healthCalls).toBe(asked); expect(s.spawned).toEqual([]);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]); expect(s.record).toBeNull();
  });
  it("shares the wait for the adoption between callers, and says it is starting to none of them until it is", async () => {
    const { m, s } = recorded({ diesOn: "SIGTERM" });
    void m.adoptIfOurs();
    const [early, late] = [vi.fn(), vi.fn()];
    const first = watch(m.ensureRunning(early));
    await vi.advanceTimersByTimeAsync(1000);
    const second = watch(m.ensureRunning(late));
    await vi.advanceTimersByTimeAsync(1999);
    expect(s.healthCalls).toBe(12); // all the adoption's
    expect(early).not.toHaveBeenCalled(); expect(late).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The adoption stops the hung server, whose group goes at once: one health check and one spawn for both callers.
    expect(s.events).toEqual(["SIGTERM 777", "spawn 5151"]); expect(s.healthCalls).toBe(13);
    for (const onStatus of [early, late]) expect(onStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(first.state).toBe("resolved"); expect(second.state).toBe("resolved");
    expect(s.spawned).toHaveLength(1); expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
  it("goes on with the start when the adoption fails", async () => {
    const { m, s } = recorded({ diesOn: "SIGTERM" });
    const adopting = watch(m.adoptIfOurs());
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(2000);
    s.saveThrows = true; // the adoption will stop the hung server and then fail to clear its record
    await vi.advanceTimersByTimeAsync(1000);
    s.saveThrows = false;
    expect(adopting.state).toBe("rejected"); expect(s.events).toEqual(["SIGTERM 777", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
  it("checks health in the same tick, with no timer, when no adoption is in progress", async () => {
    const { m, s } = recorded({ record: null });
    const call = watch(m.ensureRunning());
    expect(s.healthCalls).toBe(1); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved");
  });
  it("checks health in the same tick, with no timer, when the adoption has settled", async () => {
    const { m, s } = recorded({ healthy: true });
    await m.adoptIfOurs();
    const [asked, timers] = [s.healthCalls, vi.getTimerCount()];
    const call = watch(m.ensureRunning());
    expect(s.healthCalls).toBe(asked + 1); expect(vi.getTimerCount()).toBe(timers);
    await flush();
    expect(call.state).toBe("resolved"); expect(s.spawned).toEqual([]);
  });
  it("settles the record itself when adoptIfOurs was never called: a recorded server that answers a moment later is adopted, and nothing is spawned", async () => {
    const { m, s } = recorded();
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.healthCalls).toBe(5); // the adoption's polls: the start has not asked for health yet
    expect(s.spawned).toEqual([]); expect(call.state).toBe("pending");
    s.healthy = true; // the recorded server answers after all
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved");
    expect(s.spawned).toEqual([]); expect(s.killed).toEqual([]); expect(s.record).toEqual(saved);
    expect(onStatus).not.toHaveBeenCalled();
    // It is owned: its idle timer, started when it was adopted, stops it.
    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(s.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull(); expect(s.spawned).toEqual([]);
  });
  it("settles the record itself when adoptIfOurs was never called: a recorded server that never answers is stopped, waited for, and replaced by one spawn", async () => {
    const { m, s } = recorded({ diesOn: "SIGKILL" });
    const onStatus = vi.fn();
    const call = watch(m.ensureRunning(onStatus));
    await vi.advanceTimersByTimeAsync(2999);
    expect(s.events).toEqual([]); expect(call.state).toBe("pending"); expect(onStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual(["SIGTERM 777"]); expect(s.record).toBeNull();
    expect(onStatus).toHaveBeenCalledTimes(1); expect(onStatus).toHaveBeenCalledWith("starting");
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.events).toEqual(["SIGTERM 777"]); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual(["SIGTERM 777", "SIGKILL 777", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.spawned).toHaveLength(1); expect(s.killed).toHaveLength(2);
  });

  const orders = {
    "ensureRunning then adoptIfOurs": (m: ServerManager) => {
      const call = watch(m.ensureRunning());
      return { call, adopting: watch(m.adoptIfOurs()) };
    },
    "adoptIfOurs then ensureRunning": (m: ServerManager) => {
      const adopting = watch(m.adoptIfOurs());
      return { call: watch(m.ensureRunning()), adopting };
    },
  };
  const ORDERS = Object.keys(orders) as Array<keyof typeof orders>;

  it.each(ORDERS)("%s in one tick make one adoption of a server that answers: it is owned once, and nothing is spawned", async (order) => {
    const { deps, s } = fake({ healthy: true, record: saved, alive: [777], cmd: SERVER_CMD, spawnPid: 5151 });
    const loadRecord = vi.spyOn(deps, "loadRecord");
    const saveRecord = vi.spyOn(deps, "saveRecord");
    const m = new ServerManager(deps);
    const { call, adopting } = orders[order](m);
    await flush();
    expect(call.state).toBe("resolved"); expect(adopting.state).toBe("resolved");
    expect(loadRecord).toHaveBeenCalledTimes(1); expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(s.spawned).toEqual([]); expect(s.record).toEqual(saved); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * MIN + 5000);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]); expect(s.spawned).toEqual([]);
  });
  it.each(ORDERS)("%s in one tick make one adoption of a server that never answers: it is stopped once, and replaced by one spawn", async (order) => {
    const { m, s } = recorded({ diesOn: "SIGKILL" });
    const { call, adopting } = orders[order](m);
    await vi.advanceTimersByTimeAsync(2999);
    expect(s.events).toEqual([]); expect(call.state).toBe("pending"); expect(adopting.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual(["SIGTERM 777"]); expect(adopting.state).toBe("resolved");
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.events).toEqual(["SIGTERM 777", "SIGKILL 777", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]); expect(s.spawned).toHaveLength(1);
  });
  it("makes its adoption once: a second adoptIfOurs returns the same promise, reads no record, and settles with the first", async () => {
    const { deps, s } = fake({ healthy: false, record: saved, alive: [777], cmd: SERVER_CMD });
    const loadRecord = vi.spyOn(deps, "loadRecord");
    const m = new ServerManager(deps);
    const adoption = m.adoptIfOurs();
    const first = watch(adoption);
    await vi.advanceTimersByTimeAsync(1000);
    const again = m.adoptIfOurs();
    const second = watch(again);
    await flush();
    expect(again).toBe(adoption); expect(loadRecord).toHaveBeenCalledTimes(1);
    expect(first.state).toBe("pending"); expect(second.state).toBe("pending");
    s.healthy = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(first.state).toBe("resolved"); expect(second.state).toBe("resolved");
    expect(s.record).toEqual(saved); expect(s.killed).toEqual([]); expect(vi.getTimerCount()).toBe(1);
    expect(m.adoptIfOurs()).toBe(adoption); // and once it has settled, too
    expect(loadRecord).toHaveBeenCalledTimes(1);
  });
  it("with no saved record, reads that once, makes one health check in the same tick and spawns, with no added delay", async () => {
    const { deps, s } = fake({ healthy: false, healthyAfterPolls: 1 });
    const loadRecord = vi.spyOn(deps, "loadRecord");
    const m = new ServerManager(deps);
    const call = watch(m.ensureRunning());
    expect(loadRecord).toHaveBeenCalledTimes(1); expect(s.healthCalls).toBe(1); expect(vi.getTimerCount()).toBe(0);
    await flush();
    expect(s.events).toEqual(["spawn 4242"]); expect(s.healthCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 4242, port: 8181 });
    // A later start does not read the record again: the adoption was made.
    m.stopIfOwned();
    const asked = s.healthCalls;
    watch(m.ensureRunning());
    expect(s.healthCalls).toBe(asked + 1); expect(loadRecord).toHaveBeenCalledTimes(2); // the second read is the stop's own
  });
  it.each([
    ["the plugin's call at load", (m: ServerManager) => { void m.adoptIfOurs(); }],
    ["a start", (m: ServerManager) => { watch(m.ensureRunning()); }],
  ])("when a stop overtakes the adoption begun by %s, stops the recorded server and clears its record; a later start waits for that group, then spawns once", async (_name, begin) => {
    const { m, s } = recorded({ diesOn: "SIGKILL" });
    begin(m);
    await vi.advanceTimersByTimeAsync(1000);
    m.stopIfOwned(); // as a change of the QMD path or of the extra PATH directories does
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    const asked = s.healthCalls;
    const call = watch(m.ensureRunning());
    expect(s.healthCalls).toBe(asked + 1); // in the same tick: the record is settled, so there is no adoption to wait for
    await vi.advanceTimersByTimeAsync(3999);
    expect(s.events).toEqual(["SIGTERM 777"]); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual(["SIGTERM 777", "SIGKILL 777", "spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.spawned).toHaveLength(1); expect(s.killed).toHaveLength(2); expect(s.record).toEqual({ pid: 5151, port: 8181 });
  });
  it("when a stop overtakes the adoption of a PID that is not this port's server, clears the record and signals nothing; a later start spawns at once", async () => {
    const { m, s } = recorded({ cmd: "node /x/dist/cli/qmd.js mcp --http" });
    const adopting = watch(m.adoptIfOurs());
    await vi.advanceTimersByTimeAsync(1000);
    m.stopIfOwned();
    expect(s.killed).toEqual([]); expect(s.record).toBeNull();
    await flush();
    expect(adopting.state).toBe("resolved"); expect(vi.getTimerCount()).toBe(0);
    const call = watch(m.ensureRunning());
    await flush();
    expect(s.events).toEqual(["spawn 5151"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.killed).toEqual([]);
  });
  it("stops at once a recorded server on a port the plugin no longer uses, without asking it for health, and a start on the port that is set does not wait for it", async () => {
    const { m, s } = recorded({ record: { pid: 777, port: 9000 }, cmd: "node /x/dist/cli/qmd.js mcp --http --port 9000" });
    const adopting = watch(m.adoptIfOurs());
    expect(s.killed).toEqual([[777, "SIGTERM"]]); expect(s.record).toBeNull(); expect(s.healthCalls).toBe(0);
    await flush();
    expect(adopting.state).toBe("resolved"); expect(vi.getTimerCount()).toBe(1); // the force-kill alone: it is not owned
    const call = watch(m.ensureRunning());
    await flush();
    expect(s.events).toEqual(["SIGTERM 777", "spawn 5151"]); expect(s.spawned).toEqual([8181]);
    await vi.advanceTimersByTimeAsync(250);
    expect(call.state).toBe("resolved"); expect(s.record).toEqual({ pid: 5151, port: 8181 });
    await vi.advanceTimersByTimeAsync(4750);
    expect(s.killed).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]);
  });
  it("remembers that server against its own port: a start on that port waits for it", async () => {
    const { m, s } = recorded({ record: { pid: 777, port: 9000 }, cmd: "node /x/dist/cli/qmd.js mcp --http --port 9000", diesOn: "SIGKILL" });
    void m.adoptIfOurs();
    s.settings.port = 9000; // set back to the port that server holds
    const call = watch(m.ensureRunning());
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.events).toEqual(["SIGTERM 777"]); expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.events).toEqual(["SIGTERM 777", "SIGKILL 777", "spawn 5151"]); expect(s.spawned).toEqual([9000]);
  });
  it("clears the record of a server on another port, and signals nothing, when its command line names a port other than the record's", async () => {
    // The record says 9000 and the process says 8181, the port that is set: it is neither the
    // recorded server nor one to adopt. If it answers, it is another's.
    const { m, s } = recorded({ healthy: true, record: { pid: 777, port: 9000 } });
    await m.adoptIfOurs();
    expect(s.killed).toEqual([]); expect(s.record).toBeNull(); expect(s.healthCalls).toBe(0);
    await m.ensureRunning();
    m.noteActivity();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    m.stopIfOwned();
    expect(s.killed).toEqual([]); expect(s.spawned).toEqual([]);
  });
  it.each([0, -1, 65536, 80.5, NaN])("clears a record whose port is %s and signals nothing, even when a qmd server names that very port", async (port) => {
    const { m, s } = recorded({ record: { pid: 777, port }, cmd: `node /x/dist/cli/qmd.js mcp --http --port ${port}` });
    await m.adoptIfOurs();
    expect(s.killed).toEqual([]); expect(s.record).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
});
