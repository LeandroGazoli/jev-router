import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_HEADER, randomToken, startDashboard } from "./dashboard.mjs";
import { ensurePrivateDir, writePrivateFile } from "./private-fs.mjs";
import { STATUS_DIR } from "./status.mjs";

const TOKEN_FILE = "dashboard.token";
export const DEFAULT_DASHBOARD_PORT = 8787;

/**
 * The dashboard's access token, persisted in the private status directory so the link stays the
 * same across restarts and can be bookmarked. It is a long-lived credential for reading routed
 * prompts, hence the same 0600/0700, symlink-checked storage as the status files. `rotate`
 * replaces it, which invalidates every previously shared link.
 */
export function dashboardToken({ dir = STATUS_DIR, rotate = false } = {}) {
  ensurePrivateDir(dir);
  const file = join(dir, TOKEN_FILE);
  if (!rotate && existsSync(file) && !lstatSync(file).isSymbolicLink()) {
    const saved = readFileSync(file, "utf8").trim();
    if (/^[\w-]{16,}$/.test(saved)) return saved;
  }
  const token = randomToken();
  writePrivateFile(dir, TOKEN_FILE, token);
  return token;
}

/** The command that opens `url` in the default browser, or null if the URL is not ours. */
export function openCommand(url, platform = process.platform) {
  // The URL is always http://127.0.0.1:<port>/?token=<base64url>; refuse anything else so
  // nothing unexpected ever reaches a shell (`start` goes through cmd.exe on Windows).
  if (!/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/.test(url)) return null;
  if (platform === "win32") return { file: "cmd", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { file: "open", args: [url] };
  return { file: "xdg-open", args: [url] };
}

export function openBrowser(url) {
  const command = openCommand(url);
  if (!command) return false;
  try {
    const child = spawn(command.file, command.args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no browser/opener available: the printed link still works
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the dashboard, or recognises that one is already serving on the port. With the stable
 * token the already-running instance accepts the very same link, so a second `jev-claude` or
 * `jev-dashboard` simply reuses it instead of failing.
 *
 * @returns {Promise<{url: string, close: () => void, alreadyRunning: boolean}>}
 */
export async function launchDashboard({
  port = Number(process.env.JEV_DASHBOARD_PORT ?? DEFAULT_DASHBOARD_PORT),
  open = false,
  rotate = false,
  statusDir,
} = {}) {
  const dir = statusDir ?? STATUS_DIR;
  // A rotated token is only a candidate until the server is actually listening with it: if the
  // port turns out to be taken, the saved token must stay in step with the dashboard holding it.
  const token = rotate ? randomToken() : dashboardToken({ dir });
  let handle = null;
  try {
    handle = await startDashboard({ port, token, statusDir });
  } catch (err) {
    if (err.code !== "EADDRINUSE") throw err;
    if (rotate) {
      throw new Error(
        `port ${port} is already in use by a running dashboard that still accepts the old token; stop it before rotating`,
      );
    }
  }
  if (rotate) writePrivateFile(dir, TOKEN_FILE, token);
  const url = `http://127.0.0.1:${handle?.port ?? port}/?token=${token}`;
  if (!handle) {
    // Something holds the port. Only call it "already running" if it really is a dashboard that
    // accepts this token; otherwise the printed link would be a dead end.
    const reachable = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(
      (res) => res.ok && res.headers.get(IDENTITY_HEADER) === "1",
      () => false,
    );
    if (!reachable) {
      throw new Error(`port ${port} is in use by something that is not this dashboard (or uses another token)`);
    }
  }
  if (open) openBrowser(url);
  return { url, close: handle?.close ?? (() => {}), alreadyRunning: handle == null };
}
