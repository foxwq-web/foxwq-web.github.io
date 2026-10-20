import type { Clock, SessionState } from "./state";
export function clockInputValue(seconds: number): string {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0"))
    .join(":");
}


// Fox's 006e7060 rounds elapsed milliseconds to the nearest second. Its own
// clock tick (006e7cd0) spends a period only after seconds become negative;
// the opponent tick (006e7fd0) waits at zero for the next server update.
export function clockReading(clock: Clock, elapsed = 0, periodLength = 60, own = true) {
  const ticks = Math.floor(Math.max(0, elapsed) + 0.5);
  const main = Math.max(0, clock.main - ticks);
  if (main > 0)
    return {
      main,
      periods: clock.periods,
      seconds: clock.byoyomi,
      overtime: false,
    };
  const length = clock.periodLength || periodLength;
  let periods = clock.periods;
  let seconds = clock.byoyomi - Math.max(0, ticks - clock.main);
  if (own && seconds < 0 && periods > 0) {
    periods--;
    // The native tick spends at most one period and resets its anchor to now.
    // Session.tickClock persists that reset before the next display/audio tick.
    seconds = periods ? length : 0;
  }
  seconds = periods ? Math.max(0, seconds) : 0;
  return { main: 0, periods, seconds, overtime: true };
}

export class ByoyomiAnnouncements {
  play: (name: string) => void;
  game: string | null = null;
  turn: string | null = null;
  periods: number | null = null;
  said = new Set<string>();
  saidPeriods = new Set<number>();
  sawMain = false;
  byoyomiAnnounced = false;
  constructor(play: (name: string) => void) {
    this.play = play;
    this.reset();
  }
  reset() {
    this.game = null;
    this.turn = null;
    this.periods = null;
    this.said = new Set<string>();
    this.saidPeriods = new Set<number>();
    this.sawMain = false;
    this.byoyomiAnnounced = false;
  }
  update(state: SessionState, time = Date.now() / 1000) {
    if (state.phase !== "playing") {
      this.reset();
      return;
    }
    const game = `${state.gameId ?? ""}:${state.color}`;
    if (game !== this.game) {
      this.reset();
      this.game = game;
    }
    const clock = state.clocks[state.color];
    if (!clock) return;
    const active =
      state.turn === state.color &&
      !state.pending &&
      !state.counting &&
      !state.confirmation;
    const reading = clockReading(
      clock,
      active ? Math.max(0, time - clock.at) : 0,
    );
    this.sawMain ||= !reading.overtime;
    if (!active) {
      this.turn = null;
      return;
    }
    const turn = `${state.moves}:${state.color}`;
    if (turn !== this.turn) {
      this.said.clear();
      this.turn = turn;
    }
    if (
      reading.overtime &&
      reading.periods > 0 &&
      this.sawMain &&
      !this.byoyomiAnnounced
    ) {
      this.byoyomiAnnounced = true;
      this.play("byoyomi-start");
    }
    if (
      this.periods !== null &&
      reading.periods < this.periods &&
      [1, 2].includes(reading.periods) &&
      !this.saidPeriods.has(reading.periods)
    ) {
      this.saidPeriods.add(reading.periods);
      this.play(`periods-${reading.periods}`);
    }
    this.periods = reading.periods;
    if (reading.overtime && reading.seconds >= 1 && reading.seconds <= 9) {
      const key = `${reading.periods}:${reading.seconds}`;
      if (!this.said.has(key)) {
        this.said.add(key);
        this.play(`count-${reading.seconds}`);
      }
    }
  }
}
