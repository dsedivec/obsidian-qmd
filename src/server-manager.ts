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

const POLL_MS = 250;
const STARTUP_LIMIT_MS = 60_000;
const KILL_GRACE_MS = 5_000;
/**
 * How long after its SIGTERM a stopped group can keep a start on its port waiting. Longer than
 * `KILL_GRACE_MS`, so that the SIGKILL has landed.
 */
const STOPPED_WAIT_MS = 6_000;
/** How long a recorded server has at load to answer health before it is taken for hung. */
const ADOPT_WAIT_MS = 3_000;
const SHUT_DOWN = "The QMD server manager was shut down.";
const CANCELLED = "The QMD server start was cancelled.";

type Timer = ReturnType<typeof setTimeout>;
type StatusListener = (status: "starting") => void;
type StartOutcome = "healthy" | "timeout" | "stopped" | SpawnExit;
/** A process group this manager has sent SIGTERM: the port it served, and when it was signalled, by `performance.now()`. */
interface StoppedGroup { pid: number; port: number; at: number }

/**
 * Makes sure a QMD server is reachable and stops only its own.
 *
 * `killGroup` is called only with a PID that `spawnServer` returned to this manager (held in
 * `pending`, then in `owned`), or with one from a saved record that passed the checks in
 * `adoptIfOurs`: either it answered health (held in `owned`), or it never did and its command
 * line names this port's server (never held, only stopped). A server that merely answers health
 * is none of these, and is never signalled. A PID that was not spawned moments ago is checked
 * again right before SIGTERM, in `stopRecorded` and nowhere else. An owned PID is forgotten once
 * its launcher has exited and its process group is gone, so a PID that died and was reused is
 * not signalled either. Every PID here names a process group: the launcher leads it and the
 * server is in it.
 *
 * It never spawns on a port while a group it has itself sent SIGTERM for that port is still
 * alive: such a group holds the port, and the new server could not bind it. Every SIGTERM is
 * remembered in `stopped`, and a start waits for those groups first. Nor does it spawn while it
 * owns a server: a start that has waited asks for health again, and stops what it has come to
 * own meanwhile, before it goes on.
 *
 * `adoptIfOurs` is to be called once, at load, and to have settled before the first
 * `ensureRunning`. At load the plugin does so: it awaits `adoptIfOurs` before it starts the
 * indexer, and every search waits for the indexer. (A settings change in those seconds can start
 * the indexer sooner.) A caller that lets a start overlap the adoption's three seconds still gets
 * both guarantees, but a worse answer: with no group of its own stopped on the port, that start
 * spawns at once, and fails as "port in use" for as long as the hung recorded server holds the
 * port. The adoption then stands down for the server being started, and leaves the record to the
 * next load.
 *
 * `stopIfOwned` and `dispose` also overtake work that is waiting: on a health answer, for a
 * stopped server to be gone, or for a recorded server to answer. A start does not go on to
 * spawn, and an adoption does not go on to own or to signal. After `dispose` the manager spawns
 * nothing, owns nothing new and never arms the idle timer again; only `stopIfOwned` still acts.
 * A SIGKILL follow-up is the one timer `dispose` leaves alone.
 */
