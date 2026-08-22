import { and, eq, inArray, sql } from "drizzle-orm";
import { messengerPrivacySubjects } from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";

export class MessengerPrivacyFenceError extends Error {
  constructor() {
    super("Messenger privacy fence is unavailable");
    this.name = "MessengerPrivacyFenceError";
  }
}

type SubjectScope = {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
};

export async function ensureActiveMessengerPrivacySubject(
  input: SubjectScope
): Promise<number> {
  validateScope(input);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    await tx
      .insert(messengerPrivacySubjects)
      .values({ ...input, privacyEpoch: 1, status: "active" })
      .onDuplicateKeyUpdate({
        set: { privacyEpoch: sql`privacy_epoch` },
      });
    const rows = await tx
      .select()
      .from(messengerPrivacySubjects)
      .where(scopePredicate(input))
      .limit(1)
      .for("update");
    if (!rows[0] || rows[0].status !== "active") {
      throw new MessengerPrivacyFenceError();
    }
    return rows[0].privacyEpoch;
  });
}

export async function assertMessengerPrivacySubject(
  input: SubjectScope & {
    privacyEpoch: number;
  }
): Promise<void> {
  validateScope(input);
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ id: messengerPrivacySubjects.id })
    .from(messengerPrivacySubjects)
    .where(
      and(
        scopePredicate(input),
        eq(messengerPrivacySubjects.privacyEpoch, input.privacyEpoch),
        eq(messengerPrivacySubjects.status, "active")
      )
    )
    .limit(1);
  if (!rows[0]) throw new MessengerPrivacyFenceError();
}

export async function getActiveMessengerPrivacySubjectEpoch(
  input: SubjectScope
): Promise<number | null> {
  validateScope(input);
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ privacyEpoch: messengerPrivacySubjects.privacyEpoch })
    .from(messengerPrivacySubjects)
    .where(
      and(scopePredicate(input), eq(messengerPrivacySubjects.status, "active"))
    )
    .limit(1);
  return rows[0]?.privacyEpoch ?? null;
}

export async function getErasingMessengerPrivacySubjectEpoch(
  input: SubjectScope
): Promise<number | null> {
  validateScope(input);
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ privacyEpoch: messengerPrivacySubjects.privacyEpoch })
    .from(messengerPrivacySubjects)
    .where(
      and(scopePredicate(input), eq(messengerPrivacySubjects.status, "erasing"))
    )
    .limit(1);
  return rows[0]?.privacyEpoch ?? null;
}

export async function assertMessengerErasureControlDelivery(
  input: SubjectScope & { privacyEpoch: number }
): Promise<void> {
  validateScope(input);
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ id: messengerPrivacySubjects.id })
    .from(messengerPrivacySubjects)
    .where(
      and(
        scopePredicate(input),
        eq(messengerPrivacySubjects.privacyEpoch, input.privacyEpoch),
        inArray(messengerPrivacySubjects.status, [
          "active",
          "erasing",
          "erased",
        ])
      )
    )
    .limit(1);
  if (!rows[0]) throw new MessengerPrivacyFenceError();
}

export async function beginMessengerPrivacyErasure(
  input: SubjectScope
): Promise<number> {
  validateScope(input);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    await tx
      .insert(messengerPrivacySubjects)
      .values({ ...input, privacyEpoch: 1, status: "erasing" })
      .onDuplicateKeyUpdate({ set: { privacyEpoch: sql`privacy_epoch` } });
    const rows = await tx
      .select()
      .from(messengerPrivacySubjects)
      .where(scopePredicate(input))
      .limit(1)
      .for("update");
    const subject = rows[0];
    if (!subject) throw new MessengerPrivacyFenceError();
    if (subject.status === "active") {
      const nextEpoch = subject.privacyEpoch + 1;
      await tx
        .update(messengerPrivacySubjects)
        .set({ privacyEpoch: nextEpoch, status: "erasing" })
        .where(
          and(
            eq(messengerPrivacySubjects.id, subject.id),
            eq(messengerPrivacySubjects.privacyEpoch, subject.privacyEpoch),
            eq(messengerPrivacySubjects.status, "active")
          )
        );
      return nextEpoch;
    }
    return subject.privacyEpoch;
  });
}

export async function completeMessengerPrivacyErasure(
  input: SubjectScope & { privacyEpoch: number },
  now = new Date()
): Promise<void> {
  const database = await getDatabaseOrThrow();
  const result = await database
    .update(messengerPrivacySubjects)
    .set({ status: "erased", erasedAt: now })
    .where(
      and(
        scopePredicate(input),
        eq(messengerPrivacySubjects.privacyEpoch, input.privacyEpoch),
        eq(messengerPrivacySubjects.status, "erasing")
      )
    );
  const metadata = Array.isArray(result) ? result[0] : result;
  if (
    Number(
      (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
    ) !== 1
  ) {
    throw new MessengerPrivacyFenceError();
  }
}

function scopePredicate(input: SubjectScope) {
  return and(
    eq(messengerPrivacySubjects.workspaceId, input.workspaceId),
    eq(messengerPrivacySubjects.channelConnectionId, input.channelConnectionId),
    eq(messengerPrivacySubjects.userKey, input.userKey)
  );
}

function validateScope(input: SubjectScope): void {
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId <= 0 ||
    !Number.isSafeInteger(input.channelConnectionId) ||
    input.channelConnectionId <= 0 ||
    !/^[A-Za-z0-9:_-]{16,96}$/.test(input.userKey)
  ) {
    throw new MessengerPrivacyFenceError();
  }
}
