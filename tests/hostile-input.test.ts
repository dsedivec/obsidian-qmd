// Text full of shell metacharacters has to reach `qmd` and the QMD server as plain data. The plugin
// starts every process from an argument array and runs no shell; these tests fail if that changes.
// A string that could run a command would create the sentinel file, which nothing else ever does.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveCollectionName, isValidCollectionName, sanitizeSettings } from "../src/config";
import { QmdCli } from "../src/qmd-cli";
import { QmdClient } from "../src/qmd-client";
import { SearchService } from "../src/search-service";

const hostile = (sentinel: string) => [
  `$(touch ${sentinel})`,
  `\`touch ${sentinel}\``,
  `; touch ${sentinel}`,
  `&& touch ${sentinel}`,
  `| touch ${sentinel}`,
  `$HOME`,
  `\${HOME}`,
  `'single' "double"`,
  `back\\slash`,
  `glob * ? [a-z]`,
  `> ${sentinel}`,
  `line one\nline two`,
  `emoji ☕ and é`,
];

/** One case for each hostile string: a name that is the same on every run, and its place in `strings`. */
const CASES = hostile("SENTINEL").map((name, index) => [name, index] as const);

const FAKE = resolve(__dirname, "fixtures/fake-qmd.sh");
const T = { timeoutMs: 5000 };

let tmp: string;
let sentinel: string;
let strings: string[];

const expectNoSentinel = (): void =>
  expect(existsSync(sentinel), "a shell ran the text as a command, which created the sentinel").toBe(false);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "qmd-search-hostile-"));
  sentinel = join(tmp, "sentinel");
  strings = hostile(sentinel);
});

// Removed after each test, so that a sentinel one test let through is not held against the next.
afterEach(() => rmSync(sentinel, { force: true }));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("QmdCli", () => {
  const cli = (qmdPath = FAKE, extraPath = "") => new QmdCli(() => ({ qmdPath, extraPath }));
  /** What the fake's `args` case prints for these arguments: their number, then each one, all ending in a NUL. */
  const report = (...args: string[]): string[] => [String(args.length), ...args, ""];

  it.each(CASES)("passes %j to qmd as one argument, byte for byte", async (_name, index) => {
    const text = strings[index];
    const result = await cli().run(["args", text], T);
    expectNoSentinel();
    expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
    expect(result.stdout.split("\0")).toEqual(report(text));
  });

  it("passes every hostile string in one call, each as its own argument", async () => {
    const result = await cli().run(["args", ...strings], T);
    expectNoSentinel();
    expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
    expect(result.stdout.split("\0")).toEqual(report(...strings));
  });

  describe("with shell metacharacters in a configured path", () => {
    let hostileDir: string;

    beforeAll(() => {
      // A space, `$HOME`, a backtick pair and a single quote. The pair holds the sentinel's whole
      // path, so that running it would create the sentinel; the slashes in that path make this a
      // chain of directories, one inside the other, all of them under the temp directory.
      hostileDir = join(tmp, `has space $HOME \`touch ${sentinel}\` it's`);
      mkdirSync(hostileDir, { recursive: true });
      copyFileSync(FAKE, join(hostileDir, "qmd"));
      chmodSync(join(hostileDir, "qmd"), 0o755);
    });

    it("runs a qmd whose own path contains them", async () => {
      const result = await cli(join(hostileDir, "qmd")).run(["args", "ran"], T);
      expectNoSentinel();
      expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
      expect(result.stdout.split("\0")).toEqual(report("ran"));
    });

    it("puts an extra PATH directory that contains them on PATH as it is written", async () => {
      const result = await cli(FAKE, hostileDir).run(["path"], T);
      expectNoSentinel();
      expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
      expect(result.stdout.split(":").slice(0, 2)).toEqual([dirname(FAKE), hostileDir]);
    });
  });
});

describe("QmdClient", () => {
  let server: http.Server;
  let client: QmdClient;
  /** The body of every request the server has received in the current test. */
  let bodies: string[];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        bodies.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { results: [] } } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "localhost", done));
    const { port } = server.address() as AddressInfo;
    client = new QmdClient(() => port);
  });

  beforeEach(() => {
    bodies = [];
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  // The client does not check collection names. Whatever it is given has to travel as data too,
  // so each string is sent as the query beside its neighbour in the list as the collection.
  it.each(CASES)("sends %j as the query, and another hostile string as the collection", async (_name, index) => {
    const text = strings[index];
    const collection = strings[(index + 1) % strings.length];
    const outcome = await client.query(text, { collection, limit: 20 }).catch((error: unknown) => error);
    expectNoSentinel();
    expect(outcome).toEqual([]);
    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]).params.arguments;
    expect(sent.query).toBe(text);
    expect(sent.collections).toEqual([collection]);
  });
});

describe("SearchService", () => {
  // The service collapses each run of whitespace into one space and trims the ends. The only
  // whitespace in the list that this changes is the one newline, so every other string has to
  // arrive exactly as it was typed.
  it.each(CASES)("hands %j to the client with nothing but its whitespace changed", async (_name, index) => {
    const text = strings[index];
    const query = vi.fn<QmdClient["query"]>(async () => []);
    const service = new SearchService({
      indexer: { whenReady: async () => true, getState: () => ({ kind: "idle" }) },
      server: { ensureRunning: async () => {}, noteActivity: () => {} },
      client: { query },
      getSettings: () => ({ collectionName: "Main", resultCount: 3 }),
      fileExists: () => true,
      isExcluded: () => false,
    });
    await service.search(text);
    expectNoSentinel();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(text.replaceAll("\n", " "));
  });
});

describe("collection names", () => {
  const BAD = ["a$b", "a`b", "a;b", "a b", "a|b", "a&b", "$(x)", "a/b", "a\nb", "-x", "a'b", 'a"b'];

  it.each(BAD)("%j is refused, and the saved setting falls back to a name made from the vault's", (bad) => {
    expect(isValidCollectionName(bad)).toBe(false);
    expect(sanitizeSettings({ collectionName: bad }, "My Vault").collectionName).toBe("My-Vault");
  });

  it("makes a name of safe characters alone from a hostile vault name", () => {
    expect(deriveCollectionName("We$ird `vault` (1); rm -rf")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
