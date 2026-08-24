import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const databaseMock = vi.hoisted(() => ({
  getDatabaseOrThrow: vi.fn(),
}));

vi.mock("./db", () => ({
  getDatabaseOrThrow: databaseMock.getDatabaseOrThrow,
}));

import {
  channelConnections,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
} from "../drizzle/schema";
import { sealFacebookPageToken } from "./_core/facebookConnectStore";
import {
  runWithMessengerErasureControlDelivery,
  runWithMessengerRequestContext,
  setMessengerRequestErasurePrivacySubject,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import { WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION } from "./_core/messengerProviderAttemptFence";
import { toUserKey } from "./_core/privacy";
import {
  sendWhatsAppErasureControlText,
  sendWhatsAppText,
  WhatsAppDeliveryError,
} from "./_core/whatsappApi";

type PrivacyStatus = "active" | "erasing" | "erased";

const PHONE_NUMBER_ID = "404040404040404";
const WABA_ID = "303030303030303";
const SENDER_ID = "32470000001";
const WORKSPACE_ID = 42;
const CONNECTION_ID = 8;
const BINDING_EPOCH = 3;
const PRIVACY_EPOCH = 6;
const TOKEN = "tenant-whatsapp-token";
const dialect = new MySqlDialect();

type StoredFence = Record<string, unknown> & {
  attemptKeyHash: string;
  providerOperation: string;
  leaseToken: string;
  status: string;
  leaseUntil: Date;
  attemptNumber: number;
};

function predicateParams(predicate: SQL | undefined): unknown[] {
  if (!predicate) throw new Error("Expected an exact database predicate");
  return dialect.sqlToQuery(predicate).params;
}

function includesEvery(params: unknown[], values: unknown[]): boolean {
  return values.every(value => params.includes(value));
}

function createTransportDatabase(input: {
  userKey: string;
  privacyStatus: PrivacyStatus;
  rebindAfterCredential?: boolean;
}) {
  let bindingCurrent = true;
  let storedFence: StoredFence | null = null;
  const insertedOperations: string[] = [];
  const insertedAttemptHashes: string[] = [];
  const privacyPredicates: unknown[][] = [];

  const resolveRows = (
    table: unknown,
    selection: Record<string, unknown> | undefined,
    predicate: SQL | undefined
  ): unknown[] => {
    const params = predicateParams(predicate);
    if (table === channelConnections) {
      const exactBinding = includesEvery(params, [
        CONNECTION_ID,
        WORKSPACE_ID,
        "whatsapp",
        "connected",
        PHONE_NUMBER_ID,
        BINDING_EPOCH,
      ]);
      if (!bindingCurrent || !exactBinding) return [];
      if (selection && "encryptedAccessToken" in selection) {
        if (input.rebindAfterCredential) bindingCurrent = false;
        return [
          {
            encryptedAccessToken: sealFacebookPageToken(TOKEN),
            phoneNumberId: PHONE_NUMBER_ID,
            wabaId: WABA_ID,
          },
        ];
      }
      return [{ id: CONNECTION_ID }];
    }
    if (table === messengerPrivacySubjects) {
      privacyPredicates.push(params);
      const exactSubject = includesEvery(params, [
        WORKSPACE_ID,
        CONNECTION_ID,
        input.userKey,
      ]);
      const statusValues: PrivacyStatus[] = ["active", "erasing", "erased"];
      const hasStatusConstraint = statusValues.some(status =>
        params.includes(status)
      );
      const hasEpochConstraint = params.includes(PRIVACY_EPOCH);
      return exactSubject &&
        (!hasStatusConstraint || params.includes(input.privacyStatus)) &&
        (!hasEpochConstraint || params.includes(PRIVACY_EPOCH))
        ? [
            {
              id: 91,
              status: input.privacyStatus,
              privacyEpoch: PRIVACY_EPOCH,
            },
          ]
        : [];
    }
    if (table === messengerProviderAttemptFences) {
      return storedFence &&
        includesEvery(params, [
          WORKSPACE_ID,
          CONNECTION_ID,
          BINDING_EPOCH,
          input.userKey,
          PRIVACY_EPOCH,
          storedFence.providerOperation,
          storedFence.attemptKeyHash,
        ])
        ? [storedFence]
        : [];
    }
    return [];
  };

  const database = {
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((predicate: SQL) => ({
          limit: vi.fn(() => {
            const rows = resolveRows(table, selection, predicate);
            return Object.assign(Promise.resolve(rows), {
              for: vi.fn(async () => rows),
            });
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        if (table === messengerProviderAttemptFences) {
          insertedAttemptHashes.push(String(value.attemptKeyHash));
        }
        if (table === messengerProviderAttemptFences && !storedFence) {
          storedFence = value as StoredFence;
          insertedOperations.push(storedFence.providerOperation);
        }
        return {
          onDuplicateKeyUpdate: vi.fn(async () => undefined),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => ({
        where: vi.fn(async (predicate: SQL) => {
          if (table !== messengerProviderAttemptFences || !storedFence) {
            return { affectedRows: 0 };
          }
          const params = predicateParams(predicate);
          if (
            !includesEvery(params, [
              WORKSPACE_ID,
              CONNECTION_ID,
              BINDING_EPOCH,
              input.userKey,
              PRIVACY_EPOCH,
              storedFence.attemptKeyHash,
              storedFence.providerOperation,
              storedFence.leaseToken,
              storedFence.status,
            ])
          ) {
            return { affectedRows: 0 };
          }
          storedFence = { ...storedFence, ...value };
          return { affectedRows: 1 };
        }),
      })),
    })),
    transaction: vi.fn(
      async (task: (tx: typeof database) => Promise<unknown>) =>
        await task(database)
    ),
  };

  return {
    database,
    insertedOperations,
    insertedAttemptHashes,
    privacyPredicates,
    getStoredFence: () => storedFence,
    attemptDisconnect: () => {
      if (
        storedFence &&
        (storedFence.status === "started" ||
          storedFence.status === "ambiguous" ||
          storedFence.status === "reserved") &&
        storedFence.leaseUntil.getTime() > Date.now()
      ) {
        return false;
      }
      bindingCurrent = false;
      return true;
    },
  };
}

async function withErasureScope<T>(
  userKey: string,
  task: () => Promise<T>,
  bindingEpoch = BINDING_EPOCH
): Promise<T> {
  return await runWithMessengerRequestContext(
    PHONE_NUMBER_ID,
    async () => {
      setMessengerRequestErasurePrivacySubject({
        userKey,
        privacyEpoch: PRIVACY_EPOCH,
        dataPrivacyEpoch: PRIVACY_EPOCH - 1,
      });
      return await runWithMessengerErasureControlDelivery(task);
    },
    {
      channel: "whatsapp",
      workspaceId: WORKSPACE_ID,
      channelConnectionId: CONNECTION_ID,
      bindingEpoch,
    }
  );
}

describe("WhatsApp deletion outcome transport boundary", () => {
  const originalEnv = {
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    privacyPepper: process.env.PRIVACY_PEPPER,
  };
  let userKey: string;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "mysql://transport-boundary.invalid/test";
    process.env.JWT_SECRET = "whatsapp-erasure-boundary-secret-32-bytes";
    process.env.PRIVACY_PEPPER = "whatsapp-erasure-boundary-pepper";
    userKey = toUserKey(SENDER_ID);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    for (const [name, value] of [
      ["NODE_ENV", originalEnv.nodeEnv],
      ["DATABASE_URL", originalEnv.databaseUrl],
      ["JWT_SECRET", originalEnv.jwtSecret],
      ["PRIVACY_PEPPER", originalEnv.privacyPepper],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each(["erasing", "erased"] as const)(
    "sends a %s deletion outcome through one durable Graph attempt",
    async privacyStatus => {
      const flow = createTransportDatabase({ userKey, privacyStatus });
      databaseMock.getDatabaseOrThrow.mockResolvedValue(flow.database);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ messages: [] })));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        withErasureScope(userKey, async () => {
          await sendWhatsAppErasureControlText(
            SENDER_ID,
            "deletion outcome",
            `stable-${privacyStatus}-event`
          );
          await sendWhatsAppErasureControlText(
            SENDER_ID,
            "deletion outcome",
            `stable-${privacyStatus}-event`
          );
        })
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(flow.insertedOperations).toEqual([
        WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION,
      ]);
      expect(flow.getStoredFence()).toMatchObject({
        providerOperation: WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION,
        status: "succeeded",
      });
      expect(new Set(flow.insertedAttemptHashes).size).toBe(1);
      const erasureDeliveryPredicate = flow.privacyPredicates.find(
        predicate =>
          predicate.includes("active") &&
          predicate.includes("erasing") &&
          predicate.includes("erased")
      );
      const erasureOnlyPredicate = flow.privacyPredicates.find(
        predicate =>
          !predicate.includes("active") &&
          predicate.includes("erasing") &&
          predicate.includes("erased")
      );
      expect(erasureDeliveryPredicate).toEqual(
        expect.arrayContaining(["active", "erasing", "erased"])
      );
      expect(erasureOnlyPredicate).toEqual(
        expect.arrayContaining(["erasing", "erased"])
      );
      expect(erasureOnlyPredicate).not.toContain("active");
    }
  );

  it("never turns an active subject into a fresh erasure-control send", async () => {
    const flow = createTransportDatabase({ userKey, privacyStatus: "active" });
    databaseMock.getDatabaseOrThrow.mockResolvedValue(flow.database);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      withErasureScope(userKey, () =>
        sendWhatsAppErasureControlText(
          SENDER_ID,
          "stale deletion outcome",
          "stale-active-event"
        )
      )
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "pre_transport",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(flow.insertedOperations).toEqual([]);
  });

  it("keeps a normal stale send active-only and stops before fetch", async () => {
    const flow = createTransportDatabase({
      userKey,
      privacyStatus: "erased",
    });
    databaseMock.getDatabaseOrThrow.mockResolvedValue(flow.database);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runWithMessengerRequestContext(
        PHONE_NUMBER_ID,
        async () => {
          setMessengerRequestPrivacySubject({
            userKey,
            privacyEpoch: PRIVACY_EPOCH,
          });
          await sendWhatsAppText(SENDER_ID, "ordinary stale reply");
        },
        {
          channel: "whatsapp",
          workspaceId: WORKSPACE_ID,
          channelConnectionId: CONNECTION_ID,
          bindingEpoch: BINDING_EPOCH,
        }
      )
    ).rejects.toMatchObject({
      name: WhatsAppDeliveryError.name,
      outcome: "pre_transport",
      cause: { name: "WhatsAppTransportBindingError" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(flow.insertedOperations).toEqual([]);
  });

  it("stops a normal send when disconnect wins after credential resolution", async () => {
    const flow = createTransportDatabase({
      userKey,
      privacyStatus: "active",
      rebindAfterCredential: true,
    });
    databaseMock.getDatabaseOrThrow.mockResolvedValue(flow.database);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runWithMessengerRequestContext(
        PHONE_NUMBER_ID,
        async () => {
          setMessengerRequestPrivacySubject({
            userKey,
            privacyEpoch: PRIVACY_EPOCH,
          });
          await sendWhatsAppText(SENDER_ID, "must not leave");
        },
        {
          channel: "whatsapp",
          workspaceId: WORKSPACE_ID,
          channelConnectionId: CONNECTION_ID,
          bindingEpoch: BINDING_EPOCH,
        }
      )
    ).rejects.toBeInstanceOf(WhatsAppDeliveryError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(flow.insertedOperations).toEqual([]);
  });

  it("stops an erasure-control send when disconnect wins after credential resolution", async () => {
    const flow = createTransportDatabase({
      userKey,
      privacyStatus: "erasing",
      rebindAfterCredential: true,
    });
    databaseMock.getDatabaseOrThrow.mockResolvedValue(flow.database);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      withErasureScope(userKey, () =>
        sendWhatsAppErasureControlText(
          SENDER_ID,
          "deletion outcome must not leave",
          "disconnect-after-credential"
        )
      )
    ).rejects.toBeInstanceOf(WhatsAppDeliveryError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(flow.insertedOperations).toEqual([
      WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION,
    ]);
    expect(flow.getStoredFence()).toMatchObject({ status: "known_failed" });
  });

  it.each(["normal", "erasure_control"] as const)(
    "keeps a %s send linear when disconnect races after transport start",
    async deliveryKind => {
      const flow = createTransportDatabase({
        userKey,
        privacyStatus:
          deliveryKind === "normal" ? "active" : ("erasing" as const),
      });
      databaseMock.getDatabaseOrThrow.mockResolvedValue(flow.database);
      const disconnectResults: boolean[] = [];
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
        disconnectResults.push(flow.attemptDisconnect());
        return new Response(JSON.stringify({ messages: [] }));
      });
      vi.stubGlobal("fetch", fetchMock);

      if (deliveryKind === "normal") {
        await runWithMessengerRequestContext(
          PHONE_NUMBER_ID,
          async () => {
            setMessengerRequestPrivacySubject({
              userKey,
              privacyEpoch: PRIVACY_EPOCH,
            });
            await sendWhatsAppText(SENDER_ID, "normal outcome");
          },
          {
            channel: "whatsapp",
            workspaceId: WORKSPACE_ID,
            channelConnectionId: CONNECTION_ID,
            bindingEpoch: BINDING_EPOCH,
          }
        );
      } else {
        await withErasureScope(userKey, () =>
          sendWhatsAppErasureControlText(
            SENDER_ID,
            "deletion outcome",
            "disconnect-after-start"
          )
        );
      }

      expect(disconnectResults).toEqual([false]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(flow.getStoredFence()).toMatchObject({ status: "succeeded" });
    }
  );

  it("fails closed for the wrong immutable binding scope", async () => {
    const flow = createTransportDatabase({
      userKey,
      privacyStatus: "erasing",
    });
    databaseMock.getDatabaseOrThrow.mockResolvedValue(flow.database);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      withErasureScope(
        userKey,
        () =>
          sendWhatsAppErasureControlText(
            SENDER_ID,
            "wrong binding",
            "wrong-binding"
          ),
        BINDING_EPOCH + 1
      )
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "pre_transport",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(flow.insertedOperations).toEqual([]);
  });
});
