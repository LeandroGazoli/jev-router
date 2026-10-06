import {
  appendFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, FILE_MODE, privateDirPath, writePrivateFile } from "./private-fs.mjs";

// One file per session rather than a shared map, so concurrent jev-claude sessions can never
// clobber each other's status. Kept in the temp dir so the OS eventually cleans up.
// JEV_STATUS_DIR relocates it; `npm test` uses that to keep test traffic out of the real one.
const DIR = process.env.JEV_STATUS_DIR || privateDirPath("jev-claude");

// Files not updated for this long belong to finished sessions and are removed.
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
let pruned = false;

const fileFor = (sessionId) => join(DIR, `${sessionId.replace(/[^\w-]/g, "")}.json`);

/** Publish the latest routing decision so the status line can display it. */
export function writeStatus(sessionId, status) {
  if (!sessionId) return;
  try {
    writePrivateFile(DIR, `${sessionId.replace(/[^\w-]/g, "")}.json`, JSON.stringify(status));
    if (!pruned) {
      pruned = true;
      pruneStale();
    }
  } catch {
    // Status display is cosmetic and must never interfere with a request.
  }
}

/** Publish a routed prompt and retain recent exact Jev exchanges for diagnosis. */
export function writeDecision(sessionId, decision) {
  const previous = readStatus(sessionId);
  const history = [...(previous?.history ?? []), decision].slice(-20);
  writeStatus(sessionId, { ...decision, history });
}

/** Latest routing decision for a session, or null if none has been made yet. */
export function readStatus(sessionId) {
  try {
    return JSON.parse(readFileSync(fileFor(sessionId), "utf8"));
  } catch {
    return null;
  }
}

/** Delete status files untouched for `maxAgeMs`. Runs once per process on the first write. */
export function pruneStale(maxAgeMs = STALE_AFTER_MS, now = Date.now()) {
  let removed = 0;
  try {
    for (const name of readdirSync(DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = join(DIR, name);
      try {
        if (now - statSync(file).mtimeMs > maxAgeMs) {
          unlinkSync(file);
          removed++;
        }
      } catch {
        // Another session may have removed or replaced it; ignore.
      }
    }
  } catch {
    // Missing or unreadable directory: nothing to prune.
  }
  return removed;
}

/** Directory holding status files, exposed for tests and diagnostics. */
export const STATUS_DIR = DIR;

// --- Dashboard support: a durable ledger plus a listing of current sessions. Both are
// read-only from the dashboard's point of view -- nothing here ever calls askJev. ---

// ".jsonl" names, not ".json", so pruneStale's `.json`-only filter above never deletes them.
const LEDGER_NAME = "routing.jsonl";
const USAGE_NAME = "usage.jsonl";
const SIGNALS_NAME = "signals.jsonl";
const MAX_LEDGER_LINES = 20000;
// One line per upstream request rather than per turn, so it fills faster than the ledger.
const MAX_USAGE_LINES = 50000;
const ledgerFile = (dir) => join(dir, LEDGER_NAME);
const usageFile = (dir) => join(dir, USAGE_NAME);
const signalsFile = (dir) => join(dir, SIGNALS_NAME);
const writes = new Map();

function appendLine(file, dir, entry, maxLines) {
  try {
    ensurePrivateDir(dir);
    const firstWrite = !existsSync(file);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, firstWrite ? { mode: FILE_MODE } : undefined);
    if (firstWrite) chmodSync(file, FILE_MODE);
    const count = (writes.get(file) ?? 0) + 1;
    writes.set(file, count);
    // Rotation is checked occasionally, not on every write, since it means reading the whole
    // file back.
    if (count % 200 === 0) rotateLedgerIfLarge(file, maxLines);
  } catch {
    // Best-effort telemetry; must never interfere with a request.
  }
}

function readLines(file, { since, limit }) {
  let entries;
  try {
    entries = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
  const filtered = since == null ? entries : entries.filter((entry) => (entry.at ?? 0) >= since);
  return filtered.slice(-limit);
}

/**
 * Appends one routing decision to a durable, cross-session ledger, deliberately without the
 * prompt text that the per-session status file carries for /jev-explain -- this file is meant
 * to live much longer (across sessions and restarts), so it carries less. Used by the
 * dashboard for aggregate stats; never read by the router itself.
 */
export function appendRouting(entry, dir = DIR) {
  appendLine(ledgerFile(dir), dir, entry, MAX_LEDGER_LINES);
}

/**
 * Appends the tokens one upstream request used, as the API reported them. Kept apart from the
 * routing ledger because it has a different grain (every request, including each step of a tool
 * loop, not one row per turn) and the calibration view reads the ledger as "one row = one
 * decision". Like the ledger it carries no prompt text.
 */
export function appendUsage(entry, dir = DIR) {
  appendLine(usageFile(dir), dir, entry, MAX_USAGE_LINES);
}

/**
 * Appends a moment where the person acted on a routing decision, such as switching model by hand
 * after the router had chosen one. These are the only evidence the ledger has that a decision was
 * wrong, which the router's own confidence cannot say. No prompt text.
 */
export function appendSignal(entry, dir = DIR) {
  appendLine(signalsFile(dir), dir, entry, MAX_LEDGER_LINES);
}

/** Keeps only the last `maxLines` lines of a ledger file. Exposed for testing. */
export function rotateLedgerIfLarge(file, maxLines = MAX_LEDGER_LINES) {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length <= maxLines) return;
    const kept = lines.slice(-maxLines);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${kept.join("\n")}\n`, { mode: FILE_MODE });
    renameSync(tmp, file);
  } catch {
    // An oversized ledger is not worse than one rotation failing; keep going either way.
  }
}

/** Parsed ledger entries whose `at` is >= `since` (when given), oldest first, capped at `limit`. */
export function readLedger({ since, limit = 1000, dir = DIR } = {}) {
  return readLines(ledgerFile(dir), { since, limit });
}

/** Same shape as readLedger, for the person's reactions to decisions. */
export function readSignals({ since, limit = 100000, dir = DIR } = {}) {
  return readLines(signalsFile(dir), { since, limit });
}

/** Same shape as readLedger, for the per-request token records. */
export function readUsage({ since, limit = 100000, dir = DIR } = {}) {
  return readLines(usageFile(dir), { since, limit });
}

/** Every session's latest status, newest first -- the dashboard's "active sessions" list. */
export function listStatuses(dir = DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && name !== "settings.json")
    .map((name) => {
      try {
        return { sessionId: name.slice(0, -".json".length), ...JSON.parse(readFileSync(join(dir, name), "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
