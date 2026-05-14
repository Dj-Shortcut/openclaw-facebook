import { hasFacebookConfiguredEnv } from "./src/naming.js";

export function hasFacebookConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return hasFacebookConfiguredEnv(params.env);
}

export function hasMessengerConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return hasFacebookConfiguredState(params);
}
