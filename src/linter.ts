import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { getModuleExports } from "./inference.ts";

export interface LintIssue {
  level: "error" | "warning";
  line: number;
  message: string;
}

export interface LintResult {
  file: string;
  issues: LintIssue[];
  errors: number;
  warnings: number;
}

export async function lintFile(filePath: string): Promise<LintResult> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n");
  const issues: LintIssue[] = [];
  const absPath = resolve(filePath);

  const err  = (line: number, msg: string) => issues.push({ level: "error",   line, message: msg });
  const warn = (line: number, msg: string) => issues.push({ level: "warning", line, message: msg });

  let hasTitle = false;
  let hasModule = false;
  let moduleRaw = "";
  let hasGroup = false;
  let currentGroup: {
    name: string; line: number;
    hasMethod: boolean; hasSetup: boolean; assertions: number;
    methodName?: string; methodLine?: number;
    moduleOverride?: string;
  } | null = null;
  const seenAssertions = new Map<string, number>(); // text -> first line
  // Collect all method annotations for stale-check after parsing
  const methodAnnotations: Array<{ name: string; line: number; modulePath: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const t  = lines[i].trim();

    // ── Character policy ──────────────────────────────────────────────
    // Unicode arrows are valid in assertion lines (parser normalises both → and ->)
    // Only flag → in prose (non-assertion, non-annotation) lines
    const isAssertionLine = t.startsWith("- ") || t.startsWith("  - ");
    const isAnnotationLine = t.startsWith("**");
    if (!isAssertionLine && !isAnnotationLine && t.includes("→"))
      warn(ln, 'Unicode arrow in prose — use -> in assertion lines for consistency');
    if (t.includes("—")) err(ln, 'Em-dash found: use -- or rephrase');

    // Deprecated ASCII separator " - prose" in assertions (context-aware)
    if (t.startsWith("- ") && !t.includes("->") && / - [a-z]/.test(t)) {
      warn(ln, 'Possible deprecated " - " prose separator: use // instead');
    }

    // ── Structure ─────────────────────────────────────────────────────
    if (t.startsWith("# ") && !t.startsWith("## ")) {
      hasTitle = true;
      continue;
    }

    if (!hasModule && t.startsWith("> ")) {
      hasModule = true;
      moduleRaw = t.slice(2).trim();
      continue;
    }

    if (t.startsWith("## ")) {
      if (currentGroup) {
        if (currentGroup.assertions === 0) {
          warn(currentGroup.line, `Group "${currentGroup.name}" has no assertions`);
        }
        // Collect method annotation for stale check
        if (currentGroup.methodName && currentGroup.methodLine) {
          const effectiveModule = currentGroup.moduleOverride ?? (moduleRaw
            ? (moduleRaw.startsWith("./") || moduleRaw.startsWith("../")
              ? resolve(dirname(absPath), moduleRaw)
              : resolve(process.cwd(), moduleRaw))
            : "");
          if (effectiveModule) {
            methodAnnotations.push({
              name: currentGroup.methodName,
              line: currentGroup.methodLine,
              modulePath: effectiveModule,
            });
          }
        }
      }
      hasGroup = true;
      currentGroup = { name: t.slice(3).trim(), line: ln, hasMethod: false, hasSetup: false, assertions: 0 };
      continue;
    }

    if (!currentGroup) continue;

    // ── Annotation syntax ─────────────────────────────────────────────
    if (/^\*\*method:\*\*/i.test(t)) {
      if (!t.match(/^\*\*method:\*\*\s*`[^`]+`/i)) {
        err(ln, '**method:** value must be backtick-wrapped: **method:** `methodName`');
      } else {
        const methodName = t.match(/^\*\*method:\*\*\s*`([^`]+)`/i)?.[1];
        if (methodName && currentGroup) {
          currentGroup.methodName = methodName;
          currentGroup.methodLine = ln;
        }
      }
      currentGroup.hasMethod = true;
      continue;
    }

    if (/^\*\*module:\*\*/i.test(t)) {
      const modRaw = t.match(/^\*\*module:\*\*\s*`([^`]+)`/i)?.[1];
      if (modRaw && currentGroup) {
        const base = absPath;
        currentGroup.moduleOverride = modRaw.startsWith("./") || modRaw.startsWith("../")
          ? resolve(dirname(base), modRaw)
          : resolve(process.cwd(), modRaw);
      }
      continue;
    }
    if (/^\*\*setup:\*\*/i.test(t)) {
      if (!t.match(/^\*\*setup:\*\*\s*`[^`]+`/i))
        err(ln, '**setup:** value must be backtick-wrapped: **setup:** `createFoo()`');
      currentGroup.hasSetup = true;
      continue;
    }
    if (/^\*\*beforeall:\*\*/i.test(t)) {
      if (!t.match(/^\*\*beforeall:\*\*\s*`[^`]+`/i))
        err(ln, '**beforeAll:** value must be backtick-wrapped');
      continue;
    }
    if (/^\*\*beforeeach:\*\*/i.test(t)) {
      if (!t.match(/^\*\*beforeeach:\*\*\s*`[^`]+`/i))
        err(ln, '**beforeEach:** value must be backtick-wrapped');
      continue;
    }

    // ── Assertion bullets ─────────────────────────────────────────────
    if (!t.startsWith("- ")) continue;

    const assertion = t.slice(2).trim();
    currentGroup.assertions++;

    // Duplicate detection: only flag top-level assertions (perspectives may intentionally
    // repeat the same test under different parent claims)
    const isTopLevel = !lines[i - 1]?.startsWith("  ") || !lines[i].startsWith("  ");
    const isIndented = /^\s{2,}-\s/.test(lines[i]);
    if (!isIndented) {
      if (seenAssertions.has(assertion)) {
        warn(ln, `Duplicate assertion (first at line ${seenAssertions.get(assertion)}): "${assertion.slice(0, 60)}"`);
      } else {
        seenAssertions.set(assertion, ln);
      }
    }

    // Note: assertions without a method, setup, or inline call will run as pending.
    // This is intentional and expected for pre-implementation LLDs.
    // Pending = intent documented, implementation not yet verified.
  }

  // Final group check + collect last group's method annotation
  if (currentGroup) {
    if (currentGroup.assertions === 0) {
      warn(currentGroup.line, `Group "${currentGroup.name}" has no assertions`);
    }
    if (currentGroup.methodName && currentGroup.methodLine) {
      const effectiveModule = currentGroup.moduleOverride ?? (moduleRaw
        ? (moduleRaw.startsWith("./") || moduleRaw.startsWith("../")
          ? resolve(dirname(absPath), moduleRaw)
          : resolve(process.cwd(), moduleRaw))
        : "");
      if (effectiveModule) {
        methodAnnotations.push({
          name: currentGroup.methodName,
          line: currentGroup.methodLine,
          modulePath: effectiveModule,
        });
      }
    }
  }

  // ── Document-level ────────────────────────────────────────────────
  if (!hasTitle)  err(1, 'Missing document title: # Title');
  if (!hasModule) err(1, 'Missing module pointer: > path/to/module');
  if (!hasGroup)  warn(1, 'No groups defined: add ## Section headings');

  if (moduleRaw) {
    const modPath = moduleRaw.startsWith("./") || moduleRaw.startsWith("../")
      ? resolve(dirname(absPath), moduleRaw)
      : resolve(process.cwd(), moduleRaw);
    if (!existsSync(modPath)) {
      err(1, `Module not found: ${moduleRaw}`);
    }
  }

  // Stale annotation check: verify **method:** names exist as actual exports OR __lld_api declarations.
  // Methods declared in __lld_api are valid virtual methods — the translator derives their calls
  // from the description vocabulary even when no function body exists.
  const exportCache = new Map<string, Set<string>>();
  const apiCache    = new Map<string, Set<string>>();

  for (const ann of methodAnnotations) {
    if (!existsSync(ann.modulePath)) continue;

    if (!exportCache.has(ann.modulePath)) {
      const exports = await getModuleExports(ann.modulePath);
      exportCache.set(ann.modulePath, new Set(exports));
    }
    if (!apiCache.has(ann.modulePath)) {
      try {
        const src = await readFile(ann.modulePath, "utf-8");
        const apiMatch = src.match(/export\s+const\s+__lld_api\s*=\s*`([^`]*)`/s);
        const apiNames = new Set<string>();
        if (apiMatch) {
          for (const m of apiMatch[1].matchAll(/^\s+(\w+)\s*\(/gm)) apiNames.add(m[1]);
        }
        apiCache.set(ann.modulePath, apiNames);
      } catch { apiCache.set(ann.modulePath, new Set()); }
    }

    const exports = exportCache.get(ann.modulePath)!;
    const apiDecls = apiCache.get(ann.modulePath)!;
    if (exports.size > 0 && !exports.has(ann.name) && !apiDecls.has(ann.name)) {
      err(ann.line, `**method:** \`${ann.name}\` not found in module — was it renamed? Available: ${[...exports].filter(e => !e.startsWith("__")).slice(0, 6).join(", ")}`);
    }
  }

  const errors   = issues.filter(i => i.level === "error").length;
  const warnings = issues.filter(i => i.level === "warning").length;
  return { file: filePath, issues, errors, warnings };
}
