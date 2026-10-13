// Text full of shell metacharacters has to reach `qmd` and the QMD server as plain data. The plugin
// starts every process from an argument array and runs no shell; these tests fail if that changes.
// A string that could run a command would create the sentinel file, which nothing else ever does.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  DEFAULT_SETTINGS,
  deriveCollectionName,
  isValidCollectionName,
  sanitizeSettings,
  type KeyValueStore,
  type QmdSearchSettings,
} from "../src/config";
import { QmdCli } from "../src/qmd-cli";
import { QmdClient } from "../src/qmd-client";
import { SearchService } from "../src/search-service";
import { createServerDeps, serverLogPath } from "../src/server-deps";

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
/** A directory whose path is hostile too, holding a copy of the fake named `qmd`. */
let hostileDir: string;

const expectNoSentinel = (): void =>
  expect(
    existsSync(sentinel),
    "a shell ran the text as a command, which created the sentinel",
  ).toBe(false);

/** The fake's report of these arguments: their number, then each one, all ending in a NUL. */
const report = (...args: string[]): string[] => [
  String(args.length),
  ...args,
  "",
];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "qmd-search-hostile-"));
  sentinel = join(tmp, "sentinel");
  strings = hostile(sentinel);

  // A space, `$HOME`, a backtick pair and a single quote. The pair holds the sentinel's whole
  // path, so that running it would create the sentinel; the slashes in that path make this a
  // chain of directories, one inside the other, all of them under the temp directory.
  hostileDir = join(tmp, `has space $HOME \`touch ${sentinel}\` it's`);
  mkdirSync(hostileDir, { recursive: true });
  copyFileSync(FAKE, join(hostileDir, "qmd"));
  chmodSync(join(hostileDir, "qmd"), 0o755);
});

// Removed after each test, so that a sentinel one test let through is not held against the next.
afterEach(() => rmSync(sentinel, { force: true }));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("QmdCli", () => {
  const cli = (qmdPath = FAKE, extraPath = "") =>
    new QmdCli(() => ({ qmdPath, extraPath }));

  it.each(CASES)(
    "passes %j to qmd as one argument, byte for byte",
    async (_name, index) => {
      const text = strings[index];
      const result = await cli().run(["args", text], T);
      expectNoSentinel();
      expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
      expect(result.stdout.split("\0")).toEqual(report(text));
    },
  );

  it("passes every hostile string in one call, each as its own argument", async () => {
    const result = await cli().run(["args", ...strings], T);
    expectNoSentinel();
    expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
    expect(result.stdout.split("\0")).toEqual(report(...strings));
  });

  it("runs a qmd whose own path contains shell metacharacters", async () => {
    const result = await cli(join(hostileDir, "qmd")).run(["args", "ran"], T);
    expectNoSentinel();
    expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
    expect(result.stdout.split("\0")).toEqual(report("ran"));
  });

  it("puts an extra PATH directory that contains shell metacharacters on PATH as it is written", async () => {
    const result = await cli(FAKE, hostileDir).run(["path"], T);
    expectNoSentinel();
    expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
    expect(result.stdout.split(":").slice(0, 2)).toEqual([
      dirname(FAKE),
      hostileDir,
    ]);
  });
});

// The other place the plugin starts `qmd`: the server, from the same two settings.
describe("createServerDeps", () => {
  it("starts the server from a qmd path and a PATH that contain shell metacharacters", async () => {
    // Held open for the whole test, so that the log file its number names is this test's alone.
    const held = net.createServer();
    await new Promise<void>((done) => held.listen(0, "localhost", done));
    const { port } = held.address() as net.AddressInfo;
    const qmdPath = join(hostileDir, "qmd");
    const settings: QmdSearchSettings = {
      ...DEFAULT_SETTINGS,
      qmdPath,
      extraPath: hostileDir,
      port,
    };
    const store: KeyValueStore = { get: () => undefined, set: () => {} };
    const deps = createServerDeps({
      cli: new QmdCli(() => settings),
      getSettings: () => settings,
      store,
    });

    const server = deps.spawnServer(port);
    try {
      // The fake reports its arguments and exits. The timer only bounds a failure.
      const exit = await Promise.race([
        server.exit,
        sleep(3000, "still running", { ref: false }),
      ]);
      expectNoSentinel();
      // The log is the server's output: the fake names the path it was run by, then its arguments.
      const log = readFileSync(serverLogPath(port), "utf8").split("\0");
      expect({ exit, log }).toEqual({
        exit: { code: 0 },
        log: [qmdPath, ...report("mcp", "--http", "--port", String(port))],
      });
    } finally {
      if (server.pid !== undefined) deps.killGroup(server.pid, "SIGKILL");
      await server.exit;
      rmSync(serverLogPath(port), { force: true });
      await new Promise<void>((done) => held.close(() => done()));
    }
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
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { structuredContent: { results: [] } },
          }),
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, "localhost", done));
    const { port } = server.address() as net.AddressInfo;
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
  it.each(CASES)(
    "sends %j as the query, and another hostile string as the collection",
    async (_name, index) => {
      const text = strings[index];
      const collection = strings[(index + 1) % strings.length];
      const outcome = await client
        .query(text, { collection, limit: 20 })
        .catch((error: unknown) => error);
      expectNoSentinel();
      expect(outcome).toEqual([]);
      expect(bodies).toHaveLength(1);
      const sent = JSON.parse(bodies[0]).params.arguments;
      expect(sent.query).toBe(text);
      expect(sent.collections).toEqual([collection]);
    },
  );
});

describe("SearchService", () => {
  // The service collapses each run of whitespace into one space and trims the ends. The only
  // whitespace in the list that this changes is the one newline, so every other string has to
  // arrive exactly as it was typed.
  it.each(CASES)(
    "hands %j to the client with nothing but its whitespace changed",
    async (_name, index) => {
      const text = strings[index];
      const query = vi.fn<QmdClient["query"]>(async () => []);
      const service = new SearchService({
        indexer: {
          whenReady: async () => true,
          getState: () => ({ kind: "idle" }),
        },
        server: {
          ensureRunning: async () => {},
          noteActivity: () => {},
          hold: () => () => {},
        },
        client: { query },
        getSettings: () => ({ collectionName: "Main", resultCount: 3 }),
        fileExists: () => true,
        isExcluded: () => false,
      });
      await service.search(text);
      expectNoSentinel();
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toBe(text.replaceAll("\n", " "));
    },
  );
});

describe("collection names", () => {
  const BAD = [
    "a$b",
    "a`b",
    "a;b",
    "a b",
    "a|b",
    "a&b",
    "$(x)",
    "a/b",
    "a\nb",
    "-x",
    "a'b",
    'a"b',
  ];

  it.each(BAD)(
    "%j is refused, and the saved setting falls back to a name made from the vault's",
    (bad) => {
      expect(isValidCollectionName(bad)).toBe(false);
      expect(
        sanitizeSettings({ collectionName: bad }, "My Vault").collectionName,
      ).toBe("My-Vault");
    },
  );

  it("makes a name of safe characters alone from a hostile vault name", () => {
    expect(deriveCollectionName("We$ird `vault` (1); rm -rf")).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
  });
});
