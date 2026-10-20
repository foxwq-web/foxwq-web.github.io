// Run: node --import tsx client/scripts/investigate-countdown.ts
// No audio device, network connection, or credentials are used.
import assert from "node:assert/strict";
import { clockReading, ByoyomiAnnouncements } from "../src/clock.ts";
import { Session } from "../src/session.ts";
import { decode, encode } from "../src/wire.ts";

const session = new Session();
const originalNow = Date.now;
let time = 0;
Date.now = () => time * 1000;
const voices: { time: number; name: string }[] = [];
const speaker = new ByoyomiAnnouncements(name => voices.push({ time, name }));
const rows: object[] = [];

try {
  session.phase = "playing"; session.uid = 42; session.color = 1;
  session.board.timeControl = { main: 0, periods: 3, byoyomi: 60 };
  session.clocks[1] = { main: 0, periods: 3, byoyomi: 60, periodLength: 60, at: 0 };
  function sample(at: number) {
    time = at;
    session.tickClock(time);
    const clock = session.clocks[1];
    const reading = clockReading(clock, time - clock.at);
    const before = voices.length;
    speaker.update(session.snapshot(), time);
    rows.push({ time, periods: reading.periods, seconds: reading.seconds,
      voice: voices.slice(before).map(v => v.name).join(", ") });
    return reading;
  }
  for (let t = 50.5; t <= 60.5; t++) sample(t);
  assert.deepEqual(voices.map(v => v.name), [
    ...Array.from({ length: 9 }, (_, i) => `count-${9 - i}`), "periods-2",
  ]);
  assert.equal((rows[9] as { seconds: number }).seconds, 0);
  assert.equal(session.clocks[1].at, 60.5);
  console.log("Native cadence: nine through one, displayed zero, then period rollover");
  console.table(rows);

  time = 100;
  session.gameMessage(108, decode(encode({ 2: 0, 3: 2, 4: 0, 5: 42 })), decode(encode({})));
  assert.equal(sample(100).seconds, 0);
  assert.equal(session.clocks[1].periods, 2);
  assert.equal(sample(100.5).periods, 1);
  console.log("Server zero is preserved; the next native tick spends the period.");

  time = 200;
  session.clocks[1] = { main: 0, periods: 3, byoyomi: 60, periodLength: 60, at: time };
  time = 252;
  session.gameMessage(108, decode(encode({ 2: 0, 3: 3, 4: 60, 5: 42 })), decode(encode({})));
  assert.equal(session.clocks[1].byoyomi, 8);
  console.log("Full initial-period notification clamps to the displayed 8 seconds.");
} finally {
  Date.now = originalNow;
  session.close();
}
