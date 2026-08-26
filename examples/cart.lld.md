# Cart Service
> examples/cart.ts

Prices are always fetched live, never stored in the cart.

Checkout is out of scope for this document. Pricing is decided at read time, so the cart's own
design is complete without it.

## Adding items
**method:** `addItem`

- an invalid item -- out of stock, or not in the catalog -- is rejected before any mutation occurs // failure is atomic, not partial
  - addItem("sess1", "sku-out") -> `CartError`
  - addItem("sess1", "sku-does-not-exist") -> `CartError`
- adding the same item twice raises its quantity rather than adding a second line // a cart holds one line per item, so callers never have to merge duplicates themselves
  - addItem("merge-1", "sku-apple") captures first then addItem("merge-1", "sku-apple") captures second -> second.items.length === 1

## Pricing
**method:** `getTotal`

- discounts apply at checkout, not at add-time // adding to cart never triggers discount logic
  - addItem("disc-1", "sku-apple") captures cart and getTotal("disc-1") captures total -> total === 1.5

## Session isolation

- two sessions never share a cart // each session has independent state
  - addItem("iso-a", "sku-apple") captures cartA and getTotal("iso-b") captures totalB -> totalB === 0
