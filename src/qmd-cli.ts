import { spawn, type ChildProcess } from "node:child_process";
import { buildPath } from "./config";

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
}

const KILL_GRACE_MS = 2000;

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

export class QmdCli {
  private readonly running = new Set<ChildProcess>();

  constructor(private readonly getConfig: () => { qmdPath: string; extraPath: string }) {}

  env(): NodeJS.ProcessEnv {
    const { qmdPath, extraPath } = this.getConfig();
    return { ...process.env, PATH: buildPath(qmdPath, extraPath, process.env.PATH) };
  }

  run(args: string[], opts: { timeoutMs: number }): Promise<CliResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let errorCode: string | undefined;
      let exited = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(this.getConfig().qmdPath, args, {
        env: this.env(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.running.add(child);

      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        this.running.delete(child);
        resolve({ code, stdout, stderr, timedOut, ...(errorCode ? { errorCode } : {}) });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        signalGroup(child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (!exited) signalGroup(child, "SIGKILL");
        }, KILL_GRACE_MS);
      }, opts.timeoutMs);

      child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (e: NodeJS.ErrnoException) => {
        errorCode = e.code;
        finish(null);
      });
      child.on("exit", () => {
        exited = true;
      });
      child.on("close", (code) => finish(code));
    });
  }

  killAll(): void {
    for (const child of this.running) signalGroup(child, "SIGTERM");
  }
}
