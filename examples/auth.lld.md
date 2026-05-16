# Auth Service
> examples/auth.ts

Identity verification and session management. Passwords are never returned or stored in tokens. Tokens are time-bounded. Failed attempts are tracked per user, not per session.

## Login
**method:** `login`

- valid credentials resolve with a token and expiry // the password does not appear in the response
- wrong password -> `AuthError` // the error does not distinguish wrong password from unknown email
- unknown email -> `AuthError` // same error as wrong password, by design
- locked account -> `AuthError` regardless of whether the password would have been correct

## Token validation
**method:** `validateToken`

- login("user@example.com", "password123") captures tok -> validateToken(tok.token) captures r -> r.userId is defined // valid token resolves with user's id and role
- an expired token -> `TokenExpiredError`, not a generic auth error
- a malformed or tampered token -> `InvalidTokenError`
- empty string -> `InvalidTokenError`

## Lockout behavior
**method:** `login`
**beforeEach:** `_reset()`

- 5 x login("user@example.com", "wrongpass") -> account locked // five consecutive failures lock; sixth sees AuthError even with correct credentials
- a successful login resets the failure counter to zero // after success, 4 more failures should not trigger lockout

## Security invariants
**method:** `login`
**beforeEach:** `_reset()`

- login("user@example.com", "password123") captures result -> result.token does not contain "password123"
- login("user@example.com", "password123") captures result -> result.expiresAt is within 24 hours from now
- login("user@example.com", "password123") captures tokenA and login("admin@example.com", "adminpass") captures tokenB -> tokenA.token !== tokenB.token
