import http from "node:http";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { THRESHOLDS, availableTiers, shouldUseExactModel } from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { appendRouting, appendSignal, appendUsage, writeDecision, writeStatus } from "./status.mjs";
import { syntheticKind } from "./synthetic.mjs";
import { tapResponse } from "./usage.mjs";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const API_BASE_URL = "https://api.openai.com/v1";
export const CODEX_AUTO_MODEL = "jev-router";
const DEFAULT_MODELS = {
  haiku: "gpt-5.6-luna",
  sonnet: "gpt-5.6-terra",
  opus: "gpt-5.6-sol",
  fable: "gpt-6-astra",
};
const MODEL_ENV = {
  haiku: "JEV_CODEX_FAST_MODEL",
  sonnet: "JEV_CODEX_BALANCED_MODEL",
  opus: "JEV_CODEX_STRONG_MODEL",
  fable: "JEV_CODEX_LONG_MODEL",
};

export const codexModelOf = (tier) => process.env[MODEL_ENV[tier]] ?? DEFAULT_MODELS[tier];

export function codexTierOf(model) {
  const configured = Object.keys(DEFAULT_MODELS).find((tier) => codexModelOf(tier) === model);
  if (configured) return configured;
  if (/(?:astra|fable|long)/i.test(model ?? "")) return "fable";
  if (/(?:sol|opus|strong|max|pro)/i.test(model ?? "")) return "opus";
  if (/(?:luna|haiku|fast|mini|nano)/i.test(model ?? "")) return "haiku";
  return /^gpt-/i.test(model ?? "") ? "sonnet" : null;
}

/**
 * One Jev candidate per tier, built from the configured (or default) model id for that tier --
 * never from the account catalog alone. A model configured via JEV_CODEX_*_MODEL that has not
 * propagated to the account's catalog yet (or belongs to a different account) must still be a
 * candidate Jev can choose; filtering candidates down to whatever the catalog happens to list
 * silently made such a configured model invisible to the router. The catalog is only consulted
 * here for a nicer description when it does have a matching entry.
 */
export function codexModels(models = new Map()) {
  return Object.keys(DEFAULT_MODELS).map((tier) => {
    const id = codexModelOf(tier);
    const info = models.get(id);
    const description = info
      ? [info.display_name, info.description, info.context_window && `${info.context_window} context tokens`]
          .filter(Boolean)
          .join("; ") || id
      : id;
    return { id, tier, description };
  });
}

const modelForTier = (models, tier) =>
  models.find((model) => model.tier === tier)?.id ?? codexModelOf(tier);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text")
    .map((item) => item.text)
    .join("\n");
};

const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();

export const isCodexAuxiliaryPrompt = (prompt) =>
  /^Generate a concise, single-line task title\b/i.test(prompt);

