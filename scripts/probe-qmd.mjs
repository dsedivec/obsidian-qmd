#!/usr/bin/env node
// One-off probe of the real QMD server (plan Task 1; spec experiments 1, 3, 4
// and 7). It indexes a copy of tests/fixtures/vault into a throwaway QMD index,
// starts `qmd mcp --http`, finds the /mcp request the server accepts, captures
// fixtures from it, and then checks index freshness, the cost of an idle
// `qmd embed`, and recovery from an interrupted one.
//
// Run:  node scripts/probe-qmd.mjs     (QMD_BIN overrides the `qmd` binary)
//
// Findings go to stdout, one line each. Progress and qmd's own output go to
// stderr. On a machine that does not have QMD's models yet, `qmd embed` and the
// first query download them into ~/.cache/qmd/models.

import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const QMD = process.env.QMD_BIN ?? "qmd";
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "fixtures",
);
const COLLECTION = "probe";
const QUERY_ARGS = {
  query: "sourdough starter hydration",
  collections: [COLLECTION],
  limit: 5,
};
const QUERY_TOP_FILE = `${COLLECTION}/HTML & markup.md`;
const FRESH_PHRASE = "quokka enclosure maintenance";

const BASE_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const SHAPES = [
  { name: "A", headers: BASE_HEADERS },
  {
    name: "B",
    headers: {
      ...BASE_HEADERS,
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "query",
    },
    meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "qmd-search",
        version: "0.1.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
];

const tmp = await mkdtemp(join(tmpdir(), "qmd-probe-"));
const vault = join(tmp, "vault");
const env = {
  ...process.env,
  INDEX_PATH: join(tmp, "index.sqlite"),
  QMD_CONFIG_DIR: join(tmp, "config"),
};

const log = (message) => process.stderr.write(`[probe] ${message}\n`);

// ---------------------------------------------------------------------------
// qmd child processes
// ---------------------------------------------------------------------------

// Every qmd child still running. Each is the leader of its own process group,
// because the `qmd` launcher runs the real process as a child of its own and
// does not forward signals: only a signal to the group reaches both.
const running = new Set();

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/** Start `qmd <args>`. `exited` resolves with `{ code, signal, output }`, where `output` is stdout and stderr combined. */
function start(args) {
  log(`$ qmd ${args.join(" ")}`);
  // cwd is the temp directory because qmd prefers a project-local
  // .qmd/index.yml found at or above its cwd over INDEX_PATH.
  const child = spawn(QMD, args, {
    cwd: tmp,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
  }
  const proc = { pid: child.pid };
  proc.exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    // "close" waits for the pipes, which the real qmd process inherits, so it
    // fires only once the whole group has finished writing.
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  }).finally(() => running.delete(proc));
  running.add(proc);
  return proc;
}

/** Run `qmd <args>` to completion. Throws on a non-zero exit unless `allowFailure` is set. */
async function run(args, { allowFailure = false } = {}) {
  const startedAt = Date.now();
  const result = await start(args).exited;
  const ms = Date.now() - startedAt;
  log(
    `exit ${result.code ?? result.signal} after ${ms} ms: qmd ${args.join(" ")}`,
  );
  if (result.code !== 0 && !allowFailure) {
    throw new Error(
      `qmd ${args.join(" ")} exited with ${result.code ?? result.signal}`,
    );
  }
  return { ...result, ms };
}

/** SIGTERM a child's process group and wait until every process in it is gone. */
async function stopGroup(proc) {
  signalGroup(proc.pid, "SIGTERM");
  const kill = setTimeout(() => signalGroup(proc.pid, "SIGKILL"), 15_000);
  try {
    const result = await proc.exited;
    while (groupAlive(proc.pid)) await sleep(50);
    return result;
  } finally {
    clearTimeout(kill);
  }
}

let cleaning;
function cleanup() {
  cleaning ??= (async () => {
    await Promise.allSettled([...running].map(stopGroup));
    await rm(tmp, { recursive: true, force: true });
  })();
  return cleaning;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "localhost", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, { method, path, headers = {}, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        method,
        path,
        headers,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () =>
      req.destroy(
        new Error(`${method} ${path} timed out after ${timeoutMs} ms`),
      ),
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function waitForHealth(port, server) {
  let exit;
  server.exited.then((result) => (exit = result));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exit)
      throw new Error(
        `qmd mcp exited with ${exit.code ?? exit.signal} before it was healthy`,
      );
    try {
      const res = await request(port, {
        method: "GET",
        path: "/health",
        timeoutMs: 2_000,
      });
      if (JSON.parse(res.text).status === "ok") return;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error("qmd mcp did not report healthy within 120 s");
}

/** The `{ headers, body }` of a `tools/call` of the `query` tool in the given shape. */
function toolCall(shape, args) {
  const params = { name: "query", arguments: args };
  if (shape.meta) params._meta = shape.meta;
  return {
    headers: shape.headers,
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params },
  };
}

/** POST a tool call to /mcp. `json` is the parsed response body, or undefined if it is not JSON. */
async function postMcp(port, { headers, body }) {
  // The first query loads three models, so allow it plenty of time.
  const res = await request(port, {
    method: "POST",
    path: "/mcp",
    headers,
    body: JSON.stringify(body),
    timeoutMs: 600_000,
  });
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    json = undefined;
  }
  return { ...res, json };
}

