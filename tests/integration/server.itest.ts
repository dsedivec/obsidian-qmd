// Runs the plugin's server handling against the real `qmd`: a throwaway index over a copy of the
// fixture vault, and real server processes on a spare port. Slow. Run with `npm run test:integration`.

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type KeyValueStore, type QmdSearchSettings } from "../../src/config";
import { QmdCli } from "../../src/qmd-cli";
import { QmdClient } from "../../src/qmd-client";
import { toSearchResults } from "../../src/results";
import { checkHealth, createServerDeps, SERVER_RECORD_KEY, serverLogPath } from "../../src/server-deps";
import { ServerManager, type OwnedRecord, type ServerDeps, type SpawnedServer } from "../../src/server-manager";

const COLLECTION = "itest";
const FIXTURE_VAULT = fileURLToPath(new URL("../fixtures/vault", import.meta.url));
/** What points `qmd` at an index. Each is redirected into the temp directory for the whole file. */
const ISOLATED = ["INDEX_PATH", "QMD_CONFIG_DIR"] as const;
/** Longer than a server takes to stop, so a server that is still up after it was not signalled. */
const STOP_WOULD_SHOW_MS = 3000;

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return { get: (key) => values.get(key), set: (key, value) => void values.set(key, value) };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "localhost", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** True until no process is left in the group. A launcher that has exited but is not yet reaped still counts. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await sleep(50);
  }
}

