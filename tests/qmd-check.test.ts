import { describe, expect, it } from "vitest";
import type { CliResult } from "../src/qmd-cli";
import { checkQmd, qmdCheckText, type QmdCheck } from "../src/qmd-check";

const ran = (result: Partial<CliResult>): CliResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...result,
});

/** A command runner that answers every call with `result`, and keeps what it was asked. */
function fakeCli(result: CliResult) {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  return {
    calls,
    run(args: string[], opts: { timeoutMs: number }): Promise<CliResult> {
      calls.push({ args, timeoutMs: opts.timeoutMs });
      return Promise.resolve(result);
    },
  };
}

describe("checkQmd", () => {
  it("asks qmd for its version, once, and gives it fifteen seconds", async () => {
    const cli = fakeCli(ran({ stdout: "qmd 2.8.3 (facd35e)\n" }));
    await checkQmd(cli);
    expect(cli.calls).toEqual([{ args: ["--version"], timeoutMs: 15_000 }]);
  });

  it.each<[string, Partial<CliResult>, QmdCheck]>([
    [
      "the version line QMD 2.8.3 prints",
      { stdout: "qmd 2.8.3 (facd35e)\n" },
      { kind: "found", version: "2.8.3" },
    ],
    [
      "a version line with nothing after the number",
      { stdout: "qmd 2.10.0\n" },
      { kind: "found", version: "2.10.0" },
    ],
    [
      "a pre-release version",
      { stdout: "qmd 3.0.0-beta.1 (0123abc)\n" },
      { kind: "found", version: "3.0.0-beta.1" },
    ],
    [
      "a version line that follows a warning",
      { stdout: "(node:1) ExperimentalWarning: x\nqmd 2.8.3 (facd35e)\n" },
      { kind: "found", version: "2.8.3" },
    ],
    [
      "a program that only echoes its arguments",
      { stdout: "--version\n" },
      { kind: "not-qmd" },
    ],
    ["a program that prints nothing", { stdout: "" }, { kind: "not-qmd" }],
    [
      "another program's version line",
      { stdout: "GNU bash, version 5.2.37\n" },
      { kind: "not-qmd" },
    ],
    [
      "a name that only starts with qmd",
      { stdout: "qmdtool 1.2.3\n" },
      { kind: "not-qmd" },
    ],
    [
      "qmd with no version number after it",
      { stdout: "qmd help\n" },
      { kind: "not-qmd" },
    ],
    [
      "a path with no file at it",
      { code: null, errorCode: "ENOENT" },
      { kind: "cannot-run", errorCode: "ENOENT" },
    ],
    [
      "a file that may not be executed",
      { code: null, errorCode: "EACCES" },
      { kind: "cannot-run", errorCode: "EACCES" },
    ],
    [
      "a path that treats a file as a folder",
      { code: null, errorCode: "ENOTDIR" },
      { kind: "cannot-run", errorCode: "ENOTDIR" },
    ],
    [
      "a launcher that cannot find node",
      { code: 127, stderr: "env: node: No such file or directory\n" },
      { kind: "failed", detail: "env: node: No such file or directory" },
    ],
    [
      "a failure that says why on its first line",
      {
        code: 1,
        stderr: "\nError: Cannot find module 'x'\n    at a (b.js:1)\n",
      },
      { kind: "failed", detail: "Error: Cannot find module 'x'" },
    ],
    [
      "a Node error, whose reason comes after the place it was thrown",
      {
        code: 1,
        stderr:
          "node:internal/modules/cjs/loader:1921\n  throw err;\n  ^\n\nError: Cannot find module '/x/qmd.js'\n    at a (b.js:1)\n\nNode.js v26.5.0\n",
      },
      { kind: "failed", detail: "Error: Cannot find module '/x/qmd.js'" },
    ],
    [
      "a failure of another kind of error",
      {
        code: 1,
        stderr: "warning: slow disk\nTypeError: x is not a function\n",
      },
      { kind: "failed", detail: "TypeError: x is not a function" },
    ],
    [
      "a failure that says why on standard output only",
      { code: 2, stdout: "usage: qmd <command>\n" },
      { kind: "failed", detail: "usage: qmd <command>" },
    ],
    [
      "a failure that says nothing",
      { code: 3 },
      { kind: "failed", detail: "exit code 3" },
    ],
    [
      "a version line from a run that failed all the same",
      { code: 1, stdout: "qmd 2.8.3 (facd35e)\n", stderr: "boom\n" },
      { kind: "failed", detail: "boom" },
    ],
    [
      "a run that was stopped before it finished",
      { code: null },
      { kind: "failed", detail: "it was stopped before it finished" },
    ],
    [
      "a run that took too long",
      { code: null, timedOut: true },
      { kind: "timed-out" },
    ],
    [
      "a run that took too long and had already printed a version",
      { code: null, timedOut: true, stdout: "qmd 2.8.3 (facd35e)\n" },
      { kind: "timed-out" },
    ],
  ])("reads %s", async (_what, result, expected) => {
    expect(await checkQmd(fakeCli(ran(result)))).toEqual(expected);
  });

  it("cuts a very long reason short", async () => {
    const check = await checkQmd(
      fakeCli(ran({ code: 1, stderr: "x".repeat(500) })),
    );
    expect(check).toEqual({ kind: "failed", detail: "x".repeat(200) + "…" });
  });
});

describe("qmdCheckText", () => {
  const PATH = "/Users/alex/bin/qmd";

  it.each<[QmdCheck, string, boolean]>([
    [{ kind: "found", version: "2.8.3" }, "Found QMD 2.8.3.", true],
    [
      { kind: "cannot-run", errorCode: "ENOENT" },
      `Couldn't run qmd at "/Users/alex/bin/qmd".`,
      false,
    ],
    [
      { kind: "cannot-run", errorCode: "EACCES" },
      `Couldn't run qmd at "/Users/alex/bin/qmd".`,
      false,
    ],
    [
      { kind: "cannot-run", errorCode: "ENOTDIR" },
      `Couldn't run qmd at "/Users/alex/bin/qmd" (ENOTDIR).`,
      false,
    ],
    [
      { kind: "failed", detail: "env: node: No such file or directory" },
      `qmd started but failed: env: node: No such file or directory. Add node's folder to "Extra PATH directories".`,
      false,
    ],
    [
      { kind: "failed", detail: "exit code 3" },
      "qmd started but failed: exit code 3.",
      false,
    ],
    [
      { kind: "failed", detail: "Something went wrong." },
      "qmd started but failed: Something went wrong.",
      false,
    ],
    [{ kind: "not-qmd" }, "That ran, but it doesn't look like QMD.", false],
    [{ kind: "timed-out" }, "qmd did not answer within 15 seconds.", false],
  ])("says of %j: %s", (check, text, ok) => {
    expect(qmdCheckText(check, PATH)).toEqual({ text, ok });
  });
});