export class ServerManager {
  /** The running server this manager spawned or adopted. */
  private owned: OwnedRecord | null = null;
  /** The server this manager spawned that has not answered health yet and has not exited. */
  private pending: { pid: number | undefined; port: number; abort(): void } | null = null;
  /**
   * The groups this manager has sent SIGTERM and has not yet seen gone or given six seconds. In
   * memory only: what an earlier session stopped is not known here.
   */
  private stopped: StoppedGroup[] = [];
  /** The attempt that `ensureRunning` calls join. */
  private attempt: Promise<void> | null = null;
  /** The callers of that attempt that have yet to hear that it is starting a server, or null once they have. */
  private listeners: StatusListener[] | null = null;
  /** Counts `stopIfOwned` calls, so work that waited can tell it was overtaken. */
  private stops = 0;
  private disposed = false;
  private idleTimer: Timer | undefined;
  /** The holds not yet released. The idle timer is not armed while there are any. */
  private holds = 0;
  /** Ends each `poll` in progress. `stopIfOwned` and `dispose` call them all. */
  private readonly polls = new Set<() => void>();

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
      if (this.listeners) this.listeners.push(onStatus);
      else onStatus("starting");
    }
    return this.attempt;
  }

  /** Restarts the idle timer of an owned server. Does nothing while a hold is outstanding. */
  noteActivity(): void {
    clearTimeout(this.idleTimer);
    if (this.disposed || !this.owned || this.holds > 0) return;
    const { idleTimeoutMinutes } = this.deps.getSettings();
    this.idleTimer = setTimeout(() => this.stopOwned(), idleTimeoutMinutes * 60_000);
  }

  /**
   * Marks the server as in use. The idle timer does not run while any hold is outstanding.
   * Returns a release function; calling it more than once is harmless. When the last hold is
   * released, the idle timer starts afresh.
   *
   * A hold pauses the idle timer and nothing else: `stopIfOwned`, `dispose` and the stop of a
   * server that no longer answers all go ahead. It is counted whether or not a server is owned,
   * so a server that comes to be owned during a hold gets its idle timer at the release.
   */
  hold(): () => void {
    if (this.disposed) return () => {};
    this.holds++;
    clearTimeout(this.idleTimer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds === 0) this.noteActivity();
    };
  }

  /** Synchronous, so it is safe to call from `beforeunload`. */
  stopIfOwned(): void {
    // Overtake a start or adoption that is waiting, and detach the attempt in flight so that a
    // call made from now on begins a fresh one.
    this.stops++;
    this.attempt = null;
    this.endPolls();
    const starting = this.pending;
    this.pending = null;
    starting?.abort();
    // Returned by `spawnServer` and not yet exited, so this PID needs no identity check.
    if (starting?.pid !== undefined) this.terminate(starting.pid, starting.port);
    this.stopOwned();
  }

  /**
   * Crash recovery, for a server recorded by an earlier session. One that answers health is taken
   * back as owned. One that does not answer within three seconds, and is this port's server by
   * its command line, is stopped: nothing else would ever stop it. Otherwise the record is
   * cleared and nothing is signalled.
   */
  async adoptIfOurs(): Promise<void> {
    if (this.disposed) return;
    const record = this.deps.loadRecord();
    if (!record) return;
    // A group signal to PID 0 or 1 would reach the group of this process, or every process. Such
    // a record is discarded before anything is asked about its PID.
    if (!isUsablePid(record.pid)) {
      this.deps.saveRecord(null);
      return;
    }
    // A server this session spawned takes precedence, and its outcome settles the record.
    if (this.owned || this.pending) return;
    if (record.port !== this.deps.getSettings().port || !this.looksLikeQmdServer(record.pid)) {
      this.deps.saveRecord(null);
      return;
    }
    const stops = this.stops;
    // A fair chance to answer: a server that is busy for a moment is still worth keeping.
    const answered = await this.poll(() => this.deps.health(record.port), ADOPT_WAIT_MS);
    // Overtaken by a stop or a shutdown: own nothing, signal nothing, and leave the record for a
    // later session.
    if (this.disposed || this.stops !== stops) return;
    if (this.owned || this.pending) return;
    if (answered) this.own(record);
    // Hung, and never owned by this session. With no health answer to vouch for it, it is
    // signalled only if its command line names this very port; the record is cleared either way.
    else this.stopRecorded(record, "on-this-port");
  }

  /**
   * Shuts the manager down for good. It clears the idle timer, the startup timers and the timers
   * of every other wait, fails a start that is waiting, and sends no signal. From then on
   * `ensureRunning` rejects, `noteActivity` and `adoptIfOurs` do nothing, and `hold` counts
   * nothing; `stopIfOwned` still works.
   *
   * It does not cancel a SIGKILL follow-up: a server that ignores SIGTERM must still be killed
   * after the plugin unloads. When Obsidian itself quits, the page goes away and that timer never
   * fires.
   */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.pending?.abort();
    this.endPolls();
  }

  private async start(listeners: StatusListener[]): Promise<void> {
    const { port } = this.deps.getSettings();
    const stops = this.stops;
    const healthy = await this.deps.health(port);
    if (this.disposed || this.stops !== stops) throw this.overtaken();
    if (healthy) return;
    // An owned server that does not answer is stopped and replaced.
    this.stopOwned();
    // From here on a caller that joins this attempt is told at once.
    if (this.listeners === listeners) this.listeners = null;
    for (const listener of listeners) listener("starting");
    // A group this manager has stopped holds the port until it is gone, whichever stop it was:
    // the one just above, the idle timer, `stopIfOwned`, the stop at load, or a failed start. One
    // that does not act on SIGTERM goes at the SIGKILL; past its six seconds the spawn is tried
    // anyway. Asked again after each wait, because a group can be stopped during one.
    for (let wait = this.waitForStopped(port); wait > 0; wait = this.waitForStopped(port)) {
      await this.poll(() => this.waitForStopped(port) === 0, wait);
      if (this.disposed || this.stops !== stops) throw this.overtaken();
      // Time has passed, so what the first health check found may no longer hold. A server may
      // answer now: one that an adoption has come to own meanwhile, or another program's. It is
      // used as it is, owned or not, and nothing is spawned.
      const answers = await this.deps.health(port);
      if (this.disposed || this.stops !== stops) throw this.overtaken();
      if (answers) return;
      // A server that came to be owned during the wait and does not answer is stopped like the
      // one before it, and waited for in its turn.
      this.stopOwned();
    }
    // Nothing is owned here: `stopOwned` ran since the last health answer, with no await after it.
    const server = this.deps.spawnServer(port);
    const outcome = await this.untilStarted(port, server);
    if (outcome === "healthy") {
      if (server.pid === undefined) return;
      const record = { pid: server.pid, port };
      this.own(record);
      // The launcher can exit while the server it spawned lives on in the group. The PID can be
      // reused only once the whole group is gone, so only then is the server forgotten.
      void server.exit.then(() => {
        if (this.owned === record && !this.disposed && !this.deps.isAlive(record.pid)) this.forget(record);
      });
      return;
    }
    if (outcome === "stopped") throw this.overtaken();
    // The start failed: 60 seconds passed, or the launcher exited. After a timeout the group is
    // still there; after an exit the server the launcher spawned may be. Either way it is the
    // group `spawnServer` created moments ago, so there is no identity check.
    if (server.pid !== undefined && (outcome === "timeout" || this.deps.isAlive(server.pid))) {
      this.terminate(server.pid, port);
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
        }, POLL_MS);
      };
      const deadline = setTimeout(() => settle("timeout"), STARTUP_LIMIT_MS);
      const pending = { pid: server.pid, port, abort: (): void => settle("stopped") };
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

  /**
   * Asks `ask` now, and again 250 ms after each no, until it says yes or `limitMs` have passed.
   * Resolves true for a yes and false otherwise. `stopIfOwned` and `dispose` end it at once, with
   * false and with its timers cleared; the caller tells that from `stops` and `disposed`.
   */
  private poll(ask: () => boolean | Promise<boolean>, limitMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer: Timer | undefined;
      const settle = (answer: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        clearTimeout(deadline);
        this.polls.delete(end);
        resolve(answer);
      };
      const end = (): void => settle(false);
      const check = async (): Promise<void> => {
        const yes = await ask();
        // An answer that comes after the limit, or after a stop, counts for nothing.
        if (settled) return;
        if (yes) settle(true);
        else pollTimer = setTimeout(() => void check(), POLL_MS);
      };
      const deadline = setTimeout(end, limitMs);
      this.polls.add(end);
      void check();
    });
  }

  private endPolls(): void {
    for (const end of [...this.polls]) end();
  }

  /**
   * How many milliseconds a start on `port` still has to wait for the groups this manager has
   * stopped there: until the last of them is gone, and for none of them past six seconds from
   * its SIGTERM. Zero when there is nothing to wait for. A group on another port is never waited
   * for. Forgets every group, on any port, that is gone or past its six seconds.
   */
  private waitForStopped(port: number): number {
    const now = performance.now();
    this.stopped = this.stopped.filter((group) => now - group.at < STOPPED_WAIT_MS && this.deps.isAlive(group.pid));
    const waits = this.stopped.filter((group) => group.port === port).map((group) => group.at + STOPPED_WAIT_MS - now);
    return Math.max(0, ...waits);
  }

  /** Why a start that `stopIfOwned` or `dispose` overtook fails. */
  private overtaken(): QmdSearchError {
    return new QmdSearchError("server-start", this.disposed ? SHUT_DOWN : CANCELLED);
  }

  /** Stops the owned server if its PID still looks like a QMD server, and forgets it either way. */
  private stopOwned(): void {
    if (this.owned) this.stopRecorded(this.owned, "qmd-server");
  }

  /**
   * The one way to SIGTERM for a PID that was not spawned moments ago: the owned server's, or at
   * load that of a recorded server which never answered. It is signalled only if it passes the
   * identity test now, and it is forgotten either way.
   */
  private stopRecorded(record: OwnedRecord, identity: "qmd-server" | "on-this-port"): void {
    const ours = identity === "on-this-port" ? this.isServerOnItsPort(record) : this.looksLikeQmdServer(record.pid);
    // Signal before clearing the record: a save that throws must not leave the server running.
    if (ours) this.terminate(record.pid, record.port);
    this.forget(record);
  }

  /**
   * The identity test for a process group the manager did not just spawn: it still has a live
   * member, and one of its processes has a command line naming both qmd and mcp. Adoption
   * requires it, and so does every SIGTERM to an owned server, in case the group died and its PID
   * was reused. With `port`, that same command line must also pass `--port` with that port.
   */
  private looksLikeQmdServer(pid: number, port?: number): boolean {
    if (!this.deps.isAlive(pid)) return false;
    const commandLines = this.deps.commandLine(pid);
    if (commandLines === null) return false;
    // Line by line: `qmd` in one process and `mcp` in another does not make either the server.
    return commandLines
      .split("\n")
      .some((line) => line.includes("qmd") && line.includes("mcp") && (port === undefined || namesPort(line, port)));
  }

  /**
   * The stricter identity test, for a recorded server that is signalled without ever having
   * answered health: a usable PID, the port that is set now, a live group, and in it one process
   * whose command line names qmd, mcp and `--port` with that port.
   */
  private isServerOnItsPort(record: OwnedRecord): boolean {
    return (
      isUsablePid(record.pid) &&
      record.port === this.deps.getSettings().port &&
      this.looksLikeQmdServer(record.pid, record.port)
    );
  }

  /**
   * SIGTERM now, SIGKILL five seconds later. Nothing cancels the SIGKILL, `dispose` included.
   * Every SIGTERM this manager sends is sent here, so every group it stops is remembered with the
   * port it served: a start on that port waits for it to be gone.
   */
  private terminate(pid: number, port: number): void {
    this.deps.killGroup(pid, "SIGTERM");
    this.stopped.push({ pid, port, at: performance.now() });
    // Unconditional: `killGroup` does nothing once the whole group is gone.
    setTimeout(() => this.deps.killGroup(pid, "SIGKILL"), KILL_GRACE_MS);
  }

  private own(record: OwnedRecord): void {
    this.owned = record;
    this.deps.saveRecord(record);
    this.noteActivity();
  }

  /**
   * Forgets `record` and nothing else: it is no longer owned if it was the owned one, and the
   * saved record is cleared only if it still names that server. Another server's ownership, and a
   * record saved for another server since, are left as they are.
   */
  private forget(record: OwnedRecord): void {
    if (this.owned === record) {
      clearTimeout(this.idleTimer);
      this.owned = null;
    }
    const saved = this.deps.loadRecord();
    if (saved !== null && saved.pid === record.pid && saved.port === record.port) this.deps.saveRecord(null);
  }
}

/** A PID that a group signal may be sent to. One to 0 or 1 would reach this process's own group, or every process. */
function isUsablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/** True when the command line passes `--port` with exactly this port as the argument after it. */
function namesPort(commandLine: string, port: number): boolean {
  const args = commandLine.split(/\s+/);
  return args.some((arg, i) => arg === "--port" && args[i + 1] === String(port));
}
