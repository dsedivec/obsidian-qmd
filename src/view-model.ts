import type { IndexState } from "./indexer";
import type { SearchStatus } from "./search-service";

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const STEP_TEXT = {
  setup: "setting up",
  update: "scanning",
  embed: "embedding",
} as const;

export function footerText(
  count: number | null,
  state: IndexState,
  now: number,
): { text: string; error: boolean } {
  const parts: string[] = [];
  if (count !== null)
    parts.push(`${count} ${count === 1 ? "result" : "results"}`);
  let error = false;
  if (state.kind === "idle") {
    if (state.lastIndexedAt !== undefined)
      parts.push(`indexed ${formatAge(now - state.lastIndexedAt)}`);
  } else if (state.kind === "running") {
    parts.push(`indexing… (${STEP_TEXT[state.step]})`);
  } else {
    parts.push(`index failed: ${state.message}`);
    error = true;
  }
  const joined = parts.join(" · ");
  return { text: joined.charAt(0).toUpperCase() + joined.slice(1), error };
}

export function statusText(status: SearchStatus, elapsedMs: number): string {
  const label = status === "starting" ? "Starting QMD server…" : "Searching…";
  return `${label} ${Math.floor(elapsedMs / 1000)}s`;
}

/** Index of the selected result, or null when the input has focus. */
export function moveSelection(
  current: number | null,
  key: "ArrowUp" | "ArrowDown",
  count: number,
): number | null {
  if (key === "ArrowDown") {
    if (current === null) return count > 0 ? 0 : null;
    return Math.min(current + 1, count - 1);
  }
  if (current === null || current === 0) return null;
  return current - 1;
}

/** A note's folder as shown under its title: "Projects/Platform" reads "Projects / Platform". */
export function folderLabel(folder: string): string {
  return folder.split("/").join(" / ");
}

export function scorePercent(score: number): string {
  const pct = Number.isNaN(score)
    ? 0
    : Math.min(100, Math.max(0, Math.round(score * 100)));
  return `${pct}%`;
}
