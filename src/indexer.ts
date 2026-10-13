import type { QmdSearchSettings } from "./config";
import type { CliResult } from "./qmd-cli";

export type IndexState =
  | { kind: "idle"; lastIndexedAt?: number }
  | { kind: "running"; step: "setup" | "update" | "embed" }
  | { kind: "failed"; message: string };

export interface IndexerDeps {
  cli: { run(args: string[], opts: { timeoutMs: number }): Promise<CliResult> };
  getSettings: () => Pick<
    QmdSearchSettings,
    "collectionName" | "reindexQuietMinutes" | "qmdPath"
  >;
  vaultPath: string;
  realpath: (path: string) => string;
  now: () => number;
}

type Step = Extract<IndexState, { kind: "running" }>["step"];

/** What `qmd collection show` says about the configured collection. */
type Found = "here" | "elsewhere" | "missing";

const MINUTE_MS = 60_000;
const SHOW_TIMEOUT_MS = MINUTE_MS;
const ADD_TIMEOUT_MS = 10 * MINUTE_MS;
const UPDATE_TIMEOUT_MS = 10 * MINUTE_MS;
const EMBED_TIMEOUT_MS = 30 * MINUTE_MS;

const pointsElsewhere = (name: string): string =>
  `collection "${name}" points at another folder`;

function lastNonEmptyLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .pop();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the vault's QMD collection current: a run follows once note edits have
 * gone quiet, and there is never more than one run at a time.
 *
 * The only command here that changes a collection is `collection add`. It runs
 * for the configured name alone, and only after `collection show` has reported
 * that no collection of that name exists. A collection of that name that points
 * at another folder is left exactly as it is.
 */
export class Indexer {
  /** The idle state to publish: it carries the time of the last completed run, once there is one. */
  private idleState: IndexState = { kind: "idle" };
  private state: IndexState = this.idleState;
  private readonly listeners = new Set<(state: IndexState) => void>();
  /** Whether search is allowed: the configured collection is this vault's and has been indexed. */
  private ready = false;
  private disposed = false;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private currentRun: Promise<void> | undefined;
  /** The run waiting for `currentRun` to finish; every `runNow()` made meanwhile shares it. */
  private queuedRun: Promise<void> | undefined;
  /** The most recent `start()`. Before the first one, a promise that waits for it. */
  private latestStart: Promise<void>;
  private signalStarted: () => void = () => {};

  constructor(private readonly deps: IndexerDeps) {
    this.latestStart = new Promise((resolve) => (this.signalStarted = resolve));
  }

  /**
   * The load-time check. Call it again whenever the collection-name, QMD path or extra PATH
   * directories setting changes: any of them can change what the check finds.
   */
  start(): Promise<void> {
    const check = this.checkCollection();
    this.latestStart = check;
    this.signalStarted();
    return check;
  }

  /** A note changed: restart the quiet period, at the end of which a run follows. */
  markDirty(): void {
    if (this.disposed) return;
    clearTimeout(this.quietTimer);
    const quietMs = this.deps.getSettings().reindexQuietMinutes * MINUTE_MS;
    this.quietTimer = setTimeout(() => void this.runNow(), quietMs);
  }

  /** Runs now, or straight after the run in progress. Never rejects. */
  runNow(): Promise<void> {
    if (this.queuedRun !== undefined) return this.queuedRun;
    if (this.currentRun === undefined) return this.beginRun();
    this.queuedRun = this.currentRun.then(() => this.beginRun());
    return this.queuedRun;
  }

  /** Resolves once the most recent `start()` has finished its check; it does not wait for a run. */
  async whenReady(): Promise<boolean> {
    let awaited: Promise<void> | undefined;
    while (awaited !== this.latestStart) {
      awaited = this.latestStart;
      await awaited;
    }
    return this.ready;
  }

  getState(): IndexState {
    return this.state;
  }

