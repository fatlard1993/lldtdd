# Verification
> src/drift.ts

A design document without a feedback loop is a snapshot that decays. Two mechanisms close the loop: drift detection asks whether the implementation still honors the design; mutation testing asks whether the design's claims are strong enough to catch real bugs. Together they answer the question: does this document still mean something?

## A signature change is detected as drift
**method:** `compareImplementations`

- when a function's parameter list changes, that is drift; the LLD must be updated to reflect the new contract
  - does comparing a function with an added parameter produce at least one change?

## Identical signatures produce no drift
**method:** `compareImplementationsNoChange`

- drift is only reported when something actually changed; an unchanged module is clean
  - does comparing identical exported signatures produce an empty result?

## A removed export is high-risk drift
**method:** `compareImplementationsRemovedExport`

- removing an export is the highest-risk change; callers that depend on it will break
  - does a function present in before but absent in after produce a finding?

## Added exports never generate drift impacts
**method:** `driftFromSourceAddedExport`

- adding a new export to a module does not constitute drift for existing claims — nothing that existed before is broken by addition; only changes and removals affect what the document already describes
  - does adding a new export produce a finding with no impact on existing claims?

## Identical source content produces no drift
**method:** `driftFromUnchangedSource`

- drift detection skips modules whose content hasn't changed — comparing identical source to itself produces no signal; there is nothing to report
  - does comparing identical source content return null?

## Structural changes produce impacts on related claims
**method:** `driftFromSourceChange`

- when a structural change is detected, drift maps the change to the claims that describe that behavior — the author sees exactly which claims need review
  - does a parameter change produce at least one impact against a related claim?

## Drift covers behavioral contracts, not only structural signatures
**method:** `compareImplementationsGuardRemoval`

- guard removal is drift — if a function previously checked for null or undefined and no longer does, the behavioral contract changed even if the signature is identical; this carries high risk
- try/catch removal is drift — a function that previously absorbed exceptions and now propagates them has changed its contract
  - does removing a null guard produce a drift finding even when the signature is unchanged?

## Try/catch removal is behavioral drift
**method:** `compareImplementationsNoCatch`

- removing a try/catch changes what happens when the implementation encounters an error — the caller's contract changes even if the public signature does not
  - does removing a try/catch block produce a drift finding?

## A renamed export is two changes, not one
**method:** `compareImplementationsRenameExport`

- renaming is not a single operation in the structural model — it is one export disappearing and a new one appearing; the LLD must be updated to reflect the new name
  - does renaming an export produce exactly two findings?

## Mutations verify that claims have teeth
**module:** `src/mutate.ts`
**method:** `mutationsFromSource`

- a test that passes even when the code is wrong adds no value; mutation testing generates targeted variants of the implementation and checks whether the claims catch each one — a source string with a binary operator produces at least one mutation

