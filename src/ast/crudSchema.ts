// Schema and CRUD fact derivation: everything keyed off the createCRUD factory convention --
// schema extraction, hook extraction, foreign keys inferred from hook triggers, the entity
// index, and the return types of the virtual methods the CRUD/self-database families emit.
// Regex substance, like sourceScrapers.ts; split out because these facts form one CRUD-shaped
// cluster the rest of the extraction only consumes.

import type { SchemaInfo, HookInfo } from "./types.ts";

// ── Schema extraction ─────────────────────────────────────────────────
// Detects: createCRUD('name', ['field1', 'field2'], { hooks })
//          mongoose.Schema({ field: type })
//          similar factory / schema patterns

const CRUD_FACTORY = /createCRUD\(\s*['"`](\w+)['"`]\s*,\s*(\[[^\]]+\])/g;
const FIELD_LIST   = /['"`](\w+)['"`]/g;
const FIELD_DEFAULT_EQ_EMPTY = /\?\?\s*['"]{2}/;  // ?? '' pattern
const FIELD_DEFAULT_NULL      = /\?\?\s*null/;

export function extractSchemas(source: string): SchemaInfo[] {
  const schemas: SchemaInfo[] = [];

  for (const match of source.matchAll(CRUD_FACTORY)) {
    const collection = match[1];
    const fieldsRaw  = match[2];

    const fields: string[] = [];
    for (const f of fieldsRaw.matchAll(FIELD_LIST)) fields.push(f[1]);

    const fieldDefault = FIELD_DEFAULT_EQ_EMPTY.test(source) ? "''"
      : FIELD_DEFAULT_NULL.test(source)       ? "null"
      : undefined;

    const hooks = extractHooks(source, collection);
    schemas.push({ collection, fields, fieldDefault, hooks });
  }

  return schemas;
}

function extractHooks(source: string, _collection: string): HookInfo[] {
  const hooks: HookInfo[] = [];

  // beforeCreate with optional-chain trigger: data.X?.create
  const beforeCreateBody = source.match(/beforeCreate[^}]+}/s)?.[0] ?? "";
  if (beforeCreateBody) {
    const triggerMatch = beforeCreateBody.match(/(data\.\w+\?\.\w+)/);
    hooks.push({
      kind: "beforeCreate",
      trigger: triggerMatch?.[1],
      description: triggerMatch
        ? `inline sub-entity creation when ${triggerMatch[1]} is present`
        : undefined,
    });
  }

  const beforeUpdateBody = source.match(/beforeUpdate[^}]+}/s)?.[0] ?? "";
  if (beforeUpdateBody) {
    const triggerMatch = beforeUpdateBody.match(/(update\.\w+\?\.\w+)/);
    if (triggerMatch) {
      hooks.push({ kind: "beforeUpdate", trigger: triggerMatch[1] });
    }
  }

  const afterDeleteBody = source.match(/afterDelete[^}]+}/s)?.[0] ?? "";
  if (afterDeleteBody) hooks.push({ kind: "afterDelete" });

  return hooks;
}

// ── Default-export CRUD detection ────────────────────────────────────

/** Detects if this is a default-exporting CRUD module (createCRUD pattern in source). */
export function detectDefaultCrudExport(source: string): boolean {
  return /export\s+default\s+createCRUD\b/.test(source)
    || (/export\s+default\s+/.test(source) && extractSchemas(source).length > 0);
}

// ── Entity index ─────────────────────────────────────────────────────

/** Builds the entity index from schema collection names + exported function name patterns. */
export function buildEntityIndex(schemas: SchemaInfo[]): Record<string, { create?: string; read?: string; search?: string }> {
  const entityIndex: Record<string, { create?: string; read?: string; search?: string }> = {};
  for (const schema of schemas) {
    // Convert collection name to entity label: "searchEngines" → "searchEngine"
    const label = schema.collection.replace(/s$/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase();
    entityIndex[label] = {
      create: schema.collection + ".create",
      read: schema.collection + ".read",
    };
  }
  return entityIndex;
}

// ── Foreign keys from hook triggers ──────────────────────────────────

/** Detects foreign key relationships from hooks: a trigger "data.category?.create" is an FK from
 *  the current entity to "category". entityTypes collects primary + related entity names. */
export function deriveForeignKeysFromHooks(schemas: SchemaInfo[]): { foreignKeys: Record<string, string>; entityTypes: string[] } {
  const foreignKeys: Record<string, string> = {};
  const entityTypes: string[] = [];

  for (const schema of schemas) {
    entityTypes.push(schema.collection);
    for (const hook of schema.hooks) {
      if (hook.trigger) {
        // "data.fieldName?.create" → FK to entity named by fieldName
        const fkMatch = hook.trigger.match(/data\.(\w+)\??\.\w+/);
        if (fkMatch) {
          const fkField = fkMatch[1];
          // Infer entity type from the field name (category → category, authorId → author)
          const relatedEntity = fkField.replace(/Id$/, "");
          foreignKeys[fkField] = relatedEntity;
          if (!entityTypes.includes(relatedEntity)) entityTypes.push(relatedEntity);
        }
      }
    }
  }

  return { foreignKeys, entityTypes };
}

// ── Virtual-method return types ──────────────────────────────────────

/** Return types for virtual methods derived from patterns (no __lld_api needed).
 *  Mutates `returnTypes` in place, filling only keys the __lld_api scrape left unset. */
export function addVirtualMethodReturnTypes(
  returnTypes: Record<string, string>,
  schemas: SchemaInfo[],
  foreignKeys: Record<string, string>,
  isSelfDatabase: boolean
): void {
  const schema0 = schemas[0];
  if (schema0) {
    const entity0 = schema0.collection.replace(/ies$/, "y").replace(/s$/, "");
    returnTypes["createMinimal"]          ??= entity0;
    returnTypes["updateName"]             ??= entity0;
    returnTypes["updateUrl"]              ??= entity0;
    // Dynamic FK-based virtual method return types
    for (const [fkField, relatedEntity] of Object.entries(foreignKeys)) {
      const cap = fkField.charAt(0).toUpperCase() + fkField.slice(1);
      const plural = relatedEntity.endsWith("y") ? relatedEntity.slice(0,-1)+"ies" : relatedEntity+"s";
      const capPlural = plural.charAt(0).toUpperCase() + plural.slice(1);
      returnTypes[`createWith${cap}Field`]   ??= entity0;
      returnTypes[`change${cap}Isolation`]   ??= entity0;
      returnTypes[`read${capPlural}`]        ??= `${relatedEntity}[]`;
      returnTypes[`deleteOrphans`]           ??= "void";
      returnTypes[`deleteAndMove`]           ??= "void";
    }
  }
  if (isSelfDatabase) {
    returnTypes["readAll"]                ??= "object";
    returnTypes["writesInOrder"]          ??= "boolean";
    returnTypes["queueFailThenRecover"]   ??= "boolean";
    returnTypes["addFieldAndRead"]        ??= "object";
  }
  // The return types for the synthesized search-provider methods were declared here. Removed with
  // the methods themselves -- see the note in apiVocabulary.ts where they were emitted.
}
