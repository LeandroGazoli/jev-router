// Turns a person did not type. Claude Code sends several kinds of machine-written prompts through
// the same path as real ones, and each reaches the router as if it were a request. Left in the
// calibration data they make the router look more (or less) sure than it is on real work, so they
// are labelled and the calibration view leaves them out. They are still routed normally.

const PATTERNS = [
  ["peer-message", /^(?:Another Claude session sent a message|<teammate-message\b)/],
  ["continuation", /^This session is being continued from a previous conversation/],
  ["suggestion", /^\[SUGGESTION MODE:/],
  ["recap", /^The user stepped away and is coming back\. Recap/],
  ["summary-request", /^CRITICAL: Respond with TEXT ONLY\. Do NOT call any tools/],
];

/** The kind of machine-written prompt this is, or null when it looks typed by a person. */
export function syntheticKind(prompt) {
  const text = typeof prompt === "string" ? prompt.trimStart() : "";
  for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) return kind;
  // A slash command run with no text of its own (/compact, /clear, a skill with no arguments).
  // With arguments, what follows is something the person wrote and the turn is real.
  const left = text
    .replace(/<(local-command-caveat|local-command-stdout|system-reminder)>[\s\S]*?<\/\1>/g, "")
    .replace(/<command-(?:message|name)>[\s\S]*?<\/command-(?:message|name)>/g, "")
    .replace(/<command-args>\s*<\/command-args>/g, "")
    .trim();
  return !left && text.includes("<command-name>") ? "command" : null;
}
