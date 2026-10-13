import { classifyStartFailure, QmdSearchError } from "./errors";

export interface OwnedRecord { pid: number; port: number }
export interface SpawnExit { code: number | null; errorCode?: string }
/**
 * `pid` is the launcher, which leads the process group the server runs in; it is undefined when
 * the spawn itself failed. `exit` resolves when the launcher exits or could not be spawned, and
 * never rejects. The launcher exiting does not mean the group is gone: the server is its child.
 */
export interface SpawnedServer { pid: number | undefined; exit: Promise<SpawnExit> }
export interface ServerDeps {
  getSettings(): { port: number; idleTimeoutMinutes: number };
  /** Resolves true when a QMD server answers on the port, false otherwise. Never rejects. */
  health(port: number): Promise<boolean>;
  spawnServer(port: number): SpawnedServer;
  logTail(port: number): string;
  /** True while the process group led by `pid` still has a live member, whether or not `pid` itself does. */
  isAlive(pid: number): boolean;
  /**
   * The command lines of the live processes in the group led by `pid`, joined with newlines, or
   * null when there are none or they cannot be read.
   */
  commandLine(pid: number): string | null;
  /** Signals the process group led by `pid`. Does nothing when the group is already gone. */
  killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  loadRecord(): OwnedRecord | null;
  saveRecord(record: OwnedRecord | null): void;
}

const HEALTH_POLL_MS = 250;
const STARTUP_LIMIT_MS = 60_000;
const KILL_GRACE_MS = 5_000;
const SHUT_DOWN = "The QMD server manager was shut down.";
const CANCELLED = "The QMD server start was cancelled.";

type Timer = ReturnType<typeof setTimeout>;
type StatusListener = (status: "starting") => void;
type StartOutcome = "healthy" | "timeout" | "stopped" | SpawnExit;

/**
 * Makes sure a QMD server is reachable and stops only its own.
 *
 * `killGroup` is called only with a PID that `spawnServer` returned to this manager (held in
 * `pending`, then in `owned`), or with one from a saved record that passed every check in
 * `adoptIfOurs` (held in `owned`). A server that merely answers health is neither, and is never
 * signalled. An owned PID is checked again right before SIGTERM, and forgotten once its launcher
 * has exited and its process group is gone, so a PID that died and was reused is not signalled
 * either. Every PID here names a process group: the launcher leads it and the server is in it.
 *
 * `stopIfOwned` and `dispose` also overtake work that is waiting on a health answer: a start
 * does not go on to spawn, and an adoption does not go on to own. After `dispose` the manager
 * spawns nothing, owns nothing new and arms no timer; only `stopIfOwned` still acts.
 */
export class ServerManager {
  /** The running server this manager spawned or adopted. */
  private owned: OwnedRecord | null = null;
  /** The server this manager spawned that has not answered health yet and has not exited. */
  private pending: { pid: number | undefined; abort(): void } | null = null;
  /** The attempt that `ensureRunning` calls join, with the callers waiting to hear whether it spawns. */
  private attempt: Promise<void> | null = null;
  private listeners: StatusListener[] = [];
  /** Counts `stopIfOwned` calls, so work that awaited a health answer can tell it was overtaken. */
  private stops = 0;
  private disposed = false;
  private idleTimer: Timer | undefined;
  private readonly killTimers = new Set<Timer>();

  constructor(private readonly deps: ServerDeps) {}

  /** Resolves once a server answers. Concurrent calls share one attempt. */
  ensureRunning(onStatus?: StatusListener): Promise<void> {
    if (this.disposed) return Promise.reject(new QmdSearchError("server-start", SHUT_DOWN));
    if (!this.attempt) {
      const listeners: StatusListener[] = [];
      const attempt: Promise<void> = this.start(listeners).finally(() => {
        if (this.attempt === attempt) this.attempt = null;
      });
      this.attempt = attempt;
      this.listeners = listeners;
    }
    if (onStatus) {
      if (this.pending) onStatus("starting");
      else this.listeners.push(onStatus);
    }
    return this.attempt;
  }

  /** Restarts the idle timer of an owned server. */
  noteActivity(): void {
    clearTimeout(this.idleTimer);
    if (this.disposed || !this.owned) return;
    const { idleTimeoutMinutes } = this.deps.getSettings();
    this.idleTimer = setTimeout(() => this.stopOwned(), idleTimeoutMinutes * 60_000);
  }

  /** Synchronous, so it is safe to call from `beforeunload`. */
  stopIfOwned(): void {
    // Overtake a start or adoption that is waiting on a health answer, and detach the attempt in
    // flight so that a call made from now on begins a fresh one.
    this.stops++;
    this.attempt = null;
    const starting = this.pending;
    this.pending = null;
    starting?.abort();
    // Returned by `spawnServer` and not yet exited, so this PID needs no identity check.
    if (starting?.pid !== undefined) this.terminate(starting.pid);
    this.stopOwned();
  }

