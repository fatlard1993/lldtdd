// Top-level dispatchers: resolveMethodCall (the **method:**-annotated / apiMatch-inferred
// path) and deriveInline (claim-vocabulary-only path, tried when no group method applies).
// Both compose the pattern-family resolvers in ./patterns/* in a fixed, load-bearing order --
// see each function's own comments for why that order matters.

import type { AstFacts, InlineDerived } from "./types.ts";
import { syntheticValue } from "./types.ts";
import { extractFieldTypes } from "./sourceScrapers.ts";
import { resolveTransformPatterns } from "./patterns/transform.ts";
import { resolveCliClassPatterns, resolveCliParserPatterns, buildZeroArgInline } from "./patterns/cli.ts";
import { resolveSelfDatabasePatterns, resolveCrudSearchPatterns } from "./patterns/crud.ts";
import { deriveEventTargetInline } from "./patterns/event-target.ts";
import { deriveDerivationFactoryInline, deriveStyledFactoryInline } from "./patterns/factory.ts";
import { deriveComponentInline } from "./patterns/component.ts";
import { deriveHttpClientInline } from "./patterns/http-client.ts";

// Vocabulary-pattern catalog, checked in order against the __lld_api description text.
// Each stage owns one family of recipes; the first stage to recognize the description wins.
export function resolveMethodCall(
  methodName: string,
  apiDescription: string,
  facts: AstFacts
): InlineDerived | null {
  const lower = apiDescription.toLowerCase();
  const schema = facts.schemas[0];
  const baseArgs = schema
    ? Object.fromEntries(schema.fields.slice(0, 2).map(f => [f, syntheticValue(f)]))
    : {};

  // ── Zero-arg scenario: call the method, derive assertions from the captured result ──
  const zeroArgScenario = facts.zeroArgScenarios?.[methodName];
  if (zeroArgScenario) return buildZeroArgInline(zeroArgScenario, methodName);

  return resolveTransformPatterns(lower, methodName, facts)
    ?? resolveCliParserPatterns(lower, apiDescription, facts)
    ?? resolveSelfDatabasePatterns(lower, facts)
    ?? resolveCrudSearchPatterns(lower, apiDescription, facts, schema, baseArgs);
}

// ── deriveInline pattern constants ────────────────────────────────────
const REQUIRED_FIELDS = /\b(\w+)\s+and\s+(\w+)\s+are\s+the\s+only\s+required\s+fields?\b/i;
const DEFAULT_EMPTY   = /\bdefaults?\s+to\s+(?:empty\s+string|""|'')\b/i;
const MUTABILITY      = /\bfields?\s+can\s+be\s+updated?\b|\bcan\s+be\s+(?:updated?|changed?|modified?)\s+after\b/i;
const INLINE_CREATION = /\bcan\s+create\s+a\s+new\s+(\w+)\s+in\s+the\s+same\s+operation\b/i;
const FULL_SCHEMA_DROP = /\b(?:only\s+declared\s+fields?\s+(?:survive|are\s+kept|are\s+preserved)|undeclared\s+fields?\s+(?:are\s+)?(?:dropped|removed|stripped|ignored))\b/i;

