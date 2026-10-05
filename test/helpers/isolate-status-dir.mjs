// Loaded with `node --import` by `npm test`. Points the status/ledger directory at a throwaway
// temp directory so the suite never writes fake sessions or routing decisions into the real
// one that jev-claude, jev-codex and jev-dashboard use. node --test runs each test file in its
// own process and passes --import along, so every file gets its own isolated directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jev-test-status-"));
process.env.JEV_STATUS_DIR = dir;
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of a temp directory.
  }
});
