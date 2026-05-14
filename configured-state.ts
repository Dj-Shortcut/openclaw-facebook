import { hasFacebookConfiguredEnv } from "./src/naming.js";

export function hasMessengerConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return hasFacebookConfiguredEnv(params.env);
}
