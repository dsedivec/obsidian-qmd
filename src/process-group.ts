// Which PIDs and ports are usable, and the one function in the plugin that signals a process.
// `QmdCli` stops its commands with `signalGroup`, and it is the `killGroup` that `createServerDeps`
// gives `ServerManager`. No Node or Obsidian imports, so that `ServerManager` can use the checks.

/**
 * A PID that a spawned process can have, and so one whose group may be signalled. 0 and 1 are
 * not, and must never reach a group signal: `process.kill(-0)` signals this process's own group,
 * and `process.kill(-1)` every process the user owns.
 */
export function isUsablePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

/** A port a server can listen on. */
export function isUsablePort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
  );
}

/**
 * Sends `signal` to the process group led by `pid`. Does nothing for a PID that is not usable,
 * and nothing when there is no group left to signal.
 */
export function signalGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (!isUsablePid(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch (e) {
    // `ESRCH` is a group that is gone. macOS answers `EPERM` for a group whose only members are
    // zombies, such as a launcher that has exited and that Node has not reaped yet. Either way
    // there is nothing left to signal.
    const { code } = e as NodeJS.ErrnoException;
    if (code !== "ESRCH" && code !== "EPERM") throw e;
  }
}
