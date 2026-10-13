import { describe, expect, it, vi } from "vitest";
import { createCliHandler, formatCliText, parseLimit } from "../src/cli-handler";

const r1 = { path: "Projects/Platform/EKS plan.md", title: "EKS plan", folder: "Projects/Platform", line: 42, score: 0.88, snippet: "Move workloads off node instance profiles." };
const r2 = { path: "AWS IAM.md", title: "AWS IAM", folder: "", line: 7, score: 0.71, snippet: "A trust policy says who can assume the role." };
const make = (search = vi.fn(async (_text: string, _limit: number) => [r1, r2])) => ({ search, handler: createCliHandler({ search, getDefaultLimit: () => 10, describe: (e) => (e as Error).message }) });

describe("cli-handler", () => {
  it("formats text output", () => {
    expect(formatCliText([r1, r2])).toBe(
      "Projects/Platform/EKS plan.md:42  (88%)\n  Move workloads off node instance profiles.\n\nAWS IAM.md:7  (71%)\n  A trust policy says who can assume the role.");
    expect(formatCliText([])).toBe("No results.");
  });
  it("parses limit", () => {
    expect([parseLimit(undefined, 10), parseLimit("5", 10), parseLimit("50", 10)]).toEqual([10, 5, 50]);
    for (const bad of ["0", "51", "abc", "2.5", "-1", ""]) expect(() => parseLimit(bad, 10)).toThrow("limit must be a whole number from 1 to 50");
  });
  it("searches with the default limit and prints text", async () => {
    const { search, handler } = make();
    expect(await handler({ query: "pod" })).toBe(formatCliText([r1, r2]));
    expect(search).toHaveBeenCalledWith("pod", 10);
  });
  it("trims the query", async () => {
    const { search, handler } = make();
    await handler({ query: "  pod  " });
    expect(search).toHaveBeenCalledWith("pod", 10);
  });
  it("honours limit and json", async () => {
    const { search, handler } = make();
    expect(JSON.parse(await handler({ query: "pod", limit: "3", json: "true" }))).toEqual([r1, r2]);
    expect(search).toHaveBeenCalledWith("pod", 3);
    expect(await make(vi.fn(async () => [])).handler({ query: "pod", json: "true" })).toBe("[]");
  });
  it("reports problems as Error lines without searching", async () => {
    const { search, handler } = make();
    expect(await handler({})).toBe("Error: query is required");
    expect(await handler({ query: "   " })).toBe("Error: query is required");
    expect(await handler({ query: "pod", limit: "99" })).toBe("Error: limit must be a whole number from 1 to 50");
    expect(search).not.toHaveBeenCalled();
  });
  it("reports a failed search", async () => {
    const { handler } = make(vi.fn(async () => { throw new Error("The vault is still being indexed for the first time."); }));
    expect(await handler({ query: "pod" })).toBe("Error: The vault is still being indexed for the first time.");
  });
});
