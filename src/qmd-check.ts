import { cannotRunText, saysNodeIsMissing } from "./errors";
import type { CliResult } from "./qmd-cli";

/** What running `qmd --version` showed about the QMD path in the settings. */
export type QmdCheck =
  | { kind: "found"; version: string }
  /** The file could not be started at all. */
  | { kind: "cannot-run"; errorCode: string }
  /** It started and ended in failure. `detail` is the first thing it said, or how it ended. */
  | { kind: "failed"; detail: string }
  /** It ran to the end, and what it printed is not QMD's version line. */
  | { kind: "not-qmd" }
  | { kind: "timed-out" };

const CHECK_TIMEOUT_MS = 15_000;
const DETAIL_LIMIT = 200;
/** QMD 2.8.3 prints `qmd 2.8.3 (facd35e)`. */
const VERSION_LINE = /^qmd (\d+\.\d+\.\d+\S*)/m;

/**
 * Runs `qmd --version` and says what came of it. The command reads no index and starts no server,
 * so the check changes nothing.
 */
export async function checkQmd(cli: {
  run(args: string[], opts: { timeoutMs: number }): Promise<CliResult>;
}): Promise<QmdCheck> {
  const result = await cli.run(["--version"], { timeoutMs: CHECK_TIMEOUT_MS });
  if (result.timedOut) return { kind: "timed-out" };
  if (result.code === null && result.errorCode !== undefined)
    return { kind: "cannot-run", errorCode: result.errorCode };
  if (result.code !== 0)
    return { kind: "failed", detail: failureDetail(result) };
  const version = VERSION_LINE.exec(result.stdout)?.[1];
  return version === undefined
    ? { kind: "not-qmd" }
    : { kind: "found", version };
}

/** The line that says why, from standard error for preference, or else how the command ended. */
function failureDetail(result: CliResult): string {
  const said = reasonLine(result.stderr) ?? reasonLine(result.stdout);
  if (said !== undefined)
    return said.length > DETAIL_LIMIT
      ? `${said.slice(0, DETAIL_LIMIT)}…`
      : said;
  return result.code === null
    ? "it was stopped before it finished"
    : `exit code ${result.code}`;
}

/**
 * The first line that names an error, as in `Error: Cannot find module`, or failing that the first
 * line there is. Node puts the place an error was thrown before the error itself.
 */
function reasonLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.find((line) => /^\w*Error: /.test(line)) ?? lines[0];
}

/** The line the settings tab shows for a check. `qmdPath` is the path that was run. */
export function qmdCheckText(
  check: QmdCheck,
  qmdPath: string,
): { text: string; ok: boolean } {
  switch (check.kind) {
    case "found":
      return { text: `Found QMD ${check.version}.`, ok: true };
    case "cannot-run":
      return { text: cannotRunText(qmdPath, check.errorCode), ok: false };
    case "failed": {
      const sentence = /[.!?…]$/.test(check.detail)
        ? check.detail
        : `${check.detail}.`;
      const hint = saysNodeIsMissing(check.detail)
        ? ` Add node's folder to "Extra PATH directories".`
        : "";
      return { text: `qmd started but failed: ${sentence}${hint}`, ok: false };
    }
    case "not-qmd":
      return { text: "That ran, but it doesn't look like QMD.", ok: false };
    case "timed-out":
      return {
        text: `qmd did not answer within ${CHECK_TIMEOUT_MS / 1000} seconds.`,
        ok: false,
      };
  }
}
