import Anthropic from "@anthropic-ai/sdk";
import type { RawAssertion, TestCase } from "../types.ts";

const client = new Anthropic();

const SYSTEM = `You translate behavioral assertions from Low Level Design documents into test code.

Given a module path, group name, optional method/setup context, and an English assertion, produce either:

A) A COMPLETE TEST BODY when you can write a specific, verifiable test:
{
  "code": "const r = await Subject.parseArgs([\"--flag\", \"TRUE\"], { flag: { type: \"boolean\" } }); expect(r.flag).toBe(true);"
}
Use Subject.methodName(args) to call the function. Write the assertion that actually verifies the claim.
Prefer this form — do not write toBeDefined() as a placeholder.

B) STRUCTURED METADATA when you cannot write a specific test body:
{
  "setup": [],
  "action": { "method": "camelCase method name or null", "argDescription": "description" },
  "assertion": {
    "type": "throws|resolves|equals|shape|property|called|calledWith|notCalled",
    "errorClass": null, "errorMessage": null, "expected": null, "description": "what to verify"
  }
}

Choose A when:
- You can infer specific arguments from the assertion text
- The assertion implies a concrete expected value
- You can write a test that would fail if the described behavior were absent

Choose B when:
- The assertion is too abstract to synthesize specific args
- The setup state required is not derivable from the assertion text

Test environment: bun:test
- Use mock() not jest.fn() for spy functions
- Use mock.fn() not jest.mock()
- Imports are already resolved — use Subject.methodName() directly
- For spy/mock: import { mock } from "bun:test" is already imported
- Errors should be checked with toThrow(), not by inspecting return value

Method inference (for form B):
- If a "Default method" is provided, use it unless the assertion implies a different operation
- If group has setup like "createEventBus()", the method is called on _subject
- Return null for method if genuinely unclear

Assertion rules (for form B):
- "called" / "called with X" / "not called" → spy assertion types
- "allowed" / "denied" → property check
- "no error" → resolves

Be specific. A test that always passes is worse than pending.`;


export interface AIContext {
  module: string;
  group: string;
  groupContext?: string;
  groupSetup?: string;
  groupMethod?: string;
  moduleExports?: string[];  // available Subject.xxx functions
  moduleApi?: string;        // __lld_api description from the helper module
  astFacts?: import("../ast.ts").AstFacts;  // implementation semantics from AST inspection
}

export async function translateWithAI(
  assertion: RawAssertion,
  ctx: AIContext
): Promise<TestCase> {
  // Summarise AST facts relevant to this assertion for the AI
  const astLines: string[] = [];
  if (ctx.astFacts) {
    const f = ctx.astFacts;
    if (f.schemas.length > 0) {
      for (const s of f.schemas) {
        astLines.push(`Schema "${s.collection}": fields [${s.fields.join(", ")}], default ${s.fieldDefault ?? "''"}`);
        for (const h of s.hooks) {
          if (h.trigger) astLines.push(`  hook ${h.kind}: triggers when ${h.trigger} is present`);
        }
      }
    }
    for (const a of f.allowlists) {
      astLines.push(`Allowlist ${a.name}: [${a.values.join(", ")}]${a.checkedIn ? ` — checked in ${a.checkedIn}` : ""}`);
    }
    for (const v of f.validationLocations) {
      astLines.push(`Validation "${v.concept}": in ${v.checkedIn}, NOT in ${v.notCheckedIn.join(", ")}`);
    }
    // Verb semantics for exported functions — helps AI understand what each function does
    const verbEntries = Object.entries(f.exportVerbs);
    if (verbEntries.length > 0) {
      astLines.push(`Export semantics: ${verbEntries.map(([n, v]) => `${n}(${v.returns}${v.sideEffect ? ",side-effect" : ""})`).join(", ")}`);
    }
  }

  const userContent = [
    `Module: ${ctx.module}`,
    `Group: ${ctx.group}`,
    ctx.moduleApi ? `Subject API:\n${ctx.moduleApi}` : (ctx.moduleExports?.length ? `Subject exports: ${ctx.moduleExports.join(", ")} — use Subject.fn(args), never new Subject()` : null),
    astLines.length > 0 ? `Implementation facts (from AST):\n${astLines.join("\n")}` : null,
    ctx.groupMethod  ? `Default method: \`${ctx.groupMethod}\`` : null,
    ctx.groupSetup   ? `Setup: \`${ctx.groupSetup}\`` : null,
    ctx.groupContext ? `Context: ${ctx.groupContext}` : null,
    ``,
    `Assertion: "${assertion.raw}"`,
  ]
    .filter(Boolean)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: userContent }],
  });

  const raw =
    message.content[0].type === "text" ? message.content[0].text.trim() : "{}";

  // strip markdown code fences if the model wrapped its response
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  try {
    const p = JSON.parse(text);

    // Form A: AI generated a complete test body
    if (typeof p.code === "string" && p.code.trim()) {
      return {
        description: assertion.raw,
        setup: [],
        action: { method: ctx.groupMethod ?? "_ai_generated", argDescription: assertion.condition },
        assertion: { type: "inspect", code: p.code.trim() },
        source: "ai",
      };
    }

    // Form B: structured metadata
    return {
      description: assertion.raw,
      setup: Array.isArray(p.setup) ? p.setup : [],
      action: {
        method: p.action?.method ?? undefined,
        argDescription: p.action?.argDescription ?? assertion.condition,
      },
      assertion: {
        type: p.assertion?.type ?? "resolves",
        errorClass: p.assertion?.errorClass ?? undefined,
        errorMessage: p.assertion?.errorMessage ?? undefined,
        expected: p.assertion?.expected ?? undefined,
        description: p.assertion?.description ?? assertion.outcome,
      },
      source: "ai",
    };
  } catch {
    return fallback(assertion);
  }
}

function fallback(assertion: RawAssertion): TestCase {
  return {
    description: assertion.raw,
    setup: [],
    action: { argDescription: assertion.condition },
    assertion: { type: "resolves", description: assertion.outcome },
    source: "needs-fixture",
  };
}
