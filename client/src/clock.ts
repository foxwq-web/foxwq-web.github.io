import type { Clock } from "./state";
export function clockInputValue(seconds: number): string {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0"))
    .join(":");
}


export function clockReading(clock: Clock, elapsed = 0, periodLength = 60) {
  const main = Math.max(0, clock.main - elapsed);
  if (main > 0)
    return {
      main,
      periods: clock.periods,
      seconds: clock.byoyomi,
      overtime: false,
    };
  const overtime = Math.max(0, elapsed - clock.main);
  const length = clock.periodLength || periodLength;
  const spent =
    overtime < clock.byoyomi
      ? 0
      : 1 + Math.floor((overtime - clock.byoyomi) / length);
  const periods = Math.max(0, clock.periods - spent);
  const seconds = periods
    ? Math.ceil(
        spent
          ? length - ((overtime - clock.byoyomi) % length)
          : clock.byoyomi - overtime,
      )
    : 0;
  return { main: 0, periods, seconds, overtime: true };
}
