import { rankLabel, resultLabel } from "./game";

export const RECENT_GAME_LIMIT = 20;
export interface HistoryGame {
  id: string;
  date: number;
  opponent: string;
  opponentRank: string;
  color: "Black" | "White";
  result: string;
  moves: number | null;
  outcome: "win" | "loss" | "draw" | "unknown";
}
export interface PlayerHistory {
  uid: number;
  name: string;
  rank: string;
  loading: boolean;
  error: string;
  games: HistoryGame[];
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Fox game response.");
  const response = value as Record<string, unknown>;
  if (response.result !== 0) throw Error(`Fox could not load this record (${response.result ?? "unknown"}).`);
  return response;
}

// TXWQFetchChessList returns decimal strings for uint64 chess IDs. Converting
// them to Number changes the ID and can merge distinct table rows.
export function historyGames(value: unknown, uid: number): HistoryGame[] {
  const response = responseObject(value);
  if (!Array.isArray(response.chesslist)) throw Error("Invalid Fox game history response.");
  return response.chesslist.map((item): HistoryGame | null => {
    if (!item || typeof item !== "object") throw Error("Invalid Fox game history record.");
    const record = item as Record<string, unknown>;
    const color = record.blackuid === uid ? 1 : record.whiteuid === uid ? 2 : 0;
    if (!color) return null;
    if (typeof record.chessid !== "string" || !/^[1-9][0-9]{0,19}$/.test(record.chessid) || BigInt(record.chessid) > 18446744073709551615n)
      throw Error("Invalid Fox game identifier.");
    const date = gameTime(record.gamestarttime, record.gameendtime);
    if (date === null) throw Error("Invalid Fox game date.");
    const opponentColor = color === 1 ? "white" : "black";
    const name = record[`${opponentColor}enname`] || record[`${opponentColor}nick`];
    const rank = record[`${opponentColor}dan`];
    const winner = record.winner;
    const outcome = record.reason === 8 ? "unknown" : winner === 3 ? "draw" : winner === 1 || winner === 2
      ? winner === color ? "win" : "loss" : "unknown";
    const ending = record.reason === 8 ? "Void"
      : record.reason === 3 || record.point === -1 ? "R"
      : record.reason === 2 || record.point === -2 ? "T"
      : record.reason === 7 || record.point === -3 ? "F" : "";
    const points = typeof record.point === "number" && record.point >= 0
      ? record.point / (record.additionalrule ? 100 : 50) : null;
    return {
      id: record.chessid, date,
      opponent: typeof name === "string" && name ? name : "Unknown player",
      opponentRank: typeof rank === "number" ? rankLabel(rank) : "",
      color: color === 1 ? "Black" : "White",
      result: resultLabel(winner, points, ending) || "Unknown",
      moves: typeof record.movenum === "number" && Number.isSafeInteger(record.movenum) && record.movenum >= 0 ? record.movenum : null,
      outcome,
    };
  }).filter((record): record is HistoryGame => !!record)
    .sort((a, b) => b.date - a.date).slice(0, RECENT_GAME_LIMIT);
}

function gameTime(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value !== "number" && typeof value !== "string") continue;
    const time = Number(value);
    if (Number.isSafeInteger(time) && time > 0 && time <= 8640000000000) return time;
  }
  return null;
}
