import { createHmac } from "crypto";

export const __lld_api = `
  login(email, password) -> { token: string, expiresAt: Date } | throws AuthError on wrong creds or locked account
  validateToken(token: string) -> { userId: string, role: string } | throws TokenExpiredError or InvalidTokenError
  _reset() -> void | reset all user state (failed attempts, locked status) for tests
  To get a valid token for testing: const { token } = await Subject.login("user@example.com", "password123")
  Then: await Subject.validateToken(token) -> { userId, role }
`;

// Demo value only -- never ship a hardcoded signing key. Real code loads it from config/env.
const SECRET = "dev-secret";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

export class TokenExpiredError extends Error {
  constructor() {
    super("token expired");
    this.name = "TokenExpiredError";
  }
}

export class InvalidTokenError extends Error {
  constructor(msg = "invalid token") {
    super(msg);
    this.name = "InvalidTokenError";
  }
}

interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  failedAttempts: number;
  locked: boolean;
}

const db = new Map<string, User>([
  ["user@example.com", { id: "u1", email: "user@example.com", passwordHash: hash("password123"), role: "user", failedAttempts: 0, locked: false }],
  ["admin@example.com", { id: "u2", email: "admin@example.com", passwordHash: hash("adminpass"), role: "admin", failedAttempts: 0, locked: false }],
]);

function hash(s: string): string {
  return createHmac("sha256", SECRET).update(s).digest("hex");
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function makeToken(userId: string, role: string, exp: number): string {
  const payload = `${userId}:${role}:${exp}`;
  return Buffer.from(payload).toString("base64url") + "." + sign(payload);
}

export function login(email: string, password: string): { token: string; expiresAt: Date } {
  const user = db.get(email);
  if (!user) throw new AuthError("invalid credentials");
  if (user.locked) throw new AuthError("account locked");
  if (hash(password) !== user.passwordHash) {
    user.failedAttempts++;
    if (user.failedAttempts >= 5) user.locked = true;
    throw new AuthError("invalid credentials");
  }
  user.failedAttempts = 0;
  const exp = Date.now() + TOKEN_TTL_MS;
  return { token: makeToken(user.id, user.role, exp), expiresAt: new Date(exp) };
}

export function validateToken(token: string): { userId: string; role: string } {
  if (!token) throw new InvalidTokenError("token required");
  const dot = token.lastIndexOf(".");
  if (dot < 0) throw new InvalidTokenError();

  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const payload = Buffer.from(encoded, "base64url").toString();

  if (sign(payload) !== sig) throw new InvalidTokenError("signature mismatch");

  const parts = payload.split(":");
  if (parts.length !== 3) throw new InvalidTokenError();

  const [userId, role, expStr] = parts;
  if (Date.now() > Number(expStr)) throw new TokenExpiredError();

  return { userId, role };
}

// Reset test state between runs
export function _reset() {
  for (const user of db.values()) {
    user.failedAttempts = 0;
    user.locked = false;
  }
}

