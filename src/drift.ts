/**
 * Implementation drift detection for LLD files.
 *
 * Compares function signatures and structure between working tree and HEAD,
 * then flags which LLD claims may be affected by structural changes.
 *
 * Uses ts-morph for accurate AST traversal. Logic ported from ctx-semantic-diff.
 */

import { Project, SyntaxKind } from "ts-morph";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { execSync } from "child_process";

// ── Signature extraction ──────────────────────────────────────────────

export interface FunctionSig {
  name: string;
  params: Array<{ name: string; type: string; optional: boolean }>;
  returnType: string;
  async: boolean;
  guards: string[];        // null/undefined guard conditions
  hasTryCatch: boolean;
  throwCount: number;
  branchCount: number;
}

function extractGuards(fn: any): string[] {
  const body = fn.getBody?.();
  if (!body) return [];
  const params = (fn.getParameters?.() ?? []).map((p: any) => p.getName());
  return (body.getDescendantsOfKind(SyntaxKind.IfStatement) ?? [])
    .map((s: any) => s.getExpression().getText())
    .filter((c: string) =>
      params.some((p: string) =>
        c.includes(`!${p}`) || c.includes(`${p} ==`) || c.includes(`${p} ===`) ||
        c.includes(`${p} !==`) || c.includes("null") || c.includes("undefined")
      )
    );
}

function sigOf(fn: any): FunctionSig {
  const body = fn.getBody?.();
  return {
    name: fn.getName?.() ?? "",
    params: (fn.getParameters?.() ?? []).map((p: any) => ({
      name: p.getName(),
      type: p.getType().getText(p),
      optional: p.isOptional(),
    })),
    returnType: fn.getReturnType?.()?.getText(fn) ?? "unknown",
    async: fn.isAsync?.() ?? false,
    guards: extractGuards(fn),
    hasTryCatch: (body?.getDescendantsOfKind(SyntaxKind.TryStatement) ?? []).length > 0,
    throwCount:  (body?.getDescendantsOfKind(SyntaxKind.ThrowStatement) ?? []).length,
    branchCount: (body?.getDescendantsOfKind(SyntaxKind.IfStatement) ?? []).length,
  };
}

function extractAll(source: string, ext = "ts"): Record<string, FunctionSig> {
  const isJs = ["js", "jsx", "mjs"].includes(ext);
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: true,
    compilerOptions: isJs ? { allowJs: true, checkJs: false } : {},
  });
  const label = `module.${ext}`;
  const sf = project.createSourceFile(label, source);
  const sigs: Record<string, FunctionSig> = {};

  for (const fn of sf.getFunctions()) {
    if (!fn.isExported() || !fn.getName()) continue;
    sigs[fn.getName()!] = sigOf(fn);
  }
  for (const v of sf.getVariableDeclarations()) {
    const stmt = v.getVariableStatement();
    if (!stmt?.isExported()) continue;
    const init = v.getInitializer();
    if (!init) continue;
    const k = init.getKindName();
    if (k === "ArrowFunction" || k === "FunctionExpression") {
      sigs[v.getName()] = sigOf(init);
    }
  }
  return sigs;
}

// ── Change classification ─────────────────────────────────────────────

export type ChangeType = "ADDED" | "REMOVED" | "CHANGED";

export interface StructuralChange {
  type: ChangeType;
  name: string;
  diffs: string[];
  risk: "high" | "medium" | "low";
}

export function compareImplementations(
  oldSigs: Record<string, FunctionSig>,
  newSigs: Record<string, FunctionSig>
): StructuralChange[] {
  const changes: StructuralChange[] = [];
  const names = new Set([...Object.keys(oldSigs), ...Object.keys(newSigs)]);

  for (const name of names) {
    const o = oldSigs[name];
    const n = newSigs[name];

    if (!o) { changes.push({ type: "ADDED", name, diffs: [], risk: "low" }); continue; }
    if (!n) { changes.push({ type: "REMOVED", name, diffs: [], risk: "high" }); continue; }

    const diffs: string[] = [];
    let risk: "high" | "medium" | "low" = "low";

    if (o.params.length !== n.params.length) {
      const fmt = (ps: typeof o.params) => ps.map(p => `${p.name}: ${p.type}`).join(", ");
      diffs.push(`params: (${fmt(o.params)}) → (${fmt(n.params)})`);
      risk = "high";
    } else {
      o.params.forEach((op, i) => {
        const np = n.params[i];
        if (op.type !== np.type) diffs.push(`  param '${op.name}' type: ${op.type} → ${np.type}`);
        if (op.optional !== np.optional) diffs.push(`  param '${op.name}' optional: ${op.optional} → ${np.optional}`);
      });
    }

    if (o.returnType !== n.returnType) {
      diffs.push(`return: ${o.returnType} → ${n.returnType}`);
      if (risk === "low") risk = "medium";
    }

    if (o.async !== n.async) diffs.push(`async: ${o.async} → ${n.async}`);

    const removedGuards = o.guards.filter(g => !n.guards.includes(g));
    removedGuards.forEach(g => {
      diffs.push(`⚠  GUARD-REMOVED: if (${g}) — null/undefined check dropped`);
      risk = "high";
    });

    if (o.hasTryCatch && !n.hasTryCatch) {
      diffs.push("⚠  TRY-CATCH-REMOVED — error handling dropped");
      risk = "high";
    }

    const throwDelta = n.throwCount - o.throwCount;
    if (throwDelta !== 0) {
      diffs.push(`throws: ${o.throwCount} → ${n.throwCount} (${throwDelta > 0 ? "+" : ""}${throwDelta})`);
      if (risk === "low") risk = "medium";
    }

    if (n.branchCount > o.branchCount + 2) {
      diffs.push(`branches: ${o.branchCount} → ${n.branchCount} (+${n.branchCount - o.branchCount} paths)`);
      if (risk === "low") risk = "medium";
    }

    if (diffs.length > 0) changes.push({ type: "CHANGED", name, diffs, risk });
  }

  return changes;
}

