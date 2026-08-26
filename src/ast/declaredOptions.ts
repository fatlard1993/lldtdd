// Reading a component's own declaration to build a valid construction argument.
//
// Constructing with `{}` leaves an option-driven component inert: setters never run, so listeners
// are not attached and deferred work is never armed. A pattern that needs to *drive* a component
// therefore needs it built the way its author intended, and the only trustworthy source for that is
// the module itself.
//
// Two declarations carry it, and neither alone is enough. `static schema` gives defaults and enums --
// across one real corpus that typed only 4 components out of 24. JSDoc `@param` gives the actual
// types, and is a universal convention rather than one project's. Together they resolved 13 of 24,
// and every one of those 13 constructed without throwing.

function balanced(src: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return { body: src.slice(open + 1, i), end: i }; }
  }
  return null;
}

function schemaEntries(source: string): Array<[string, string]> {
  const at = source.search(/static\s+schema\s*=\s*\{/);
  if (at < 0) return [];
  const outer = balanced(source, source.indexOf("{", at));
  if (!outer) return [];
  const entries: Array<[string, string]> = [];
  const block = outer.body;
  const keyRe = /(?:^|[,{]\s*)\s*(\w+)\s*:\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(block))) {
    const open = block.indexOf("{", m.index + m[0].length - 1);
    const inner = balanced(block, open);
    if (!inner) continue;
    entries.push([m[1], inner.body]);
    keyRe.lastIndex = inner.end;
  }
  return entries;
}

/** A value of the type a JSDoc `@param` annotation declares for an option, or undefined if the
 *  option is not annotated.
 *
 *  JSDoc is where the *type* lives. A `static schema` entry declares behaviour -- a default, an enum,
 *  a setter -- which says what a value must be only for the minority of options that have a default
 *  or an enum. Across one real corpus that was 4 components out of 24; the other 20 each had at
 *  least one option whose type appears nowhere but its `@param` line. */
function jsdocValue(source: string, key: string): string | undefined {
  const decl = source.match(new RegExp(`@param\\s*\\{([^}]+)\\}\\s*\\[?options\\.${key}\\b`))?.[1];
  if (!decl) return undefined;
  const t = decl.trim();

  return resolveType(t);
}

/** A value for a declared type, resolving a union to its first usable member.
 *
 *  `{string|object}`, `{Component|string}`, `{number|boolean}` -- a union offers a choice, and any
 *  member the caller can supply is a valid construction. Taking the first *resolvable* member is what
 *  lets an option documented as `Component|string` be built from the string half instead of being
 *  written off because the other half names a class nothing can invent.
 *
 *  Reading only the whole annotation treated every union as unknown, which reported six components as
 *  undocumented when their options were annotated all along. */
