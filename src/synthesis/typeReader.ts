import { readFile } from "fs/promises";
import { existsSync } from "fs";
import type { ParamInfo } from "./semantic.ts";

// Cache to avoid re-reading the same file for every assertion in a group
const signatureCache = new Map<string, Map<string, ParamInfo[] | null>>();

export async function readFunctionSignature(
  modulePath: string,
  methodName: string
): Promise<ParamInfo[] | null> {
  if (!existsSync(modulePath)) return null;

  let methodCache = signatureCache.get(modulePath);
  if (!methodCache) {
    methodCache = new Map();
    signatureCache.set(modulePath, methodCache);
  }

  if (methodCache.has(methodName)) return methodCache.get(methodName)!;

  const source = await readFile(modulePath, "utf-8");
  const result = extractSignature(source, methodName);
  methodCache.set(methodName, result);
  return result;
}

// Try several patterns to find the function signature
function extractSignature(source: string, name: string): ParamInfo[] | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    // export const fn = (async)? (params) =>
    new RegExp(`(?:export\\s+)?(?:const|let)\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)`, "m"),
    // export (async)? function fn(params)
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(([^)]*)\\)`, "m"),
    // method(params) in class or object literal (non-exported)
    new RegExp(`(?:^|[\\s,{])${escaped}\\s*\\(([^)]*)\\)\\s*(?::\\s*[\\w<{[]+)?\\s*(?:=>|{)`, "m"),
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match !== null) {
      const parsed = parseParams(match[1] ?? "");
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

function parseParams(raw: string): ParamInfo[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const parts = splitOnCommas(trimmed);
  const params: ParamInfo[] = [];

  for (const part of parts) {
    const p = parseOneParam(part.trim());
    if (p) params.push(p);
  }

  return params.length > 0 ? params : null;
}

// Split on commas while respecting nested brackets
function splitOnCommas(s: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (const ch of s) {
    if ("{[(<".includes(ch)) depth++;
    else if ("}])>".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseOneParam(p: string): ParamInfo | null {
  if (!p) return null;

  const optional = p.includes("?");
  // Remove default value: "name = default" or "name: type = default"
  const noDefault = p.replace(/\s*=\s*.*$/, "").trim();

  // Destructured param: ({ id, update }) -- use a generic name
  if (noDefault.startsWith("{") || noDefault.startsWith("[")) {
    const typeMatch = p.match(/\)\s*:\s*(.+)$/);
    return { name: "_args", type: typeMatch?.[1].trim() ?? "object", optional };
  }

  const colonIdx = noDefault.indexOf(":");
  if (colonIdx < 0) {
    const name = noDefault.replace(/\?$/, "").trim();
    if (!name || name.startsWith("...")) return { name: name.replace(/^\.\.\./, ""), type: "any", optional };
    return { name, type: "any", optional };
  }

  const name = noDefault.slice(0, colonIdx).replace(/[?]/, "").trim();
  const type = noDefault.slice(colonIdx + 1).trim();

  return { name, type, optional };
}
