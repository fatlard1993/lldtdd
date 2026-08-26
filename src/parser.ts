import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import type { LLDDocument, LLDGroup, RawAssertion, ScenarioStep } from "./types.ts";
import { isContained } from "./pathContainment.ts";

const ARROW = "→";
const REPEAT_PREFIX = /^(\d+)\s*[×x]\s*/i;
// One step of a capture chain: a call expression, `captures <name>`, then either a joiner
// (`and`/`then`) or the end of the condition.
//
// Iterating this replaces the old fixed-arity pair of regexes (one for a single capture, one for
// exactly two). Arity was a limit nobody chose: claims about ordering routinely need three steps
// -- "subscribe a throwing handler, subscribe a spy, publish" -- and the two-call ceiling meant
// those claims had no expressible form and stayed pending. Consuming one step at a time also
// handles args containing the joiner words, since each step is anchored by its own
// `captures <name>` rather than by splitting the whole string on " and ".
//
// `and` and `then` are interchangeable to the parser; the distinction is for the reader. Later
// calls may reference earlier captures by name, because each capture is in scope by the time the
// next call is emitted.
const CHAIN_STEP = /^(.+?)\s+captures\s+(\w+)(?:\s+(?:and|then)\s+|$)/i;

export async function parseFile(filePath: string, root?: string): Promise<LLDDocument> {
  return parse(await readFile(filePath, "utf-8"), filePath, root);
}

/** Resolves a module pointer (`> src/x.ts`, `**module:**`, `**companion:**`) and refuses one that
 *  lands outside the project.
 *
 *  Without the check, an absolute pointer discards `root` entirely -- resolve ignores every
 *  segment before an absolute one -- and a relative pointer climbs out with enough `..`. The
 *  resolved path is later read by lint and suggest, and the pre-commit hook runs lint on its own,
 *  so "lint does not leave the project" was true only by convention of the corpus. This makes it
 *  a property of the resolver.
 *
 *  Contained means inside `root`, or inside the document's own directory. The second base exists
 *  because a linted document may itself live outside root -- the linter's temp-dir fixtures do --
 *  and a `./` pointer to the module beside it is exactly the read the caller asked for. Whenever the
 *  document sits inside root, its directory adds nothing and root is the whole boundary.
 *
 *  Containment follows symlinks (see isContained). A module pointer is a read into a document's repo,
 *  and that document may not be the reader's own -- lint runs on documents you did not write, and the
 *  pre-commit hook runs lint. A committed symlink whose lexical path stays inside root but whose
 *  target is `/etc/...` is exactly the escape a reviewer of the `.lld.md` cannot see, so the boundary
 *  is on where the path actually leads, not on how it is spelled. */
function resolveModulePointer(raw: string, docDir: string, root: string): string {
  const resolved = raw.startsWith("./") || raw.startsWith("../")
    ? resolve(docDir, raw)
    : resolve(root, raw);
  if (!isContained(resolved, [resolve(root), docDir])) {
    throw new Error(`module pointer \`${raw}\` resolves to ${resolved}, outside the project root ${root}; refusing to read it`);
  }
  return resolved;
}

/** `root` is the project root that a non-relative module pointer resolves against; `./x` and
 *  `../x` always resolve relative to the document instead.
 *
 *  It defaults to `process.cwd()`, which is what the CLI wants, but it must stay a parameter.
 *  Hardcoding it makes the `cwd` argument on `runAndCheck` a half-truth: a library caller could
 *  point the runner at another directory, watch it find the documents there, and then watch every
 *  module pointer inside them resolve against this process's directory instead, so every claim
 *  comes back pending and the run passes, which is the worst way to be wrong. */
