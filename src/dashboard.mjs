import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THRESHOLDS } from "./config.mjs";
import { EXPORT_FORMATS, USAGE_EXPORT_FORMATS, exportFilename } from "./export.mjs";
import { STALE_AFTER_MS, listStatuses, readLedger, readUsage } from "./status.mjs";

// The product is being renamed: this is the one place the name lives. The page and the
// sign-in screen both read it, so the rename is a single edit.
export const PRODUCT_NAME = "Jev Router";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, "dashboard.html"), "utf8").replaceAll("{{PRODUCT_NAME}}", PRODUCT_NAME);

// Lets a second launcher tell "our dashboard is already on this port" from any other local server.
export const IDENTITY_HEADER = "x-jev-dashboard";

export const randomToken = () => randomBytes(18).toString("base64url");

/** Bearer header first, falling back to the ?token= query string the page itself is opened with. */
function tokenFrom(req, url) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return url.searchParams.get("token") ?? "";
}

/** Constant-time comparison so an invalid token cannot be narrowed down by response timing. */
function tokenMatches(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Time windows the page offers for statistics and export. `all` means everything retained.
export const WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, all: null };
export const DEFAULT_WINDOW = "24h";
// The ledger itself is capped well below this, so it covers "everything retained".
const LEDGER_READ_LIMIT = 100_000;

/** `{ name, since }` for a window name (or the fallback when absent), or null when it is unknown. */
export function parseWindow(value, fallback, now = Date.now()) {
  const name = value ?? fallback;
  if (typeof name !== "string" || !Object.hasOwn(WINDOWS, name)) return null;
  return { name, since: WINDOWS[name] == null ? undefined : now - WINDOWS[name] };
}

/**
 * What the policy did with the router's pick, from the decision `reason` (see policy.decide):
 * accepted as is, changed by policy, forced by the user's own words, or no router answer at all.
 */
export function reasonFamily(reason) {
  const text = typeof reason === "string" ? reason : "";
  if (text.startsWith("override")) return "override";
  if (text.startsWith("jev-unavailable")) return "unavailable";
  if (text === "jev" || text === "jev/no-change") return "accepted";
  return "overruled";
}

/**
 * Counts for the calibration view. Confidence bands are cut at the router's own thresholds, so
 * "low" means exactly what the policy treats as low rather than a number picked for the page.
 */
export function aggregate(entries, { minConfidence, stepUpConfidence } = THRESHOLDS) {
  const byTier = {};
  const byCli = {};
  const bands = { low: 0, mid: 0, high: 0, unknown: 0 };
  const outcomes = { accepted: 0, overruled: 0, override: 0, unavailable: 0 };
  let first = null;
  let last = null;
  for (const entry of entries) {
    if (entry.tier) byTier[entry.tier] = (byTier[entry.tier] ?? 0) + 1;
    if (entry.cli) byCli[entry.cli] = (byCli[entry.cli] ?? 0) + 1;
    const confidence = entry.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) bands.unknown += 1;
    else if (confidence < minConfidence) bands.low += 1;
    else if (confidence < stepUpConfidence) bands.mid += 1;
    else bands.high += 1;
    outcomes[reasonFamily(entry.reason)] += 1;
    if (Number.isFinite(entry.at)) {
      first = first == null ? entry.at : Math.min(first, entry.at);
      last = last == null ? entry.at : Math.max(last, entry.at);
    }
  }
  return { total: entries.length, byTier, byCli, bands, outcomes, first, last };
}

const TOKEN_KINDS = ["input", "cacheRead", "cacheWrite", "output"];
const sumTokens = (entry) => TOKEN_KINDS.reduce((sum, kind) => sum + (Number(entry[kind]) || 0), 0);

/**
 * Token spend over a set of per-request usage records, in the four non-overlapping kinds the API
 * reports (see usage.mjs). `total` includes cache reads, which are the bulk of a long session but
 * are billed at a fraction of fresh input, so the kinds are kept separate rather than blended.
 */
