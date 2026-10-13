import type { SearchResult } from "./results";
import { scorePercent } from "./view-model";

export const CLI_COMMAND = "qmd-search";
export const CLI_DESCRIPTION = "Search this vault with QMD (hybrid search with reranking)";
export const CLI_FLAGS = {
  query: { value: "<text>", description: "Search text", required: true },
  limit: { value: "<n>", description: "Maximum results, 1 to 50" },
  json: { description: "Output JSON" },
};

const LIMIT_ERROR = "limit must be a whole number from 1 to 50";

export function formatCliText(results: SearchResult[]): string {
  if (results.length === 0) return "No results.";
  return results
    .map((r) => `${r.path}:${r.line}  (${scorePercent(r.score)})\n  ${r.snippet}`)
    .join("\n\n");
}

export function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(LIMIT_ERROR);
  const n = Number(raw);
  if (n < 1 || n > 50) throw new Error(LIMIT_ERROR);
  return n;
}

export function createCliHandler(deps: {
  search: (text: string, limit: number) => Promise<SearchResult[]>;
  getDefaultLimit: () => number;
  describe: (err: unknown) => string;
}): (params: Record<string, string>) => Promise<string> {
  return async (params) => {
    const query = params.query?.trim();
    if (!query) return "Error: query is required";
    let limit: number;
    try {
      limit = parseLimit(params.limit, deps.getDefaultLimit());
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
    try {
      const results = await deps.search(query, limit);
      return params.json === "true" ? JSON.stringify(results, null, 2) : formatCliText(results);
    } catch (err) {
      return `Error: ${deps.describe(err)}`;
    }
  };
}
