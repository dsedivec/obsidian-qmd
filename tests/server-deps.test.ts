import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type KeyValueStore, type QmdSearchSettings } from "../src/config";
import { QmdCli } from "../src/qmd-cli";
import { checkHealth, createServerDeps, SERVER_RECORD_KEY, serverLogPath } from "../src/server-deps";
import type { ServerDeps, SpawnedServer } from "../src/server-manager";

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return { get: (key) => values.get(key), set: (key, value) => void values.set(key, value) };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(20);
  expect(cond()).toBe(true);
}

/** Blocks the event loop, so that Node cannot reap a child in the meantime. */
const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const groupOf = (pid: number): number =>
  Number(execFileSync("/bin/ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("server-deps", () => {
  let server: http.Server;
  /** The fake HTTP server's port. It is this run's alone, so it also names a log file nothing else uses. */
  let port: number;
  let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders };
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const sockets = new Set<net.Socket>();

  const respondRaw = (status: number, body: string) => {
    handler = (_req, res) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(body); };
  };

  beforeEach(async () => {
    handler = () => {};
    seen = { headers: {} };
    server = http.createServer((req, res) => {
      seen = { method: req.method, url: req.url, headers: req.headers };
      handler(req, res);
    });
    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(0, "localhost", r));
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe("checkHealth", () => {
    it.each([
      [200, '{"status":"ok","uptime":3}', true], [200, '{"status":"starting"}', false],
      [200, "hello", false], [500, '{"status":"ok"}', false],
    ])("status %i body %j gives %j", async (status, body, expected) => {
      respondRaw(status, body);
      expect(await checkHealth(port)).toBe(expected);
    });

    it("is false when nothing listens or nothing answers in time", async () => {
      const tmp = net.createServer();
      await new Promise<void>((r) => tmp.listen(0, "localhost", r));
      const closedPort = (tmp.address() as net.AddressInfo).port;
      await new Promise<void>((r) => tmp.close(() => r()));
      expect(await checkHealth(closedPort)).toBe(false);
      handler = () => {};
      expect(await checkHealth(port, 100)).toBe(false);
      await waitFor(() => sockets.size === 0);
    });

    it("is false, without waiting out the time allowed, when the answer is cut off after what reads as a whole body", async () => {
      handler = (_req, res) => {
        res.writeHead(200, { "Content-Length": "40" });
        res.write('{"status":"ok"}', () => res.destroy());
      };
      const startedAt = Date.now();
      expect(await checkHealth(port, 3000)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1500);
    });

    it("is false, not a rejection, for a port that cannot exist", async () => {
      expect(await checkHealth(70_000)).toBe(false);
    });

    it("sends GET /health with no Origin header", async () => {
      respondRaw(200, '{"status":"ok","uptime":3}');
      await checkHealth(port);
      expect(seen).toMatchObject({ method: "GET", url: "/health" });
      expect(seen.headers.origin).toBeUndefined();
    });
  });

  it("names the log file by port", () => {
    expect(serverLogPath(8181)).toBe(join(tmpdir(), "qmd-search-server-8181.log"));
  });

  describe("createServerDeps", () => {
    let dir: string;
    let settings: QmdSearchSettings;
    let store: KeyValueStore;
    let cli: QmdCli;
    let deps: ServerDeps;
    /** What `afterEach` kills: each launcher, its process group, and the child it reported. */
    const leftovers: number[] = [];

    const readLog = (): string => readFileSync(serverLogPath(port), "utf8");

    /** Installs `body` as the `qmd` the deps run. */
    function fakeQmd(body: string): string {
      const path = join(dir, "qmd");
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      settings.qmdPath = path;
      return path;
    }

    function spawnServer(): SpawnedServer {
      const result = deps.spawnServer(port);
      if (result.pid !== undefined) leftovers.push(-result.pid, result.pid);
      return result;
    }

    /** A stand-in for the launcher: it starts a child of its own, reports it, and waits. */
    async function spawnLauncher(): Promise<{ pid: number; child: number; exit: SpawnedServer["exit"] }> {
      fakeQmd('echo "args:$*"\necho "path:$PATH"\necho "on stderr" >&2\nsleep 300 &\necho "child:$!"\nwait');
      const { pid, exit } = spawnServer();
      await waitFor(() => /child:\d+/.test(readLog()));
      const child = Number(/child:(\d+)/.exec(readLog())![1]);
      leftovers.push(child);
      return { pid: pid!, child, exit };
    }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "qmd-search-deps-"));
      settings = { ...DEFAULT_SETTINGS, qmdPath: join(dir, "qmd"), extraPath: "/extra/one", port, idleTimeoutMinutes: 7 };
      store = memoryStore();
      cli = new QmdCli(() => settings);
      deps = createServerDeps({ cli, getSettings: () => settings, store });
    });

    afterEach(() => {
      for (const target of leftovers.splice(0)) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(serverLogPath(port), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    });

    it("passes the settings and the health check through", async () => {
      expect(deps.getSettings()).toMatchObject({ port, idleTimeoutMinutes: 7 });
      respondRaw(200, '{"status":"ok","uptime":3}');
      expect(await deps.health(port)).toBe(true);
      respondRaw(200, '{"status":"starting"}');
      expect(await deps.health(port)).toBe(false);
    });

    it("spawns qmd mcp --http on the port, with the CLI's PATH and its output in a fresh log", async () => {
      writeFileSync(serverLogPath(port), "left over from the last server\n");
      const { child } = await spawnLauncher();
      const path = cli.env().PATH!;
      expect(path.startsWith(`${dir}:/extra/one:`)).toBe(true);
      expect(readLog()).toBe(`args:mcp --http --port ${port}\npath:${path}\non stderr\nchild:${child}\n`);
    });

    it("reports the launcher's real command line and whether it is alive", async () => {
      const { pid, exit } = await spawnLauncher();
      expect(deps.isAlive(pid)).toBe(true);
      expect(deps.commandLine(pid)).toContain(`${settings.qmdPath} mcp --http --port ${port}`);
      deps.killGroup(pid, "SIGKILL");
      await exit;
      expect(deps.isAlive(pid)).toBe(false);
      expect(deps.commandLine(pid)).toBeNull();
    });

    it("makes the launcher the leader of a process group of its own, which holds its child", async () => {
      const { pid, child } = await spawnLauncher();
      expect(groupOf(pid)).toBe(pid);
      expect(groupOf(child)).toBe(pid);
      expect(groupOf(process.pid)).not.toBe(pid);
    });

    it("killGroup reaches the launcher's child too, and does nothing once the group is gone", async () => {
      const { pid, child, exit } = await spawnLauncher();
      deps.killGroup(pid, "SIGTERM");
      expect(await exit).toEqual({ code: null });
      await waitFor(() => !alive(child));
      expect(() => deps.killGroup(pid, "SIGTERM")).not.toThrow();
      expect(() => deps.killGroup(pid, "SIGKILL")).not.toThrow();
    });

    it("killGroup does nothing when the launcher has exited but has not been reaped", () => {
      fakeQmd("exit 0");
      const { pid } = spawnServer();
      // macOS answers EPERM, not ESRCH, for a group whose only members are zombies.
      for (let i = 0; i < 250 && deps.commandLine(pid!) !== "<defunct>"; i++) sleepSync(20);
      expect(deps.commandLine(pid!)).toBe("<defunct>");
      expect(() => deps.killGroup(pid!, "SIGTERM")).not.toThrow();
    });

    // `process.kill(-0)` signals this process's own group, and `process.kill(-1)` every process the user owns.
    it("killGroup signals only the group of a PID that is an integer above 1", () => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        for (const pid of [0, 1, -3, 1.5, Number.NaN]) deps.killGroup(pid, "SIGTERM");
        expect(kill).not.toHaveBeenCalled();
        deps.killGroup(4242, "SIGTERM");
        expect(kill.mock.calls).toEqual([[-4242, "SIGTERM"]]);
      } finally {
        kill.mockRestore();
      }
    });

    it("resolves exit with the launcher's exit code", async () => {
      fakeQmd("exit 3");
      const { pid, exit } = spawnServer();
      expect(pid).toEqual(expect.any(Number));
      expect(await exit).toEqual({ code: 3 });
    });

    it("reports a qmd that is missing or not executable through exit", async () => {
      const missing = spawnServer();
      expect(missing.pid).toBeUndefined();
      expect(await missing.exit).toEqual({ code: null, errorCode: "ENOENT" });
      writeFileSync(settings.qmdPath, "#!/bin/sh\n");
      const notExecutable = spawnServer();
      expect(notExecutable.pid).toBeUndefined();
      expect(await notExecutable.exit).toEqual({ code: null, errorCode: "EACCES" });
    });

    it("reports a spawn that throws through exit", async () => {
      settings.qmdPath = "";
      const result = spawnServer();
      expect(result.pid).toBeUndefined();
      expect(await result.exit).toEqual({ code: null, errorCode: "ERR_INVALID_ARG_VALUE" });
    });

    it("spawns nothing when the log cannot be opened, and does not blame qmd", async () => {
      fakeQmd("exit 0");
      mkdirSync(serverLogPath(port));
      const result = spawnServer();
      expect(result.pid).toBeUndefined();
      expect(await result.exit).toEqual({ code: null });
    });

    it("logTail is the last 20 lines of the log, or empty without one", () => {
      expect(deps.logTail(port)).toBe("");
      const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
      writeFileSync(serverLogPath(port), `${lines.join("\n")}\n`);
      expect(deps.logTail(port)).toBe(lines.slice(5).join("\n"));
      writeFileSync(serverLogPath(port), "only line\n");
      expect(deps.logTail(port)).toBe("only line");
    });

    it("saves and loads the ownership record under its key", () => {
      expect(deps.loadRecord()).toBeNull();
      deps.saveRecord({ pid: 4242, port: 8181 });
      expect(store.get(SERVER_RECORD_KEY)).toEqual({ pid: 4242, port: 8181 });
      expect(deps.loadRecord()).toEqual({ pid: 4242, port: 8181 });
      deps.saveRecord(null);
      expect(store.get(SERVER_RECORD_KEY)).toBeNull();
      expect(deps.loadRecord()).toBeNull();
    });

    it.each([
      ["a string", "4242:8181"],
      ["a number", 4242],
      ["an array", [4242, 8181]],
      ["null", null],
      ["a record with no port", { pid: 4242 }],
      ["a record with no pid", { port: 8181 }],
      ["pid 0, whose group is this process's own", { pid: 0, port: 8181 }],
      ["pid 1, whose negation means every process", { pid: 1, port: 8181 }],
      ["pid -5", { pid: -5, port: 8181 }],
      ["pid 1.5", { pid: 1.5, port: 8181 }],
      ["pid NaN", { pid: Number.NaN, port: 8181 }],
      ['pid "4242"', { pid: "4242", port: 8181 }],
      ["port 0", { pid: 4242, port: 0 }],
      ["port 70000", { pid: 4242, port: 70_000 }],
      ["port 8181.5", { pid: 4242, port: 8181.5 }],
      ["port NaN", { pid: 4242, port: Number.NaN }],
      ['port "8181"', { pid: 4242, port: "8181" }],
    ])("loads nothing from %s", (_name, stored) => {
      store.set(SERVER_RECORD_KEY, stored);
      expect(deps.loadRecord()).toBeNull();
    });

    it.each([
      [{ pid: 2, port: 1 }],
      [{ pid: 4242, port: 65_535 }],
    ])("loads %j, at the edge of what is valid", (stored) => {
      store.set(SERVER_RECORD_KEY, stored);
      expect(deps.loadRecord()).toEqual(stored);
    });
  });
});
