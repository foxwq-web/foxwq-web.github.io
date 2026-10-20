import type { TimeControl } from "./state";
const NAME = "foxwq_time_control";
export function rememberedTimeControl(): Omit<TimeControl, "id"> | null {
  try {
    const entry = document.cookie
      .split("; ")
      .find((value) => value.startsWith(`${NAME}=`));
    if (!entry) return null;
    const value = JSON.parse(decodeURIComponent(entry.slice(NAME.length + 1)));
    return value?.size === 19 &&
      [value.main, value.periods, value.byoyomi].every(
        (v: unknown) =>
          Number.isSafeInteger(v) && typeof v === "number" && v >= 0,
      ) &&
      (value.periods === 0 ? value.main > 0 : value.byoyomi > 0)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function rememberTimeControl({
  size,
  main,
  periods,
  byoyomi,
}: Omit<TimeControl, "id">) {
  const value = encodeURIComponent(
    JSON.stringify({ size, main, periods, byoyomi }),
  );
  try {
    document.cookie = `${NAME}=${value}; Max-Age=${365 * 24 * 60 * 60}; Path=/; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {

  }
}
