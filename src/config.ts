export interface QmdSearchSettings {
  qmdPath: string;
  extraPath: string;
  collectionName: string;
  port: number;
  idleTimeoutMinutes: number;
  reindexQuietMinutes: number;
  resultCount: number;
}

export const DEFAULT_SETTINGS: QmdSearchSettings = {
  qmdPath: "qmd",
  extraPath: "/opt/homebrew/bin:/usr/local/bin",
  collectionName: "",
  port: 8181,
  idleTimeoutMinutes: 60,
  reindexQuietMinutes: 5,
  resultCount: 10,
};

export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/**
 * QMD's own rule, less a leading hyphen: the name reaches `qmd` as a positional argument, where
 * a leading hyphen could be read as an option.
 */
export function isValidCollectionName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name);
}

export function deriveCollectionName(vaultName: string): string {
  const name = vaultName
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name === "" ? "vault" : name;
}

/**
 * A number, or a string that holds one. Nothing else counts, so that `Number()` cannot turn a
 * cleared field ("" is 0), a null or a boolean into a setting.
 */
function readNumber(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || value.trim() === "")
  )
    return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function clampedSetting(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = readNumber(value);
  return n === undefined ? fallback : Math.min(max, Math.max(min, n));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function sanitizeSettings(
  raw: unknown,
  vaultName: string,
): QmdSearchSettings {
  const obj: Record<string, unknown> =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const d = DEFAULT_SETTINGS;

  const qmdPath = (readString(obj.qmdPath) ?? "").trim() || d.qmdPath;
  const extraPath = splitPath(readString(obj.extraPath) ?? d.extraPath).join(
    ":",
  );
  const rawName = readString(obj.collectionName);
  const collectionName =
    rawName !== undefined && isValidCollectionName(rawName)
      ? rawName
      : deriveCollectionName(vaultName);

  const port = readNumber(obj.port);

  return {
    qmdPath,
    extraPath,
    collectionName,
    port: port !== undefined && port >= 1 && port <= 65535 ? port : d.port,
    idleTimeoutMinutes: clampedSetting(
      obj.idleTimeoutMinutes,
      d.idleTimeoutMinutes,
      1,
      1440,
    ),
    reindexQuietMinutes: clampedSetting(
      obj.reindexQuietMinutes,
      d.reindexQuietMinutes,
      1,
      120,
    ),
    resultCount: clampedSetting(obj.resultCount, d.resultCount, 1, 50),
  };
}

function splitPath(path: string): string[] {
  return path
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/**
 * The working directory of every `qmd` the plugin starts. QMD takes a project-local index,
 * `.qmd/index.yml`, in its working directory or in any directory above it, in place of its
 * default index. A `qmd` that inherited Obsidian's working directory would index and search such
 * a project's index whenever Obsidian had been started from a shell inside the project. No
 * directory is above `/`, and it is where Obsidian already runs when it is started from the Dock.
 */
export const QMD_WORKING_DIRECTORY = "/";

/** PATH for the spawned qmd: qmd's own directory, the extras, then the inherited PATH, deduplicated. */
export function buildPath(
  qmdPath: string,
  extraPath: string,
  inherited: string | undefined,
): string {
  const slash = qmdPath.lastIndexOf("/");
  const qmdDir = slash > 0 ? [qmdPath.slice(0, slash)] : [];
  const all = [
    ...qmdDir,
    ...splitPath(extraPath),
    ...splitPath(inherited ?? ""),
  ];
  return [...new Set(all)].join(":");
}
