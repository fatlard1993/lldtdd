# Cart Service
> examples/cart.ts

Manages user shopping carts. Prices are always fetched live, never stored in the cart.

## Adding items
**method:** `addItem`

- addItem("sess1", "sku-apple") -> resolves // valid item added
  - addItem("sess1", "sku-apple") captures cart -> cart.items[0].id === "sku-apple"
- addItem("sess1", "sku-out") -> `CartError` before any mutation occurs
- addItem("sess1", "nonexistent") -> `CartError` before any mutation occurs
- 2 x addItem("sess1", "sku-apple") -> resolves // duplicate item increments quantity, not adds a second line
  - 1 x addItem("fresh", "sku-apple") captures cart -> cart.items[0].quantity === 2

## Pricing
**method:** `getTotal`

- getTotal("empty-sess") -> total is zero
- discounts apply at checkout, not at add-time // adding to cart never triggers discount logic

## Session isolation
**method:** `logout`

- two sessions never share a cart // each session has independent state
- logout("sess1") -> resolves