const summarize = (res) =>
  `HTTP ${res.status} (${res.headers["content-type"]}) ${res.text.slice(0, 600)}`;

const writeFixture = (name, text) => writeFile(join(FIXTURES, name), text);
const writeJsonFixture = (name, value) =>
  writeFixture(name, `${JSON.stringify(value, null, 2)}\n`);

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

async function main() {
  // 1. A throwaway index over a copy of the fixture vault.
  await cp(join(FIXTURES, "vault"), vault, { recursive: true });
  await run(["collection", "add", vault, "--name", COLLECTION]);
  // No `qmd pull` here. It deletes a cached model and downloads it again
  // whenever its check against huggingface.co fails, and the probe does not
  // need it: `qmd embed` and the first query fetch a missing model themselves.
  await run(["embed", "-c", COLLECTION]);

  const show = await run(["collection", "show", COLLECTION]);
  await writeFixture("collection-show.txt", show.output);
  const showMissing = await run(["collection", "show", "nosuch"], {
    allowFailure: true,
  });
  await writeFixture("collection-show-missing.txt", showMissing.output);
  log(
    `collection show ${COLLECTION}: exit ${show.code}; collection show nosuch: exit ${showMissing.code}`,
  );

  // 2. The server.
  const port = await freePort();
  const server = start(["mcp", "--http", "--port", String(port)]);
  await waitForHealth(port, server);

  // 3. Experiment 1: the /mcp request shape. A shape counts only if the body
  // is a JSON document: QMD 2.8.3 answers shape A through its 2025-era path
  // with the same result framed as a text/event-stream message.
  let working;
  for (const shape of SHAPES) {
    const req = toolCall(shape, QUERY_ARGS);
    const res = await postMcp(port, req);
    log(`shape ${shape.name}: ${summarize(res)}`);
    if (Array.isArray(res.json?.result?.structuredContent?.results)) {
      working = { shape, request: req, response: res.json };
      break;
    }
  }
  if (!working)
    throw new Error(
      "mcp: neither shape A nor shape B returned result.structuredContent.results",
    );
  console.log(`mcp: shape ${working.shape.name} works`);

  const toolError = await postMcp(port, toolCall(working.shape, {}));
  log(`tool error: ${summarize(toolError)}`);
  if (toolError.json === undefined)
    throw new Error("mcp: the response to empty arguments is not JSON");

  await writeJsonFixture("mcp-query-request.json", working.request);
  await writeJsonFixture("mcp-query-response.json", working.response);
  await writeJsonFixture("mcp-tool-error-response.json", toolError.json);

  const search = async (query) => {
    const res = await postMcp(
      port,
      toolCall(working.shape, { ...QUERY_ARGS, query }),
    );
    const results = res.json?.result?.structuredContent?.results;
    if (!Array.isArray(results))
      throw new Error(`query "${query}" failed: ${summarize(res)}`);
    return results;
  };
  const files = (results) =>
    JSON.stringify(results.map((result) => result.file));

  // 4. Experiment 3: the running server sees a note indexed after it started.
  await writeFile(
    join(vault, "Fresh note.md"),
    `Checklist for ${FRESH_PHRASE}: walk the fence line, then refill the water trough.\n`,
  );
  await run(["update"]);
  await run(["embed", "-c", COLLECTION]);
  const fresh = await search(FRESH_PHRASE);
  if (fresh[0]?.file !== `${COLLECTION}/Fresh note.md`) {
    throw new Error(
      `freshness: expected ${COLLECTION}/Fresh note.md first, got ${files(fresh)}`,
    );
  }
  console.log("freshness: ok");

  // 5. Experiment 4: `qmd embed` with nothing to embed.
  const idle = await run(["embed", "-c", COLLECTION]);
  if (!idle.output.includes("already have embeddings")) {
    throw new Error(
      `embed idle: the embed was not idle: ${idle.output.trim()}`,
    );
  }
  console.log(`embed idle: ${idle.ms} ms`);

  // 6. Experiment 7: an embed killed partway leaves a usable index.
  const forced = start(["embed", "-f", "-c", COLLECTION]);
  await sleep(1_000);
  const killed = await stopGroup(forced);
  log(`interrupted embed ended with ${killed.code ?? killed.signal}`);
  if (killed.code === 0)
    throw new Error(
      "interrupt: embed -f finished before it could be interrupted",
    );
  const redone = await run(["embed", "-c", COLLECTION]);
  if (!redone.output.includes("Done!")) {
    throw new Error(
      `interrupt: the next embed had nothing to redo or did not finish: ${redone.output.trim()}`,
    );
  }
  const after = await search(QUERY_ARGS.query);
  if (after[0]?.file !== QUERY_TOP_FILE) {
    throw new Error(
      `interrupt: expected ${QUERY_TOP_FILE} first, got ${files(after)}`,
    );
  }
  console.log("interrupt: ok");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log(`${signal}: cleaning up`);
    cleanup().finally(() => process.exit(1));
  });
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  log(`FAILED: ${error.message}`);
} finally {
  await cleanup();
}
