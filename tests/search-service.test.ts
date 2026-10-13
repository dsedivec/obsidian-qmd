import { describe, expect, it, vi } from "vitest";
import { SearchService } from "../src/search-service";
import { QmdSearchError } from "../src/errors";
import type { RawResult } from "../src/results";

const raw = (...names: string[]): RawResult[] =>
  names.map((n) => ({ file: `Main/${n}`, line: 1, score: 0.5, snippet: "s" }));

function fake(over: {
  raw?: RawResult[]; ready?: boolean; state?: any;
  fileExists?: (p: string) => boolean; isExcluded?: (p: string) => boolean;
} = {}) {
  return {
    indexer: {
      whenReady: vi.fn(async () => over.ready ?? true),
      getState: vi.fn(() => over.state ?? { kind: "idle" }),
    },
    server: {
      ensureRunning: vi.fn<(cb?: (s: "starting") => void) => Promise<void>>(async () => {}),
      noteActivity: vi.fn(),
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
