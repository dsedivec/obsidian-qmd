import type { Indexer } from "./indexer";
import type { ServerManager } from "./server-manager";
import type { QmdClient } from "./qmd-client";
import type { QmdSearchSettings } from "./config";
import { QmdSearchError } from "./errors";
import { toSearchResults, type SearchResult } from "./results";

export type SearchStatus = "starting" | "searching";

export interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
  onStatus?: (status: SearchStatus) => void;
}

export interface SearchServiceDeps {
  indexer: Pick<Indexer, "whenReady" | "getState">;
  server: Pick<ServerManager, "ensureRunning" | "noteActivity" | "hold">;
  client: Pick<QmdClient, "query">;
  getSettings: () => Pick<QmdSearchSettings, "collectionName" | "resultCount">;
  fileExists: (vaultPath: string) => boolean;
  isExcluded: (vaultPath: string) => boolean;
}

const aborted = () => new QmdSearchError("aborted", "Search cancelled.");

export class SearchService {
  constructor(private readonly deps: SearchServiceDeps) {}

  async search(text: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const { signal, onStatus } = opts;
    if (signal?.aborted) throw aborted();
    const query = text.replace(/\s+/g, " ").trim();
    if (query === "") return [];

    const { indexer, server, client } = this.deps;
    if (!(await indexer.whenReady())) {
      const state = indexer.getState();
      if (state.kind === "failed") throw new QmdSearchError("index", state.message);
      throw new QmdSearchError("not-ready", "The vault is still being indexed for the first time.");
    }

    const settings = this.deps.getSettings();
    const wanted = opts.limit ?? settings.resultCount;

    const attempt = async () => {
      await server.ensureRunning(onStatus);
      if (signal?.aborted) throw aborted();
      // The server is in use until the query has its answer: its idle timer must not stop it meanwhile.
      const release = server.hold();
      try {
        onStatus?.("searching");
        // Awaited here, so that the hold lasts for the whole of the query.
        return await client.query(query, { collection: settings.collectionName, limit: wanted * 2, signal });
      } finally {
        release();
      }
    };

    let raw;
    try {
      raw = await attempt();
    } catch (err) {
      if (!(err instanceof QmdSearchError) || err.kind !== "connection") throw err;
      raw = await attempt();
    }

    const results = toSearchResults(raw, settings.collectionName)
      .filter((r) => this.deps.fileExists(r.path) && !this.deps.isExcluded(r.path))
      .slice(0, wanted);
    server.noteActivity();
    return results;
  }
}
