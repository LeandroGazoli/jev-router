# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Open-source users: developers who run coding CLIs (Claude Code, OpenAI Codex) and find the project through GitHub or npm, without ever having met the author. The product has to explain itself to a stranger; nobody is on hand to walk them through it.

The person who opens the dashboard is the same developer who runs the CLI, on their own machine, looking at their own routing. Their jobs, all confirmed:

- see what is happening now: which model each session is using and with what confidence, without spending the routing model to find out;
- calibrate the routing thresholds (confidence, risk floor, step-up, downgrade cutoff) from how decisions actually distribute;
- control cost: understand how much of their use went to the cheap, balanced and strong tiers;
- export the decision history for analysis elsewhere.

## Product Purpose

Run a coding CLI normally while every fresh turn is silently sent to the cheapest model that can handle it, instead of the user choosing a model by hand or paying for the strongest one all the time. The CLI keeps its own interface, tools, sessions, permissions and authentication; the router only picks the model.

The routing decision comes from a small model that runs locally (JevK5 through llama-server), so no prompt text leaves the machine to be classified. The dashboard exists to make that decision-making observable and tunable, not to operate the CLI.

Success: a user can trust the routing because they can see it, adjust it with evidence, and take the data elsewhere.

## Positioning

A fork of gargpratyush/jev-router, which the original author appears to have abandoned, now maintained independently. What a neighbouring router could not truthfully copy: the decision runs on the user's own hardware (no API key, no prompt leaves the machine), it works through the CLIs' existing subscriptions rather than separate API billing, and it ships its own local, read-only observability.

## Operating Context

- The product is primarily a command-line tool. `jev-claude` and `jev-codex` wrap the real CLIs through a loopback proxy; `jev-explain` prints a text report of the last decision; `jev-dashboard` is the only visual surface.
- The dashboard is a local web page served on 127.0.0.1, opened through a link that carries an access token. It can be started on its own, or alongside a session with `JEV_DASHBOARD=1`. It is only available while its process runs.
- Data comes from files the proxies already write: one status file per session (current decision, prompt, short history) and a durable ledger of decisions (`routing.jsonl`, no prompt text). The dashboard never calls the router.
- Users are usually mid-task in a terminal and glance at the dashboard in a browser tab or second monitor; it must read at a glance and stay accurate while data updates every few seconds.

## Capabilities and Constraints

- Tiers: haiku (fast), sonnet (balanced), opus (strong), and an opt-in long tier. Codex maps the same tiers to its own models.
- Per decision the ledger holds: time, CLI, tier, model, confidence, reason (why policy accepted or overruled the model's pick), three complexity scores, context size, conversation id. It does not hold token counts or prices, so the dashboard can show how decisions distribute across tiers but cannot state money spent or saved. Do not present cost figures the data cannot support.
- Confidence is the probability of the chosen option, not a distribution-concentration measure; interface wording must not imply more than that.
- The dashboard is read-only and token-protected, loopback only. Prompt text appears in session views but never in the ledger or exports.
- Export is CSV or JSON of the ledger, in the browser or with `jev-dashboard --export`.
- Windows, macOS and Linux are all in scope; the author develops on Windows.
- Zero runtime dependencies today; the dashboard is a single static page with no build step.
- Interface language is English today; whether to localise is undecided.
- The product is being renamed. The new name is not yet chosen, so "Jev Router" appears everywhere today and must be treated as a placeholder to replace, not a brand to build on.

## Brand Commitments

None binding yet beyond the decision to leave the original project's name behind. Open decision: the new name and any identity that goes with it.

## Evidence on Hand

- A real decision ledger from the author's own use (a few dozen routed turns, Portuguese and English prompts). Enough to demonstrate the dashboard; not enough to make claims about savings or accuracy.
- No testimonials, benchmarks, customer counts, cost-saving figures or screenshots of other people's use exist. Future work must not invent any.

## Product Principles

1. **Looking is free.** Observing the router must never consume the router. Anything on the dashboard comes from data already on disk.
2. **Prompts are private by default.** Durable and shareable artefacts (ledger, exports) carry no prompt text; anything that does is protected and local.
3. **Calibrate from evidence.** Thresholds are tuned from recorded decisions, so the interface should make distributions and outliers easy to see, not just a feed of events.
4. **Say only what the data supports.** No cost, savings or accuracy claims the ledger cannot back; show confidence as what it is.
5. **A stranger can use it unaided.** Install, start, find the link and read the page without the author present.

## Accessibility & Inclusion

No product-specific standard established. The audience is international open-source developers, so the interface must not depend on colour alone to carry tier or status, and must respect the user's light/dark preference.
