const WARNING =
  "QMD Search: could not read Obsidian's excluded files; excluding nothing.";

function matchesFilter(path: string, filter: unknown): boolean {
  if (typeof filter !== "string" || filter.trim() === "") return false;
  if (filter.length >= 2 && filter.startsWith("/") && filter.endsWith("/")) {
    try {
      return new RegExp(filter.slice(1, -1)).test(path);
    } catch {
      return false;
    }
  }
  return path.startsWith(filter);
}

/** True when any Obsidian "Excluded files" filter matches the path. */
export function matchesFilters(
  path: string,
  filters: readonly unknown[],
): boolean {
  return filters.some((filter) => matchesFilter(path, filter));
}

type IgnoreApp = {
  metadataCache?: { isUserIgnored?: (path: string) => boolean };
  vault?: { getConfig?: (key: string) => unknown };
};

/** Builds a path check backed by Obsidian's own exclusion logic, falling back to the raw filter list. */
export function createExclusionCheck(
  app: unknown,
  warn: (message: string) => void = console.warn,
): (path: string) => boolean {
  const { metadataCache, vault } = (app ?? {}) as IgnoreApp;
  let warned = false;
  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    warn(WARNING);
  };
  return (path) => {
    try {
      if (typeof metadataCache?.isUserIgnored === "function") {
        return Boolean(metadataCache.isUserIgnored(path));
      }
      if (typeof vault?.getConfig === "function") {
        const filters = vault.getConfig("userIgnoreFilters");
        if (Array.isArray(filters)) return matchesFilters(path, filters);
      }
    } catch {
      // fall through to the warning
    }
    warnOnce();
    return false;
  };
}
