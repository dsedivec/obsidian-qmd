import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "../src/config";
import { Indexer, MODELS_PULLED_KEY, type IndexerDeps } from "../src/indexer";
import type { CliResult } from "../src/qmd-cli";

const fixture = (name: string): string => readFileSync(join(__dirname, "fixtures", name), "utf8");

const OK: CliResult = { code: 0, stdout: "", stderr: "", timedOut: false };
const QUIET = 300_000;
const POINTS_ELSEWHERE = 'collection "Main" points at another folder';

/** Real `qmd collection show` output, with its `Path:` line pointing at `p`. */
const showWithPath = (p: string): CliResult => ({
  ...OK,
  stdout: fixture("collection-show.txt").replace(/^(\s*Path:\s*).*$/m, (_line, label: string) => label + p),
});
const SHOW_OK = showWithPath("/vault");
// The real qmd writes this to stderr and exits with code 1.
const SHOW_MISSING: CliResult = { ...OK, code: 1, stderr: fixture("collection-show-missing.txt") };

type Script = Record<string, CliResult | Promise<CliResult>>;

function fake(script: Script = {}, over: Partial<IndexerDeps> = {}) {
  const calls: string[][] = [];
  const values = new Map<string, unknown>();
  const store: KeyValueStore = { get: (key) => values.get(key), set: (key, value) => void values.set(key, value) };
  const deps: IndexerDeps = {
    cli: {
      run: async (args) => {
        calls.push(args);
        return script[args.join(" ")] ?? OK;
      },
    },
    getSettings: () => ({ collectionName: "Main", reindexQuietMinutes: 5, qmdPath: "qmd" }),
    vaultPath: "/vault",
    realpath: (path) => path,
    store,
    now: () => Date.now(),
    ...over,
  };
  return { deps, calls, store, script };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const count = (calls: string[][], command: string): number => calls.filter((c) => c[0] === command).length;

describe("Indexer", () => {
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("an existing collection for this vault is ready at once; a catch-up run follows the quiet period", async () => {
  const { deps, calls } = fake({ "collection show Main": SHOW_OK });
  const ix = new Indexer(deps);
  await ix.start();
  expect(await ix.whenReady()).toBe(true);
  expect(calls).toEqual([["collection", "show", "Main"]]);
  await vi.advanceTimersByTimeAsync(QUIET);
  expect(calls.slice(1)).toEqual([["collection", "show", "Main"], ["pull"], ["update"], ["embed", "-c", "Main"]]);
  expect(ix.getState()).toEqual({ kind: "idle", lastIndexedAt: deps.now() });
});
it("a missing collection is created and indexed immediately; ready only when that run completes", async () => {
  const gate = deferred<CliResult>();
  const { deps, calls } = fake({ "collection show Main": SHOW_MISSING, "embed -c Main": gate.promise });
  const ix = new Indexer(deps);
  await ix.start();
  expect(await ix.whenReady()).toBe(false);
  gate.resolve(OK); await vi.runAllTimersAsync();
  expect(calls).toEqual([["collection", "show", "Main"], ["collection", "show", "Main"],
    ["collection", "add", "/vault", "--name", "Main"], ["pull"], ["update"], ["embed", "-c", "Main"]]);
  expect(await ix.whenReady()).toBe(true);
});
it("a collection pointing elsewhere fails, is not ready, and is left alone", async () => {
  const { deps, calls } = fake({ "collection show Main": showWithPath("/other") });
  const ix = new Indexer(deps);
  await ix.start();
  expect(ix.getState()).toEqual({ kind: "failed", message: 'collection "Main" points at another folder' });
  expect(await ix.whenReady()).toBe(false);
  expect(calls).toHaveLength(1);
});
it("compares paths after realpath", async () => {
  const { deps } = fake({ "collection show Main": showWithPath("/vault-link") }, { realpath: (p) => (p === "/vault-link" ? "/vault" : p) });
  const ix = new Indexer(deps); await ix.start();
  expect(await ix.whenReady()).toBe(true);
});
it("pulls models once per device", async () => {
  const { deps, calls, store } = fake({ "collection show Main": SHOW_OK });
  const ix = new Indexer(deps); await ix.start();
  await ix.runNow(); await ix.runNow();
  expect(calls.filter((c) => c[0] === "pull")).toHaveLength(1);
  expect(store.get(MODELS_PULLED_KEY)).toBe(true);
});
it("a failed pull fails the run and leaves the flag unset", async () => {
  const { deps, calls, store } = fake({ "collection show Main": SHOW_OK, pull: { ...OK, code: 1, stderr: "network down\n" } });
  const ix = new Indexer(deps); await ix.start(); await ix.runNow();
  expect(ix.getState()).toEqual({ kind: "failed", message: "qmd pull failed: network down" });
  expect(store.get(MODELS_PULLED_KEY)).toBeUndefined();
  expect(calls.some((c) => c[0] === "update")).toBe(false);
});
it("collapses a burst of changes into one run", async () => {
  const { deps, calls } = fake({ "collection show Main": SHOW_OK });
  const ix = new Indexer(deps); await ix.start(); await vi.advanceTimersByTimeAsync(QUIET); calls.length = 0;
  for (let i = 0; i < 500; i++) { ix.markDirty(); await vi.advanceTimersByTimeAsync(200); }
  expect(calls).toEqual([]);
  await vi.advanceTimersByTimeAsync(QUIET);
  expect(calls.filter((c) => c[0] === "update")).toHaveLength(1);
});
it("a change during a run schedules another run after it", async () => {
  const gate = deferred<CliResult>();
  const { deps, calls } = fake({ "collection show Main": SHOW_OK, update: gate.promise });
  const ix = new Indexer(deps); await ix.start();
  const first = ix.runNow(); await vi.advanceTimersByTimeAsync(0);
  ix.markDirty(); gate.resolve(OK); await first;
  await vi.advanceTimersByTimeAsync(QUIET);
  expect(calls.filter((c) => c[0] === "embed")).toHaveLength(2);
});
it("runNow during a run waits and then runs again", async () => {
  const { deps, calls } = fake({ "collection show Main": SHOW_OK });
  const ix = new Indexer(deps); await ix.start();
  await Promise.all([ix.runNow(), ix.runNow()]);
  expect(calls.filter((c) => c[0] === "update")).toHaveLength(2);
});
it("a failed update keeps search ready and is retried at the next trigger", async () => {
  const { deps, script } = fake({ "collection show Main": SHOW_OK, update: { ...OK, code: 1, stderr: "warn\ndisk I/O error\n\n" } });
  const ix = new Indexer(deps); await ix.start(); await ix.runNow();
  expect(ix.getState()).toEqual({ kind: "failed", message: "qmd update failed: disk I/O error" });
  expect(await ix.whenReady()).toBe(true);
  script.update = OK; ix.markDirty(); await vi.advanceTimersByTimeAsync(QUIET);
  expect(ix.getState().kind).toBe("idle");
});
it.each<[CliResult, string]>([
  [{ ...OK, code: null, errorCode: "ENOENT" }, `Couldn't run qmd at "qmd".`],
  [{ ...OK, code: null, errorCode: "EACCES" }, `Couldn't run qmd at "qmd".`],
  [{ ...OK, code: null, timedOut: true }, "qmd collection show Main timed out"],
  [{ ...OK, code: 2, stderr: "" }, "qmd collection show Main failed: exit code 2"],
])("reports %j as %j", async (result, message) => {
  const { deps } = fake({ "collection show Main": result });
  const ix = new Indexer(deps); await ix.start();
  expect(ix.getState()).toEqual({ kind: "failed", message });
  expect(await ix.whenReady()).toBe(false);
});
it("reports each step to listeners", async () => {
  const { deps } = fake({ "collection show Main": SHOW_MISSING });
  const ix = new Indexer(deps); const seen: string[] = [];
  ix.onChange((s) => seen.push(s.kind === "running" ? s.step : s.kind));
  await ix.start(); await vi.runAllTimersAsync();
  expect(seen).toEqual(["setup", "models", "update", "embed", "idle"]);
});
it("start again after a collection rename checks the new name", async () => {
  const settings = { collectionName: "Main", reindexQuietMinutes: 5, qmdPath: "qmd" };
  // The gate holds the setup run open, so it is still in progress when readiness is read.
  const gate = deferred<CliResult>();
  const { deps, calls } = fake(
    { "collection show Main": SHOW_OK, "collection show Other": SHOW_MISSING, "embed -c Other": gate.promise },
    { getSettings: () => settings });
  const ix = new Indexer(deps); await ix.start();
  settings.collectionName = "Other"; await ix.start();
  expect(await ix.whenReady()).toBe(false);
  gate.resolve(OK); await vi.runAllTimersAsync();
  expect(calls).toContainEqual(["collection", "add", "/vault", "--name", "Other"]);
  expect(await ix.whenReady()).toBe(true);
});
it("dispose cancels the pending run", async () => {
  const { deps, calls } = fake({ "collection show Main": SHOW_OK });
  const ix = new Indexer(deps); await ix.start(); ix.dispose();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(QUIET);
  expect(calls).toHaveLength(1);
});

describe("commands", () => {
  it("gives each command its own timeout", async () => {
    const { deps } = fake({ "collection show Main": SHOW_MISSING });
    const timeouts: Record<string, number> = {};
    const { run } = deps.cli;
    deps.cli = { run: (args, opts) => { timeouts[args.join(" ")] = opts.timeoutMs; return run(args, opts); } };
    const ix = new Indexer(deps); await ix.start(); await vi.runAllTimersAsync();
    expect(timeouts).toEqual({
      "collection show Main": 60_000,
      "collection add /vault --name Main": 600_000,
      pull: 3_600_000,
      update: 600_000,
      "embed -c Main": 1_800_000,
    });
  });
  it("waits for the configured quiet period", async () => {
    const { deps, calls } = fake({ "collection show Main": SHOW_OK },
      { getSettings: () => ({ collectionName: "Main", reindexQuietMinutes: 1, qmdPath: "qmd" }) });
    const ix = new Indexer(deps); await ix.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count(calls, "update")).toBe(1);
  });
  it("names the configured qmd path when it cannot be run", async () => {
    const { deps } = fake({ "collection show Main": { ...OK, code: null, errorCode: "ENOENT" } },
      { getSettings: () => ({ collectionName: "Main", reindexQuietMinutes: 5, qmdPath: "/opt/q md/qmd" }) });
    const ix = new Indexer(deps); await ix.start();
    expect(ix.getState()).toEqual({ kind: "failed", message: `Couldn't run qmd at "/opt/q md/qmd".` });
  });
  it("start and runNow settle even when the runner rejects", async () => {
    const { deps } = fake({}, { cli: { run: () => Promise.reject(new Error("spawn exploded")) } });
    const ix = new Indexer(deps);
    await ix.start();
    expect(ix.getState()).toEqual({ kind: "failed", message: "spawn exploded" });
    expect(await ix.whenReady()).toBe(false);
    await expect(ix.runNow()).resolves.toBeUndefined();
    expect(ix.getState()).toEqual({ kind: "failed", message: "spawn exploded" });
  });
});

describe("collection safety", () => {
  it("finds 'Collection not found' on stdout as well as stderr", async () => {
    const { deps, calls } = fake({ "collection show Main": { ...OK, code: 1, stdout: SHOW_MISSING.stderr } });
    const ix = new Indexer(deps); await ix.start(); await vi.runAllTimersAsync();
    expect(calls).toContainEqual(["collection", "add", "/vault", "--name", "Main"]);
  });
  it("never adds a collection when collection show fails for another reason", async () => {
    const { deps, calls } = fake({ "collection show Main": { ...OK, code: 1, stderr: "database is locked\n" } });
    const ix = new Indexer(deps); await ix.start(); await ix.runNow();
    expect(ix.getState()).toEqual({ kind: "failed", message: "qmd collection show Main failed: database is locked" });
    expect(calls).toEqual([["collection", "show", "Main"], ["collection", "show", "Main"]]);
  });
  it.each<[string, CliResult]>([
    ["was killed by the timeout", { ...OK, code: null, timedOut: true, stderr: SHOW_MISSING.stderr }],
    ["exited with code 0", { ...SHOW_OK, stderr: SHOW_MISSING.stderr }],
  ])("does not read 'Collection not found' as missing when collection show %s", async (_how, result) => {
    const { deps, calls } = fake({ "collection show Main": result });
    const ix = new Indexer(deps); await ix.start(); await ix.runNow();
    expect(calls.filter((c) => c[1] === "add")).toEqual([]);
  });
  it("never adds a collection under a name that was changed while collection show ran", async () => {
    const settings = { collectionName: "Main", reindexQuietMinutes: 5, qmdPath: "qmd" };
    const gate = deferred<CliResult>();
    const { deps, calls } = fake(
      { "collection show Main": gate.promise, "collection show Other": SHOW_OK },
      { getSettings: () => settings });
    const ix = new Indexer(deps);
    const run = ix.runNow();
    settings.collectionName = "Other"; gate.resolve(SHOW_MISSING); await run;
    expect(calls.filter((c) => c[1] === "add")).toEqual([]);
    expect(calls.at(-1)).toEqual(["embed", "-c", "Other"]);
  });
  it("a run that finds the collection pointing elsewhere stops there, and search is no longer ready", async () => {
    const { deps, calls, script } = fake({ "collection show Main": SHOW_OK });
    const ix = new Indexer(deps); await ix.start();
    script["collection show Main"] = showWithPath("/other"); calls.length = 0;
    await ix.runNow();
    expect(ix.getState()).toEqual({ kind: "failed", message: POINTS_ELSEWHERE });
    expect(calls).toEqual([["collection", "show", "Main"]]);
    expect(await ix.whenReady()).toBe(false);
  });
  it("a collection that disappears is created again, and search waits for that run", async () => {
    const gate = deferred<CliResult>();
    const { deps, calls, script } = fake({ "collection show Main": SHOW_OK, "embed -c Main": gate.promise });
    const ix = new Indexer(deps); await ix.start();
    script["collection show Main"] = SHOW_MISSING;
    const run = ix.runNow(); await vi.advanceTimersByTimeAsync(0);
    expect(await ix.whenReady()).toBe(false);
    gate.resolve(OK); await run;
    expect(calls).toContainEqual(["collection", "add", "/vault", "--name", "Main"]);
    expect(await ix.whenReady()).toBe(true);
  });
  it("a collection whose output has no Path line counts as another folder", async () => {
    const { deps, calls } = fake({ "collection show Main": { ...OK, stdout: "Collection: Main\n" } });
    const ix = new Indexer(deps); await ix.start();
    expect(ix.getState()).toEqual({ kind: "failed", message: POINTS_ELSEWHERE });
    expect(calls).toHaveLength(1);
  });
  it("a collection folder that cannot be resolved counts as another folder", async () => {
    const realpath = (p: string): string => {
      if (p === "/gone") throw new Error("ENOENT: no such file or directory");
      return p;
    };
    const { deps, calls } = fake({ "collection show Main": showWithPath("/gone") }, { realpath });
    const ix = new Indexer(deps); await ix.start();
    expect(ix.getState()).toEqual({ kind: "failed", message: POINTS_ELSEWHERE });
    expect(calls).toHaveLength(1);
  });
  it("a failed collection add fails the run and search stays not ready", async () => {
    const { deps, calls } = fake({
      "collection show Main": SHOW_MISSING,
      "collection add /vault --name Main": { ...OK, code: 1, stderr: "Error: cannot read folder\n" },
    });
    const ix = new Indexer(deps); await ix.start(); await vi.runAllTimersAsync();
    expect(ix.getState()).toEqual({ kind: "failed", message: "qmd collection add /vault --name Main failed: Error: cannot read folder" });
    expect(await ix.whenReady()).toBe(false);
    expect(count(calls, "pull")).toBe(0);
  });
});

describe("readiness", () => {
  it("whenReady called before start waits for it", async () => {
    const { deps } = fake({ "collection show Main": SHOW_OK });
    const ix = new Indexer(deps);
    let ready: boolean | undefined;
    void ix.whenReady().then((r) => (ready = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBeUndefined();
    await ix.start(); await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(true);
  });
  it("a check overtaken by a collection rename cannot make search ready", async () => {
    const settings = { collectionName: "Main", reindexQuietMinutes: 5, qmdPath: "qmd" };
    const gate = deferred<CliResult>();
    const { deps, calls } = fake(
      { "collection show Main": gate.promise, "collection show Other": showWithPath("/other") },
      { getSettings: () => settings });
    const ix = new Indexer(deps);
    const first = ix.start();
    settings.collectionName = "Other"; await ix.start();
    gate.resolve(SHOW_OK); await first;
    expect(await ix.whenReady()).toBe(false);
    expect(ix.getState()).toEqual({ kind: "failed", message: 'collection "Other" points at another folder' });
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(calls).toHaveLength(2);
  });
  it("a run for the old name that finishes after a rename does not make search ready", async () => {
    const settings = { collectionName: "Main", reindexQuietMinutes: 5, qmdPath: "qmd" };
    const gate = deferred<CliResult>();
    const { deps } = fake(
      { "collection show Main": SHOW_OK, "embed -c Main": gate.promise, "collection show Other": showWithPath("/other") },
      { getSettings: () => settings });
    const ix = new Indexer(deps); await ix.start();
    const run = ix.runNow(); await vi.advanceTimersByTimeAsync(0);
    settings.collectionName = "Other"; await ix.start();
    gate.resolve(OK); await run;
    expect(await ix.whenReady()).toBe(false);
  });
});

describe("scheduling", () => {
  it("runNow calls made during one run share a single follow-up run", async () => {
    const { deps, calls } = fake({ "collection show Main": SHOW_OK });
    const ix = new Indexer(deps); await ix.start();
    await Promise.all([ix.runNow(), ix.runNow(), ix.runNow()]);
    expect(count(calls, "update")).toBe(2);
  });
  it("a listener that calls runNow as a run begins gets a second run, never a concurrent one", async () => {
    const { deps, calls } = fake({ "collection show Main": SHOW_OK });
    const { run } = deps.cli;
    let inFlight = 0;
    let mostInFlight = 0;
    deps.cli = {
      run: async (args, opts) => {
        mostInFlight = Math.max(mostInFlight, ++inFlight);
        try { return await run(args, opts); } finally { inFlight--; }
      },
    };
    const ix = new Indexer(deps); await ix.start();
    let second: Promise<void> | undefined;
    let asked = false;
    ix.onChange((s) => {
      if (asked || s.kind !== "running" || s.step !== "setup") return;
      asked = true;
      second = ix.runNow();
    });
    await ix.runNow(); await second;
    expect(count(calls, "update")).toBe(2);
    expect(mostInFlight).toBe(1);
  });
  it("runNow cancels the pending quiet-period run", async () => {
    const { deps, calls } = fake({ "collection show Main": SHOW_OK });
    const ix = new Indexer(deps); await ix.start();
    await ix.runNow(); await vi.advanceTimersByTimeAsync(QUIET);
    expect(count(calls, "update")).toBe(1);
  });
  it("a queued run covers a change made before it began", async () => {
    const gate = deferred<CliResult>();
    const { deps, calls } = fake({ "collection show Main": SHOW_OK, update: gate.promise });
    const ix = new Indexer(deps); await ix.start();
    const first = ix.runNow(); await vi.advanceTimersByTimeAsync(0);
    ix.markDirty(); const second = ix.runNow();
    gate.resolve(OK); await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(count(calls, "update")).toBe(2);
  });
  it("a quiet period that ends during a run is followed by one run straight after it", async () => {
    const gate = deferred<CliResult>();
    const { deps, calls } = fake({ "collection show Main": SHOW_OK, update: gate.promise });
    const ix = new Indexer(deps); await ix.start();
    const first = ix.runNow(); await vi.advanceTimersByTimeAsync(0);
    ix.markDirty(); await vi.advanceTimersByTimeAsync(QUIET);
    expect(count(calls, "update")).toBe(1);
    gate.resolve(OK); await first; await vi.advanceTimersByTimeAsync(0);
    expect(count(calls, "embed")).toBe(2);
  });
  it("onChange returns a function that stops the notifications", async () => {
    const { deps } = fake({ "collection show Main": SHOW_OK });
    const ix = new Indexer(deps); const seen: string[] = [];
    const off = ix.onChange((s) => seen.push(s.kind));
    await ix.start(); await ix.runNow();
    const before = seen.length;
    off(); await ix.runNow();
    expect(before).toBeGreaterThan(0);
    expect(seen).toHaveLength(before);
  });
  it("a listener that throws does not stop the run or the other listeners", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = fake({ "collection show Main": SHOW_OK });
    const ix = new Indexer(deps); const seen: string[] = [];
    ix.onChange(() => { throw new Error("bad listener"); });
    ix.onChange((s) => seen.push(s.kind));
    await ix.start(); await ix.runNow();
    expect(ix.getState().kind).toBe("idle");
    expect(seen.at(-1)).toBe("idle");
    expect(logged).toHaveBeenCalled();
  });
  it("dispose during a run starts no further commands and tells listeners nothing more", async () => {
    const gate = deferred<CliResult>();
    const { deps, calls } = fake({ "collection show Main": SHOW_OK, update: gate.promise });
    const ix = new Indexer(deps); const seen: string[] = [];
    ix.onChange((s) => seen.push(s.kind === "running" ? s.step : s.kind));
    await ix.start();
    const run = ix.runNow(); await vi.advanceTimersByTimeAsync(0);
    ix.dispose(); gate.resolve(OK); await run;
    expect(calls.at(-1)).toEqual(["update"]);
    ix.markDirty();
    expect(vi.getTimerCount()).toBe(0);
    await ix.runNow(); await ix.start();
    expect(calls.at(-1)).toEqual(["update"]);
    expect(seen).toEqual(["setup", "models", "update"]);
  });
});
});
