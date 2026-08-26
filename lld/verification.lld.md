# Verification
> src/drift.ts

A design document without a feedback loop is a snapshot that decays. Two mechanisms close the loop: drift detection asks whether the implementation still honors the design; mutation testing asks whether the design's claims are strong enough to catch real bugs. Together they answer the question: does this document still mean something?

## A signature change is detected as drift
**method:** `compareImplementations`

- when a function's parameter list changes, that is drift; the LLD must be updated to reflect the new contract
  - does comparing a function with an added parameter produce at least one change?

## A removed export is high-risk drift
**method:** `compareImplementations`

- removing an export is the highest-risk change; callers that depend on it will break
  - does a function present in before but absent in after produce a finding?

## Added exports never generate drift impacts
**method:** `compareSourcesForDrift`

The addition is still reported as a change, because it is one. What it never does is produce an
impact against an existing claim -- and impacts are what an author is asked to re-read. Treating
every new export as something to review would make the channel noisy enough to ignore, which
costs more than the additions were ever worth.

- adding a new export to a module does not constitute drift for existing claims -- nothing that existed before is broken by addition; only changes and removals affect what the document already describes
  - compareSourcesForDrift("export function a() { return 1; }", "export function a() { return 1; } export function b() { return 2; }", ["a returns one"]) captures r → r.impacts.length === 0
  - compareSourcesForDrift("export function a() { return 1; }", "export function a() { return 1; } export function b() { return 2; }", ["a returns one"]) captures r → r.changes.length === 1

## An unchanged implementation reports no drift at all
**method:** `compareSourcesForDrift`

- comparing a module against itself produces null rather than an empty report; there is nothing for an author to look at, and saying so with a value keeps the caller from having to distinguish "no findings" from "nothing ran"
  - compareSourcesForDrift("export function a() { return 1; }", "export function a() { return 1; }") captures r → r === null

## Structural changes produce impacts on related claims
**method:** `compareSourcesForDrift`

- when a structural change is detected, drift maps the change to the claims that describe that behavior -- the author sees exactly which claims need review
  - compareSourcesForDrift("export function login(e) { return 1; }", "export function login(e, m) { return 1; }", ["login rejects a bad email"]) captures r → r.impacts.length === 1

## Drift covers behavioral contracts, not only structural signatures
**method:** `compareImplementations`

- guard removal is drift -- if a function previously checked for null or undefined and no longer does, the behavioral contract changed even if the signature is identical; this carries high risk
  - does removing a null guard produce a drift finding even when the signature is unchanged?
  - compareSourcesForDrift("export function f(x) { if (!x) return 0; return x * 2; }", "export function f(x) { return x * 2; }", ["f doubles its argument"]) captures r → r.changes.length === 1
- try/catch removal is drift -- a function that previously absorbed exceptions and now propagates them has changed its contract
  - compareSourcesForDrift("export function f() { try { g(); } catch (e) { return 0; } return 1; }", "export function f() { g(); return 1; }", ["f absorbs failures"]) captures r → r.changes.length === 1

## A renamed export is two changes, not one
**method:** `compareImplementations`

- renaming is not a single operation in the structural model -- it is one export disappearing and a new one appearing; the LLD must be updated to reflect the new name
  - does renaming an export produce exactly two findings?

## Mutations verify that claims have teeth
**module:** `src/mutate.ts`
**method:** `buildMutations`

- a test that passes even when the code is wrong adds no value; mutation testing generates targeted variants of the implementation and checks whether the claims catch each one
  - buildMutations("const x = a === b;") captures r → r.length > 0
- source with nothing worth mutating produces no mutants, rather than a mutant that changes nothing; an empty result is an honest "no probe available here"
  - buildMutations("export const x = 1;") captures r → r.length === 0

## Every generated mutant must be able to load
**module:** `src/mutate.ts`
**method:** `buildMutations`

A mutant that does not parse cannot run, and a mutant that cannot run teaches nothing about the
claims. Two operators used to emit invalid code -- one deleted a guard line along with the `{` it
opened, the other rewrote the first line of a multi-line `return` and orphaned the body under it.
Both produced mutants that failed to load, and a failed load was scored as a kill, so the tool
reported strong claims exactly where it had learned nothing.

The operators no longer generate those shapes, and a parse check drops anything that slips
through. Reporting is the other half: an unloadable mutant is counted on its own rather than being
folded into either the caught or the survived pile.

- a mutant is only useful if it parses; a multi-line return is left alone rather than rewritten into a syntax error
  - buildMutations("export function f() { return { a: 1 }; }") captures r → r.length > 0

