# Event Bus
> examples/eventBus.ts

In-process pub/sub. Handlers are called synchronously in the order they subscribed. Events are not stored: subscribing after a publish never receives past events.

## Publishing
**setup:** `createEventBus()`
**method:** `publish`

- publishing to a subscribed topic calls all handlers with the event
- publishing to an unsubscribed topic does nothing // no error, no effect
- the handler receives the exact same object reference that was published, not a copy

## Subscribing and unsubscribing
**setup:** `createEventBus()`
**method:** `subscribe`

- subscribe returns an unsubscribe function
- calling unsubscribe stops future delivery for that handler // past deliveries are unaffected
- subscribing the same handler twice -> handler called twice per publish // not deduplicated
- subscribing after a publish does not receive that event

## Subscription order is preserved

**method:** `orderPreserved`

- handlers are called in the order they subscribed — the first subscriber receives the event before later subscribers
  - orderPreserved() captures result → result[0] === "first"

## Error isolation
**setup:** `createEventBus()`
**method:** `publish`

- a throwing handler does not prevent subsequent handlers from running
- a throwing handler's error does not propagate to the publisher // publish never throws due to a handler
