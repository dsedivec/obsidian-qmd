export type QmdErrorKind =
  | "qmd-not-found"
  | "node-not-found"
  | "port-in-use"
  | "server-start"
  | "connection"
  | "timeout"
  | "server-response"
  | "tool"
  | "not-ready"
  | "index"
  | "aborted";

export class QmdSearchError extends Error {
  constructor(
    readonly kind: QmdErrorKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "QmdSearchError";
  }
}

export function classifyStartFailure(
  logTail: string,
  spawnErrorCode: string | undefined,
): QmdErrorKind {
  if (spawnErrorCode === "ENOENT" || spawnErrorCode === "EACCES")
    return "qmd-not-found";
  if (/node: No such file or directory/.test(logTail)) return "node-not-found";
  if (/already in use/i.test(logTail)) return "port-in-use";
  return "server-start";
}

export interface ErrorView {
  message: string;
  hint?: string;
  detail?: string;
  links: Array<"settings" | "retry">;
}

export function describeError(
  err: unknown,
  ctx: { qmdPath: string; port: number },
): ErrorView {
  if (!(err instanceof QmdSearchError)) {
    const text = err instanceof Error ? err.message : String(err);
    return { message: `Search failed: ${text}`, links: ["retry"] };
  }
  const detail = err.detail ? { detail: err.detail } : {};
  switch (err.kind) {
    case "qmd-not-found":
      return {
        message: `Couldn't run qmd at "${ctx.qmdPath}".`,
        hint: "Set the QMD path in settings.",
        ...detail,
        links: ["settings"],
      };
    case "node-not-found":
      return {
        message: "Couldn't start the QMD server.",
        hint: `QMD needs node on its PATH. Check "Extra PATH directories" in settings, then retry.`,
        ...detail,
        links: ["settings", "retry"],
      };
    case "port-in-use":
      return {
        message: `Port ${ctx.port} is in use by another program.`,
        hint: "Change the server port in settings.",
        ...detail,
        links: ["settings"],
      };
    case "server-start":
      return {
        message: "Couldn't start the QMD server.",
        ...detail,
        links: ["settings", "retry"],
      };
    case "connection":
      return {
        message: "Lost the connection to the QMD server.",
        ...detail,
        links: ["retry"],
      };
    case "timeout":
      return {
        message: "The search took longer than 2 minutes.",
        hint: "If QMD is still downloading its models, try again in a few minutes.",
        ...detail,
        links: ["retry"],
      };
    case "server-response":
      return {
        message: "QMD returned an unexpected response.",
        ...detail,
        links: ["retry"],
      };
    case "tool":
      return { message: err.message, ...detail, links: ["retry"] };
    case "not-ready":
      return { message: err.message, ...detail, links: [] };
    case "index":
      return {
        message: `Index failed: ${err.message}`,
        ...detail,
        links: ["settings"],
      };
    case "aborted":
      return { message: "Search cancelled.", ...detail, links: [] };
  }
}
