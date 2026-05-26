import { routeActiveExperience, routeEntryIntent } from "./experienceRouter";
import {
  getOrCreateState,
  setActiveExperience,
  setLastEntryIntent,
  type MessengerUserState,
} from "./messengerState";
import { sendWhatsAppExperienceRouteResponse } from "./whatsappResponseService";
import type { NormalizedWhatsAppEvent } from "./whatsappTypes";

export async function handleWhatsAppExperienceRouting(
  event: NormalizedWhatsAppEvent
): Promise<boolean> {
  const currentState = await Promise.resolve(getOrCreateState(event.senderId));
  const routingInput = {
    state: currentState,
    setLastEntryIntent: (nextEntryIntent: MessengerUserState["lastEntryIntent"]) =>
      Promise.resolve(setLastEntryIntent(event.senderId, nextEntryIntent ?? null)),
    setActiveExperience: (
      nextActiveExperience: MessengerUserState["activeExperience"]
    ) =>
      Promise.resolve(
        setActiveExperience(event.senderId, nextActiveExperience ?? null)
      ),
  };

  const entryIntentRoute = await routeEntryIntent({
    ...routingInput,
    entryIntent: event.entryIntent ?? null,
  });
  if (entryIntentRoute.handled) {
    await sendWhatsAppExperienceRouteResponse(event.senderId, entryIntentRoute);
    return true;
  }

  const activeExperienceRoute = await routeActiveExperience({
    ...routingInput,
    action: event.textBody ?? null,
  });
  if (activeExperienceRoute.handled) {
    await sendWhatsAppExperienceRouteResponse(event.senderId, activeExperienceRoute);
    return true;
  }

  return false;
}
