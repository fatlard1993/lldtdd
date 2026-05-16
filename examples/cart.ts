export const __lld_api = `
  addItem(sessionId, itemId, qty?) -> Cart | adds item to session cart; throws CartError if out-of-stock or nonexistent
  getTotal(sessionId) -> number | sum of current catalog prices * quantities; 0 for empty/unknown session
  checkout(sessionId, discountCode?) -> { total, discountApplied }
  logout(sessionId) -> void | clears the cart for that session
  Catalog items: "sku-apple" (in stock), "sku-banana" (in stock), "sku-out" (out of stock)
  Each session has its own cart; sessions are independent
`;

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartError";
  }
}

interface Item {
  id: string;
  quantity: number;
  price: number;
}

interface Cart {
  items: Item[];
  sessionId: string;
}

const catalog: Record<string, { price: number; inStock: boolean }> = {
  "sku-apple": { price: 1.5, inStock: true },
  "sku-banana": { price: 0.75, inStock: true },
  "sku-out": { price: 9.99, inStock: false },
};

const sessions: Record<string, Cart> = {};

function getCart(sessionId: string): Cart {
  if (!sessions[sessionId]) sessions[sessionId] = { items: [], sessionId };
  return sessions[sessionId];
}

export function addItem(sessionId: string, itemId: string, qty = 1): Cart {
  const entry = catalog[itemId];
  if (!entry) throw new CartError(`item not found: ${itemId}`);
  if (!entry.inStock) throw new CartError(`out of stock: ${itemId}`);

  const cart = getCart(sessionId);
  const existing = cart.items.find(i => i.id === itemId);
  if (existing) {
    existing.quantity += qty;
  } else {
    cart.items.push({ id: itemId, quantity: qty, price: entry.price });
  }
  return cart;
}

export function getTotal(sessionId: string): number {
  return getCart(sessionId).items.reduce(
    (sum, i) => sum + i.price * i.quantity,
    0
  );
}

export function checkout(_sessionId: string, _discountCode?: string) {
  return { total: 0, discountApplied: false };
}

export function logout(sessionId: string): void {
  delete sessions[sessionId];
}
