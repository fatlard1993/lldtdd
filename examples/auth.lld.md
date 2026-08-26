# Auth Service
> examples/auth.ts

Passwords are never returned or stored in tokens. Tokens are time-bounded. Failed attempts are tracked per user, not per session.

## Login
**method:** `login`

- wrong password -> `AuthError` // the error does not distinguish wrong password from unknown email
- unknown email -> `AuthError` // same error as wrong password, by design
- locked account -> `AuthError` regardless of whether the password would have been correct
- repeated failed attempts lock the account, so brute-force guessing can't run indefinitely
  - 5 x login("user@example.com", "wrongpass") -> `AuthError("account locked")`

## Security invariants
**method:** `login`
**beforeEach:** `_reset()`

- the token never contains the raw password used to obtain it
  - login("user@example.com", "password123") captures result -> result.token does not contain "password123"
- tokens expire; they are not valid indefinitely
  - login("user@example.com", "password123") captures result -> result.expiresAt is within 24 hours from now

## Token validation
**method:** `validateToken`
**beforeEach:** `_reset()`

A token carries its own proof. Validation re-signs the payload and compares, so it needs no session
store and no round trip -- which is the reason the signature is part of the token rather than a
record on the server.

- a token issued by login validates, and identifies the user it was issued to // the signature makes the token self-verifying; nothing is looked up
  - login("user@example.com", "password123") captures issued then validateToken(issued.token) captures claims -> claims.userId === "u1"
- a missing token is rejected as an invalid token, not as a crash // callers handle one error type; they never see a TypeError from indexing nothing
  - validateToken(null) -> `InvalidTokenError`
