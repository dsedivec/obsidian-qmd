import { classifyStartFailure, QmdSearchError } from "./errors";

export interface OwnedRecord { pid: number; port: number }
export interface SpawnExit { code: number | null; errorCode?: string }
/** `pid` is undefined when the spawn itself failed. `exit` resolves when the launcher exits or could not be spawned; it never rejects. */
export interface SpawnedServer { pid: number | undefined; exit: Promise<SpawnExit> }
export interface ServerDeps {
  getSettings(): { port: number; idleTimeoutMinutes: number };
  /** Resolves true when a QMD server answers on the port, false otherwise. Never rejects. */
  health(port: number): Promise<boolean>;
  spawnServer(port: number): SpawnedServer;
  logTail(port: number): string;
  isAlive(pid: number): boolean;
  commandLine(pid: number): string | null;
  /** Signals the process group led by `pid`. Does nothing when the group is already gone. */
  killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  loadRecord(): OwnedRecord | null;
  saveRecord(record: OwnedRecord | null): void;
}

const HEALTH_POLL_MS = 250;
const STARTUP_LIMIT_MS = 60_000;
const KILL_GRACE_MS = 5_000;

type Timer = ReturnType<typeof setTimeout>;
type StatusListener = (status: "starting") => void;
type StartOutcome = "healthy" | "timeout" | "stopped" | SpawnExit;

function isQmdServer(commandLine: string | null): boolean {
  return commandLine !== null && commandLine.includes("qmd") && commandLine.includes("mcp");
}

/**
 * Makes sure a QMD server is reachable and stops only its own.
 *
 * `killGroup` is called only with a PID that `spawnServer` returned to this manager (held in
 * `pending`, then in `owned`), or with one from a saved record that passed every check in
 * `adoptIfOurs` (held in `owned`). A server that merely answers health is neither, and is never
 * signalled.
 */
export class ServerManager {
  /** The running server this manager spawned or adopted. */
  private owned: OwnedRecord | null = null;
  /** The server this manager spawned that has not answered health yet. */
  private pending: { pid: number | undefined; abort(): void } | null = null;
  private attempt: Promise<void> | null = null;
  private listeners: StatusListener[] = [];
  private idleTimer: Timer | undefined;
  private readonly killTimers = new Set<Timer>();

  constructor(private readonly deps: ServerDeps) {}

  /** Resolves once a server answers. Concurrent calls share one attempt. */
  ensureRunning(onStatus?: StatusListener): Promise<void> {
    if (onStatus) {
      if (this.pending) onStatus("starting");
      else this.listeners.push(onStatus);
    }
    this.attempt ??= this.start().finally(() => {
      this.attempt = null;
      this.listeners = [];
    });
    return this.attempt;
  }

  /** Restarts the idle timer of an owned server. */
  noteActivity(): void {
    clearTimeout(this.idleTimer);
    if (!this.owned) return;
    const { idleTimeoutMinutes } = this.deps.getSettings();
    this.idleTimer = setTimeout(() => this.stopIfOwned(), idleTimeoutMinutes * 60_000);
  }

  /** Synchronous, so it is safe to call from `beforeunload`. */
  stopIfOwned(): void {
    const pid = this.owned?.pid ?? this.pending?.pid;
    this.forget();
    this.pending?.abort();
    if (pid === undefined) return;
    this.deps.killGroup(pid, "SIGTERM");
    // Unconditional: `killGroup` does nothing once the group is gone, and the launcher dying first
    // says nothing about the server it spawned. On unload `dispose` clears this before it fires.
    const timer = setTimeout(() => {
      this.killTimers.delete(timer);
      this.deps.killGroup(pid, "SIGKILL");
    }, KILL_GRACE_MS);
    this.killTimers.add(timer);
  }

  /** Crash recovery: takes back a server recorded by an earlier session, or clears the record. */
  async adoptIfOurs(): Promise<void> {
    const record = this.deps.loadRecord();
    if (!record) return;
    const ours =
      record.port === this.deps.getSettings().port &&
      this.deps.isAlive(record.pid) &&
      isQmdServer(this.deps.commandLine(record.pid)) &&
      (await this.deps.health(record.port));
    // A server this session spawned takes precedence, and its outcome settles the record.
    if (this.owned || this.pending) return;
    if (ours) this.own(record);
    else this.deps.saveRecord(null);
  }

  /** Clears every timer and signals nothing. */
  dispose(): void {
    clearTimeout(this.idleTimer);
    for (const timer of this.killTimers) clearTimeout(timer);
    this.killTimers.clear();
    this.pending?.abort();
  }

  private async start(): Promise<void> {
    const { port } = this.deps.getSettings();
    if (await this.deps.health(port)) return;
    // A server this manager owned is not answering. Treat it as gone: forget it, do not signal it.
    this.forget();
    for (const listener of this.listeners) listener("starting");
    const server = this.deps.spawnServer(port);
    const outcome = await this.untilStarted(port, server);
    if (outcome === "healthy") {
      if (server.pid !== undefined) this.own({ pid: server.pid, port });
      return;
    }
    // One SIGTERM and no SIGKILL follow-up, so that a failed start leaves no timer behind.
    if (outcome === "timeout" && server.pid !== undefined) this.deps.killGroup(server.pid, "SIGTERM");
    const tail = this.deps.logTail(port);
    const errorCode = typeof outcome === "object" ? outcome.errorCode : undefined;
    throw new QmdSearchError(classifyStartFailure(tail, errorCode), "The QMD server did not start.", tail);
  }

  /** Waits until the spawned server answers health, exits, runs out of time, or is stopped. */
  private untilStarted(port: number, server: SpawnedServer): Promise<StartOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer: Timer | undefined;
      const settle = (outcome: StartOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        clearTimeout(deadline);
        this.pending = null;
        resolve(outcome);
      };
      const poll = (): void => {
        pollTimer = setTimeout(() => {
          void this.deps.health(port).then((healthy) => {
            if (settled) return;
            if (healthy) settle("healthy");
            else poll();
          });
        }, HEALTH_POLL_MS);
      };
      const deadline = setTimeout(() => settle("timeout"), STARTUP_LIMIT_MS);
      this.pending = { pid: server.pid, abort: () => settle("stopped") };
      void server.exit.then(settle);
      poll();
    });
  }

  private own(record: OwnedRecord): void {
    this.owned = record;
    this.deps.saveRecord(record);
    this.noteActivity();
  }

  private forget(): void {
    clearTimeout(this.idleTimer);
    if (!this.owned) return;
    this.owned = null;
    this.deps.saveRecord(null);
  }
}
