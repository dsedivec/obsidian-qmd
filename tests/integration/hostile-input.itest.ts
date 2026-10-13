// Runs text and paths full of shell metacharacters through the real `qmd`: a vault whose path is
// made of them, indexed into a throwaway index, and a search for every hostile string against a
// real server on a spare port. A string that a shell interpreted anywhere on the way, in the
// plugin or in `qmd`, would create the sentinel file. Slow. Run with `npm run test:integration`.

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  type KeyValueStore,
  type QmdSearchSettings,
} from "../../src/config";
import { QmdSearchError } from "../../src/errors";
import { QmdCli, type CliResult } from "../../src/qmd-cli";
import { QmdClient } from "../../src/qmd-client";
import { toSearchResults } from "../../src/results";
import {
  checkHealth,
  createServerDeps,
  serverLogPath,
} from "../../src/server-deps";
import { ServerManager } from "../../src/server-manager";

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

const COLLECTION = "hostile";
const VAULT_NAME = "va$ult `x` 'q' (1) && true";
const FIXTURE_VAULT = fileURLToPath(
  new URL("../fixtures/vault", import.meta.url),
);
/** What points `qmd` at an index. Each is redirected into the temp directory for the whole file. */
const ISOLATED = ["INDEX_PATH", "QMD_CONFIG_DIR"] as const;

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "localhost", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** True until no process is left in the group. A launcher that has exited but is not yet reaped still counts. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error(`Condition not met within ${timeoutMs} ms`);
    await sleep(50);
  }
}

