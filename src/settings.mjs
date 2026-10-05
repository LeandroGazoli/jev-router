import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_MODEL } from "./config.mjs";
import { atomicWriteFile } from "./private-fs.mjs";

export const USER_SETTINGS = join(homedir(), ".claude", "settings.json");

/**
 * The model saved as the user's default, ignoring a sentinel left behind by a session that
 * did not exit cleanly, which is not a preference worth restoring.
 */
export function readSavedModel(file = USER_SETTINGS) {
  try {
    const model = JSON.parse(readFileSync(file, "utf8")).model;
    return model === AUTO_MODEL ? undefined : model;
  } catch {
    return undefined;
  }
}

/**
 * Whether the settings file currently holds the routing sentinel as the saved default. True
 * both while a session is legitimately mid-run (it will clear this on its own exit) and after
 * one was killed hard enough to skip that -- callers that can tell the two apart (see
 * src/lock.mjs) use this to decide whether a stuck sentinel is safe to heal.
 */
export function hasStuckSentinel(file = USER_SETTINGS) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).model === AUTO_MODEL;
  } catch {
    return false;
  }
}

/**
 * Puts `previous` back if the settings file now holds the sentinel. Selecting a row with
 * Enter makes Claude Code save it as the default for new sessions, and a saved "jev-router"
 * would break plain `claude`, which has no proxy to resolve it. Anything other than an exact
 * sentinel match is left alone, so a real model chosen during the session survives.
 */
export function restoreSavedModel(previous, file = USER_SETTINGS) {
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    if (settings.model !== AUTO_MODEL) return false;
    if (previous === undefined) delete settings.model;
    else settings.model = previous;
    // Write-temp-then-rename: a process killed mid-write must never leave the user's real
    // settings file half-written, and the existing file's mode is preserved rather than reset.
    atomicWriteFile(file, `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
