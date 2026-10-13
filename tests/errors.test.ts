import { describe, expect, it } from "vitest";
import {
  QmdSearchError,
  classifyStartFailure,
  describeError,
  type QmdErrorKind,
} from "../src/errors";

describe("classifyStartFailure", () => {
  it.each([
    ["", "ENOENT", "qmd-not-found"],
    ["", "EACCES", "qmd-not-found"],
    ["env: node: No such file or directory\n", undefined, "node-not-found"],
    [
      "Port 8181 already in use. Try a different port with --port.\n",
      undefined,
      "port-in-use",
    ],
    ["something else\n", undefined, "server-start"],
    ["", undefined, "server-start"],
  ])("classifyStartFailure(%j, %j) is %s", (log, code, kind) => {
    expect(classifyStartFailure(log, code)).toBe(kind);
  });
});

const ctx = { qmdPath: "/x/qmd", port: 8181 };
const E = (kind: QmdErrorKind, message = "m", detail?: string) =>
  new QmdSearchError(kind, message, detail);

describe("describeError", () => {
  it.each([
    [
      E("qmd-not-found"),
      {
        message: `Couldn't run qmd at "/x/qmd".`,
        hint: "Set the QMD path in settings.",
        links: ["settings"],
      },
    ],
    [
      E("node-not-found", "m", "env: node: …"),
      {
        message: "Couldn't start the QMD server.",
        hint: `QMD needs node on its PATH. Check "Extra PATH directories" in settings, then retry.`,
        detail: "env: node: …",
        links: ["settings", "retry"],
      },
    ],
    [
      E("port-in-use"),
      {
        message: "Port 8181 is in use by another program.",
        hint: "Change the server port in settings.",
        links: ["settings"],
      },
    ],
    [
      E("server-start", "m", "log tail"),
      {
        message: "Couldn't start the QMD server.",
        detail: "log tail",
        links: ["settings", "retry"],
      },
    ],
    // With no log tail, the error's own message says what happened, and settings are not the fix.
    [
      E("server-start", "The QMD server start was cancelled."),
      { message: "The QMD server start was cancelled.", links: ["retry"] },
    ],
    [
      E("server-start", "QMD Search was shut down."),
      { message: "QMD Search was shut down.", links: ["retry"] },
    ],
    [
      E("server-start", "The QMD server did not start.", ""),
      { message: "The QMD server did not start.", links: ["retry"] },
    ],
    [
      E("connection"),
      { message: "Lost the connection to the QMD server.", links: ["retry"] },
    ],
    [
      E("timeout"),
      {
        message: "The search took longer than 2 minutes.",
        hint: "If QMD is still downloading its models, try again in a few minutes.",
        links: ["retry"],
      },
    ],
    [
      E("server-response", "m", "<html>"),
      {
        message: "QMD returned an unexpected response.",
        detail: "<html>",
        links: ["retry"],
      },
    ],
    [E("tool", "bad params"), { message: "bad params", links: ["retry"] }],
    [
      E("not-ready", "The vault is still being indexed for the first time."),
      {
        message: "The vault is still being indexed for the first time.",
        links: [],
      },
    ],
    [
      E("index", `collection "Main" points at another folder`),
      {
        message: `Index failed: collection "Main" points at another folder`,
        links: ["settings"],
      },
    ],
    [
      new Error("kaboom"),
      { message: "Search failed: kaboom", links: ["retry"] },
    ],
  ])("describeError %#", (err, expected) => {
    expect(describeError(err, ctx)).toEqual(expected);
  });

  it("treats an empty detail as absent", () => {
    expect(
      describeError(new QmdSearchError("qmd-not-found", "m", ""), ctx),
    ).not.toHaveProperty("detail");
  });
});
