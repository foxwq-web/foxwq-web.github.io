import {
  encode,
  decode,
  type Fields,
  type Message,
} from "./wire.ts";
import { gatewayPayload, splitGateway } from "./framing.ts";
export const GATEWAY = 20001,
  ROOM = 30006,
  GAME = 31000;
export const NORMAL = [19, 1200, 3, 60];
export function envelope(
  uid: number,
  service: number,
  operation: number,
  fields: Fields = {},
  node = 0,
) {
  return gatewayPayload(
    encode({
      1: operation,
      3: uid,
      5: 32,
      6: 6,
      7: service,
      8: node,
      19: "11509231",
      20: 4,
    }),
    encode(fields),
  );
}
export function unpack(payload: import("buffer").Buffer) {
  return splitGateway(payload).map(decode);
}
export function matchFields(records: Message[]) {
  const seen = new Set();
  return records
    .filter(
      (r) => r.number(2) === 19 && r.number(12) === 1 && r.number(7) === 0,
    )
    .map((r) => ({
      id: r.number(1),
      size: r.number(2),
      main: r.number(3),
      periods: r.number(4),
      byoyomi: r.number(5),
    }))
    .filter(
      (f) =>
        Number.isSafeInteger(f.id) &&
        f.id > 0 &&
        [f.main, f.periods, f.byoyomi].every(
          (v) => Number.isSafeInteger(v) && v >= 0,
        ) &&
        (f.periods === 0 ? f.main > 0 : f.byoyomi > 0) &&
        !seen.has(f.id) &&
        seen.add(f.id),
    )
    .sort(
      (a, b) =>
        a.main - b.main ||
        a.byoyomi - b.byoyomi ||
        a.periods - b.periods ||
        a.id - b.id,
    );
}
export function timeLabel(field: {
  main: number;
  periods: number;
  byoyomi: number;
}) {
  const main =
    field.main === 0
      ? ""
      : field.main % 60 === 0
        ? `${field.main / 60}m`
        : `${field.main}s`;
  return field.periods ? `${main}${field.byoyomi}s` : main;
}
export function rankLabel(rank: number) {
  if (!Number.isInteger(rank) || rank < 0) return "";
  if (rank < 18) return `${18 - rank}k`;
  if (rank < 27) return `${rank - 17}d`;
  if (rank < 36) return `${rank - 26}p`;
  return "";
}
export function resultLabel(winner: unknown, points: number | null, ending: "R" | "T" | "F" | "Void" | "" = "") {
  if (ending === "Void") return "Void";
  if (winner === 3) return "0";
  if (winner !== 1 && winner !== 2) return "";
  return `${winner === 1 ? "B" : "W"}+${ending || (points ?? "")}`;
}
export function plain(message: Message): Fields {
  return Object.fromEntries(
    [...message].map(([key, values]) => [
      key,
      values.length > 1 ? values : values[0],
    ]),
  );
}


export function countingResult(message: Message) {
  const winner = message.number(8);
  const result: {
    winner: string | null;
    black?: number;
    white?: number;
    komi?: number;
  } = {
    winner:
      (
        { 1: "Black wins", 2: "White wins", 3: "Draw" } as Record<
          number,
          string
        >
      )[winner] ?? null,
  };
  if (message.has(6)) {
    const bytes = new DataView(new ArrayBuffer(4));
    bytes.setUint32(0, message.number(6), true);
    const black = bytes.getFloat32(0, true);
    if (Number.isFinite(black) && black >= 0 && black <= 361) {
      result.black = black;
      result.white = 361 - black;
      result.komi = 7.5;
    }
  }
  return result;
}
