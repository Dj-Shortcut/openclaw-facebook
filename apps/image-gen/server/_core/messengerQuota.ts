import { getDayKey } from "./messengerStateNormalization";
import { getOrCreateState, type MessengerUserState } from "./messengerState";
import { updateStoredState } from "./stateStore";

const FREE_DAILY_LIMIT = 3;

function hasQuotaBypass(psid: string, userKey: string): boolean {
  const raw = process.env.MESSENGER_QUOTA_BYPASS_IDS ?? "";
  if (!raw.trim()) {
    return false;
  }

  const ids = new Set(raw.split(",").map(item => item.trim()).filter(Boolean));
  return ids.has(psid) || ids.has(userKey);
}

function withSyncedQuota(state: MessengerUserState, now = Date.now()): MessengerUserState {
  const dayKey = getDayKey(now);

  if (state.quota.dayKey === dayKey) {
    return state;
  }

  return {
    ...state,
    quota: {
      dayKey,
      count: 0,
    },
    updatedAt: now,
  };
}

async function syncQuotaState(psid: string, now = Date.now()): Promise<MessengerUserState> {
  const current = withSyncedQuota(await Promise.resolve(getOrCreateState(psid)), now);

  return Promise.resolve(
    updateStoredState<MessengerUserState>(psid, storedState => {
      if (!storedState) {
        return current;
      }

      return withSyncedQuota(storedState, now);
    }),
  );
}

export async function canGenerate(psid: string): Promise<boolean> {
  const state = await syncQuotaState(psid);
  if (hasQuotaBypass(psid, state.userKey)) {
    return true;
  }

  return state.quota.count < FREE_DAILY_LIMIT;
}

export async function increment(psid: string): Promise<void> {
  const now = Date.now();
  const current = await syncQuotaState(psid, now);
  if (hasQuotaBypass(psid, current.userKey)) {
    return;
  }


  await Promise.resolve(
    updateStoredState<MessengerUserState>(psid, storedState => {
      const baseState = withSyncedQuota(storedState ?? current, now);

      return {
        ...baseState,
        quota: {
          ...baseState.quota,
          count: baseState.quota.count + 1,
        },
        updatedAt: now,
      };
    }),
  );
}