/** Every file and directory under `dir`, as sorted paths relative to it. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

// The tests are the stages of one run, in order: each needs what the ones before it left behind.
describe("hostile text with the real qmd", () => {
  const savedEnv = Object.fromEntries(
    ISOLATED.map((name) => [name, process.env[name]]),
  );
  const savedCwd = process.cwd();
  let tmp: string;
  let sentinel: string;
  let vault: string;
  let strings: string[];
  let settings: QmdSearchSettings;
  let cli: QmdCli;
  let client: QmdClient;
  let manager: ServerManager | undefined;
  /** Every launcher the manager spawned, so that a failed test leaves no server behind. */
  const launchers: number[] = [];

  const expectNoSentinel = (after: string): void =>
    expect(
      existsSync(sentinel),
      `a shell ran hostile text as a command: the sentinel appeared after ${after}`,
    ).toBe(false);

  /** Runs one `qmd` command that has to exit 0. */
  async function qmd(args: string[], timeoutMs: number): Promise<CliResult> {
    const result = await cli.run(args, { timeoutMs });
    if (result.code !== 0)
      throw new Error(
        `qmd ${args.join(" ")} failed: ${JSON.stringify(result)}`,
      );
    expectNoSentinel(`qmd ${args.join(" ")}`);
    return result;
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "qmd-search-hostile-itest-"));
    process.env.INDEX_PATH = join(tmp, "index.sqlite");
    process.env.QMD_CONFIG_DIR = join(tmp, "config");
    // qmd prefers a project-local .qmd/index.yml at or above its working directory over INDEX_PATH.
    process.chdir(tmp);

    sentinel = join(tmp, "sentinel");
    strings = hostile(sentinel);
    settings = {
      ...DEFAULT_SETTINGS,
      qmdPath: process.env.QMD_BIN ?? "qmd",
      port: await freePort(),
    };
    cli = new QmdCli(() => settings);
    client = new QmdClient(() => settings.port);

    vault = join(tmp, VAULT_NAME);
    cpSync(FIXTURE_VAULT, vault, { recursive: true });
  });

  afterAll(async () => {
    try {
      manager?.dispose();
      cli?.killAll();
      for (const pid of launchers) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The usual case: the test stopped its server, and the group is gone.
        }
      }
      await waitFor(() => !launchers.some(groupAlive), 10_000);
    } finally {
      process.chdir(savedCwd);
      for (const name of ISOLATED) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
      }
      if (settings) rmSync(serverLogPath(settings.port), { force: true });
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("indexes a vault whose path is made of shell metacharacters", async () => {
    await qmd(["collection", "add", vault, "--name", COLLECTION], 120_000);
    // The index and its configuration are the throwaway ones, not the user's.
    expect(existsSync(join(tmp, "index.sqlite"))).toBe(true);
    expect(existsSync(join(tmp, "config", "index.yml"))).toBe(true);

    const show = await qmd(["collection", "show", COLLECTION], 60_000);
    const path = /^\s*Path:\s*(.+)$/m.exec(show.stdout)?.[1] ?? "";
    expect(path.slice(-VAULT_NAME.length - 1)).toBe(`/${VAULT_NAME}`);
    // The comparison by which the plugin's indexer takes a collection for its own vault's.
    expect(realpathSync(path)).toBe(realpathSync(vault));

    await qmd(["update"], 300_000);
    await qmd(["embed", "-c", COLLECTION], 300_000);
  });

  it("answers or refuses every hostile query, and still searches afterwards", async () => {
    const real = createServerDeps({
      cli,
      getSettings: () => settings,
      store: memoryStore(),
    });
    manager = new ServerManager({
      ...real,
      spawnServer: (port) => {
        const server = real.spawnServer(port);
        if (server.pid !== undefined) launchers.push(server.pid);
        return server;
      },
    });
    await manager.ensureRunning();

    // QMD may refuse some text, which the client reports as kind `tool`. Anything else it does
    // with a query other than answering it is a failure: a timeout, a dropped connection, a
    // response that makes no sense, or a server that is gone afterwards.
    const names = hostile("SENTINEL");
    const outcomes: string[] = [];
    const failures: string[] = [];
    for (const [index, text] of strings.entries()) {
      const name = JSON.stringify(names[index]);
      let outcome: string;
      let acceptable: boolean;
      try {
        const raw = await client.query(text, {
          collection: COLLECTION,
          limit: 5,
        });
        acceptable = Array.isArray(raw);
        outcome = acceptable
          ? `resolved with ${raw.length} results`
          : `resolved with ${JSON.stringify(raw)}`;
      } catch (error) {
        acceptable = error instanceof QmdSearchError && error.kind === "tool";
        outcome =
          error instanceof QmdSearchError
            ? `rejected with kind ${error.kind}: ${JSON.stringify(error.message)}`
            : `rejected with ${String(error)}`;
      }
      expectNoSentinel(`the query ${name}`);
      outcomes.push(`${name}: ${outcome}`);
      if (!acceptable) failures.push(`${name}: ${outcome}`);
      if (!(await checkHealth(settings.port)))
        failures.push(
          `${name}: the server did not answer a health check afterwards`,
        );
    }
    console.log(
      `hostile queries against the real qmd:\n  ${outcomes.join("\n  ")}`,
    );
    expect(failures).toEqual([]);

    const raw = await client.query("sourdough starter hydration", {
      collection: COLLECTION,
      limit: 5,
    });
    expect(toSearchResults(raw, COLLECTION)[0].path).toBe("HTML & markup.md");

    manager.stopIfOwned();
    await waitFor(() => !launchers.some(groupAlive), 10_000);
    manager.dispose();
  });

  it("leaves no sentinel, and nothing in the temp directory that the test did not put there", () => {
    expectNoSentinel("the whole run");
    const expected = [
      "config",
      "config/index.yml",
      "index.sqlite",
      VAULT_NAME,
      ...tree(FIXTURE_VAULT).map((path) => `${VAULT_NAME}/${path}`),
    ].sort();
    // SQLite keeps its write-ahead log and shared memory beside the index while it is in use.
    expect(
      tree(tmp).filter((path) => !/^index\.sqlite-(wal|shm)$/.test(path)),
    ).toEqual(expected);
  });
});
