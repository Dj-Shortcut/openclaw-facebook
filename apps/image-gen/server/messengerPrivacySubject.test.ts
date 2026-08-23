import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("./db", () => ({ getDatabaseOrThrow: getDatabaseOrThrowMock }));

import {
  admitMessengerPrivacySubjectFromMetaEvent,
  assertMessengerPrivacyErasure,
  completeMessengerPrivacyErasure,
  getErasingMessengerPrivacySubject,
  MessengerPrivacyFenceError,
  runWithLockedMessengerPrivacyErasure,
} from "./_core/messengerPrivacySubject";

const scope = {
  workspaceId: 42,
  channelConnectionId: 7,
  userKey: "a".repeat(64),
};

describe("Messenger privacy-subject reactivation fence", () => {
  beforeEach(() => {
    getDatabaseOrThrowMock.mockReset();
  });

  it("reactivates an erased subject only for a strictly newer inbound event", async () => {
    const boundary = new Date("2026-08-23T12:00:00.123Z");
    const flow = transactionFlow({
      id: 11,
      ...scope,
      privacyEpoch: 8,
      status: "erased",
      erasedAt: boundary,
      lastErasedAt: boundary,
    });
    getDatabaseOrThrowMock.mockResolvedValue(flow.database);

    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: new Date(boundary.getTime() + 1),
        allowReactivation: true,
      })
    ).resolves.toBe(9);

    expect(flow.insert).toHaveBeenCalledTimes(1);
    expect(flow.updateSet).toHaveBeenCalledWith({
      privacyEpoch: 9,
      status: "active",
      erasedAt: null,
      lastErasedAt: boundary,
    });
  });

  it("copies an old writer's erasedAt into the durable boundary before reactivation", async () => {
    const boundary = new Date("2026-08-23T12:00:00.000Z");
    const erasedFlow = transactionFlow({
      id: 11,
      ...scope,
      privacyEpoch: 8,
      status: "erased",
      erasedAt: boundary,
      lastErasedAt: null,
    });
    const activeFlow = transactionFlow({
      id: 11,
      ...scope,
      privacyEpoch: 9,
      status: "active",
      erasedAt: null,
      lastErasedAt: boundary,
    });
    getDatabaseOrThrowMock
      .mockResolvedValueOnce(erasedFlow.database)
      .mockResolvedValueOnce(activeFlow.database);

    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: new Date(boundary.getTime() + 2_000),
        allowReactivation: true,
      })
    ).resolves.toBe(9);
    expect(erasedFlow.updateSet).toHaveBeenCalledWith({
      privacyEpoch: 9,
      status: "active",
      erasedAt: null,
      lastErasedAt: boundary,
    });

    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: boundary,
        allowReactivation: true,
      })
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
  });

  it("rejects delayed events even after the subject is active again", async () => {
    const boundary = new Date("2026-08-23T12:00:00.123Z");
    const flow = transactionFlow({
      id: 11,
      ...scope,
      privacyEpoch: 9,
      status: "active",
      erasedAt: null,
      lastErasedAt: boundary,
    });
    getDatabaseOrThrowMock.mockResolvedValue(flow.database);

    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: boundary,
        allowReactivation: true,
      })
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);

    expect(flow.update).not.toHaveBeenCalled();
  });

  it("blocks the whole legacy second when the old boundary lost milliseconds", async () => {
    const legacyBoundary = new Date("2026-08-23T12:00:00.000Z");
    const flow = transactionFlow({
      id: 11,
      ...scope,
      privacyEpoch: 8,
      status: "erased",
      erasedAt: legacyBoundary,
      lastErasedAt: legacyBoundary,
    });
    getDatabaseOrThrowMock.mockResolvedValue(flow.database);

    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: new Date(legacyBoundary.getTime() + 999),
        allowReactivation: true,
      })
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);

    expect(flow.update).not.toHaveBeenCalled();
  });

  it("uses a newer erasedAt written by an old server during rollout", async () => {
    const durableBoundary = new Date("2026-08-23T12:00:00.123Z");
    const newerLegacyWrite = new Date("2026-08-23T12:05:00.000Z");
    const flow = transactionFlow({
      id: 11,
      ...scope,
      privacyEpoch: 8,
      status: "erased",
      erasedAt: newerLegacyWrite,
      lastErasedAt: durableBoundary,
    });
    getDatabaseOrThrowMock.mockResolvedValue(flow.database);

    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: new Date("2026-08-23T12:03:00.000Z"),
        allowReactivation: true,
      })
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);

    expect(flow.update).not.toHaveBeenCalled();
  });

  it("never lets a background action create or reactivate a subject", async () => {
    const boundary = new Date("2026-08-23T12:00:00.123Z");
    const flow = transactionFlow({
      id: 11,
      ...scope,
      privacyEpoch: 8,
      status: "erased",
      erasedAt: boundary,
      lastErasedAt: boundary,
    });
    getDatabaseOrThrowMock.mockResolvedValue(flow.database);

    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: new Date(boundary.getTime() + 10_000),
        allowReactivation: false,
      })
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);

    expect(flow.insert).not.toHaveBeenCalled();
    expect(flow.update).not.toHaveBeenCalled();
  });

  it("preserves the durable boundary when an erasure completes", async () => {
    const completedAt = new Date("2026-08-23T12:00:00.123Z");
    const updateSet = vi.fn();
    const database = updateFlow(updateSet, [{ affectedRows: 1 }]);
    getDatabaseOrThrowMock.mockResolvedValue(database);

    await completeMessengerPrivacyErasure(
      { ...scope, privacyEpoch: 8 },
      completedAt
    );

    expect(updateSet).toHaveBeenCalledWith({
      status: "erased",
      erasedAt: completedAt,
      lastErasedAt: completedAt,
    });
  });

  it("maps the current erasing epoch to exactly the preceding data epoch", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(selectFlow([{ privacyEpoch: 6 }]));

    await expect(getErasingMessengerPrivacySubject(scope)).resolves.toEqual({
      privacyEpoch: 6,
      dataPrivacyEpoch: 5,
    });
  });

  it("requires the exact current erasing epoch before a retry can scrub data", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(selectFlow([]));

    await expect(
      assertMessengerPrivacyErasure({
        ...scope,
        privacyEpoch: 6,
        dataPrivacyEpoch: 5,
      })
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
  });

  it("holds the erasing subject lock through the scrub and commits completion", async () => {
    const completedAt = new Date("2026-08-23T12:30:00.123Z");
    const flow = transactionFlow({ id: 11 });
    getDatabaseOrThrowMock.mockResolvedValue(flow.database);

    await expect(
      runWithLockedMessengerPrivacyErasure(
        { ...scope, privacyEpoch: 6, dataPrivacyEpoch: 5 },
        async () => ({ value: "completed", complete: true }),
        () => completedAt
      )
    ).resolves.toBe("completed");

    expect(flow.updateSet).toHaveBeenCalledWith({
      status: "erased",
      erasedAt: completedAt,
      lastErasedAt: completedAt,
    });
  });
});

function selectFlow(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}

function transactionFlow(subject: Record<string, unknown>) {
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      onDuplicateKeyUpdate: vi.fn(async () => undefined),
    })),
  }));
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => ({
          for: vi.fn(async () => [subject]),
        })),
      })),
    })),
  }));
  const updateSet = vi.fn(() => ({
    where: vi.fn(async () => [{ affectedRows: 1 }]),
  }));
  const update = vi.fn(() => ({ set: updateSet }));
  const tx = { insert, select, update };
  return {
    database: {
      transaction: vi.fn(async (task: (value: typeof tx) => unknown) =>
        task(tx)
      ),
    },
    insert,
    update,
    updateSet,
  };
}

function updateFlow(updateSet: ReturnType<typeof vi.fn>, result: unknown) {
  return {
    update: vi.fn(() => ({
      set: (...args: unknown[]) => {
        updateSet(...args);
        return { where: vi.fn(async () => result) };
      },
    })),
  };
}
