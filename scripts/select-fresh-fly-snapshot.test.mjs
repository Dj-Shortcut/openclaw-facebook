import { describe, expect, it } from "vitest";

import { selectFreshFlySnapshot } from "./select-fresh-fly-snapshot.mjs";

const baseline = [
  {
    id: "vs_01K39M7A7WEXAMPLE1",
    created_at: "2026-08-22T01:00:00Z",
    digest: "sha256:old-one",
    status: "created",
    retention_days: 5,
    size: 1024,
    volume_size: 10,
  },
  {
    id: "vs_01K39M7A7WEXAMPLE2",
    created_at: "2026-08-23T01:00:00Z",
    digest: "sha256:old-two",
    status: "created",
    retention_days: 5,
    size: 2048,
    volume_size: 10,
  },
];

describe("fresh Fly snapshot selection", () => {
  it("waits for the one post-schedule snapshot and returns it only when created", () => {
    const pending = {
      id: "vs_01K39M7A7WEXAMPLE3",
      created_at: "2026-08-23T14:00:01Z",
      digest: "sha256:new",
      status: "pending",
      retention_days: 5,
      size: 0,
      volume_size: 10,
    };
    expect(
      selectFreshFlySnapshot(
        baseline,
        [...baseline, pending],
        "2026-08-23T14:00:00Z",
      ),
    ).toEqual({ state: "waiting" });

    expect(
      selectFreshFlySnapshot(
        baseline,
        [...baseline, { ...pending, status: "created", size: 4096 }],
        "2026-08-23T14:00:00Z",
      ),
    ).toEqual({
      state: "ready",
      snapshot: {
        id: pending.id,
        digest: pending.digest,
        createdAt: pending.created_at,
      },
    });
  });

  it("does not mistake an older unseen snapshot for the scheduled snapshot", () => {
    const older = {
      ...baseline[0],
      id: "vs_01K39M7A7WEXAMPLE0",
      created_at: "2026-08-23T13:59:59Z",
    };
    expect(
      selectFreshFlySnapshot(
        baseline,
        [...baseline, older],
        "2026-08-23T14:00:00Z",
      ),
    ).toEqual({ state: "waiting" });
  });

  it("fails closed if more than one new snapshot appears", () => {
    const first = {
      ...baseline[0],
      id: "vs_01K39M7A7WEXAMPLE3",
      created_at: "2026-08-23T14:00:01Z",
    };
    const second = {
      ...baseline[0],
      id: "vs_01K39M7A7WEXAMPLE4",
      created_at: "2026-08-23T14:00:02Z",
    };
    expect(() =>
      selectFreshFlySnapshot(
        baseline,
        [...baseline, first, second],
        "2026-08-23T14:00:00Z",
      ),
    ).toThrow("more than one fresh snapshot");
  });
});
