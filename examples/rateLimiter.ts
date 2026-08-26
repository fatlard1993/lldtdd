interface Window {
  count: number;
  resetAt: number;
}

export const __lld_api = `
  createLimiter(limit, windowMs) -> checkFn | the returned checkFn IS _subject in tests; call _subject(key) -> { allowed: boolean, remaining: number }
  In tests with **setup:** createLimiter(N, ms), all assertions call _subject("key"), not Subject.createLimiter
  _subject(key) returns { allowed: true/false, remaining: number }; remaining counts down from limit to 0
`;

export function createLimiter(limit: number, windowMs: number) {
  const windows = new Map<string, Window>();

  return function check(key: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const win = windows.get(key);

    if (!win || now >= win.resetAt) {
      if (limit === 0) return { allowed: false, remaining: 0 };
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1 };
    }

    if (win.count >= limit) {
      return { allowed: false, remaining: 0 };
    }

    win.count++;
    return { allowed: true, remaining: limit - win.count };
  };
}
