import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
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
const cli = (qmdPath = FAKE, extraPath = "") =>
  new QmdCli(() => ({ qmdPath, extraPath }));
/** What `process.kill` throws on macOS for a process group whose only members are zombies. */
const eperm = (): NodeJS.ErrnoException =>
  Object.assign(new Error("kill EPERM"), { code: "EPERM" });

describe("QmdCli", () => {
  it("captures output and exit code", async () => {
    expect(await cli().run(["echo", "a b", "c"], T)).toMatchObject({
      code: 0,
      stdout: "out:a b c\n",
      stderr: "err:a b c\n",
      timedOut: false,
    });
    expect(await cli().run(["fail"], T)).toMatchObject({
      code: 3,
      stderr: "boom\n",
    });
  });
  it("reports a missing binary instead of rejecting", async () => {
    expect(await cli("/nonexistent/qmd").run(["echo"], T)).toMatchObject({
      code: null,
      errorCode: "ENOENT",
    });
  });
  it("puts qmd's directory and the extra directories first on PATH", async () => {
    const { stdout } = await cli(FAKE, "/extra/one:/extra/two").run(
      ["path"],
      T,
    );
    expect(stdout.startsWith(`${dirname(FAKE)}:/extra/one:/extra/two:`)).toBe(
      true,
    );
  });
  // QMD takes a `.qmd/index.yml` at or above its working directory for its index. This process
  // runs in the repository, so a qmd that inherited its working directory would not report `/`.
  it("runs qmd from /, not from the directory this process is in", async () => {
    expect(process.cwd()).not.toBe("/");
    expect((await cli().run(["pwd"], T)).stdout).toBe("/\n");
  });
  it("runs a qmd whose path contains a space", async () => {
    const dir = mkdtempSync(join(tmpdir(), "has space "));
    try {
      const copy = join(dir, "qmd");
      copyFileSync(FAKE, copy);
      chmodSync(copy, 0o755);
      expect((await cli(copy).run(["echo", "x"], T)).stdout).toBe("out:x\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  it("killAll signals every running command, even when signalling one of them fails with EPERM", async () => {
    const c = cli();
    const first = c.run(["hang"], { timeoutMs: 60_000 });
    const second = c.run(["hang"], { timeoutMs: 60_000 });
    await sleep(300);
    // The first signal fails. Every later one goes through to the real `process.kill`.
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw eperm();
    });
    try {
      expect(() => c.killAll()).not.toThrow();
      const groups = kill.mock.calls.map(([pid]) => pid);
      expect(kill.mock.calls.map(([, signal]) => signal)).toEqual([
        "SIGTERM",
        "SIGTERM",
      ]);
      expect(new Set(groups).size).toBe(2);
      expect(groups.every((pid) => pid < -1)).toBe(true);
      expect((await second).code).toBeNull();
    } finally {
      kill.mockRestore();
      c.killAll(); // the first command is still running: its signal was the one that failed
    }
    expect((await first).code).toBeNull();
  });
  it("goes on to SIGKILL and settles when signalling the group fails with EPERM at the timeout", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw eperm();
    });
    try {
      const pending = cli().run(["hang"], { timeoutMs: 300 });
      // Each step runs in a timer of the CLI's own, and a throw from a timer comes out of the advance.
      expect(() => vi.advanceTimersByTime(300)).not.toThrow();
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
      vi.advanceTimersByTime(1000);
      expect(await pending).toMatchObject({ code: null, timedOut: true });
      expect(kill.mock.calls.map(([, signal]) => signal)).toEqual([
        "SIGTERM",
        "SIGKILL",
      ]);
    } finally {
      const group = kill.mock.calls.at(0)?.[0];
      kill.mockRestore();
      vi.useRealTimers();
      // No signal reached the command, so it is still running.
      if (group !== undefined) process.kill(group, "SIGKILL");
    }
  });
  it("resolves instead of rejecting when spawn throws", async () => {
    expect(await cli("").run(["echo"], T)).toMatchObject({
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      errorCode: "ERR_INVALID_ARG_VALUE",
    });
    expect(await cli().run(["echo", "a\0b"], T)).toMatchObject({
      code: null,
      timedOut: false,
      errorCode: "ERR_INVALID_ARG_VALUE",
    });
  });
  it("resolves instead of rejecting when getConfig throws", async () => {
    const plain = new QmdCli(() => {
      throw new Error("bad config");
    });
    expect(await plain.run(["echo"], T)).toMatchObject({
      code: null,
      timedOut: false,
      errorCode: "ECONFIG",
    });
    const coded = new QmdCli(() => {
      throw Object.assign(new Error("x"), { code: "EWHATEVER" });
    });
    expect(await coded.run(["echo"], T)).toMatchObject({
      code: null,
      errorCode: "EWHATEVER",
    });
  });
  it("settles after a timeout even when a grandchild ignoring SIGTERM holds the pipes", async () => {
    const result = await cli().run(["stubborn"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    const child = Number(/child:(\d+)/.exec(result.stdout)![1]);
    await sleep(300);
    expect(alive(child)).toBe(false);
  }, 8000);
});