function resolveType(t: string): string | undefined {
  // A union of string literals is its own enum: ('center'|'top'|…)
  const literal = t.match(/^\(?\s*['"]([^'"]+)['"]/)?.[1];
  if (literal !== undefined) return JSON.stringify(literal);

  // Split only on top-level `|`. A union inside a generic belongs to the generic:
  // `Array<string|object>` is one list type, and splitting it blindly yields `Array<string` and
  // `object>`, neither of which is a type -- so an option annotated that way resolved to nothing and
  // took its whole component out of reach.
  const members: string[] = [];
  let depth = 0, current = "";
  for (const c of t.replace(/^\(|\)$/g, "")) {
    if ("<([".includes(c)) depth++;
    else if (">)]".includes(c)) depth--;
    if (c === "|" && depth === 0) { members.push(current); current = ""; continue; }
    current += c;
  }
  members.push(current);

  const parts = members.map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    for (const member of parts) {
      const v = scalarForType(member);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  return scalarForType(t);
}

/** The options a TypeScript component declares in its type annotation.
 *
 *  `options: { value?: boolean; onPointerPress?: (v: boolean) => void }` is a declaration in exactly
 *  the sense the other two readers care about -- it names every option and gives each a type, and the
 *  compiler holds it true. A TS component has no reason to also carry `@param` lines or a runtime
 *  `static schema`, so reading only those two made every TypeScript component look undeclared.
 *
 *  Returns `[name, type, optional]` triples. Optionality is the `?`, which carries the same meaning
 *  as JSDoc's brackets: a caller may leave this one out. */
function tsOptionEntries(source: string): Array<[string, string, boolean]> {
  const at = source.search(/\boptions\s*:\s*\{/);
  if (at < 0) return [];
  const body = balanced(source, source.indexOf("{", at))?.body;
  if (!body) return [];

  // Split on top-level separators only, so `(v: boolean) => void` and nested object types survive.
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const c of body) {
    if ("{([<".includes(c)) depth++;
    else if ("})]>".includes(c)) depth--;
    if ((c === ";" || c === ",") && depth === 0) { parts.push(current); current = ""; continue; }
    current += c;
  }
  parts.push(current);

  return parts
    .map(e => e.trim())
    .filter(Boolean)
    .flatMap(e => {
      const m = e.match(/^(\w+)\s*(\??)\s*:\s*([\s\S]+)$/);
      return m ? [[m[1], m[3].trim(), m[2] === "?"] as [string, string, boolean]] : [];
    });
}

/** A default the JSDoc line states inline: `@param {boolean} [options.autoOpen=true]`.
 *
 *  This is a declared default like any other, and it is the one place a boolean's intended value can
 *  be read rather than guessed. */
function jsdocDefault(source: string, key: string): string | undefined {
  const raw = source.match(new RegExp(`@param\\s*\\{[^}]+\\}\\s*\\[options\\.${key}\\s*=\\s*([^\\]]+)\\]`))?.[1]?.trim();
  if (raw === undefined) return undefined;
  if (/^(true|false|-?\d+(?:\.\d+)?)$/.test(raw)) return raw;
  if (/^['"].*['"]$/.test(raw)) return JSON.stringify(raw.slice(1, -1));
  return undefined;
}

/** Whether the module documents this option as one a caller may leave out.
 *
 *  JSDoc marks an optional parameter by bracketing its name -- `[options.footer]` -- which is exactly
 *  the question being asked. A bare `options.columns` is required, and omitting it is a guess about
 *  what the component tolerates rather than a documented use. */
function jsdocOptional(source: string, key: string): boolean {
  return new RegExp(`@param\\s*\\{[^}]+\\}\\s*\\[options\\.${key}[\\]=\\s]`).test(source);
}

/** Whether a type's values are behaviour modes rather than content.
 *
 *  A boolean option has exactly two values and both are meaningful, so picking one is picking a mode
 *  -- and the mode that suppresses behaviour is as likely as the one that enables it. Building a
 *  Toggle with `disabled: true` because its type is `boolean` produced a component that correctly
 *  ignored every interaction, and the claim about interacting with it failed against working code.
 *
 *  Content-typed options are different: a list, a string or a number supplies material the component
 *  renders, and supplying some is what makes claims about rendering answerable at all.
 *
 *  So a boolean with no declared default is left out, and the component's own default stands. This is
 *  the same reasoning that already omits any option whose default the module states -- the module
 *  knows better than we can guess -- applied to the case where the default is unstated. */
function isModeType(t: string): boolean {
  return /^boolean$/i.test(t.trim());
}

/** A value of a single declared type, as the *source text* that produces it.
 *
 *  Source rather than a value because these end up inside a generated test. Serialising with
 *  `JSON.stringify` silently drops a function, so a component documented as taking an `onSelect` was
 *  being constructed without one -- the handler the claim is about, missing, and no error to say so.
 *  Anything that needs to be constructed at test time (a callback, an element) has to survive as
 *  code. */
function scalarForType(t: string): string | undefined {
  // A list gets one element of the declared element type, not an empty list. An empty array is
  // well-typed and still wrong: it puts a list-rendering component into the one state where it
  // renders nothing, and every claim about what it renders is then either untestable or answered by
  // the empty case. A Menu built with `items: []` has no item to click, and "does clicking a menu
  // item invoke onSelect" passed anyway -- the root's own handler fired, with no item in existence.
  // One element is the construction a caller would recognise.
  const element = t.match(/^Array\s*<(.+)>$/i)?.[1] ?? (/\[\]$/.test(t) ? t.slice(0, -2) : null);
  if (element !== null) {
    const v = resolveType(element.trim());
    return v === undefined ? "[]" : `[${v}]`;
  }
  if (/^Array$/i.test(t)) return "[]";
  if (/^function/i.test(t) || /=>/.test(t)) return "() => {}";
  if (/^boolean$/i.test(t)) return "true";
  if (/^number$/i.test(t)) return "1";
  if (/^string$/i.test(t)) return '"lld"';
  if (/^object$/i.test(t) || /^Record</i.test(t)) return "{}";
  // `{*}` documents "anything", so a string satisfies it as well as any other choice.
  if (t === "*" || /^any$/i.test(t)) return '"lld"';
  // A DOM node is the one "named type" the test environment can supply, and options like
  // `appendTo` and `viewport` are exactly that.
  if (/^(?:HTMLElement|Element|Node|HTMLDivElement)$/i.test(t)) return 'document.createElement("div")';
  return undefined; // a class the application owns -- nothing safe to invent
}

/** Options the module declares as lists, by name.
 *
 *  A claim about mixed input -- "a single `items` array can contain mixed formats" -- names the shape
 *  of the values but not always the option holding them. The declaration does, and a component with
 *  exactly one list-typed option leaves nothing to guess. More than one is genuinely ambiguous, and
 *  the caller is expected to decline rather than pick. */
export function arrayOptionNames(source: string): string[] {
  const names = new Set<string>();
  for (const [key] of schemaEntries(source)) {
    const decl = source.match(new RegExp(`@param\\s*\\{([^}]+)\\}\\s*\\[?options\\.${key}\\b`))?.[1];
    if (decl && (/^Array\s*</i.test(decl.trim()) || /\[\]$/.test(decl.trim()))) names.add(key);
  }
  for (const [key, type] of tsOptionEntries(source)) {
    if (/^Array\s*</i.test(type) || /\[\]$/.test(type)) names.add(key);
  }
  return [...names];
}

/** Whether the module declares this option at all, by any of the three routes it might use.
 *
 *  Asked before handing a component an option it may not accept. A callback a component ignores is a
 *  spy that never fires, and that reads as a broken implementation rather than as a pattern reaching
 *  for something the module never offered. */
export function declaresOption(source: string, name: string): boolean {
  if (new RegExp(`@param\\s*\\{[^}]*\\}\\s*\\[?options\\.${name}\\b`).test(source)) return true;
  if (schemaEntries(source).some(([key]) => key === name)) return true;
  return tsOptionEntries(source).some(([key]) => key === name);
}

/** What the module says a valid construction looks like, and which options it could not type.
 *
 *  `unresolved` is the honest half. Constructing with a guessed value throws inside the component,
 *  which surfaces as a failing claim against code that is perfectly correct -- so a caller that
 *  cannot afford that can decline instead of guessing. */
export function declaredConstructorOptions(source: string): {
  /** A JS object-literal *source string*, ready to drop into generated code. */
  optionsCode: string;
  /** Option names the declaration does not type. Non-empty means construction would be a guess. */
  unresolved: string[];
} {
  const literals = (t: string) => [...t.matchAll(/['"`]([^'"`]*)['"`]/g)].map(m => m[1]);
  const options: Record<string, string> = {};
  const unresolved: string[] = [];

  for (const [key, body] of schemaEntries(source)) {
    // An enum names its own valid members, so it wins: it is the one declaration that can *reject*
    // an otherwise well-typed value.
    // Bracketed arrays captured whole -- `[^,\n]+` stops at the first comma, which truncates every
    // multi-value inline enum. Harmless here, where only the first value is used, and not harmless in
    // `declaredOptionValues`, which needs two and concluded there was only one.
    const enumRef = body.match(/\benum\s*:\s*(\[[^\]]*\]|[^,\n]+)/)?.[1]?.trim();
    if (enumRef) {
      let vals = enumRef.startsWith("[") ? literals(enumRef) : [];
      if (!vals.length && /^[A-Za-z_$][\w$]*$/.test(enumRef)) {
        const d = source.match(new RegExp(`\\b${enumRef}\\s*=\\s*(?:Object\\.freeze\\()?\\s*\\[([\\s\\S]*?)\\]`))?.[1];
        if (d) vals = literals(d);
      }
      if (vals.length) { options[key] = JSON.stringify(vals[0]); continue; }
    }

    const def = body.match(/\bdefault\s*:\s*(true|false|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|\[\s*\])/)?.[1];
    if (def !== undefined) {
      options[key] = def === "true" || def === "false" || def === "[]" ? def
        : /^-?\d/.test(def) ? def
        : JSON.stringify(def.slice(1, -1));
      continue;
    }

    // A default the component computes rather than states -- `get default() { return document.body; }`
    // is the common shape for a mount target. There is nothing to copy, but nothing needs copying:
    // an option with a default is one the component fills in itself, and its setter runs either way.
    // Omitting it is strictly safer than inventing a value, and it is not a gap in the declaration.
    if (/\bdefault\b\s*[:(]/.test(body)) continue;

    const inline = jsdocDefault(source, key);
    if (inline !== undefined) { options[key] = inline; continue; }

    // A boolean whose default nothing states: leave it to the component. See `isModeType`. Only an
    // option that is *only* a boolean qualifies -- `{boolean|string}` offers a value that is content,
    // and that half can be supplied without choosing a mode.
    const declaredType = source.match(new RegExp(`@param\\s*\\{([^}]+)\\}\\s*\\[?options\\.${key}\\b`))?.[1];
    if (declaredType !== undefined && isModeType(declaredType)) continue;

    const typed = jsdocValue(source, key);
    if (typed !== undefined) { options[key] = typed; continue; }

    // An option the module declares as optional -- `@param {Component} [options.ListItemComponent]`,
    // brackets and all -- can be left out, and leaving it out is not a guess: it is what the majority
    // of callers do, and the component is documented to cope. Only options whose type we cannot
    // supply *and* whose declaration does not say they are skippable make construction a guess.
    //
    // Without this, one optional slot naming a class nothing can invent disqualified an entire
    // component. Menu declares `ListItemComponent` that way, and a claim about its `onSelect` -- an
    // option fully declared and central to the claim -- went pending over an unrelated option the
    // test never needed to set.
    if (jsdocOptional(source, key)) continue;

    unresolved.push(key);
  }

  // A TypeScript component declares its options in the type, and has no reason to repeat itself in
  // `@param` lines or a runtime `static schema`. Consulted only when neither of those said anything,
  // so a JS component's schema stays authoritative and nothing here can override it.
  if (Object.keys(options).length === 0 && unresolved.length === 0) {
    for (const [key, type, optional] of tsOptionEntries(source)) {
      if (isModeType(type)) continue; // see `isModeType` -- the component's own default stands
      const v = resolveType(type);
      if (v !== undefined) options[key] = v;
      else if (!optional) unresolved.push(key);
    }
  }

  const optionsCode = `{ ${Object.entries(options).map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
  return { optionsCode, unresolved };
}