export function aggregateUsage(entries) {
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const byTier = {};
  const byCli = {};
  const add = (into, entry) => {
    into.requests = (into.requests ?? 0) + 1;
    for (const kind of TOKEN_KINDS) into[kind] = (into[kind] ?? 0) + (Number(entry[kind]) || 0);
    into.total = (into.total ?? 0) + sumTokens(entry);
  };
  const totals = { requests: 0, total: 0 };
  for (const entry of entries) {
    add(totals, entry);
    if (entry.tier) add((byTier[entry.tier] ??= {}), entry);
    if (entry.cli) add((byCli[entry.cli] ??= {}), entry);
  }
  for (const kind of TOKEN_KINDS) sum[kind] = totals[kind] ?? 0;
  return { requests: totals.requests, total: totals.total, ...sum, byTier, byCli };
}

/**
 * A prompt as a person wrote it. Claude Code wraps some turns in machine text: the caveat and
 * output blocks around a slash command, system reminders, and notices from other sessions. Left
 * in, a `/compact` turn shows up as a paragraph of boilerplate instead of what was typed.
 */
export function promptPreview(text, max = 400) {
  if (typeof text !== "string") return undefined;
  let clean = text
    .replace(/<(local-command-caveat|local-command-stdout|system-reminder)>[\s\S]*?<\/\1>/g, "")
    .replace(/<command-(?:message|args)>[\s\S]*?<\/command-(?:message|args)>/g, "");
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(clean)?.[1]?.trim();
  clean = clean.replace(/<command-name>[\s\S]*?<\/command-name>/g, "").trim();
  clean = clean.replace(/\s+/g, " ");
  if (command) clean = clean ? `${command} ${clean}` : command;
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * The page needs a handful of fields per session, not the whole status file (which also holds
 * every recent prompt and the exact router exchange). Sending only what is shown keeps the
 * payload small and the exposure minimal. `recent` is the session's last few decisions, so a
 * session reads as a conversation rather than as its latest turn alone.
 */
function sessionView(status, usage, maxPrompt = 400) {
  const recent = (Array.isArray(status.history) ? status.history : [])
    .slice(-RECENT_TURNS)
    .map((turn) => ({
      at: turn.at,
      tier: turn.tier,
      confidence: turn.confidence,
      family: reasonFamily(turn.reason),
      prompt: promptPreview(turn.prompt, 160),
    }))
    .reverse();
  return {
    sessionId: status.sessionId,
    manual: status.manual === true,
    tier: status.tier,
    model: status.model,
    confidence: status.confidence,
    reason: status.reason,
    family: status.manual ? "manual" : reasonFamily(status.reason),
    at: status.at,
    // Last request seen, not last decision: a long tool loop makes requests without deciding.
    activeAt: Math.max(status.at ?? 0, usage?.lastAt ?? 0) || undefined,
    prompt: promptPreview(status.prompt, maxPrompt),
    tokens: usage ? { requests: usage.requests, total: usage.total, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } : undefined,
    recent,
  };
}

const RECENT_TURNS = 8;

/** Token totals and last-request time per session, from the per-request usage records. */
function usageBySession(dir, now = Date.now()) {
  const bySession = new Map();
  for (const entry of readUsage({ since: now - STALE_AFTER_MS, dir })) {
    if (!entry.session) continue;
    const into = bySession.get(entry.session) ?? { requests: 0, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, lastAt: 0 };
    into.requests += 1;
    into.total += sumTokens(entry);
    for (const kind of TOKEN_KINDS) into[kind] += Number(entry[kind]) || 0;
    into.lastAt = Math.max(into.lastAt, Number(entry.at) || 0);
    bySession.set(entry.session, into);
  }
  return bySession;
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", [IDENTITY_HEADER]: "1" });
  res.end(JSON.stringify(body));
};

/**
 * What someone sees when they open the page without a valid token. It says what is wrong and how
 * to recover, and reveals nothing about the dashboard's data or its token.
 */
const unauthorizedPage = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${PRODUCT_NAME} dashboard: link needed</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
  main { max-width: 56ch; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p, ol { margin: 0 0 12px; }
  code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; white-space: nowrap; }
</style>
</head>
<body>
<main>
  <h1>${PRODUCT_NAME}</h1>
  <p>This link is missing its access token, or the token has changed.</p>
  <ol>
    <li>In a terminal, run <code>jev-dashboard</code>.</li>
    <li>Open the link it prints.</li>
  </ol>
  <p>If the dashboard was started with <code>JEV_DASHBOARD=1</code>, its link is printed at the top of that session. Links stop working after <code>jev-dashboard --new-token</code>.</p>
</main>
</body>
</html>
`;

/**
 * A read-only HTTP server over the data proxy.mjs/codex-proxy.mjs already persist: current
 * sessions (status.listStatuses) and the durable cross-session ledger (status.readLedger).
 * Never calls askJev/llama-server -- viewing the dashboard costs nothing against the router.
 */
export async function startDashboard({ port = 0, token = randomToken(), statusDir } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!tokenMatches(tokenFrom(req, url), token)) {
      // A person opening the link by hand gets guidance; the API stays machine-readable.
      if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "missing or invalid token" });
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", [IDENTITY_HEADER]: "1" });
      return res.end(unauthorizedPage());
    }

    if (req.method !== "GET") return json(res, 404, { error: "not found" });

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", [IDENTITY_HEADER]: "1" });
      return res.end(PAGE);
    }

    if (url.pathname === "/api/sessions") {
      const usage = usageBySession(statusDir);
      // An arrow function, not .map(sessionView): map would pass the row index as an argument.
      return json(res, 200, listStatuses(statusDir).map((status) => sessionView(status, usage.get(status.sessionId))));
    }

    if (url.pathname === "/api/stats") {
      const win = parseWindow(url.searchParams.get("window"), DEFAULT_WINDOW);
      if (!win) return json(res, 400, { error: "window must be one of 1h, 24h, 7d, all" });
      const entries = readLedger({ since: win.since, limit: LEDGER_READ_LIMIT, dir: statusDir });
      return json(res, 200, {
        window: win.name,
        now: Date.now(),
        thresholds: { minConfidence: THRESHOLDS.minConfidence, stepUpConfidence: THRESHOLDS.stepUpConfidence },
        stats: aggregate(entries),
        usage: aggregateUsage(readUsage({ since: win.since, dir: statusDir })),
      });
    }

    if (url.pathname === "/api/ledger") {
      const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
      const entries = readLedger({ since, limit, dir: statusDir });
      return json(res, 200, { entries, stats: aggregate(entries) });
    }

    if (url.pathname === "/api/export") {
      const formatName = url.searchParams.get("format") ?? "csv";
      const kind = url.searchParams.get("kind") ?? "routing";
      if (kind !== "routing" && kind !== "tokens") return json(res, 400, { error: "kind must be routing or tokens" });
      const format = (kind === "tokens" ? USAGE_EXPORT_FORMATS : EXPORT_FORMATS)[formatName];
      if (!format) return json(res, 400, { error: "format must be csv or json" });
      // Without a window the whole retained ledger is exported, as before.
      const win = parseWindow(url.searchParams.get("window"), "all");
      if (!win) return json(res, 400, { error: "window must be one of 1h, 24h, 7d, all" });
      const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : win.since;
      const entries =
        kind === "tokens"
          ? readUsage({ since, limit: LEDGER_READ_LIMIT, dir: statusDir })
          : readLedger({ since, limit: LEDGER_READ_LIMIT, dir: statusDir });
      res.writeHead(200, {
        "content-type": format.type,
        "content-disposition": `attachment; filename="${exportFilename(formatName, new Date(), url.searchParams.has("window") ? win.name : undefined, kind)}"`,
        [IDENTITY_HEADER]: "1",
      });
      return res.end(format.toText(entries));
    }

    return json(res, 404, { error: "not found" });
  });

  // Reject on a listen failure (typically EADDRINUSE) so callers can tell "already running"
  // from a real fault, instead of an unhandled 'error' event taking the process down.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    token,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
