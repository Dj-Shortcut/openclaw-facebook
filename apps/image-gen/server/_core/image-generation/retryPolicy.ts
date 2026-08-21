export type RetryAttempt = {
  attempt: number;
  maxRetries: number;
  retryable: boolean;
};

export function canRetryAttempt(input: RetryAttempt): boolean {
  return input.retryable && input.attempt < input.maxRetries;
}

export function getExponentialRetryDelayMs(
  baseDelayMs: number,
  attempt: number
): number {
  return baseDelayMs * 2 ** attempt;
}
