import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "./private-fs.mjs";

// A hard kill (taskkill /F, Task Manager "End Task", SIGKILL, power loss) cannot be intercepted
// by any process, on any platform -- that is what "hard" means. Nothing here changes that. What
// this *can* do is let the next session notice a sentinel a killed session left stuck in the
// user's real settings.json and safely clean it up, instead of it staying broken until someone
// notices `claude` itself no longer works.
const LOCK_NAME = "jev-claude.lock";

/** Whether `pid` still identifies a running process. Signal 0 is portable: it sends nothing, it
 * only checks. */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Marks this process as the one holding the routing session, for the staleness check below. */
export function acquireLock(dir) {
  try {
    writePrivateFile(dir, LOCK_NAME, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  } catch {
    // Best-effort: a failed lock only degrades staleness detection, never blocks a request.
  }
}

/** Releases this process's own lock. Never removes a lock another process still holds. */
export function releaseLock(dir) {
  try {
    const file = join(dir, LOCK_NAME);
    const { pid } = JSON.parse(readFileSync(file, "utf8"));
    if (pid === process.pid) unlinkSync(file);
  } catch {
    // Already gone, replaced by another session, or never created; nothing to do.
  }
}

/**
 * Whether a previous session's lock is stale -- missing, unreadable, or naming a pid that is no
 * longer running -- and so it is safe to clean up whatever that session left behind.
 */
export function isLockStale(dir) {
  try {
    const { pid } = JSON.parse(readFileSync(join(dir, LOCK_NAME), "utf8"));
    return typeof pid !== "number" || !isPidAlive(pid);
  } catch {
    // No lock file at all: nothing is stale because nothing was ever claimed.
    return true;
  }
}
