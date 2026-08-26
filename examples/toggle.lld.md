# Toggle
> examples/toggle.ts

A two-state button. The design decision: activation reports through `onPointerPress`, fired on pointerdown-then-pointerup rather than a native `click` -- the same convention every pointer-driven component in this vocabulary uses, so one derivation pattern covers all of them instead of each component inventing its own event contract.

Copy `examples/auth.lld.md` for your first document, not this one. Every claim here is bare prose with no arrow and no call, and it turns green only because the subject is a DOM component class whose shape the component patterns recognize -- see GRAMMAR.md's "Component UI classes". Written this way against an ordinary module, all of these would stay pending, and the document would not tell you why.

## Activation follows the shared pointer-press convention, not a native click

- clicking the toggle invokes onPointerPress

## The disabled option sets the native disabled attribute

- the disabled attribute is set on the element
