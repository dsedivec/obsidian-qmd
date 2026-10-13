import * as http from "node:http";
import { QmdSearchError } from "./errors";
import type { RawResult } from "./results";

// Fixed parts of the request the real QMD server accepted (tests/fixtures/mcp-query-request.json).
const HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
  "MCP-Protocol-Version": "2026-07-28",
  "Mcp-Method": "tools/call",
  "Mcp-Name": "query",
};
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "qmd-search", version: "0.1.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const DETAIL_LIMIT = 500;

export class QmdClient {
  constructor(private readonly getPort: () => number, private readonly opts: { timeoutMs?: number } = {}) {}

  query(text: string, opts: { collection: string; limit: number; signal?: AbortSignal }): Promise<RawResult[]> {
    const { signal } = opts;
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "query",
        arguments: { query: text, collections: [opts.collection], limit: opts.limit },
        _meta: META,
      },
    });

    return new Promise<RawResult[]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new QmdSearchError("aborted", "Search cancelled."));
        return;
      }

      let settled = false;
      let req: http.ClientRequest | undefined;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => finish(new QmdSearchError("aborted", "Search cancelled."));

      const finish = (outcome: QmdSearchError | RawResult[]) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        req?.destroy();
        if (outcome instanceof QmdSearchError) reject(outcome);
        else resolve(outcome);
      };
      const connectionError = (err: Error) =>
        finish(new QmdSearchError("connection", "Lost the connection to the QMD server.", err.message));

      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => finish(new QmdSearchError("timeout", "The search timed out.")),
        timeoutMs,
      );

      req = http.request(
        {
          host: "localhost",
          port: this.getPort(),
          path: "/mcp",
          method: "POST",
          headers: { ...HEADERS, "Content-Length": Buffer.byteLength(payload) },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", connectionError);
          res.on("close", () => {
            if (!res.complete) {
              connectionError(new Error("connection closed before the response finished"));
              return;
            }
            finish(interpret(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
          });
        },
      );
      req.on("error", connectionError);
      req.end(payload);
    });
  }
}

function interpret(status: number, body: string): QmdSearchError | RawResult[] {
  const unexpected = () =>
    new QmdSearchError("server-response", "QMD returned an unexpected response.", body.slice(0, DETAIL_LIMIT));
  if (status !== 200) return unexpected();
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unexpected();
  }
  if (parsed === null || typeof parsed !== "object") return unexpected();
  if (parsed.error && typeof parsed.error === "object") {
    const message = typeof parsed.error.message === "string" ? parsed.error.message : "QMD reported an error.";
    return new QmdSearchError("tool", message);
  }
  const result = parsed.result;
  if (result?.isError === true) {
    const items: unknown[] = Array.isArray(result.content) ? result.content : [];
    const item = items.find((i: any) => i && typeof i.text === "string") as { text: string } | undefined;
    return new QmdSearchError("tool", item?.text ?? "QMD reported an error.");
  }
  const results = result?.structuredContent?.results;
  if (!Array.isArray(results)) return unexpected();
  return results as RawResult[];
}
