import { describe, expect, it, vi } from "vitest";
import { SearchService } from "../src/search-service";
import { QmdSearchError } from "../src/errors";
import type { RawResult } from "../src/results";

const raw = (...names: string[]): RawResult[] =>
  names.map((n) => ({ file: `Main/${n}`, line: 1, score: 0.5, snippet: "s" }));

/** Lets everything that is ready to run do so. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fake(over: {
  raw?: RawResult[]; ready?: boolean; state?: any;
  fileExists?: (p: string) => boolean; isExcluded?: (p: string) => boolean;
} = {}) {
  /** The release function of each hold taken, in the order they were taken. */
  const releases: Array<ReturnType<typeof vi.fn<() => void>>> = [];
  return {
    releases,
    indexer: {
      whenReady: vi.fn(async () => over.ready ?? true),
      getState: vi.fn(() => over.state ?? { kind: "idle" }),
    },
    server: {
      ensureRunning: vi.fn<(cb?: (s: "starting") => void) => Promise<void>>(async () => {}),
      noteActivity: vi.fn(),
      hold: vi.fn<() => () => void>(() => {
        const release = vi.fn<() => void>();
        releases.push(release);
        return release;
      }),
    },
    client: { query: vi.fn(async (..._a: any[]) => over.raw ?? []) },
    getSettings: () => ({ collectionName: "Main", resultCount: 3 }),
    fileExists: vi.fn(over.fileExists ?? (() => true)),
    isExcluded: vi.fn(over.isExcluded ?? (() => false)),
  };
}