export function parse(content: string, sourcePath: string, root: string = process.cwd()): LLDDocument {
  // Normalize the ASCII arrow to the unicode one before anything reads a claim. This lives here
  // rather than in parseFile because every document in the wild is written with `->`: when only
  // the file path normalized, content handed straight to parse (runContentAndCheck, suggestFile)
  // had every arrow claim silently demote to a bare invariant -- all pending, exit 0. The
  // substitution never spans a newline, so line numbers reported below still match the source.
  const lines = content.replace(/ *-> */g, " → ").split("\n");

  let title = "";
  let moduleRaw = "";
  let docBeforeAll = "";
  let docBeforeEach = "";
  let docCompanionRaw = "";
  let docMutate: boolean | undefined;
  const descLines: string[] = [];
  const groups: LLDGroup[] = [];
  let currentGroup: LLDGroup | null = null;
  let bodyStarted = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!title) {
      if (trimmed.startsWith("# ")) title = trimmed.slice(2).trim();
      continue;
    }

    if (!moduleRaw && trimmed.startsWith("> ")) {
      moduleRaw = trimmed.slice(2).trim();
      continue;
    }

    // Document-level lifecycle defaults (before any ## group heading)
    if (!currentGroup && !bodyStarted) {
      const dba = trimmed.match(/^\*\*beforeall:\*\*\s*`(.+?)`/i);
      if (dba) { docBeforeAll = dba[1].trim(); continue; }
      const dbe = trimmed.match(/^\*\*beforeeach:\*\*\s*`(.+?)`/i);
      if (dbe) { docBeforeEach = dbe[1].trim(); continue; }
      const dmu = trimmed.match(/^\*\*mutate:\*\*\s*(true|false)\b/i);
      if (dmu) { docMutate = dmu[1].toLowerCase() === "true"; continue; }
      const dco = trimmed.match(/^\*\*companion:\*\*\s*`(.+?)`/i);
      if (dco) { docCompanionRaw = dco[1].trim(); continue; }
    }

    if (trimmed.startsWith("## ")) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { name: trimmed.slice(3).trim(), assertions: [] };
      bodyStarted = true;
      continue;
    }

    if (currentGroup) {

      const setupMatch = trimmed.match(/^\*\*setup:\*\*\s*`(.+?)`/i);
      if (setupMatch) { currentGroup.setup = setupMatch[1].trim(); continue; }

      const methodMatch = trimmed.match(/^\*\*method:\*\*\s*`(.+?)`/i);
      if (methodMatch) { currentGroup.method = methodMatch[1].trim(); continue; }

      const moduleOverrideMatch = trimmed.match(/^\*\*module:\*\*\s*`(.+?)`/i);
      if (moduleOverrideMatch) {
        const raw = moduleOverrideMatch[1].trim();
        currentGroup.moduleOverride = resolveModulePointer(raw, dirname(resolve(sourcePath)), root);
        continue;
      }

      const browserMatch = trimmed.match(/^\*\*browser:\*\*\s*(true|false)\b/i);
      if (browserMatch) { currentGroup.browser = browserMatch[1].toLowerCase() === "true"; continue; }

      const beforeEachMatch = trimmed.match(/^\*\*beforeeach:\*\*\s*`(.+?)`/i);
      if (beforeEachMatch) { currentGroup.beforeEach = beforeEachMatch[1].trim(); continue; }

      const beforeAllMatch = trimmed.match(/^\*\*beforeall:\*\*\s*`(.+?)`/i);
      if (beforeAllMatch) { currentGroup.beforeAll = beforeAllMatch[1].trim(); continue; }

      const mockHttpMatch = trimmed.match(/^\*\*mock-http:\*\*\s*`(.+?)`/i);
      if (mockHttpMatch) {
        try { currentGroup.mockHttp = JSON.parse(mockHttpMatch[1].trim()); } catch {}
        continue;
      }

      // Indented sub-bullet: "  - question?" is a perspective on the preceding assertion
      if (/^\s{2,}-\s/.test(line)) {
        const text = line.replace(/^\s+-\s/, "").trim();
        const last = currentGroup.assertions[currentGroup.assertions.length - 1];
        if (last) {
          last.perspectives = last.perspectives ?? [];
          last.perspectives.push(parseAssertion(text));
        }
        continue;
      }

      if (trimmed.startsWith("- ")) {
        currentGroup.assertions.push(parseAssertion(trimmed.slice(2).trim()));
      }
      continue;
    }

    if (!bodyStarted && trimmed && !trimmed.startsWith("#")) {
      descLines.push(trimmed);
    }
  }

  if (currentGroup) groups.push(currentGroup);

  // Resolve absolute source path early for module resolution
  const absSource = resolve(sourcePath);
  const module = moduleRaw
    ? resolveModulePointer(moduleRaw, dirname(absSource), root)
    : "";
  const companionModule = docCompanionRaw
    ? resolveModulePointer(docCompanionRaw, dirname(absSource), root)
    : undefined;

  return {
    title,
    module,
    description: descLines.join(" ").trim() || undefined,
    defaultBeforeAll: docBeforeAll || undefined,
    defaultBeforeEach: docBeforeEach || undefined,
    companionModule,
    mutate: docMutate,
    groups,
    sourcePath: absSource,
    root: resolve(root),
  };
}

