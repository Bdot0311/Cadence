/**
 * Error taxonomy for the LinkedIn client.
 *
 * The distinction that matters everywhere else in the system: is this worth
 * retrying, and does it mean something is structurally wrong (halt) rather than
 * transiently wrong (back off)?
 */

export class LinkedInError extends Error {
  readonly status: number | undefined;
  readonly endpoint: string;
  readonly body: string | undefined;

  constructor(
    message: string,
    opts: { status?: number; endpoint: string; body?: string },
  ) {
    super(message);
    this.name = 'LinkedInError';
    this.status = opts.status;
    this.endpoint = opts.endpoint;
    this.body = opts.body;
  }

  /** Transient. Back off with jitter and retry. */
  get retryable(): boolean {
    if (this.status === undefined) return true; // network / timeout
    return this.status === 429 || this.status === 503 || this.status >= 500;
  }

  /**
   * Structurally wrong. Do NOT retry — halt writes and alert.
   *
   * 401 means the token is dead or revoked; 403 means a scope was removed or
   * the app lost a product. Retrying either one just burns quota against a
   * request that can never succeed, and hides the real problem behind a
   * backoff curve.
   */
  get fatal(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Raised by the pre-flight budget check before any request leaves the process. */
export class BudgetExceededError extends Error {
  constructor(
    readonly accountId: string,
    readonly used: number,
    readonly budget: number,
  ) {
    super(
      `Daily write budget exhausted for account ${accountId}: ${used}/${budget}. ` +
        `No request was sent.`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** Raised when the account is paused (rate-limit trip) or the kill switch is on. */
export class WritesHaltedError extends Error {
  constructor(readonly reason: string) {
    super(`Outbound writes halted: ${reason}`);
    this.name = 'WritesHaltedError';
  }
}
