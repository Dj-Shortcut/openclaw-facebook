import { beforeEach, describe, expect, it, vi } from "vitest";

const queueMocks = vi.hoisted(() => ({
  drain: vi.fn(),
  enabled: vi.fn(),
  reclaim: vi.fn(),
}));

vi.mock("./_core/messengerGenerationQueue", () => ({
  drainMessengerGenerationQueue: queueMocks.drain,
  isMessengerGenerationQueueEnabled: queueMocks.enabled,
  reclaimReservedMessengerGenerationJobs: queueMocks.reclaim,
}));
vi.mock("./_core/messengerWebhook", () => ({
  processMessengerGenerationJob: vi.fn(),
  processMessengerGenerationJobDeadLetter: vi.fn(),
}));
vi.mock("./_core/logger", () => ({ safeLog: vi.fn() }));

import { startMessengerGenerationWorker } from "./_core/messengerGenerationWorker";

describe("Messenger generation worker lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queueMocks.enabled.mockReset().mockReturnValue(true);
    queueMocks.reclaim.mockReset().mockResolvedValue(0);
    queueMocks.drain.mockReset().mockResolvedValue(undefined);
  });

  it("stops polling and waits for the active queue drain", async () => {
    let finishDrain: (() => void) | undefined;
    queueMocks.drain.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishDrain = resolve;
        })
    );

    const worker = startMessengerGenerationWorker({ keepAlive: true });
    await vi.waitFor(() => expect(queueMocks.drain).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishDrain?.();
    await stop;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(queueMocks.drain).toHaveBeenCalledTimes(1);
  });

  it("returns a harmless stop handle when the queue is disabled", async () => {
    queueMocks.enabled.mockReturnValue(false);
    const worker = startMessengerGenerationWorker({ keepAlive: true });

    await expect(worker.stop()).resolves.toBeUndefined();
    expect(queueMocks.drain).not.toHaveBeenCalled();
  });
});
