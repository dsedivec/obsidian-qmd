import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { readFileSync } from "node:fs";
import { QmdClient } from "../src/qmd-client";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
const requestFixture = fixture("mcp-query-request.json");
const responseFixture = fixture("mcp-query-response.json");
const toolErrorFixture = fixture("mcp-tool-error-response.json");

function withArgs(body: { params: object }, args: unknown) {
  return { ...body, params: { ...body.params, arguments: args } };
}

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

const Q = { collection: "Main", limit: 20 };

describe("QmdClient", () => {
  let server: http.Server;
  let port: number;
  let client: QmdClient;
  let seen: Seen;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const sockets = new Set<net.Socket>();

  const respondRaw = (status: number, body: string) => {
    handler = (_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
  };
  const respond = (status: number, body: unknown) =>
    respondRaw(status, JSON.stringify(body));

  beforeEach(async () => {
    handler = () => {};
    seen = { headers: {}, body: undefined };
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: unknown = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          /* keep raw */
        }
        seen = { method: req.method, url: req.url, headers: req.headers, body };
        handler(req, res);
      });
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, "localhost", r));
    port = (server.address() as net.AddressInfo).port;
    client = new QmdClient(() => port);
  });

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("sends the request shape that the probe recorded, with no Origin header", async () => {
    respond(200, responseFixture);
    await client.query("pod roles", { collection: "Main", limit: 20 });
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/mcp");
    expect(seen.body).toEqual(
      withArgs(requestFixture.body, {
        query: "pod roles",
        collections: ["Main"],
        limit: 20,
      }),
    );
    for (const [name, value] of Object.entries(requestFixture.headers))
      expect(seen.headers[name.toLowerCase()]).toBe(value);
    expect(seen.headers.origin).toBeUndefined();
  });

  it("returns the results array", async () => {
    respond(200, responseFixture);
    expect(await client.query("x", Q)).toEqual(
      responseFixture.result.structuredContent.results,
    );
  });

  it("turns a tool error into kind tool with the server's text", async () => {
    respond(200, toolErrorFixture);
    await expect(client.query("x", Q)).rejects.toMatchObject({
      kind: "tool",
      message: expect.stringContaining("provide either"),
    });
  });

  it("turns a JSON-RPC error into kind tool", async () => {
    respond(200, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "bad params" },
    });
    await expect(client.query("x", Q)).rejects.toMatchObject({
      kind: "tool",
      message: "bad params",
    });
  });

  it.each([
    [403, '{"error":"Forbidden"}'],
    [500, "Internal Server Error"],
    [200, "not json"],
    [200, '{"jsonrpc":"2.0","id":1,"result":{}}'],
    [
      200,
      '{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"results":"nope"}}}',
    ],
  ])("status %i body %j is an unexpected response", async (status, body) => {
    respondRaw(status, body);
    await expect(client.query("x", Q)).rejects.toMatchObject({
      kind: "server-response",
      detail: body,
    });
  });

  it("truncates the detail to 500 characters", async () => {
    respondRaw(500, "e".repeat(2000));
    await expect(client.query("x", Q)).rejects.toMatchObject({
      kind: "server-response",
      detail: "e".repeat(500),
    });
  });

  it("reports a refused connection", async () => {
    const tmp = net.createServer();
    await new Promise<void>((r) => tmp.listen(0, "localhost", r));
    const closedPort = (tmp.address() as net.AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    await expect(
      new QmdClient(() => closedPort).query("x", Q),
    ).rejects.toMatchObject({ kind: "connection" });
  });

  it("reports a connection dropped mid-response", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write("{");
      res.destroy();
    };
    await expect(client.query("x", Q)).rejects.toMatchObject({
      kind: "connection",
    });
  });

  it("times out", async () => {
    handler = () => {};
    await expect(
      new QmdClient(() => port, { timeoutMs: 200 }).query("x", Q),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects as aborted when the signal fires, before or during the request", async () => {
    handler = () => {};
    const controller = new AbortController();
    const pending = client.query("x", { ...Q, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    await expect(
      client.query("x", { ...Q, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("closes the client socket after a timeout", async () => {
    handler = () => {};
    await expect(
      new QmdClient(() => port, { timeoutMs: 100 }).query("x", Q),
    ).rejects.toMatchObject({ kind: "timeout" });
    await vi_waitFor(() => sockets.size === 0);
  });
});

async function vi_waitFor(cond: () => boolean) {
  for (let i = 0; i < 50 && !cond(); i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
}