  /** Crash recovery: takes back a server recorded by an earlier session, or clears the record. */
  async adoptIfOurs(): Promise<void> {
    if (this.disposed) return;
    const record = this.deps.loadRecord();
    if (!record) return;
    // A group signal to PID 0 or 1 would reach the group of this process, or every process. Such
    // a record is discarded before anything is asked about its PID.
    if (!Number.isInteger(record.pid) || record.pid <= 1) {
      this.deps.saveRecord(null);
      return;
    }
    const stops = this.stops;
    const ours =
      record.port === this.deps.getSettings().port &&
      this.looksLikeQmdServer(record.pid) &&
      (await this.deps.health(record.port));
    // Overtaken by a stop or a shutdown: own nothing, and leave the record for a later session.
    if (this.disposed || this.stops !== stops) return;
    // A server this session spawned takes precedence, and its outcome settles the record.
    if (this.owned || this.pending) return;
    if (ours) this.own(record);
    else this.deps.saveRecord(null);
  }

  /** Clears every timer, signals nothing, and leaves the manager shut down for good. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    for (const timer of this.killTimers) clearTimeout(timer);
    this.killTimers.clear();
    this.pending?.abort();
  }

  private async start(listeners: StatusListener[]): Promise<void> {
    const { port } = this.deps.getSettings();
    const stops = this.stops;
    const healthy = await this.deps.health(port);
    if (this.disposed || this.stops !== stops) throw this.overtaken();
    if (healthy) return;
    // An owned server that does not answer is stopped and replaced.
    this.stopOwned();
    for (const listener of listeners) listener("starting");
    const server = this.deps.spawnServer(port);
    const outcome = await this.untilStarted(port, server);
    if (outcome === "healthy") {
      if (server.pid === undefined) return;
      const record = { pid: server.pid, port };
      this.own(record);
      // The launcher can exit while the server it spawned lives on in the group. The PID can be
      // reused only once the whole group is gone, so only then is the server forgotten.
      void server.exit.then(() => {
        if (this.owned === record && !this.disposed && !this.deps.isAlive(record.pid)) this.forget();
      });
      return;
    }
    if (outcome === "stopped") throw this.overtaken();
    // The start failed: 60 seconds passed, or the launcher exited. After a timeout the group is
    // still there; after an exit the server the launcher spawned may be. Either way it is the
    // group `spawnServer` created moments ago, so there is no identity check.
    if (server.pid !== undefined && (outcome === "timeout" || this.deps.isAlive(server.pid))) {
      this.terminate(server.pid);
    }
    const tail = this.deps.logTail(port);
    const errorCode = typeof outcome === "object" ? outcome.errorCode : undefined;
    throw new QmdSearchError(classifyStartFailure(tail, errorCode), "The QMD server did not start.", tail);
  }

  /** Waits until the spawned server answers health, exits, runs out of time, or is stopped. */
  private untilStarted(port: number, server: SpawnedServer): Promise<StartOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer: Timer | undefined;
      const release = (): void => {
        if (this.pending === pending) this.pending = null;
      };
      const settle = (outcome: StartOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        clearTimeout(deadline);
        // A stopped start keeps its PID on hand: `stopIfOwned` takes it at once, and `dispose`
        // leaves it for a `stopIfOwned` that may follow.
        if (outcome !== "stopped") release();
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
      const pending = { pid: server.pid, abort: (): void => settle("stopped") };
      this.pending = pending;
      void server.exit.then((exit) => {
        // A start that `dispose` stopped gives up its PID here too. With the launcher gone there
        // would be no later sign of the group ending, and so of the PID becoming reusable.
        release();
        settle(exit);
      });
      poll();
    });
  }

  /** Why a start that `stopIfOwned` or `dispose` overtook fails. */
  private overtaken(): QmdSearchError {
    return new QmdSearchError("server-start", this.disposed ? SHUT_DOWN : CANCELLED);
  }

  /** Stops the owned server if its PID still looks like a QMD server, and forgets it either way. */
  private stopOwned(): void {
    const record = this.owned;
    if (!record) return;
    // Signal before clearing the record: a save that throws must not leave the server running.
    if (this.looksLikeQmdServer(record.pid)) this.terminate(record.pid);
    this.forget();
  }

  /**
   * The identity test for a process group the manager did not just spawn: it still has a live
   * member, and its command lines name both qmd and mcp. Adoption requires it, and so does every
   * SIGTERM to an owned server, in case the group died and its PID was reused.
   */
  private looksLikeQmdServer(pid: number): boolean {
    if (!this.deps.isAlive(pid)) return false;
    const commandLine = this.deps.commandLine(pid);
    return commandLine !== null && commandLine.includes("qmd") && commandLine.includes("mcp");
  }

  /** SIGTERM now, SIGKILL five seconds later unless `dispose` clears it first or already ran. */
  private terminate(pid: number): void {
    this.deps.killGroup(pid, "SIGTERM");
    if (this.disposed) return;
    // Unconditional: `killGroup` does nothing once the whole group is gone.
    const timer = setTimeout(() => {
      this.killTimers.delete(timer);
      this.deps.killGroup(pid, "SIGKILL");
    }, KILL_GRACE_MS);
    this.killTimers.add(timer);
  }

  private own(record: OwnedRecord): void {
    this.owned = record;
    this.deps.saveRecord(record);
    this.noteActivity();
  }

  private forget(): void {
    clearTimeout(this.idleTimer);
    this.owned = null;
    this.deps.saveRecord(null);
  }
}
