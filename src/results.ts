export interface RawResult {
  file: string;
  line: number;
  score: number;
  snippet: string;
  title?: string;
  docid?: string;
}
export interface SearchResult {
  path: string;
  title: string;
  folder: string;
  line: number;
  score: number;
  snippet: string;
}

/** Strips QMD's "N: " line prefixes and "@@" hunk header, then collapses whitespace. */
export function cleanSnippet(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\d+: ?/, ""))
    .filter((line) => !line.startsWith("@@ "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSearchResults(
  raw: unknown[],
  collection: string,
): SearchResult[] {
  const prefix = `${collection}/`;
  const out: SearchResult[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.file !== "string" ||
      !e.file.startsWith(prefix) ||
      e.file.length === prefix.length
    )
      continue;
    const path = e.file.slice(prefix.length);
    const slash = path.lastIndexOf("/");
    out.push({
      path,
      title: path.slice(slash + 1).replace(/\.md$/i, ""),
      folder: slash < 0 ? "" : path.slice(0, slash),
      line:
        typeof e.line === "number" && Number.isInteger(e.line) && e.line > 0
          ? e.line
          : 1,
      score:
        typeof e.score === "number" && Number.isFinite(e.score) ? e.score : 0,
      snippet: typeof e.snippet === "string" ? cleanSnippet(e.snippet) : "",
    });
  }
  return out;
}

/** Splits text into plain and bold runs; bold marks whole-word matches of query words (3+ chars). */
export function highlightSegments(
  text: string,
  query: string,
): Array<{ text: string; bold: boolean }> {
  if (text === "") return [];
  const tokens = [...new Set(query.split(/\s+/).filter((t) => t.length >= 3))];
  if (tokens.length === 0) return [{ text, bold: false }];
  const alt = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  const segments: Array<{ text: string; bold: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last)
      segments.push({ text: text.slice(last, m.index), bold: false });
    segments.push({ text: m[0], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length)
    segments.push({ text: text.slice(last), bold: false });
  return segments;
}
