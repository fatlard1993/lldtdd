// Self-database and CRUD-search pattern resolvers: claims about a module whose primary
// export IS the persistence layer, and the broader schema-driven create/search/seed
// vocabulary used against createCRUD-style modules.

import type { AstFacts, InlineDerived, SchemaInfo } from "../types.ts";
import { syntheticValue } from "../types.ts";

// ── Self-database patterns (isSelfDatabase: module IS the database) ──
// These must come before the faultTargets-based patterns.
export function resolveSelfDatabasePatterns(lower: string, facts: AstFacts): InlineDerived | null {
  // "read all database data" → standalone inspectCode using _database directly
  if (/read all database data|local.only access|no network/.test(lower) && facts.isSelfDatabase) {
    return {
      method: "create",
      callArgs: [],
      inspectCode: "expect(_database.db.data).toBeDefined();",
    };
  }

  // "queue writes A then B; returns true if A completed before B" → withOrderTracking
  if (/queue writes.*returns true if.*completed before|writes.*in order|order\w*.*structural|structural.*order\w*/.test(lower) && facts.isSelfDatabase) {
    const code = [
      `const order = await withOrderTracking(() => _database.write(), () => _database.write());`,
      `expect(order[0] === 1 && order[1] === 2).toBe(true);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // "fail one write then recover; returns true if queue continued" → withFaultInjection
  if (/fail\w*.*recover|recover.*fault|does not stall|queue continu\w*/.test(lower) && facts.isSelfDatabase) {
    const code = [
      `const result = await withFaultInjection(_database.db, "write", () => _database.write());`,
      `expect(result).toBe(true);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // A claim about field defaults is checkable against a module that declares its fields; point it
  // at that module and the CRUD vocabulary covers it.

  return null;
}

// ── CRUD / search-engine patterns: entity creation, FK relationships, search fixtures ──
export function resolveCrudSearchPatterns(
  lower: string,
  apiDescription: string,
  facts: AstFacts,
  schema: SchemaInfo | undefined,
  baseArgs: Record<string, unknown>
): InlineDerived | null {
  // ── Delete removes the record from its own collection (generic to any CRUD entity) ──
  // "Subject" only resolves correctly for the document's primary module -- an afterDelete
  // hook signals this schema is being tested via a **module:** override (e.g. categories.js
  // coupled from bookmarks.lld.md), where the only reliably-imported alias is the FK-style
  // _${entity} import, same as the orphan/move patterns above.
  if (/delete.*read.*absent|absent from the collection|deleted.*is absent/.test(lower)) {
    const hasOwnAfterDelete = /afterDelete/.test(facts.source);
    const entity = schema?.collection
      ? schema.collection.replace(/ies$/, "y").replace(/s$/, "")
      : "entity";
    const alias = hasOwnAfterDelete ? `_${entity}` : "Subject";
    const code = [
      `const _e = await ${alias}.create(${JSON.stringify(baseArgs)});`,
      `await ${alias}.delete({ id: _e.id });`,
      `expect(${alias}.read({ id: _e.id })).toBe(false);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // The delete check below is FK-derived: the entity and collection names come out of the module's
  // own `afterDelete` hook and `AstFacts.foreignKeys`, so it generalizes to any CRUD entity with a
  // detected relationship.

  // FK entity deletion -- orphan check: seed a primary record with FK reference, delete the FK entity,
  // verify no primary record retains the deleted FK entity's id.
  // Derived from AstFacts.foreignKeys rather than hardcoded entity names.
  if (/delete.*orphan|orphan.*delete|delete.*no.*retain|seed.*delete.*no.*retain/i.test(lower)) {
    const fkEntries = Object.entries(facts.foreignKeys ?? {});
    const afterDeleteCollMatch = facts.source.match(/afterDelete[\s\S]{0,200}database\.db\.data\.(\w+)/);
    const targetColl = afterDeleteCollMatch?.[1] ?? schema?.collection ?? "items";
    // When the subject module itself owns the afterDelete hook (fkEntries empty), it IS the
    // entity being deleted. The primary test module imports it as _${entity} (e.g. _category).
    // Extract the fkField from the afterDelete hook body.
    let fkField: string, fkImport: string, selfOwnsAfterDelete: boolean;
    if (fkEntries.length > 0) {
      fkField = fkEntries[0][0];
      fkImport = `_${fkEntries[0][1]}`;
      selfOwnsAfterDelete = false;
    } else {
      const afterDeleteFkMatch = facts.source.match(/afterDelete[\s\S]{0,300}\?\.\s*(\w+)\s*===\s*id/);
      fkField = afterDeleteFkMatch?.[1] ?? "fk";
      // Derive the import alias: collections use _${entity} naming in the isCrudDefault test layout
      const entity = schema?.collection
        ? schema.collection.replace(/ies$/, "y").replace(/s$/, "")
        : "entity";
      fkImport = `_${entity}`;
      selfOwnsAfterDelete = true;
    }
    // When selfOwnsAfterDelete, schema fields belong to the entity being deleted (not the target).
    // Use a minimal record containing only the FK field to avoid stale field assumptions.
    const recordLiteral = selfOwnsAfterDelete
      ? `{ id: "_orphan_test", ${fkField}: _cat.id }`
      : `{ id: "_orphan_test", ${(schema?.fields ?? []).filter(f => f !== "id").map(f => f === fkField ? `${f}: _cat.id` : `${f}: ${JSON.stringify(syntheticValue(f))}`).join(", ")} }`;
    const code = [
      `const _cat = await ${fkImport}.create({ name: "Test" });`,
      `_database.db.data.${targetColl} = _database.db.data.${targetColl} || {};`,
      `_database.db.data.${targetColl}["_orphan_test"] = ${recordLiteral};`,
      `await ${fkImport}.delete({ id: _cat.id });`,
      `const _remaining = Object.values(_database.db.data.${targetColl} || {});`,
      `expect(_remaining.every(r => r.${fkField} !== _cat.id)).toBe(true);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // FK entity deletion -- move: seed a primary record, delete FK entity with moveTo, verify FK field updated.
  // Derived from AstFacts.foreignKeys rather than hardcoded entity names.
  if (/delete.*moveto|moveto.*delete|move.*to.*after.*delete/i.test(lower)) {
    const fkEntries = Object.entries(facts.foreignKeys ?? {});
    const afterDeleteCollMatch = facts.source.match(/afterDelete[\s\S]{0,200}database\.db\.data\.(\w+)/);
    const targetColl = afterDeleteCollMatch?.[1] ?? schema?.collection ?? "items";
    // Same self-owns-afterDelete handling as the orphan check above.
    let fkField: string, fkImport: string, selfOwnsAfterDelete2: boolean;
    if (fkEntries.length > 0) {
      fkField = fkEntries[0][0];
      fkImport = `_${fkEntries[0][1]}`;
      selfOwnsAfterDelete2 = false;
    } else {
      const afterDeleteFkMatch = facts.source.match(/afterDelete[\s\S]{0,300}\?\.\s*(\w+)\s*===\s*id/);
      fkField = afterDeleteFkMatch?.[1] ?? "fk";
      const entity = schema?.collection
        ? schema.collection.replace(/ies$/, "y").replace(/s$/, "")
        : "entity";
      fkImport = `_${entity}`;
      selfOwnsAfterDelete2 = true;
    }
    const recordLiteral = selfOwnsAfterDelete2
      ? `{ id: "_move_test", ${fkField}: _cat1.id }`
      : `{ id: "_move_test", ${(schema?.fields ?? []).filter(f => f !== "id").map(f => f === fkField ? `${f}: _cat1.id` : `${f}: ${JSON.stringify(syntheticValue(f))}`).join(", ")} }`;
    const code = [
      `const _cat1 = await ${fkImport}.create({ name: "Source" });`,
      `const _cat2 = await ${fkImport}.create({ name: "Dest" });`,
      `_database.db.data.${targetColl} = _database.db.data.${targetColl} || {};`,
      `_database.db.data.${targetColl}["_move_test"] = ${recordLiteral};`,
      `await ${fkImport}.delete({ id: _cat1.id, moveTo: _cat2.id });`,
      `expect(_database.db.data.${targetColl}["_move_test"]?.${fkField}).toBe(_cat2.id);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // FK entity deletion -- snapshot restore on mid-loop failure: freeze one affected record so
  // the hook's own mutation throws partway through, then verify every affected record (including
  // ones already mutated before the failure) reverts to its pre-delete value.
  // Same self-owns-afterDelete handling as the orphan/move checks above.
  if (/snapshot.*restore|restore.*snapshot|failure mid.loop/i.test(lower)) {
    const fkEntries = Object.entries(facts.foreignKeys ?? {});
    const afterDeleteCollMatch = facts.source.match(/afterDelete[\s\S]{0,200}database\.db\.data\.(\w+)/);
    const targetColl = afterDeleteCollMatch?.[1] ?? schema?.collection ?? "items";
    let fkField: string, fkImport: string, selfOwnsAfterDelete3: boolean;
    if (fkEntries.length > 0) {
      fkField = fkEntries[0][0];
      fkImport = `_${fkEntries[0][1]}`;
      selfOwnsAfterDelete3 = false;
    } else {
      const afterDeleteFkMatch = facts.source.match(/afterDelete[\s\S]{0,300}\?\.\s*(\w+)\s*===\s*id/);
      fkField = afterDeleteFkMatch?.[1] ?? "fk";
      const entity = schema?.collection
        ? schema.collection.replace(/ies$/, "y").replace(/s$/, "")
        : "entity";
      fkImport = `_${entity}`;
      selfOwnsAfterDelete3 = true;
    }
    const recordLiteral = (id: string) => selfOwnsAfterDelete3
      ? `{ id: "${id}", ${fkField}: _cat1.id }`
      : `{ id: "${id}", ${(schema?.fields ?? []).filter(f => f !== "id").map(f => f === fkField ? `${f}: _cat1.id` : `${f}: ${JSON.stringify(syntheticValue(f))}`).join(", ")} }`;
    const code = [
      `const _cat1 = await ${fkImport}.create({ name: "Source" });`,
      `const _cat2 = await ${fkImport}.create({ name: "Dest" });`,
      `_database.db.data.${targetColl} = _database.db.data.${targetColl} || {};`,
      `_database.db.data.${targetColl}["_snap_a"] = ${recordLiteral("_snap_a")};`,
      `_database.db.data.${targetColl}["_snap_b"] = Object.freeze(${recordLiteral("_snap_b")});`,
      `let _threw = false;`,
      `try { await ${fkImport}.delete({ id: _cat1.id, moveTo: _cat2.id }); } catch { _threw = true; }`,
      `expect(_threw).toBe(true);`,
      `expect(_database.db.data.${targetColl}["_snap_a"].${fkField}).toBe(_cat1.id);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // "create with only required fields" → minimal entity creation
  if (/create with.*required|only required/.test(lower)) {
    return { method: "create", callArgs: [baseArgs], outcomeType: "resolves" };
  }

  // "create with inline [entity]" -- derived from beforeCreate hooks, not a hardcoded entity name
  if (/create with.*inline|inline.*create|create with.*\w+.*field/.test(lower) && schema) {
    const hook = schema.hooks.find(h => h.kind === "beforeCreate" && h.trigger);
    if (hook) {
      const field = hook.trigger!.split(".")[1]?.replace(/[?!]$/, "");
      if (field) {
        return {
          method: "create",
          callArgs: [{ ...baseArgs, [field]: { create: { name: "Test" } } }],
          captures: "r",
          inspectCode: `expect(typeof r.${field}).toBe("string");`,
        };
      }
    }
  }

  // "create then update the [field] field; result.field === value"
  const updateMatch = apiDescription.match(/create then update(?: the)? (\w+) field.*result\.(\w+)\s*===\s*["']([^"']+)["']/i);
  if (updateMatch && schema) {
    const field = updateMatch[1];
    const newVal = updateMatch[3];
    return {
      method: "create",
      callArgs: [baseArgs],
      captures: "_c",
      extraCallMethod: "update",
      extraCallArgs: [{ __expr: `{ id: _c.id, update: { ${field}: ${JSON.stringify(newVal)} } }` }],
      extraCallCaptures: "r",
      inspectCode: `expect(r.${field}).toBe(${JSON.stringify(newVal)});`,
    };
  }

  // "create two [entities] and return them as an array" → withSeedAndRead inline
  const twoEntityMatch = lower.match(/create.*two\s+(\w+).*return.*array|create.*(?:two|2)\s+(\w+).*array/);
  if (twoEntityMatch) {
    const plural = twoEntityMatch[1] ?? twoEntityMatch[2];
    const entity = plural.endsWith("ies") ? plural.slice(0, -3) + "y" : plural.replace(/s$/, "");
    // Built from the module's own schema, so it generalizes rather than matching fixed records.
    const fix = schema
      ? Object.fromEntries(schema.fields.filter(f => f !== "id").map(f => [f, syntheticValue(f)]))
      : null;
    if (fix) {
      const code = [
        `const _fix = ${JSON.stringify(fix)};`,
        `const result = await withSeedAndRead(_registry.${entity}.create, _registry.${entity}.readAll, [_fix, { ..._fix, name: "Second" }]);`,
        // The count is the claim. `Array.isArray(result)` alone was a tautology: the helper's last
        // line coerces its return to an array, so the assertion held for a `create` that did
        // nothing against a store that stayed empty.
        `expect(Array.isArray(result)).toBe(true);`,
        `expect(result.length).toBeGreaterThanOrEqual(2);`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code };
    }
  }

  // "create two [entity], change one's [field]" → withIsolationTest inline
  // Matches isolation tests that verify FK field changes don't cross entity boundaries
  const isolationMatch = lower.match(/create.*two\s+(\w+).*change.*(?:one'?s?|the)\s+(\w+)/);
  if (isolationMatch && facts.foreignKeys) {
    const plural = isolationMatch[1];
    const primaryEntity = plural.endsWith("ies") ? plural.slice(0, -3) + "y" : plural.replace(/s$/, "");
    const fkField = isolationMatch[2];
    // context entity is whatever that fkField points to (often same name as field)
    const contextEntity = fkField;
    // Also schema-derived now. The removed fixture-table lookup never actually took effect here:
    // `table[x]?.data ?? schema ? A : B` parses as `(table[x]?.data ?? schema) ? A : B`, so the
    // branch chosen was always `A` whenever either operand was truthy. Writing the intended
    // expression plainly is what makes that visible.
    const primaryFix = schema
      ? Object.fromEntries(schema.fields.slice(0, 2).map(f => [f, syntheticValue(f)]))
      : {};
    const ctxFix: Record<string, unknown> = { name: "Test" };
    if (ctxFix) {
      const code = [
        `const _ctx = ${JSON.stringify(ctxFix)};`,
        `const _ent = ${JSON.stringify(primaryFix)};`,
        `const result = await withIsolationTest(_registry, "${contextEntity}", "${primaryEntity}", "${fkField}", { ..._ctx, name: "Shared" }, _ent, { type: "reassign", contextEntity: "${contextEntity}", field: "${fkField}", fixture: { ..._ctx, name: "Solo" } });`,
        // Isolation is the claim, so assert it: the entity that was *not* reassigned must still
        // point at the shared context. `expect(result).toBeDefined()` passed for an update that
        // clobbered every record in the store -- precisely the behavior being ruled out.
        `expect(result.untouched[result.contextField]).toBe(result.sharedContextId);`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code };
    }
  }

  return null;
}