export function deriveInline(claim: string, facts: AstFacts, parentClaim?: string): InlineDerived | null {
  // Constructor-testable classes (EventTarget-based reactive contexts, DOM-wrapper/component classes) --
  // bypass the CRUD-schema requirement. Both catalogs below match on claim text alone; the
  // eventTargetClass/componentClass classification only gates whether the module is
  // constructible at all (constructorModulePath), not which catalog applies -- so both are
  // tried whenever a default-exported constructor exists, regardless of what it extends.
  if (facts.constructorModulePath) {
    const eventTargetDerived = deriveEventTargetInline(claim, facts.eventTargetClass);
    if (eventTargetDerived) return eventTargetDerived;
  }

  if (facts.constructorModulePath) {
    const derived = deriveComponentInline(claim, facts.source, parentClaim);
    if (derived) return derived;
  }

  // Reactive-derivation factory (a module exporting derive(selector, combiner, options)): a
  // plain exported function, not a constructible class, so it can't go through the
  // constructorModulePath-gated catalogs above.
  if (/export\s+function\s+derive\s*\(/.test(facts.source)) {
    const derivationDerived = deriveDerivationFactoryInline(claim);
    if (derivationDerived) return derivationDerived;
  }

  // styled()/configured() factory: also a plain exported function, not a constructible class. The
  // deriver checks that `styled` actually returns a class before building anything -- exporting the
  // name is not enough, since every pattern in that family constructs the result.
  if (/export\s+const\s+styled\s*=/.test(facts.source)) {
    const styledDerived = deriveStyledFactoryInline(claim, facts.source);
    if (styledDerived) return styledDerived;
  }

  // Class-based CLI parsers: wire the same deterministic vocabulary used for
  // **method:**-annotated groups into bare/no-method inline claims, so a claim's pending
  // status doesn't depend on whether it happened to get an explicit method anchor.
  if (facts.constructorModulePath && /\bthis\.options\s*=/.test(facts.source)) {
    const cliClassDerived = resolveCliClassPatterns(claim, facts);
    if (cliClassDerived) return cliClassDerived;
    const lower = claim.toLowerCase();
    const cliParserDerived = resolveCliParserPatterns(lower, claim, facts)
      ?? resolveTransformPatterns(lower, "create", facts);
    if (cliParserDerived) return cliParserDerived;
  }

  // Caching-fetch clients: a module exporting HTTP-verb functions whose result separates data
  // state from network state. Gated inside the deriver on that structure, so a module that merely
  // mentions `fetch` does not qualify. Tried before the schema gate below: such a module has no
  // CRUD schema, so it would otherwise fall out at `if (!schema) return null`.
  const httpClientDerived = deriveHttpClientInline(claim, facts);
  if (httpClientDerived) return httpClientDerived;

  // Transform-pattern vocabulary (framework self-tests, CLI transform/type claims) doesn't
  // require a detected schema -- tried before the schema gate below so plain-utility-module
  // claims (no CRUD schema at all) still get a chance to resolve.
  const transformDerived = resolveTransformPatterns(claim.toLowerCase(), "create", facts);
  if (transformDerived) return transformDerived;

  const schema = facts.schemas[0];
  if (!schema) return null;

  const fieldTypes = extractFieldTypes(facts.source, schema.fields);
  let requiredFields: string[] = [];

  // "X and Y are the only required fields" → minimal create call
  const reqMatch = claim.match(REQUIRED_FIELDS);
  if (reqMatch) {
    requiredFields = [reqMatch[1].toLowerCase(), reqMatch[2].toLowerCase()];
    const args = Object.fromEntries(
      requiredFields.map(f => {
        const info = fieldTypes.get(f);
        return [f, syntheticValue(f, info?.unionLiterals)];
      })
    );
    return { method: "create", callArgs: [args], outcomeType: "resolves" };
  }

  // "defaults to empty string" → create supplying one declared field, assert another came back
  // as the default.
  //
  // Any two declared fields will do, and that is the point: nothing about defaulting depends on
  // what the fields are called. Requiring a url-like field plus a name-like field is one
  // project's bookmark shape; a schema of `hullName, berth, capacity` describes exactly the
  // same behaviour.
  if (DEFAULT_EMPTY.test(claim)) {
    const [supplied, omitted] = schema.fields.filter(f => f !== "id");
    if (supplied && omitted) {
      return {
        method: "create",
        callArgs: [{ [supplied]: syntheticValue(supplied) }],
        captures: "r",
        inspectCode: `expect(r.${omitted}).toBe("");`,
      };
    }
  }

  // "only declared fields survive a write" → schema-drop
  if (FULL_SCHEMA_DROP.test(claim)) {
    return {
      method: "create",
      callArgs: [],
      outcomeType: "schema-drop",
      knownFields: [...new Set(schema.fields)],
    };
  }

  // "can create a new X in the same operation" → inline creation via beforeCreate hook
  const inlineMatch = claim.match(INLINE_CREATION);
  if (inlineMatch) {
    const entity = inlineMatch[1].toLowerCase();
    const hook = schema.hooks.find(h => h.kind === "beforeCreate" && h.trigger?.includes(entity));
    if (hook) {
      const base = requiredFields.length ? requiredFields : schema.fields.slice(0, 2);
      const baseArgs = Object.fromEntries(base.map(f => [f, syntheticValue(f)]));
      const spec = { create: { name: "Test" } };
      return {
        method: "create",
        callArgs: [{ ...baseArgs, [entity]: spec }],
        captures: "r",
        // The claim is that the hook ran: the nested spec was consumed and the field now holds a
        // reference to the record it created. `expect(r.X).toBeDefined()` was the assertion here,
        // and it could not fail -- a write path that ignores the hook entirely copies the spec
        // straight through, and an object is defined. So the one thing the claim is about was the
        // one thing unchecked.
        //
        // Comparing against the spec rather than asserting a string keeps this independent of how
        // a project shapes its ids.
        inspectCode: [
          `expect(r.${entity}).toBeDefined();`,
          `expect(r.${entity}).not.toEqual(${JSON.stringify(spec)});`,
        ].join("\n"),
      };
    }
  }

  // "fields can be updated after creation" → create + update for first simple field
  if (MUTABILITY.test(claim)) {
    const simpleField = schema.fields.find(
      f => f !== "id" && (f.includes("name") || f.includes("title") || f.includes("label"))
    );
    if (simpleField) {
      const base = schema.fields.slice(0, 2);
      const baseArgs = Object.fromEntries(base.map(f => [f, syntheticValue(f)]));
      const newVal = "Renamed";
      // Multi-step: need captures on create, then update -- emit as inspect code
      return {
        method: "create",
        callArgs: [baseArgs],
        captures: "_created",
        inspectCode: [
          `const _updated = await Subject.update({ id: _created.id, update: { ${simpleField}: ${JSON.stringify(newVal)} } });`,
          `expect(_updated.${simpleField}).toBe(${JSON.stringify(newVal)});`,
        ].join("\n"),
      };
    }
  }

  // What stays above is gated on structure the module actually exhibits -- a detected schema, a
  // `beforeCreate` hook naming an entity, a captured field name from the claim itself.

  return null;
}