  onChange(cb: (state: IndexState) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Cancels the pending run. From here on no command is started and the state no longer changes. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.quietTimer);
  }

  private async checkCollection(): Promise<void> {
    this.ready = false;
    const name = this.deps.getSettings().collectionName;
    let found: Found;
    try {
      found = await this.locate(name);
    } catch (error) {
      if (this.isConfigured(name)) this.fail(messageOf(error));
      return;
    }
    // A check overtaken by a rename is dropped: the start() for the new name decides.
    if (!this.isConfigured(name)) return;
    if (found === "here") {
      this.ready = true;
      // A failure reported earlier, for this name or a previous one, no longer holds.
      if (this.state.kind === "failed") this.setState(this.idleState);
      this.markDirty(); // catches up on changes made while Obsidian was closed
    } else if (found === "missing") {
      void this.runNow();
    } else {
      this.fail(pointsElsewhere(name));
    }
  }

  private beginRun(): Promise<void> {
    clearTimeout(this.quietTimer); // this run picks up every change made so far
    this.queuedRun = undefined;
    // The run begins a tick later, once it is recorded as in progress: a listener that
    // calls runNow() on the first state change then queues behind it.
    const run = Promise.resolve()
      .then(() => this.run())
      .finally(() => {
        this.currentRun = undefined;
      });
    this.currentRun = run;
    return run;
  }

  /**
   * A run belongs to the collection name it starts with. Once the setting holds another
   * name, the run stops after the command in flight: it starts nothing more, so nothing
   * is ever added under a name that is no longer configured. The ready flag and the
   * state then belong to the start() check for the new name; all the stopped run does
   * is take down its own `running` state if that is still showing.
   */
  private async run(): Promise<void> {
    const name = this.deps.getSettings().collectionName;
    const renamed = (): boolean => !this.isConfigured(name);
    let published: IndexState | undefined;
    const enter = (step: Step): void => {
      published = { kind: "running", step };
      this.setState(published);
    };
    try {
      enter("setup");
      const found = await this.locate(name);
      if (renamed()) return;
      if (found !== "here") this.ready = false;
      if (found === "elsewhere") throw new Error(pointsElsewhere(name));
      if (found === "missing") {
        await this.qmd(
          ["collection", "add", this.deps.vaultPath, "--name", name],
          ADD_TIMEOUT_MS,
        );
        if (renamed()) return;
      }
      enter("update");
      await this.qmd(["update"], UPDATE_TIMEOUT_MS);
      if (renamed()) return;
      enter("embed");
      await this.qmd(["embed", "-c", name], EMBED_TIMEOUT_MS);
      if (renamed()) return;
      this.ready = true;
      this.idleState = { kind: "idle", lastIndexedAt: this.deps.now() };
      this.setState(this.idleState);
    } catch (error) {
      if (!renamed()) this.fail(messageOf(error));
    } finally {
      // Only a run stopped by a rename ends with its own `running` state still showing.
      // It withdraws that state and no other, so whatever the start() check for the new
      // name published stays; the time of the last completed run is not advanced.
      if (this.state === published) this.setState(this.idleState);
    }
  }

  /** Reads where the collection points from `qmd collection show`. Changes nothing. */
  private async locate(name: string): Promise<Found> {
    const args = ["collection", "show", name];
    const result = await this.exec(args, SHOW_TIMEOUT_MS);
    const exitedNonZero = result.code !== null && result.code !== 0;
    if (
      exitedNonZero &&
      `${result.stdout}\n${result.stderr}`.includes("Collection not found")
    )
      return "missing";
    this.assertSucceeded(args, result);
    const path = /^\s*Path:\s*(.+)$/m.exec(result.stdout)?.[1];
    // Without a path there is no proof that the collection is this vault's.
    if (path === undefined) return "elsewhere";
    return this.resolved(path) === this.resolved(this.deps.vaultPath)
      ? "here"
      : "elsewhere";
  }

  /** Runs one command that has to succeed; throws the message to show when it does not. */
  private async qmd(args: string[], timeoutMs: number): Promise<void> {
    this.assertSucceeded(args, await this.exec(args, timeoutMs));
  }

  private async exec(args: string[], timeoutMs: number): Promise<CliResult> {
    if (this.disposed) throw new Error("disposed"); // ends the run or check; never shown
    return this.deps.cli.run(args, { timeoutMs });
  }

  private assertSucceeded(args: string[], result: CliResult): void {
    const command = `qmd ${args.join(" ")}`;
    const { errorCode } = result;
    if (errorCode === "ENOENT" || errorCode === "EACCES") {
      throw new Error(
        `Couldn't run qmd at "${this.deps.getSettings().qmdPath}".`,
      );
    }
    // Not started for any other reason, such as `ENOTDIR` for a path that treats a file as a
    // folder. The code is named: "killed before it finished" would point away from the path.
    if (errorCode !== undefined && result.code === null) {
      throw new Error(
        `Couldn't run qmd at "${this.deps.getSettings().qmdPath}" (${errorCode}).`,
      );
    }
    if (result.timedOut) throw new Error(`${command} timed out`);
    if (result.code !== 0) {
      const exit =
        result.code === null
          ? "killed before it finished"
          : `exit code ${result.code}`;
      throw new Error(
        `${command} failed: ${lastNonEmptyLine(result.stderr) ?? exit}`,
      );
    }
  }

  private resolved(path: string): string {
    try {
      return this.deps.realpath(path);
    } catch {
      return path; // a folder that cannot be resolved is compared as written
    }
  }

  private isConfigured(name: string): boolean {
    return name === this.deps.getSettings().collectionName;
  }

  private fail(message: string): void {
    this.setState({ kind: "failed", message });
  }

  private setState(state: IndexState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        console.error("QMD Search: an index state listener threw", error);
      }
    }
  }
}