describe("ServerManager with the real qmd", () => {
  const savedEnv = Object.fromEntries(ISOLATED.map((name) => [name, process.env[name]]));
  const savedCwd = process.cwd();
  let tmp: string;
  let settings: QmdSearchSettings;
  let cli: QmdCli;
  let client: QmdClient;
  /** Every manager a test made and every launcher they spawned, so that a failed test leaves nothing behind. */
  const managers: ServerManager[] = [];
  const launchers: number[] = [];

  async function qmd(args: string[], timeoutMs: number): Promise<void> {
    const result = await cli.run(args, { timeoutMs });
    if (result.code !== 0) throw new Error(`qmd ${args.join(" ")} failed: ${JSON.stringify(result)}`);
  }

  /** A manager over the real dependencies. `spawned` lists the servers it has started. */
  function newManager(store: KeyValueStore = memoryStore()): { manager: ServerManager; deps: ServerDeps; spawned: SpawnedServer[] } {
    const real = createServerDeps({ cli, getSettings: () => settings, store });
    const spawned: SpawnedServer[] = [];
    const deps: ServerDeps = {
      ...real,
      spawnServer: (port) => {
        const server = real.spawnServer(port);
        spawned.push(server);
        if (server.pid !== undefined) launchers.push(server.pid);
        return server;
      },
    };
    const manager = new ServerManager(deps);
    managers.push(manager);
    return { manager, deps, spawned };
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "qmd-search-itest-"));
    process.env.INDEX_PATH = join(tmp, "index.sqlite");
    process.env.QMD_CONFIG_DIR = join(tmp, "config");
    // qmd prefers a project-local .qmd/index.yml at or above its working directory over INDEX_PATH.
    process.chdir(tmp);

    settings = { ...DEFAULT_SETTINGS, qmdPath: process.env.QMD_BIN ?? "qmd", port: await freePort() };
    cli = new QmdCli(() => settings);
    client = new QmdClient(() => settings.port);

    const vault = join(tmp, "vault");
    cpSync(FIXTURE_VAULT, vault, { recursive: true });
    await qmd(["collection", "add", vault, "--name", COLLECTION], 120_000);
    expect(existsSync(join(tmp, "index.sqlite"))).toBe(true);
    expect(existsSync(join(tmp, "config", "index.yml"))).toBe(true);
    await qmd(["embed", "-c", COLLECTION], 300_000);
  }, 600_000);

  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.dispose();
    for (const pid of launchers) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The usual case: the test stopped its server, and the group is gone.
      }
    }
    await waitFor(() => !launchers.some(groupAlive), 10_000);
    launchers.length = 0;
  }, 30_000);

  afterAll(() => {
    cli?.killAll();
    process.chdir(savedCwd);
    for (const name of ISOLATED) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    if (settings) rmSync(serverLogPath(settings.port), { force: true });
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("starts a server, answers a query, and leaves no process behind", async () => {
    const store = memoryStore();
    const { manager, deps, spawned } = newManager(store);
    await manager.ensureRunning();
    const raw = await client.query("sourdough starter hydration", { collection: COLLECTION, limit: 5 });
    expect(toSearchResults(raw, COLLECTION)[0].path).toBe("HTML & markup.md");

    const { pid } = store.get(SERVER_RECORD_KEY) as OwnedRecord;
    expect(deps.isAlive(pid)).toBe(true);
    expect(groupAlive(pid)).toBe(true);
    const commandLine = deps.commandLine(pid);
    expect(commandLine).toContain("qmd");
    expect(commandLine).toContain(`mcp --http --port ${settings.port}`);

    manager.stopIfOwned();
    await waitFor(() => !groupAlive(pid), 10_000);
    expect(deps.isAlive(pid)).toBe(false);
    expect(await checkHealth(settings.port)).toBe(false);
    // The launcher's exit reaches the manager through `exit`. The timer only bounds a failure.
    expect(spawned.map((server) => server.pid)).toEqual([pid]);
    expect(await Promise.race([spawned[0].exit, sleep(5000, "still pending", { ref: false })])).toEqual({ code: null });
    manager.dispose();
  });

  it("leaves a server it did not start running", async () => {
    const ownerStore = memoryStore();
    const { manager: owner } = newManager(ownerStore);
    await owner.ensureRunning();
    const { pid } = ownerStore.get(SERVER_RECORD_KEY) as OwnedRecord;

    const visitorStore = memoryStore();
    const { manager: visitor } = newManager(visitorStore);
    await visitor.ensureRunning();
    expect(visitorStore.get(SERVER_RECORD_KEY)).toBeUndefined();
    visitor.stopIfOwned();
    await sleep(STOP_WOULD_SHOW_MS);
    expect(groupAlive(pid)).toBe(true);
    expect(await checkHealth(settings.port)).toBe(true);

    owner.stopIfOwned();
    await waitFor(() => !groupAlive(pid), 10_000);
    visitor.dispose();
    owner.dispose();
  });

  // The launcher does not forward signals and the real server does not need it: with the launcher
  // dead, the server runs on in the launcher's process group, which is what identifies and stops it.
  it("still recognises and stops a server whose launcher has died", async () => {
    const store = memoryStore();
    const { manager, deps, spawned } = newManager(store);
    await manager.ensureRunning();
    const { pid } = store.get(SERVER_RECORD_KEY) as OwnedRecord;

    // The launcher alone, by its own PID. Waiting for `exit` makes sure that it is gone and reaped.
    process.kill(pid, "SIGKILL");
    expect(await Promise.race([spawned[0].exit, sleep(5000, "still pending", { ref: false })])).toEqual({ code: null });
    expect(processAlive(pid)).toBe(false);

    expect(deps.isAlive(pid)).toBe(true);
    const commandLine = deps.commandLine(pid);
    expect(commandLine).toContain("qmd");
    expect(commandLine).toContain("mcp");
    expect(await checkHealth(settings.port)).toBe(true);

    manager.stopIfOwned();
    await waitFor(() => !groupAlive(pid), 10_000);
    expect(deps.isAlive(pid)).toBe(false);
    expect(await checkHealth(settings.port)).toBe(false);
    manager.dispose();
  });

  // The plugin takes a server for gone when /health does not answer within a second. That only
  // works if a server that is busy with a query still answers.
  it("answers every health check while a cold first query is in flight", async () => {
    const store = memoryStore();
    const { manager } = newManager(store);
    await manager.ensureRunning();
    const { pid } = store.get(SERVER_RECORD_KEY) as OwnedRecord;

    // The first query a server gets loads the models. The text is new to the index, so that no
    // answer cached by an earlier server's query shortens the work.
    const checks: Array<Promise<{ healthy: boolean; ms: number }>> = [];
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const checkedAt = Date.now();
      checks.push(checkHealth(settings.port).then((healthy) => ({ healthy, ms: Date.now() - checkedAt })));
    }, 250);
    let raw: unknown[];
    try {
      raw = await client.query("espresso grind size", { collection: COLLECTION, limit: 5 });
    } finally {
      clearInterval(ticker);
    }
    const queryMs = Date.now() - startedAt;
    const answers = await Promise.all(checks);

    let failed = 0;
    let run = 0;
    let longestFailedRun = 0;
    for (const { healthy } of answers) {
      run = healthy ? 0 : run + 1;
      if (!healthy) failed++;
      longestFailedRun = Math.max(longestFailedRun, run);
    }
    const slowestMs = Math.max(0, ...answers.map((answer) => answer.ms));
    console.log(
      `health under load: the cold query took ${queryMs} ms; ${answers.length} health checks, ${failed} failed, ` +
        `longest run of failures ${longestFailedRun}, slowest answer ${slowestMs} ms`,
    );

    expect(toSearchResults(raw, COLLECTION)[0].path).toBe("Café ☕ notes.md");
    expect(answers.length).toBeGreaterThan(0);
    expect(failed).toBe(0);

    manager.stopIfOwned();
    await waitFor(() => !groupAlive(pid), 10_000);
    manager.dispose();
  });
});
