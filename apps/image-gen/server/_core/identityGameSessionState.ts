import type { ActiveExperience, IdentityGameSession } from "./activeExperience";
import {
  deleteScopedState,
  isPromiseLike,
  readScopedState,
  type MaybePromise,
  writeScopedState,
} from "./stateStore";

const IDENTITY_GAME_SESSION_SCOPE = "identity-game-session";
const IDENTITY_GAME_USER_SCOPE = "identity-game-session-user";

type IdentityGameSessionRef = {
  sessionId: string;
};

function isExpired(session: IdentityGameSession): boolean {
  return session.expiresAt <= Date.now();
}

function writeSessionRef(
  userId: string,
  sessionId: string
): MaybePromise<void> {
  return writeScopedState<IdentityGameSessionRef>(
    IDENTITY_GAME_USER_SCOPE,
    userId,
    { sessionId }
  );
}

function logSessionRefWriteFailure(
  session: IdentityGameSession,
  error: unknown
): void {
  console.error("identity_game_session_ref_write_failed", {
    sessionId: session.sessionId,
    userId: session.userId,
    error: error instanceof Error ? error.message : String(error),
  });
}

function rollbackSessionWrite(
  session: IdentityGameSession
): MaybePromise<void> {
  return deleteScopedState(IDENTITY_GAME_SESSION_SCOPE, session.sessionId);
}

function handleSessionRefWriteFailure<T>(
  session: IdentityGameSession,
  error: unknown
): MaybePromise<T> {
  logSessionRefWriteFailure(session, error);
  let rollback: MaybePromise<void>;

  try {
    rollback = rollbackSessionWrite(session);
  } catch {
    throw error;
  }

  if (isPromiseLike(rollback)) {
    return rollback.then(
      () => {
        throw error;
      },
      () => {
        throw error;
      }
    );
  }

  throw error;
}

export function getIdentityGameSessionBySessionId(
  sessionId: string
): MaybePromise<IdentityGameSession | null> {
  const session = readScopedState<IdentityGameSession>(
    IDENTITY_GAME_SESSION_SCOPE,
    sessionId
  );

  if (isPromiseLike(session)) {
    return session.then(current => {
      if (!current || isExpired(current)) {
        return null;
      }

      return current;
    });
  }

  if (!session || isExpired(session)) {
    return null;
  }

  return session;
}

export function getIdentityGameSessionByUserId(
  userId: string
): MaybePromise<IdentityGameSession | null> {
  const ref = readScopedState<IdentityGameSessionRef>(
    IDENTITY_GAME_USER_SCOPE,
    userId
  );

  if (isPromiseLike(ref)) {
    return ref.then(current => {
      if (!current?.sessionId) {
        return null;
      }

      return Promise.resolve(
        getIdentityGameSessionBySessionId(current.sessionId)
      ).then(session => {
        if (!session) {
          return null;
        }

        return session;
      });
    });
  }

  if (!ref?.sessionId) {
    return null;
  }

  const session = getIdentityGameSessionBySessionId(ref.sessionId);

  if (isPromiseLike(session)) {
    return session.then(current => {
      if (!current) {
        return null;
      }

      return current;
    });
  }

  if (!session) {
    return null;
  }

  return session;
}

export function getIdentityGameSessionByActiveExperience(
  activeExperience: ActiveExperience | null | undefined
): MaybePromise<IdentityGameSession | null> {
  if (!activeExperience?.sessionId || activeExperience.type !== "identity_game") {
    return null;
  }

  const session = getIdentityGameSessionBySessionId(activeExperience.sessionId);

  if (isPromiseLike(session)) {
    return session.then(current => {
      if (!current || current.gameId !== activeExperience.id) {
        return null;
      }

      return current;
    });
  }

  if (!session || session.gameId !== activeExperience.id) {
    return null;
  }

  return session;
}

export function upsertIdentityGameSession(
  session: IdentityGameSession
): MaybePromise<IdentityGameSession> {
  const writeSession = writeScopedState(
    IDENTITY_GAME_SESSION_SCOPE,
    session.sessionId,
    session
  );

  if (isPromiseLike(writeSession)) {
    return writeSession.then(() =>
      Promise.resolve()
        .then(() => writeSessionRef(session.userId, session.sessionId))
        .then(() => session)
        .catch(error => handleSessionRefWriteFailure(session, error))
    );
  }

  let writeRef: MaybePromise<void>;

  try {
    writeRef = writeSessionRef(session.userId, session.sessionId);
  } catch (error) {
    return handleSessionRefWriteFailure(session, error);
  }

  if (isPromiseLike(writeRef)) {
    return writeRef
      .then(() => session)
      .catch(error => handleSessionRefWriteFailure(session, error));
  }

  return session;
}

export function clearIdentityGameSession(
  sessionId: string,
  userId?: string
): MaybePromise<void> {
  const deleteSession = deleteScopedState(IDENTITY_GAME_SESSION_SCOPE, sessionId);

  const finish = () => {
    if (!userId) {
      return undefined;
    }

    return deleteScopedState(IDENTITY_GAME_USER_SCOPE, userId);
  };

  if (isPromiseLike(deleteSession)) {
    return deleteSession.then(() => finish()).then(() => undefined);
  }

  const deleteRef = finish();
  if (isPromiseLike(deleteRef)) {
    return deleteRef.then(() => undefined);
  }
}
