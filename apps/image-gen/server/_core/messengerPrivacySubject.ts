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

export type MessengerErasingPrivacySubject = Readonly<{
  privacyEpoch: number;
  dataPrivacyEpoch: number;
}>;

export type MessengerPrivacyErasureTaskResult<T> = Readonly<{
  value: T;
  complete: boolean;
}>;

export async function admitMessengerPrivacySubjectFromMetaEvent(
  input: SubjectScope & {
    eventOccurredAt: Date;
    allowReactivation: boolean;
  }
): Promise<number> {
  validateScope(input);
  validateEventOccurredAt(input.eventOccurredAt);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    if (input.allowReactivation) {
      await tx
        .insert(messengerPrivacySubjects)
        .values({
          workspaceId: input.workspaceId,
          channelConnectionId: input.channelConnectionId,
          userKey: input.userKey,
          privacyEpoch: 1,
          status: "active",
        })
        .onDuplicateKeyUpdate({
          set: { privacyEpoch: sql`privacy_epoch` },
        });
    }
    const rows = await tx
      .select()
      .from(messengerPrivacySubjects)
      .where(scopePredicate(input))
      .limit(1)
      .for("update");
    const subject = rows[0];
    if (!subject) {
      throw new MessengerPrivacyFenceError();
    }

    // lastErasedAt remains populated after reactivation. During a rolling
    // deploy an older writer can still update erasedAt without lastErasedAt,
    // so always enforce the newest valid boundary from either column.
    const erasureBoundary = latestValidDate(
      subject.lastErasedAt,
      subject.erasedAt
    );
    if (
      erasureBoundary &&
      isAtOrBeforeErasureBoundary(input.eventOccurredAt, erasureBoundary)
    ) {
      throw new MessengerPrivacyFenceError();
    }
    if (subject.status === "active") {
      return subject.privacyEpoch;
    }
    if (subject.status === "erasing") {
      if (input.allowReactivation) return subject.privacyEpoch;
      throw new MessengerPrivacyFenceError();
    }
    if (subject.status !== "erased" || !input.allowReactivation) {
      throw new MessengerPrivacyFenceError();
    }
    if (!erasureBoundary) {
      throw new MessengerPrivacyFenceError();
    }

    const nextEpoch = subject.privacyEpoch + 1;
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch <= 1) {
      throw new MessengerPrivacyFenceError();
    }
    const result = await tx
      .update(messengerPrivacySubjects)
      .set({
        privacyEpoch: nextEpoch,
        status: "active",
        erasedAt: null,
        lastErasedAt: erasureBoundary,
      })
      .where(
        and(
          eq(messengerPrivacySubjects.id, subject.id),
          eq(messengerPrivacySubjects.privacyEpoch, subject.privacyEpoch),
          eq(messengerPrivacySubjects.status, "erased")
        )
      );
    assertExactlyOneAffectedRow(result);
    return nextEpoch;
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
  return (await getErasingMessengerPrivacySubject(input))?.privacyEpoch ?? null;
}

export async function getErasingMessengerPrivacySubject(
  input: SubjectScope
): Promise<MessengerErasingPrivacySubject | null> {
  validateScope(input);
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ privacyEpoch: messengerPrivacySubjects.privacyEpoch })
    .from(messengerPrivacySubjects)
    .where(
      and(scopePredicate(input), eq(messengerPrivacySubjects.status, "erasing"))
    )
    .limit(1);
  const privacyEpoch = rows[0]?.privacyEpoch;
  if (
    privacyEpoch === undefined ||
    !Number.isSafeInteger(privacyEpoch) ||
    privacyEpoch <= 1
  ) {
    return null;
  }
  return { privacyEpoch, dataPrivacyEpoch: privacyEpoch - 1 };
}

export async function assertMessengerPrivacyErasure(
  input: SubjectScope & MessengerErasingPrivacySubject
): Promise<void> {
  validateScope(input);
  validateErasureEpochs(input);
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ id: messengerPrivacySubjects.id })
    .from(messengerPrivacySubjects)
    .where(
      and(
        scopePredicate(input),
        eq(messengerPrivacySubjects.privacyEpoch, input.privacyEpoch),
        eq(messengerPrivacySubjects.status, "erasing")
      )
    )
    .limit(1);
  if (!rows[0]) throw new MessengerPrivacyFenceError();
}

/**
 * Serializes every destructive pass for one erasing subject on its database
 * row. Completion is committed by the same transaction, so a concurrent old
 * retry cannot keep deleting after a newer privacy epoch is reactivated.
 */
export async function runWithLockedMessengerPrivacyErasure<T>(
  input: SubjectScope & MessengerErasingPrivacySubject,
  task: () => Promise<MessengerPrivacyErasureTaskResult<T>>,
  completedAt = () => new Date()
): Promise<T> {
  validateScope(input);
  validateErasureEpochs(input);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const rows = await tx
      .select({ id: messengerPrivacySubjects.id })
      .from(messengerPrivacySubjects)
      .where(
        and(
          scopePredicate(input),
          eq(messengerPrivacySubjects.privacyEpoch, input.privacyEpoch),
          eq(messengerPrivacySubjects.status, "erasing")
        )
      )
      .limit(1)
      .for("update");
    const subject = rows[0];
    if (!subject) throw new MessengerPrivacyFenceError();

    const result = await task();
    if (result.complete) {
      const now = completedAt();
      validateEventOccurredAt(now);
      const update = await tx
        .update(messengerPrivacySubjects)
        .set({ status: "erased", erasedAt: now, lastErasedAt: now })
        .where(
          and(
            eq(messengerPrivacySubjects.id, subject.id),
            eq(messengerPrivacySubjects.privacyEpoch, input.privacyEpoch),
            eq(messengerPrivacySubjects.status, "erasing")
          )
        );
      assertExactlyOneAffectedRow(update);
    }
    return result.value;
  });
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
    .set({ status: "erased", erasedAt: now, lastErasedAt: now })
    .where(
      and(
        scopePredicate(input),
        eq(messengerPrivacySubjects.privacyEpoch, input.privacyEpoch),
        eq(messengerPrivacySubjects.status, "erasing")
      )
    );
  assertExactlyOneAffectedRow(result);
}

function assertExactlyOneAffectedRow(result: unknown): void {
  const metadata = Array.isArray(result) ? (result as unknown[]).at(0) : result;
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

function validateErasureEpochs(input: MessengerErasingPrivacySubject): void {
  if (
    !Number.isSafeInteger(input.privacyEpoch) ||
    !Number.isSafeInteger(input.dataPrivacyEpoch) ||
    input.dataPrivacyEpoch <= 0 ||
    input.privacyEpoch !== input.dataPrivacyEpoch + 1
  ) {
    throw new MessengerPrivacyFenceError();
  }
}

function validateEventOccurredAt(value: Date): void {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
    throw new MessengerPrivacyFenceError();
  }
}

function latestValidDate(
  ...values: Array<Date | null | undefined>
): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
      continue;
    }
    if (!latest || value.getTime() > latest.getTime()) {
      latest = value;
    }
  }
  return latest;
}

function isAtOrBeforeErasureBoundary(eventTime: Date, boundary: Date): boolean {
  const boundaryMs = boundary.getTime();
  // Rows backfilled from the legacy second-precision erased_at column end in
  // .000. Block that whole second so lost milliseconds cannot admit an old event.
  const exclusiveUpperBound =
    boundaryMs % 1_000 === 0 ? boundaryMs + 1_000 : boundaryMs + 1;
  return eventTime.getTime() < exclusiveUpperBound;
}