function parseAssertion(text: string): RawAssertion {
  const repeatMatch = text.match(REPEAT_PREFIX);
  let body = text;
  let repeat: number | undefined;

  if (repeatMatch) {
    repeat = parseInt(repeatMatch[1], 10);
    body = text.slice(repeatMatch[0].length).trim();
  }

  const arrowIdx = body.indexOf(ARROW);
  if (arrowIdx >= 0) {
    const conditionRaw = body.slice(0, arrowIdx).trim();
    const outcome = body.slice(arrowIdx + ARROW.length).trim();

    // A scenario: construct something, act on it, then assert. Keyed on the leading `new`, which is
    // both how every such claim naturally starts and a token the call-chain grammar below can never
    // produce -- so the two forms cannot be confused and adding this one cannot change how an
    // existing document parses.
    if (/^new\s+\w/.test(conditionRaw)) {
      const scenario = parseScenario(conditionRaw);
      if (scenario) return { raw: text, condition: conditionRaw, outcome, repeat, scenario };
    }

    // Capture chain of any length (one call, two, or more)
    const chain = parseCaptureChain(conditionRaw);
    if (chain) {
      const [first, ...rest] = chain;
      return {
        raw: text, condition: first.call, outcome, repeat,
        captures: first.captures, callMethod: first.method, callArgs: first.args,
        extraCalls: rest.length > 0
          ? rest.map(s => ({ method: s.method, args: s.args, captures: s.captures }))
          : undefined,
      };
    }

    // Regular call expression
    const m = parseCallExpr(conditionRaw);
    if (m) {
      return { raw: text, condition: conditionRaw, outcome, repeat, callMethod: m.method, callArgs: m.args };
    }

    return { raw: text, condition: conditionRaw, outcome, repeat };
  }

  return { raw: text, repeat };
}

// ── Capture chains ────────────────────────────────────────────────────

/** Splits a scenario into its ordered steps, or null if it isn't one.
 *
 *  Steps are joined by `then` or `and` and may each bind a capture. Unlike the call chain below, a
 *  step is not required to bind one: `c.render()` and `c.options.value = 1` are whole steps that
 *  produce nothing worth naming, and demanding a capture for them would be noise in the document.
 *  The safety the chain gets from that rule is preserved differently here -- every step is emitted,
 *  so there is no readable prefix to silently derive a narrower test from.
 *
 *  Splitting is bracket- and quote-aware, so a `then` inside an argument or a string stays put. */
function parseScenario(conditionRaw: string): ScenarioStep[] | null {
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, current = "";

  const src = conditionRaw.trim();
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      current += c;
      if (c === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; current += c; continue; }
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;

    if (depth === 0 && (c === "t" || c === "a")) {
      const joiner = /^(?:then|and)\s/.exec(src.slice(i));
      // A joiner only counts on a word boundary, or `c.then(...)` and any identifier ending in
      // "and" would split the step in half.
      if (joiner && /\s$/.test(current)) {
        parts.push(current.trim());
        current = "";
        i += joiner[0].length - 1;
        continue;
      }
    }
    current += c;
  }
  if (quote || depth !== 0) return null;
  parts.push(current.trim());

  const steps = parts.filter(Boolean).map(part => {
    const m = part.match(/^(.*?)\s+captures\s+(\w+)$/i);
    return m ? { expression: m[1].trim(), captures: m[2] } : { expression: part };
  });

  return steps.length > 0 && steps.every(s => s.expression) ? steps : null;
}

interface ParsedChainStep { call: string; captures: string; method?: string; args?: unknown[] }

/** Splits a condition into its capture steps, or returns null if it isn't a capture chain.
 *
 *  Null on *any* unconsumed remainder rather than on the steps parsed so far: a condition that
 *  half-parses is a claim the author wrote in a form this grammar doesn't have, and deriving a
 *  test from the readable prefix would silently check something narrower than what was written. */
function parseCaptureChain(conditionRaw: string): ParsedChainStep[] | null {
  const steps: ParsedChainStep[] = [];
  let rest = conditionRaw.trim();

  while (rest) {
    const m = rest.match(CHAIN_STEP);
    if (!m) return null;
    const call = m[1].trim();
    const parsed = parseCallExpr(call);
    steps.push({ call, captures: m[2], method: parsed?.method, args: parsed?.args });
    rest = rest.slice(m[0].length).trim();
  }

  return steps.length > 0 ? steps : null;
}

// ── Argument parsing ──────────────────────────────────────────────────