// ── Git + LLD impact ──────────────────────────────────────────────────

function sourceAtRef(ref: string, filePath: string): string | null {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel 2>/dev/null", { encoding: "utf-8" }).trim();
    const rel = filePath.replace(gitRoot + "/", "");
    return execSync(`git show ${ref}:${rel} 2>/dev/null`, { encoding: "utf-8" });
  } catch { return null; }
}

export interface DriftReport {
  modulePath: string;
  changes: StructuralChange[];
  impacts: Array<{ change: StructuralChange; affectedClaims: string[] }>;
  hasHighRisk: boolean;
}

export function mapChangesToClaims(
  changes: StructuralChange[],
  claims: string[]
): Array<{ change: StructuralChange; affectedClaims: string[] }> {
  return changes
    .filter(c => c.type !== "ADDED")
    .map(change => {
      const nameLower = change.name.toLowerCase();
      const affectedClaims = claims.filter(claim => {
        const cl = claim.toLowerCase();
        if (cl.includes(nameLower)) return true;
        if (change.diffs.some(d => d.includes("GUARD") || d.includes("TRY-CATCH"))) {
          if (/\b(?:error|fail|invalid|guard|protect|null|undefined|safe)\b/.test(cl)) return true;
        }
        if (change.diffs.some(d => d.includes("throws:"))) {
          if (/\b(?:throw|fail|error|reject|invalid)\b/.test(cl)) return true;
        }
        if (change.diffs.some(d => d.includes("params:"))) {
          if (/\b(?:required|field|parameter|input|argument)\b/.test(cl)) return true;
        }
        return false;
      });
      return { change, affectedClaims };
    })
    .filter(r => r.affectedClaims.length > 0 || r.change.risk === "high");
}

/** Pure: compare two source strings directly, no git or file I/O required. */
export function compareSourcesForDrift(
  beforeSource: string,
  afterSource: string,
  claims: string[] = [],
  ext = "ts"
): DriftReport | null {
  if (beforeSource === afterSource) return null;
  const oldSigs = extractAll(beforeSource, ext);
  const newSigs = extractAll(afterSource, ext);
  const changes = compareImplementations(oldSigs, newSigs);
  if (changes.length === 0) return null;
  const impacts = mapChangesToClaims(changes, claims);
  return { modulePath: "(inline)", changes, impacts, hasHighRisk: changes.some(c => c.risk === "high") };
}

/** Git-aware: reads current file and compares against a ref. */
export async function detectDrift(
  modulePath: string,
  claims: string[],
  baseRef = "HEAD"
): Promise<DriftReport | null> {
  if (!existsSync(modulePath)) return null;

  const currentSource = await readFile(modulePath, "utf-8");
  const oldSource = sourceAtRef(baseRef, modulePath);
  if (!oldSource) return null;
  if (currentSource === oldSource) return null; // content identical — skip ts-morph entirely

  const ext = modulePath.match(/\.(ts|tsx|js|jsx|mjs)$/)?.[1] ?? "ts";
  return compareSourcesForDrift(oldSource, currentSource, claims, ext);
}

// Zero-arg scenarios for testing drift behavior without git context.
const _src1 = `export function fn(a: string) {}`;
const _src2 = `export function fn(a: string, b: number) {}`;
const _src3 = `export function fn(a: string) {} export function newFn() {}`;

// Structural change: before has one param, after has two → CHANGED finding
export const driftFromSourceChange = () =>
  compareSourcesForDrift(_src1, _src2, ["does the parameter contract change?"]);

// Added export: before has fn, after has fn + newFn → ADDED finding with no impacts
export const driftFromSourceAddedExport = () =>
  compareSourcesForDrift(_src1, _src3, ["existing claim about fn"]);

// Identical sources: no drift
export const driftFromUnchangedSource = () =>
  compareSourcesForDrift(_src1, _src1);
