import { persistenceAllowed } from "./persistence";
const NAME = "foxwq_coordinates";

export function rememberedCoordinates(): boolean {
  try {
    return document.cookie.split("; ").includes(`${NAME}=true`);
  } catch {
    return false;
  }
}

export function rememberCoordinates(shown: boolean) {
  if (!persistenceAllowed()) return;
  try {
    document.cookie = `${NAME}=${shown}; Max-Age=${365 * 24 * 60 * 60}; Path=/; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {}
}
