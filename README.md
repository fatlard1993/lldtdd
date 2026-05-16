# lldtdd

Intent documentation that runs.

---

## What it is

An LLD (Low Level Design) document is a versioned design contract. You write it before you write code. It commits your intent about a logical slice of the solution — what it should do, what decisions were made, what would surprise a naive implementer.

The test runner converts that intent into pass/fail. But the document's primary artifact is its **commit history**. The git log of an LLD file is the history of the product's design thinking for that slice.

**A change to an LLD is a design decision, not a bug fix.** The commit message should explain why the vision changed.

---

## The lifecycle

```
commit LLD      intent documented, all assertions pending
implement       assertions go from pending to passing
assertion fails implementation drifted from intent (regression)
LLD changes     vision evolved — log the why
```

When all assertions in an LLD pass, the implementation satisfies the documented intent for that slice. That is the moment you can say: *we built what we said we'd build.*

---

## What belongs in an LLD

Three questions. All three must be yes.

1. Does this assertion express a **decision** that shaped the design?
2. Would a developer implementing naively **get this wrong**?
3. Would a future developer reading only this file understand **what was chosen and what was rejected**?

If any answer is no, it belongs in a unit test, not an LLD.

---

## Quick example

```markdown
# Auth Service
> src/auth.ts

Identity verification and session management. Passwords are never returned or stored
in tokens. Tokens are time-bounded. Failed attempts are tracked per user, not per session.

## Login
**method:** `login`

- wrong password -> `AuthError` // the error does not distinguish wrong password from unknown email
- locked account -> `AuthError` regardless of whether the password would have been correct
- five consecutive failures lock the account // the sixth attempt sees AuthError even with correct credentials
- a successful login resets the failure counter to zero
  - does a success after failures allow subsequent logins to proceed normally?

## Security invariants

- login("user@example.com", "password123") captures result -> result.token does not contain "password123"
- login("user@example.com", "password123") captures result -> result.expiresAt is within 24 hours from now
```

Indented questions (`  - does X?`) are **perspectives** — focused sub-questions that derive targeted verification tests. The parent assertion documents the decision; the perspective proves a specific aspect of it.

---

## Commands

```bash
lldtdd run [--verbose|-v] [pattern]   Run assertions + drift + mutation (default: **/*.lld.md)
lldtdd lint [pattern]                 Check LLD files for structure and style issues
lldtdd suggest [--apply] <file>       Show (or apply) auto-inferred method decorations
lldtdd drift <file.lld.md>            Detect structural changes that may invalidate claims
lldtdd mutate <file.lld.md>           Find claims that don't catch real implementation bugs
lldtdd help                           Show this message
```

`run` includes drift checking and mutation testing inline — after assertions pass, it checks whether the implementation has drifted from HEAD and whether any mutations of the implementation would go undetected by the claims.

Use `--verbose` (or `-v`) to see the derived test for each assertion: source, method call, and assertion type.

---

## Pending state

Pending is not a problem. An LLD written before implementation will be entirely pending — that is the correct starting state.

```
○  pending    intent documented, not yet verified
✓  passing    intent verified against implementation
✗  failing    implementation drifted from intent
```

---

## Test derivation

Most assertions derive tests automatically without AI. The system reads the implementation module's AST and derives:

- **CRUD schema** → create/update/schema-drop/default-field tests
- **FK relationships** → isolation tests, category list tests
- **`isSelfDatabase` pattern** → write-queue ordering, fault recovery, schema evolution tests
- **Search-engine schema** (`resultsPath` + `primaryAction` + `fetch`) → search provider tests, mock shapes
- **Conditional invariants** (`when [field] is set, [output] is [property]`) → field-controlled behavior tests

English assertions that don't match deterministic or AST patterns are translated by Claude before the adapter runs them. Translations are cached by content hash. As the grammar matures, the AI is called less.

---

## Adapters

The runner translates intent into executable tests via adapters. Each adapter generates and runs tests for a specific framework and reports results back. Currently supported: `bun`.

Adapters are configured per repo in `.lldtddrc`:

```json
{
  "mappings": [
    { "glob": "lld/**/*.lld.md", "adapter": "bun" }
  ]
}
```

---

## Grammar

See [GRAMMAR.md](./GRAMMAR.md) for the full assertion syntax, outcome patterns, perspectives, and authoring guidance.
