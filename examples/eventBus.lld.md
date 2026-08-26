# Event Bus
> examples/eventBus.ts

Handlers are called synchronously, in the order they subscribed. Events are not stored: subscribing after a publish never receives past events.

## Publishing
**setup:** `createEventBus()`
**method:** `publish`

- publishing to an unsubscribed topic does nothing // no error, no effect
  - publish("nobody-listening", { id: 1 }) -> resolves
  - subscribe("other-topic", spy) captures unsub then publish("nobody-listening", { id: 1 }) captures sent -> spy not called
- subscribing after a publish does not receive that event // events are not stored
  - publish("orders", { id: 1 }) captures sent then subscribe("orders", spy) captures unsub -> spy not called

## Error isolation
**setup:** `createEventBus()`
**method:** `publish`

- a throwing handler's error does not propagate to the publisher // publish never throws due to a handler
  - subscribe("orders", thrower) captures unsub then publish("orders", { id: 1 }) captures sent -> resolves
- a throwing handler does not prevent subsequent handlers from running // isolation is per-handler, not per-publish
  - subscribe("orders", thrower) captures u1 then subscribe("orders", spy) captures u2 then publish("orders", { id: 1 }) captures sent -> spy called
