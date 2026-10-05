import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listStatuses, readLedger } from "./status.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, "dashboard.html"), "utf8");

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

/** The session list is read far more often than any one session is inspected in full. */
function truncatePrompt(status, max = 200) {
  if (typeof status?.prompt !== "string" || status.prompt.length <= max) return status;
  return { ...status, prompt: `${status.prompt.slice(0, max)}…` };
}

function aggregate(entries) {
  const byTier = {};
  const byCli = {};
  for (const entry of entries) {
    if (entry.tier) byTier[entry.tier] = (byTier[entry.tier] ?? 0) + 1;
    if (entry.cli) byCli[entry.cli] = (byCli[entry.cli] ?? 0) + 1;
  }
  return { total: entries.length, byTier, byCli };
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * A read-only HTTP server over the data proxy.mjs/codex-proxy.mjs already persist: current
 * sessions (status.listStatuses) and the durable cross-session ledger (status.readLedger).
 * Never calls askJev/llama-server -- viewing the dashboard costs nothing against the router.
 */
export async function startDashboard({ port = 0, token = randomToken(), statusDir } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!tokenMatches(tokenFrom(req, url), token)) {
      return json(res, 401, { error: "missing or invalid token" });
    }

    if (req.method !== "GET") return json(res, 404, { error: "not found" });

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }

    if (url.pathname === "/api/sessions") {
      return json(res, 200, listStatuses(statusDir).map(truncatePrompt));
    }

    if (url.pathname === "/api/ledger") {
      const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
      const entries = readLedger({ since, limit, dir: statusDir });
      return json(res, 200, { entries, stats: aggregate(entries) });
    }

    return json(res, 404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    token,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
