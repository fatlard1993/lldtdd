# Rate Limiter
> examples/rateLimiter.ts

The window resets from the time of the first request in that window, not from an arbitrary clock boundary. Quota is tracked per key independently.

## Allow and deny
**setup:** `createLimiter(3, 60000)`

- _subject("within-quota") captures r -> r.allowed === true
- a caller is told how much quota is left, not just whether this one request passed // a client that can see the remaining count can back off before it gets denied
  - _subject("remaining-key") captures r -> r.remaining === 2
- 3 x _subject("same-key") captures r -> r.allowed === false
- a window resets rather than staying exhausted forever // expiry needs the clock under test control, so the check below only pins the first request in a fresh window
  - _subject("fresh-window") captures r -> r.allowed === true

## Zero quota
**setup:** `createLimiter(0, 60000)`

- a limiter configured with no quota denies from the very first request // zero is how a caller switches a path off, so it has to be a real setting rather than a degenerate case that falls through to allowed
  - _subject("zero-key") captures r -> r.allowed === false

## Key isolation
**setup:** `createLimiter(3, 60000)`

- two different keys are tracked independently // exhausting one does not affect the other
  - 3 x _subject("iso-a") captures exhausted and _subject("iso-b") captures fresh -> fresh.allowed === true
