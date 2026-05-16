# Rate Limiter
> examples/rateLimiter.ts

Per-key sliding window rate limiter. The window resets from the time of the first request in that window, not from an arbitrary clock boundary. Quota is tracked per key independently.

## Allow and deny
**setup:** `createLimiter(3, 60000)`

- first request on a fresh key -> allowed
- requests within quota -> allowed
- 3 x request on same key -> denied
- request after window expires -> allowed again

## Quota tracking
**setup:** `createLimiter(5, 60000)`

- each allowed request decrements remaining by one // remaining goes from 4 to 3 to 2...
- a denied request does not consume quota // the counter does not move on denial
- remaining is zero after exhaustion, never negative // denial does not subtract from zero

## Boundary conditions
**setup:** `createLimiter(0, 60000)`

- limit of zero -> denied

## Limit of one
**setup:** `createLimiter(1, 60000)`

- first request -> allowed
- 1 x request on same key -> denied

## Key isolation
**setup:** `createLimiter(3, 60000)`

- two different keys are tracked independently // exhausting one does not affect the other