describe("SearchService", () => {
  it("asks for twice the wanted count and keeps the first N that survive", async () => {
    const d = fake({ raw: raw("a.md", "stale.md", "b.md", "Archive/x.md", "c.md", "d.md"),
      fileExists: (p) => p !== "stale.md", isExcluded: (p) => p.startsWith("Archive/") });
    const results = await new SearchService(d).search("pod roles");
    expect(results.map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(d.client.query).toHaveBeenCalledWith("pod roles", expect.objectContaining({ collection: "Main", limit: 6 }));
  });
  it("filters on the vault-relative path, not the collection-prefixed one", async () => {
    const d = fake({ raw: raw("Projects/x.md") });
    await new SearchService(d).search("x");
    expect(d.fileExists).toHaveBeenCalledWith("Projects/x.md");
    expect(d.isExcluded).toHaveBeenCalledWith("Projects/x.md");
  });
  it("lets opts.limit override the setting", async () => {
    const d = fake({ raw: raw("a.md", "b.md") });
    expect(await new SearchService(d).search("x", { limit: 1 })).toHaveLength(1);
    expect(d.client.query).toHaveBeenCalledWith("x", expect.objectContaining({ limit: 2 }));
  });
  it("collapses whitespace in the query", async () => {
    const d = fake();
    await new SearchService(d).search("  pod \n roles\t");
    expect(d.client.query).toHaveBeenCalledWith("pod roles", expect.anything());
  });
  it.each(["", "   ", "\n\t"])("returns nothing for %j without starting a server", async (text) => {
    const d = fake();
    expect(await new SearchService(d).search(text)).toEqual([]);
    expect(d.server.ensureRunning).not.toHaveBeenCalled();
    expect(d.client.query).not.toHaveBeenCalled();
  });
  it("refuses while the first index run is still going", async () => {
    const d = fake({ ready: false, state: { kind: "running", step: "embed" } });
    await expect(new SearchService(d).search("x")).rejects.toMatchObject({ kind: "not-ready", message: "The vault is still being indexed for the first time." });
    expect(d.server.ensureRunning).not.toHaveBeenCalled();
  });
  it("refuses with the index error when the index has failed and is not ready", async () => {
    const d = fake({ ready: false, state: { kind: "failed", message: 'collection "Main" points at another folder' } });
    await expect(new SearchService(d).search("x")).rejects.toMatchObject({ kind: "index", message: 'collection "Main" points at another folder' });
  });
  it("retries once after a connection error", async () => {
    const d = fake();
    d.client.query.mockRejectedValueOnce(new QmdSearchError("connection", "x")).mockResolvedValueOnce(raw("a.md"));
    expect(await new SearchService(d).search("x")).toHaveLength(1);
    expect(d.server.ensureRunning).toHaveBeenCalledTimes(2);
  });
  it("does not retry twice, and does not retry other errors", async () => {
    const d = fake(); d.client.query.mockRejectedValue(new QmdSearchError("connection", "x"));
    await expect(new SearchService(d).search("x")).rejects.toMatchObject({ kind: "connection" });
    expect(d.client.query).toHaveBeenCalledTimes(2);
    for (const kind of ["timeout", "tool", "server-response", "aborted"] as const) {
      const t = fake(); t.client.query.mockRejectedValue(new QmdSearchError(kind, "x"));
      await expect(new SearchService(t).search("x")).rejects.toMatchObject({ kind });
      expect(t.client.query).toHaveBeenCalledTimes(1);
      expect(t.server.noteActivity).not.toHaveBeenCalled();
    }
  });
  it("reports status", async () => {
    const d = fake(); d.server.ensureRunning.mockImplementation(async (cb) => cb?.("starting"));
    const seen: string[] = [];
    await new SearchService(d).search("x", { onStatus: (s) => seen.push(s) });
    expect(seen).toEqual(["starting", "searching"]);
  });
  it("notes activity after success only", async () => {
    const ok = fake(); await new SearchService(ok).search("x");
    expect(ok.server.noteActivity).toHaveBeenCalledTimes(1);
    const bad = fake(); bad.client.query.mockRejectedValue(new QmdSearchError("timeout", "x"));
    await new SearchService(bad).search("x").catch(() => {});
    expect(bad.server.noteActivity).not.toHaveBeenCalled();
  });
  it("passes the signal through to the client", async () => {
    const d = fake(); const c = new AbortController();
    await new SearchService(d).search("x", { signal: c.signal });
    expect(d.client.query).toHaveBeenCalledWith("x", expect.objectContaining({ signal: c.signal }));
  });
  it("rejects as aborted without doing anything when the signal is already aborted", async () => {
    const d = fake(); const c = new AbortController(); c.abort();
    await expect(new SearchService(d).search("x", { signal: c.signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(d.indexer.whenReady).not.toHaveBeenCalled();
    expect(d.server.ensureRunning).not.toHaveBeenCalled();
  });
  it("does not query when aborted during server start", async () => {
    const d = fake(); const c = new AbortController();
    d.server.ensureRunning.mockImplementation(async () => { c.abort(); });
    await expect(new SearchService(d).search("x", { signal: c.signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(d.client.query).not.toHaveBeenCalled();
    expect(d.server.noteActivity).not.toHaveBeenCalled();
  });
});

describe("SearchService holding the server", () => {
  it("takes a hold once the server is running and before it queries", async () => {
    const d = fake(); const order: string[] = [];
    let running!: () => void;
    d.server.ensureRunning.mockImplementation(() => new Promise<void>((resolve) => { running = resolve; }));
    d.server.hold.mockImplementation(() => { order.push("hold"); return () => {}; });
    d.client.query.mockImplementation(async () => { order.push("query"); return []; });
    const searching = new SearchService(d).search("x");
    await settle();
    expect(d.server.ensureRunning).toHaveBeenCalledTimes(1);
    expect(d.server.hold).not.toHaveBeenCalled(); // the server is not known to be running yet
    running();
    await searching;
    expect(order).toEqual(["hold", "query"]);
  });
  it("keeps the hold while the query is in flight, and releases it once on success", async () => {
    const d = fake();
    let answer!: (results: RawResult[]) => void;
    d.client.query.mockImplementation(() => new Promise<RawResult[]>((resolve) => { answer = resolve; }));
    const searching = new SearchService(d).search("x");
    await settle();
    expect(d.client.query).toHaveBeenCalledTimes(1);
    expect(d.server.hold).toHaveBeenCalledTimes(1); expect(d.releases[0]).not.toHaveBeenCalled();
    answer(raw("a.md"));
    expect(await searching).toHaveLength(1);
    expect(d.server.hold).toHaveBeenCalledTimes(1); expect(d.releases[0]).toHaveBeenCalledTimes(1);
  });
  it.each(["timeout", "tool", "server-response", "connection"] as const)("releases the hold once when the query is rejected with a %s error", async (kind) => {
    const d = fake(); d.client.query.mockRejectedValue(new QmdSearchError(kind, "x"));
    await expect(new SearchService(d).search("x")).rejects.toMatchObject({ kind });
    // A connection error is retried once, and each attempt has a hold of its own.
    expect(d.server.hold).toHaveBeenCalledTimes(kind === "connection" ? 2 : 1);
    expect(d.releases).toHaveLength(kind === "connection" ? 2 : 1);
    for (const release of d.releases) expect(release).toHaveBeenCalledTimes(1);
  });
  it("releases the hold once when the search is aborted with the query in flight", async () => {
    const d = fake(); const c = new AbortController();
    d.client.query.mockImplementation((_text: string, opts: { signal?: AbortSignal }) => new Promise<RawResult[]>((_resolve, reject) => {
      opts.signal?.addEventListener("abort", () => reject(new QmdSearchError("aborted", "Search cancelled.")));
    }));
    const searching = new SearchService(d).search("x", { signal: c.signal });
    await settle();
    expect(d.server.hold).toHaveBeenCalledTimes(1); expect(d.releases[0]).not.toHaveBeenCalled();
    c.abort();
    await expect(searching).rejects.toMatchObject({ kind: "aborted" });
    expect(d.server.hold).toHaveBeenCalledTimes(1); expect(d.releases[0]).toHaveBeenCalledTimes(1);
  });
  it("takes and releases a hold of its own for the retry, after its own ensureRunning", async () => {
    const d = fake(); const order: string[] = [];
    d.server.ensureRunning.mockImplementation(async () => { order.push("ensureRunning"); });
    d.server.hold.mockImplementation(() => { order.push("hold"); return () => { order.push("release"); }; });
    d.client.query.mockImplementation(async () => {
      order.push("query");
      if (order.filter((step) => step === "query").length === 1) throw new QmdSearchError("connection", "x");
      return raw("a.md");
    });
    expect(await new SearchService(d).search("x")).toHaveLength(1);
    expect(order).toEqual(["ensureRunning", "hold", "query", "release", "ensureRunning", "hold", "query", "release"]);
  });
  it("releases the hold when the status listener throws before the query is sent", async () => {
    const d = fake();
    const onStatus = (status: string): void => { if (status === "searching") throw new Error("listener failed"); };
    await expect(new SearchService(d).search("x", { onStatus })).rejects.toThrow("listener failed");
    expect(d.client.query).not.toHaveBeenCalled();
    expect(d.server.hold).toHaveBeenCalledTimes(1); expect(d.releases[0]).toHaveBeenCalledTimes(1);
  });
  it("takes no hold when the search was aborted while the server started", async () => {
    const d = fake(); const c = new AbortController();
    d.server.ensureRunning.mockImplementation(async () => { c.abort(); });
    await expect(new SearchService(d).search("x", { signal: c.signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(d.server.hold).not.toHaveBeenCalled();
  });
  it("takes no hold when the server cannot be started", async () => {
    const d = fake(); d.server.ensureRunning.mockRejectedValue(new QmdSearchError("server-start", "x"));
    await expect(new SearchService(d).search("x")).rejects.toMatchObject({ kind: "server-start" });
    expect(d.server.hold).not.toHaveBeenCalled();
  });
  it("has released the hold by the time it notes the activity", async () => {
    const d = fake(); const order: string[] = [];
    d.server.hold.mockImplementation(() => () => { order.push("release"); });
    d.server.noteActivity.mockImplementation(() => { order.push("noteActivity"); });
    await new SearchService(d).search("x");
    expect(order).toEqual(["release", "noteActivity"]);
  });
});
