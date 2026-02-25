export type RetryOptions = {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  /** Return true if the error is retryable */
  isRetryable?: (error: unknown) => boolean;
};

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10_000,
  isRetryable: () => true,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff + jitter.
 * Handles Telegram 429 rate limits by using Retry-After header when available.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelay, maxDelay, isRetryable } = {
    ...DEFAULT_OPTIONS,
    ...opts,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !isRetryable(error)) {
        throw error;
      }

      // Check for Telegram 429 with retry_after
      const retryAfter = extractRetryAfter(error);
      const backoff = retryAfter
        ? retryAfter * 1000
        : Math.min(baseDelay * 2 ** attempt + Math.random() * 500, maxDelay);

      await delay(backoff);
    }
  }

  throw lastError;
}

function extractRetryAfter(error: unknown): number | null {
  if (error instanceof Error) {
    // Telegram Bot API errors: "Too Many Requests: retry after 5"
    const match = error.message.match(/retry after (\d+)/i);
    if (match) return parseInt(match[1], 10);

    // GramJS FloodWaitError: seconds property
    const floodErr = error as { seconds?: number };
    if (typeof floodErr.seconds === "number") return floodErr.seconds;
  }
  return null;
}

/** Check if a Telegram API error is retryable (network errors, 429, 5xx) */
export function isTelegramRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;

  // Network errors
  if (msg.includes("fetch failed") || msg.includes("network")) return true;

  // 429 Too Many Requests
  if (msg.includes("429") || msg.includes("Too Many Requests")) return true;

  // 5xx server errors
  if (/\b5\d{2}\b/.test(msg)) return true;

  // GramJS FloodWait
  if (error.constructor?.name === "FloodWaitError") return true;

  return false;
}
