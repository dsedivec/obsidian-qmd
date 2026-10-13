import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyValueStore, QmdSearchSettings } from "./config";
import type { QmdCli } from "./qmd-cli";
import type {
  OwnedRecord,
  ServerDeps,
  SpawnedServer,
  SpawnExit,
} from "./server-manager";

export const SERVER_RECORD_KEY = "qmd-search-server";

const LOG_TAIL_LINES = 20;
const PS_TIMEOUT_MS = 2000;
/** Room for every process's full command line. Past it `ps` fails, and a server cannot be recognised. */
const PS_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Resolves true when a QMD server answers `GET /health` on the port within the time allowed. Never rejects. */
export function checkHealth(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let req: http.ClientRequest | undefined;
    const finish = (healthy: boolean): void => {
      clearTimeout(timer);
      req?.destroy();
      resolve(healthy);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      req = http.get(
        { host: "localhost", port, path: "/health", agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          // An answer that is cut off ends in `error`, never in `end`.
          res.on("error", () => finish(false));
          res.on("end", () =>
            finish(
              res.statusCode === 200 &&
                saysOk(Buffer.concat(chunks).toString("utf8")),
            ),
          );
        },
      );
      req.on("error", () => finish(false));
    } catch {
      // `http.get` throws for a port number that cannot exist.
      finish(false);
    }
  });
}

function saysOk(body: string): boolean {
  try {
    return (JSON.parse(body) as { status?: unknown } | null)?.status === "ok";
  } catch {
    return false;
  }
}

export function serverLogPath(port: number): string {
  return join(tmpdir(), `qmd-search-server-${port}.log`);
}

/** The Node side of `ServerManager`: real processes, signals, the log file and the saved record. */
export function createServerDeps(opts: {
  cli: QmdCli;
  getSettings: () => QmdSearchSettings;
  store: KeyValueStore;
}): ServerDeps {
  const { cli, getSettings, store } = opts;
  return {
    getSettings,
    health: (port) => checkHealth(port),
    spawnServer: (port) => spawnServer(cli, getSettings, port),
    logTail,
    isAlive,
    commandLine,
    killGroup,
    loadRecord: () => toOwnedRecord(store.get(SERVER_RECORD_KEY)),
    saveRecord: (record) => store.set(SERVER_RECORD_KEY, record),
  };
}

function notSpawned(errorCode?: string): SpawnedServer {
  return {
    pid: undefined,
    exit: Promise.resolve(
      errorCode === undefined ? { code: null } : { code: null, errorCode },
    ),
  };
}

function spawnServer(
  cli: QmdCli,
  getSettings: () => QmdSearchSettings,
  port: number,
): SpawnedServer {
  let log: number;
  try {
    // Private to the user: the server logs the text of every query.
    log = openSync(serverLogPath(port), "w", 0o600);
  } catch {
    // No error code: `ENOENT` or `EACCES` from the log file would read as a `qmd` that cannot be run.
    return notSpawned();
  }
  try {
    // Detached, so that the launcher leads a process group that holds the real server too: the
    // launcher starts the server as its child and does not forward signals to it.
    const child = spawn(
      getSettings().qmdPath,
      ["mcp", "--http", "--port", String(port)],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: cli.env(),
      },
    );
    const exit = new Promise<SpawnExit>((resolve) => {
      child.on("exit", (code) => resolve({ code }));
      child.on("error", (e: NodeJS.ErrnoException) =>
        resolve({ code: null, errorCode: e.code }),
      );
    });
    return { pid: child.pid, exit };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    return notSpawned(typeof code === "string" ? code : undefined);
  } finally {
    closeSync(log);
  }
}

function logTail(port: number): string {
  try {
    return readFileSync(serverLogPath(port), "utf8")
      .trimEnd()
      .split("\n")
      .slice(-LOG_TAIL_LINES)
      .join("\n");
  } catch {
    return "";
  }
}

// `isAlive` and `commandLine` describe the process group that `pid` leads, not the launcher alone.
// The launcher can die and leave the real server running in its group, and the group is what
// `killGroup` signals.

/** True while the group led by `pid` has a live member that this user may signal. */
function isAlive(pid: number): boolean {
  if (!isOrdinaryPid(pid)) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    // `ESRCH` is no such group. `EPERM` is a group this user may not signal, so not the plugin's,
    // or on macOS one whose only members are zombies, such as an exited launcher not yet reaped.
    return false;
  }
}

/** The command lines of the live processes in the group led by `pid`, one to a line, or null if there are none. */
function commandLine(pid: number): string | null {
  if (!isOrdinaryPid(pid)) return null;
  try {
    // Every process, filtered here: `ps -g` means different things on macOS and Linux. One `-o` for
    // each column, because some `ps` take everything after an `=` as that column's heading.
    const output = execFileSync(
      "/bin/ps",
      ["-A", "-o", "pgid=", "-o", "stat=", "-o", "command="],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_OUTPUT_BYTES,
      },
    );
    const commands: string[] = [];
    for (const row of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(row);
      // A state that starts with Z is a zombie: exited, and not a live member.
      if (match && Number(match[1]) === pid && !match[2].startsWith("Z"))
        commands.push(match[3]);
    }
    return commands.length > 0 ? commands.join("\n") : null;
  } catch {
    return null;
  }
}

function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (!isOrdinaryPid(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch (e) {
    // `ESRCH` is a group that is gone. macOS answers `EPERM` for a group whose only members are
    // zombies, such as a launcher that has exited and that Node has not reaped yet. Either way
    // there is nothing left to signal.
    const { code } = e as NodeJS.ErrnoException;
    if (code !== "ESRCH" && code !== "EPERM") throw e;
  }
}

/**
 * A PID that a spawned process can have. 0 and 1 are not, and must never reach a group signal:
 * `process.kill(-0)` signals this process's own group, and `process.kill(-1)` every process there is.
 */
function isOrdinaryPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

function isPort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
  );
}

/** The saved value as a record, or null when it is anything but a usable PID and port. */
function toOwnedRecord(value: unknown): OwnedRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { pid, port } = value as Record<string, unknown>;
  return isOrdinaryPid(pid) && isPort(port) ? { pid, port } : null;
}
