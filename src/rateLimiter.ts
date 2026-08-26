/**
 * Simple rolling-window rate limiter.
 *
 * Used to cap how many LLM calls Lexis performs in a time window, protecting
 * the (usually local) inference server from burning GPU cycles when chat spams.
 */
export class RollingWindowRateLimiter {
  private readonly _maxRequests: number;
  private readonly _windowMs: number;
  private timestamps: number[] = [];

  constructor(maxRequests: number, windowMs: number) {
    this._maxRequests = maxRequests;
    this._windowMs = windowMs;
  }

  get maxRequests(): number {
    return this._maxRequests;
  }

  get windowMs(): number {
    return this._windowMs;
  }

  /**
   * Milliseconds to wait until a slot is available (0 if available now).
   */
  waitTime(now: number = Date.now()): number {
    const cutoff = now - this._windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    if (this.timestamps.length < this._maxRequests) {
      return 0;
    }
    return this.timestamps[0] + this._windowMs - now;
  }

  /**
   * Try to take a slot. Returns true if accepted, false if the window is full.
   */
  tryAcquire(now: number = Date.now()): boolean {
    if (this.waitTime(now) > 0) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }

  /**
   * How many slots are currently consumed in the window.
   */
  pending(now: number = Date.now()): number {
    const cutoff = now - this._windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    return this.timestamps.length;
  }
}
