import { chmodSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { QmdCli } from "../src/qmd-cli";

const FAKE = resolve(__dirname, "fixtures/fake-qmd.sh");
const T = { timeoutMs: 5000 };
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const cli = (qmdPath = FAKE, extraPath = "") => new QmdCli(() => ({ qmdPath, extraPath }));

describe("QmdCli", () => {
  it("captures output and exit code", async () => {
    expect(await cli().run(["echo", "a b", "c"], T)).toMatchObject({ code: 0, stdout: "out:a b c\n", stderr: "err:a b c\n", timedOut: false });
    expect(await cli().run(["fail"], T)).toMatchObject({ code: 3, stderr: "boom\n" });
  });
  it("reports a missing binary instead of rejecting", async () => {
    expect(await cli("/nonexistent/qmd").run(["echo"], T)).toMatchObject({ code: null, errorCode: "ENOENT" });
  });
  it("puts qmd's directory and the extra directories first on PATH", async () => {
    const { stdout } = await cli(FAKE, "/extra/one:/extra/two").run(["path"], T);
    expect(stdout.startsWith(`${dirname(FAKE)}:/extra/one:/extra/two:`)).toBe(true);
  });
  it("runs a qmd whose path contains a space", async () => {
    const copy = join(mkdtempSync(join(tmpdir(), "has space ")), "qmd");
    copyFileSync(FAKE, copy);
    chmodSync(copy, 0o755);
    expect((await cli(copy).run(["echo", "x"], T)).stdout).toBe("out:x\n");
  });
  it("kills the whole process group on timeout", async () => {
    const result = await cli().run(["hang"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    const child = Number(/child:(\d+)/.exec(result.stdout)![1]);
    await sleep(300);
    expect(alive(child)).toBe(false);
  });
  it("killAll stops everything still running", async () => {
    const c = cli();
    const pending = c.run(["hang"], { timeoutMs: 60_000 });
    await sleep(300);
    c.killAll();
    expect((await pending).code).toBeNull();
  });
  it("resolves instead of rejecting when spawn throws", async () => {
    expect(await cli("").run(["echo"], T)).toMatchObject({ code: null, stdout: "", stderr: "", timedOut: false, errorCode: "ERR_INVALID_ARG_VALUE" });
    expect(await cli().run(["echo", "a\0b"], T)).toMatchObject({ code: null, timedOut: false, errorCode: "ERR_INVALID_ARG_VALUE" });
  });
  it("resolves instead of rejecting when getConfig throws", async () => {
    const plain = new QmdCli(() => {
      throw new Error("bad config");
    });
    expect(await plain.run(["echo"], T)).toMatchObject({ code: null, timedOut: false, errorCode: "ECONFIG" });
    const coded = new QmdCli(() => {
      throw Object.assign(new Error("x"), { code: "EWHATEVER" });
    });
    expect(await coded.run(["echo"], T)).toMatchObject({ code: null, errorCode: "EWHATEVER" });
  });
  it("settles after a timeout even when a grandchild ignoring SIGTERM holds the pipes", async () => {
    const result = await cli().run(["stubborn"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    const child = Number(/child:(\d+)/.exec(result.stdout)![1]);
    await sleep(300);
    expect(alive(child)).toBe(false);
  }, 8000);
});