/** User text that starts a new Codex turn, or null for tool continuations. */
export function codexNewTurnPrompt(body) {
  if (!Array.isArray(body?.input)) return null;
  if (!body.input.some((item) => item?.type === "additional_tools")) return null;
  for (const item of [...body.input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const prompt = cleanPrompt(textOf(item.content));
    if (prompt && !isCodexAuxiliaryPrompt(prompt)) return prompt;
  }
  return null;
}

export function codexConversationKey(body) {
  const stable =
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

export function addJevModel(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.some((model) => model.slug === CODEX_AUTO_MODEL)) {
    return catalog;
  }
  const template =
    catalog.models.find((model) => model.slug === codexModelOf("sonnet")) ??
    catalog.models.find((model) => model.visibility === "list") ??
    catalog.models[0];
  if (!template) return catalog;
  catalog.models.unshift({
    ...template,
    slug: CODEX_AUTO_MODEL,
    display_name: "Jev Router",
    description: "Jev picks the cheapest model that can complete each turn.",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    upgrade: null,
  });
  return catalog;
}

export function applyCodexTier(body, tier, models = new Map(), model = codexModelOf(tier)) {
  body.model = model;
  const info = models.get(model);
  const efforts = info?.supported_reasoning_levels?.map((level) => level.effort);
  if (body.reasoning?.effort && efforts?.length && !efforts.includes(body.reasoning.effort)) {
    body.reasoning.effort = info.default_reasoning_level;
  }
  return body;
}

export const upstreamFor = (
  headers,
  path = "",
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
) => /\/models(?:\?|$)/.test(path) || headers["chatgpt-account-id"] ? chatgptBaseURL : apiBaseURL;

export function jevDecisionEvents({ tier, model = codexModelOf(tier), confidence, reason }) {
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const id = `jev-${randomUUID()}`;
  const text = reason.startsWith("jev-unavailable")
    ? `[Jev] unavailable; using ${model}. Check that llama-server is running (JEV_LOCAL_URL).`
    : `[Jev] routed this turn to ${model} (${detail}).`;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  const events = [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const debug = (line) => process.env.JEV_DEBUG && log(line);
const upstreamPath = (base, path) => `${new URL(base).pathname.replace(/\/$/, "")}${path}`;

export async function startCodexProxy({
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
  route = askJev,
  statusId = "",
} = {}) {
  const states = new Map();
  const models = new Map();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing;
      // Who a request's token usage is filed under; set once the request is understood.
      let usageFor = null;
      let convoKey = null;
      if (req.method === "POST" && /\/responses(?:\?|$)/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          if (body.model === CODEX_AUTO_MODEL) {
            const key = codexConversationKey(body);
            const candidates = codexModels(models).filter((model) =>
              availableTiers().includes(model.tier),
            );
            const available = [...new Set(candidates.map((model) => model.tier))];
            // Same first-turn guard as the Claude proxy: no tier has been fixed for this
            // conversation yet, so the opening message's size must not trip the downgrade
            // guard below and pin every new conversation to the "opus" default.
            const noTierYet = !states.has(key);
            const currentModel = states.get(key)?.model ?? modelForTier(candidates, "opus");
            const current = codexTierOf(currentModel) ?? "opus";
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            let tier = current;
            let model = currentModel;
            if (prompt && !explaining) {
              // The size the API reported for the previous request is the real one so far.
              const contextTokens = Math.max(
                Math.round(JSON.stringify(body.input).length / 4),
                states.get(key)?.realContext ?? 0,
              );
              // Idle longer than the provider keeps its cache: nothing left to protect from a downgrade.
              const cacheWarm = Date.now() - (states.get(key)?.lastAt ?? 0) < THRESHOLDS.cacheTtlMs;
              const jev = await route({ prompt, current: currentModel, contextTokens, models: candidates });
              const chosen = candidates.find((candidate) => candidate.id === jev?.choice);
              const decision = decide({
                prompt,
                jev: jev && { ...jev, choice: chosen?.tier },
                current,
                available,
                contextTokens: noTierYet ? 0 : contextTokens,
                cacheWarm,
              });
              tier = decision.tier;
              model =
                shouldUseExactModel(decision.reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : modelForTier(candidates, tier);
              states.set(key, { tier, model, decidedAt: Date.now(), realContext: states.get(key)?.realContext });
              routing = {
                prompt,
                tier,
                model,
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                reason: decision.reason,
                jev: jev ? { request: jev.request, response: jev.response } : null,
                at: Date.now(),
              };
              writeDecision(statusId, routing);
              // Durable, cross-session record for the dashboard -- deliberately without the
              // prompt text or the exact Jev exchange that the status file above carries.
              appendRouting({
                at: routing.at,
                cli: "codex",
                key,
                tier,
                model,
                confidence: routing.confidence,
                reason: routing.reason,
                metrics: routing.metrics,
                ...(syntheticKind(prompt) && { synthetic: syntheticKind(prompt) }),
              });
              debug(`${key} ${current} -> ${tier} (${decision.reason}) | ${prompt.slice(0, 60)}`);
            }
            applyCodexTier(body, tier, models, model);
            const seen = states.get(key);
            if (seen) seen.lastAt = Date.now();
            convoKey = key;
          } else {
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            if (prompt && !explaining) {
              writeStatus(statusId, { manual: true, at: Date.now() });
              // Same signal as the Claude proxy: a tier the router chose, then a model picked by hand.
              const prior = states.get(codexConversationKey(body));
              const to = codexTierOf(body.model);
              if (prior?.tier && !prior.switched && to && to !== prior.tier) {
                prior.switched = true;
                const at = Date.now();
                appendSignal({
                  at,
                  cli: "codex",
                  kind: "manual-switch",
                  key: codexConversationKey(body),
                  from: prior.tier,
                  to,
                  afterMs: prior.decidedAt ? at - prior.decidedAt : null,
                });
              }
            }
          }
          out = Buffer.from(JSON.stringify(body));
          // `body.model` is the model that goes upstream, whether routed or chosen by the user.
          usageFor = {
            session: statusId || "codex",
            convoKey,
            tier: routing?.tier ?? codexTierOf(body.model),
            model: body.model,
            routed: routing != null,
          };
        } catch (err) {
          debug(`codex passthrough, could not process body: ${err.message}`);
        }
      }

      const base = upstreamFor(req.headers, req.url, chatgptBaseURL, apiBaseURL);
      const target = new URL(base);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: upstreamPath(base, req.url ?? "/"),
          method: req.method,
          headers,
        },
        (response) => {
          const responseHeaders = { ...response.headers };
          const isModels = req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const body = [];
            response.on("data", (chunk) => body.push(chunk));
            response.on("end", () => {
              let data = Buffer.concat(body);
              try {
                const catalog = addJevModel(JSON.parse(data.toString()));
                for (const model of catalog.models) models.set(model.slug, model);
                data = Buffer.from(JSON.stringify(catalog));
                delete responseHeaders["content-length"];
              } catch (err) {
                debug(`could not extend Codex model catalog: ${err.message}`);
              }
              res.writeHead(response.statusCode, responseHeaders);
              res.end(data);
            });
            return;
          }

          if (usageFor && response.statusCode >= 200 && response.statusCode < 300) {
            tapResponse(response, ({ tokens, model }) => {
              const state = usageFor.convoKey ? states.get(usageFor.convoKey) : null;
              if (state) state.realContext = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.output ?? 0);
              appendUsage({
                at: Date.now(),
                cli: "codex",
                session: usageFor.session,
                key: usageFor.convoKey ?? undefined,
                tier: usageFor.tier ?? codexTierOf(model) ?? null,
                model: model ?? usageFor.model,
                routed: usageFor.routed,
                ...tokens,
              });
            });
          }
          const inspectForDecision = routing && response.statusCode >= 200 && response.statusCode < 300;
          if (inspectForDecision) delete responseHeaders["content-length"];
          res.writeHead(response.statusCode, responseHeaders);
          if (!inspectForDecision) {
            response.pipe(res);
            return;
          }
          // Decode with the stream's own stateful UTF-8 decoder rather than chunk.toString()
          // per chunk: a multi-byte character (accents, Arabic, emoji) can land split across
          // two HTTP chunks, and decoding each chunk in isolation turns the split bytes into
          // replacement characters. setEncoding keeps any trailing incomplete sequence buffered
          // until the next chunk completes it.
          response.setEncoding("utf8");
          let pending = "";
          let inspected = false;
          response.on("data", (chunk) => {
            if (inspected) return void res.write(chunk);
            pending += chunk;
            const end = pending.indexOf("\n\n");
            if (end < 0) return;
            const first = pending.slice(0, end + 2);
            res.write(first);
            const isSSE = /^(?:event|data):/m.test(first);
            if (isSSE) res.write(jevDecisionEvents(routing));
            debug(`codex decision display ${isSSE ? "inject" : "skip"}`);
            res.write(pending.slice(end + 2));
            pending = "";
            inspected = true;
          });
          response.on("end", () => {
            if (pending) {
              debug("codex decision display skip");
              res.write(pending);
            }
            res.end();
          });
        },
      );
      upstream.on("error", (err) => {
        debug(`codex upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // server.close() alone waits for in-flight keep-alive connections to end on their own; a
  // connection still open when the Codex CLI exits would otherwise leave this process hanging.
  return {
    port: server.address().port,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
