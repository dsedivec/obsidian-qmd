import { afterEach, describe, expect, it, vi } from "vitest";
import { isUsablePid, isUsablePort, signalGroup } from "../src/process-group";

/** An error as `process.kill` throws it. */
const failure = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`kill ${code}`), { code });

describe("process-group", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[unknown, boolean]>([
    [2, true],
    [4242, true],
    [0, false],
    [1, false],
    [-3, false],
    [1.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    ["4242", false],
    [null, false],
    [undefined, false],
  ])("isUsablePid(%s) is %s", (pid, expected) => {
    expect(isUsablePid(pid)).toBe(expected);
  });

  it.each<[unknown, boolean]>([
    [1, true],
    [8181, true],
    [65_535, true],
    [0, false],
    [-1, false],
    [65_536, false],
    [8181.5, false],
    [Number.NaN, false],
    ["8181", false],
    [null, false],
    [undefined, false],
  ])("isUsablePort(%s) is %s", (port, expected) => {
    expect(isUsablePort(port)).toBe(expected);
  });

  // `process.kill(-0)` signals this process's own group, and `process.kill(-1)` every process the user owns.
  it("signalGroup signals the group of a PID that is an integer above 1, and nothing for any other", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    for (const pid of [0, 1, -3, 1.5, Number.NaN, undefined])
      signalGroup(pid, "SIGTERM");
    expect(kill).not.toHaveBeenCalled();
    signalGroup(4242, "SIGKILL");
    expect(kill.mock.calls).toEqual([[-4242, "SIGKILL"]]);
  });

  // `ESRCH` is a group that is gone. macOS answers `EPERM` for one whose only members are zombies.
  it.each(["ESRCH", "EPERM"])(
    "signalGroup does nothing when the signal fails with %s",
    (code) => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw failure(code);
      });
      expect(() => signalGroup(4242, "SIGTERM")).not.toThrow();
      expect(kill).toHaveBeenCalledTimes(1);
    },
  );

  it("signalGroup lets any other failure through", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw failure("EINVAL");
    });
    expect(() => signalGroup(4242, "SIGTERM")).toThrow("kill EINVAL");
  });
});