// Handles nested parens, brackets, and braces when extracting method + args
function parseCallExpr(s: string): { method: string; args: unknown[] } | null {
  const parenOpen = s.indexOf("(");
  if (parenOpen < 0) return null;

  const method = s.slice(0, parenOpen).trim();
  if (!/^\w+$/.test(method)) return null;

  // Find the matching close paren, respecting nesting
  let depth = 0;
  let end = -1;
  for (let i = parenOpen; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end !== s.length - 1) return null;

  return { method, args: parseArgList(s.slice(parenOpen + 1, end)) };
}

export function parseArgList(argsStr: string): unknown[] {
  if (!argsStr.trim()) return [];
  return splitArgs(argsStr).map(parseArgValue);
}

// Splits on commas, respecting string literals, (), [], {}
function splitArgs(s: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (const ch of s) {
    if (inString) {
      current += ch;
      if (ch === stringChar) inString = false;
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      tokens.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

/** Interprets the escape sequences a quoted argument can carry.
 *
 *  Stripping the quotes is not enough. Passing the two characters of a `\n` through untouched, to
 *  be re-escaped again by codegen, hands `parse("# T\n> m.ts", "s.lld.md")` a single line
 *  containing a literal backslash and an `n`. The claim then looks like it describes a multi-line
 *  document while testing a one-line one, and any assertion about what a real document parses to
 *  checks the wrong input. A multi-line string is the natural way to write a claim about a text
 *  format, which is exactly where this bites. */
function unescapeStringLiteral(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|["'\\nrtb0])/g, (_match, esc: string) => {
    switch (esc) {
      case "n":  return "\n";
      case "r":  return "\r";
      case "t":  return "\t";
      case "b":  return "\b";
      case "0":  return "\0";
      case '"':  return '"';
      case "'":  return "'";
      case "\\": return "\\";
      default:   return String.fromCharCode(parseInt(esc.slice(1), 16));
    }
  });
}

/** Whether brackets close in order and nothing is left open, ignoring quoted spans. */
function isBalanced(s: string): boolean {
  const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === stringChar && s[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = true; stringChar = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch in closers) {
      if (stack.pop() !== closers[ch]) return false;
    }
  }
  return !inString && stack.length === 0;
}

function parseArgValue(s: string): unknown {
  const t = s.trim();
  if (!t) return undefined;
  if (t === "null") return null;
  if (t === "undefined") return undefined;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^["'].*["']$/s.test(t)) return unescapeStringLiteral(t.slice(1, -1));

  // Array literal
  if (t.startsWith("[") && t.endsWith("]")) {
    return parseArgList(t.slice(1, -1));
  }

  // Object literal
  if (t.startsWith("{") && t.endsWith("}")) {
    // Convert JS-style keys to JSON-style for parsing
    try {
      return JSON.parse(t.replace(/(\w+):/g, '"$1":'));
    } catch {
      return { __expr: t };
    }
  }

  // Constructor / new expression -- pass through as raw code
  if (t.startsWith("new ")) return { __expr: t };

  // A parenthesized expression, and anything read off it: `(await create(x)).id`.
  //
  // An argument that has to be computed had nowhere to go in a positional slot. The passthroughs
  // above cover an object literal, a `new`, and a bare identifier, so an expression smuggled in as
  // one property of an options object emitted verbatim and worked, while the identical expression
  // written as the first argument fell to the string fallback below and was emitted quoted. The
  // claim then passed a piece of source text where it meant to pass a value, which reads at a
  // glance as though it had been evaluated.
  //
  // Requiring the leading `(` is what keeps this away from the string fallback's real job. That
  // fallback exists for prose -- `- addItem(a valid session) -> ...` -- and prose does not open with
  // a parenthesis. Balance is checked so an unclosed fragment stays a string rather than becoming
  // code that cannot compile.
  if (t.startsWith("(") && isBalanced(t)) return { __expr: t };

  // A bare identifier (optionally dotted: `tok.token`) matches nothing else recognized above --
  // it's a reference to an earlier capture in a chained call ("captures tok then f(tok.token)"),
  // not a literal string. Pass it through as raw code so it evaluates against the captured
  // variable instead of becoming the literal text "tok.token".
  //
  // The reserved handler names GRAMMAR documents -- `spy` and `thrower` -- arrive here too, and
  // deliberately get no special treatment: they are only meaningful as emitted code, so the one
  // definition of what they mean lives with the code generator, in RESERVED_ARGS in
  // bunRunner.ts. Look there to add one.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(t)) return { __expr: t };

  return t;
}
