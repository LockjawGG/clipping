/**
 * Exponential backoff with full jitter for job retries.
 *
 * `attempts` is the number of tries already made (1 after the first failure).
 * Delay is `base * 2^(attempts-1)` capped at `capMs`, then multiplied by a
 * random factor in `[1 - jitter, 1 + jitter]` so a burst of failures doesn't
 * retry in lockstep.
 */
export interface BackoffConfig {
  baseMs?: number;
  capMs?: number;
  jitter?: number;
  now?: () => number;
  random?: () => number;
}

export function backoffDelayMs(attempts: number, config: BackoffConfig = {}): number {
  const baseMs = config.baseMs ?? 5_000;
  const capMs = config.capMs ?? 5 * 60_000;
  const jitter = config.jitter ?? 0.2;
  const random = config.random ?? Math.random;

  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));
  const factor = 1 - jitter + random() * (2 * jitter);
  return Math.round(Math.min(capMs, exp * factor));
}

/** The `runAfter` timestamp for the next retry. */
export function nextRunAfter(attempts: number, config: BackoffConfig = {}): Date {
  const now = config.now ?? Date.now;
  return new Date(now() + backoffDelayMs(attempts, config));
}
