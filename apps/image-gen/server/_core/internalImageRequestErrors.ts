/** Signals an accepted internal request that could not safely enqueue or start generation. */
export class InternalMessengerImageRequestNotQueuedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalMessengerImageRequestNotQueuedError";
  }
}

/** Detects non-queued internal image-request control-flow errors across module boundaries. */
export function isInternalMessengerImageRequestNotQueuedError(
  error: unknown
): error is InternalMessengerImageRequestNotQueuedError {
  return (
    error instanceof InternalMessengerImageRequestNotQueuedError ||
    (error instanceof Error &&
      error.name === "InternalMessengerImageRequestNotQueuedError")
  );
}
