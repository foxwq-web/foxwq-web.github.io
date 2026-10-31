import { StoneColor, BoardSize, JuShiConst, DuMiaoNumConst, DuMiaoConst, GameTypeTag, ENAdditionalRuleType, ENClientType } from "./protocol.ts";
import { gameFields as Game, commonFields as Common } from "./protocol-fields.ts";
import {
  encode,
  decode,
  type Fields,
  type Message,
} from "./wire.ts";
import { encodeFgwPacket, splitFgwPacket } from "./framing.ts";
export { SVR_TYPE_FGW, GAME_SVR_MGR, GAME_SVR } from "./protocol.ts";
export const NORMAL = [BoardSize.E_Board_Size_19, JuShiConst.JU_SHI_20_MIN * 60, DuMiaoNumConst.DU_MIAO_NUM_3, DuMiaoConst.DU_MIAO_60_SEC];
export function encodeFgwMessage(
  uid: number,
  serverType: number,
  messageId: number,
  fields: Fields = {},
  serverId = 0,
) {
  return encodeFgwPacket(
    encode({
      [Common.FGWHead.message_id]: messageId,
      [Common.FGWHead.uid]: uid,
      [Common.FGWHead.client_type]: ENClientType.E_CLIENT_TYPE_PC,
      [Common.FGWHead.account_type]: 6,
      [Common.FGWHead.server_type]: serverType,
      [Common.FGWHead.server_id]: serverId,
      [Common.FGWHead.pc_client_version]: "11509231",
      [Common.FGWHead.language]: 4,
    }),
    encode(fields),
  );
}
export function decodeFgwMessage(payload: import("buffer").Buffer) {
  return splitFgwPacket(payload).map(decode);
}
export function fieldCfgsToTimeControls(records: Message[]) {
  const seen = new Set();
  return records
    .filter(
      (r) => r.number(Game.FieldCfg.board_size) === BoardSize.E_Board_Size_19 && r.number(Game.FieldCfg.game_type_tag) === GameTypeTag.GAME_TYPE_TAG_NORMAL && r.number(Game.FieldCfg.additional_rule) === ENAdditionalRuleType.EN_ADDI_BASIC,
    )
    .map((r) => ({
      id: r.number(Game.FieldCfg.field_id),
      size: r.number(Game.FieldCfg.board_size),
      main: r.number(Game.FieldCfg.jushi_sec),
      periods: r.number(Game.FieldCfg.dumiao_num),
      byoyomi: r.number(Game.FieldCfg.dumiao_sec),
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
  if (winner !== StoneColor.BLACK && winner !== StoneColor.WHITE) return "";
  return `${winner === StoneColor.BLACK ? "B" : "W"}+${ending || (points ?? "")}`;
}
export function plain(message: Message): Fields {
  return Object.fromEntries(
    [...message].map(([key, values]) => [
      key,
      values.length > 1 ? values : values[0],
    ]),
  );
}


export function decodeCalculateConfirmNotify(message: Message) {
  const winner = message.number(Game.CalculateConfirmNotify.win_color);
  const result: {
    winner: string | null;
    black?: number;
    white?: number;
    komi?: number;
    ownership?: number[];
  } = {
    winner:
      (
        { [StoneColor.BLACK]: "Black wins", [StoneColor.WHITE]: "White wins", 3: "Draw" } as Record<
          number,
          string
        >
      )[winner] ?? null,
  };
  // Native 00813e70 -> 006ec320 -> 00594880 reads the first 19×19
  // ASCII points from field 5. Captures include two trailing zeroes.
  const map = message.bytes(Game.CalculateConfirmNotify.china_position_judge).subarray(0, 361).toString("utf8");
  if (/^[012]{361}$/.test(map)) result.ownership = Array.from(map, Number);
  if (message.has(Game.CalculateConfirmNotify.black_shuzi)) {
    const bytes = new DataView(new ArrayBuffer(4));
    bytes.setUint32(0, message.number(Game.CalculateConfirmNotify.black_shuzi), true);
    const black = bytes.getFloat32(0, true);
    if (Number.isFinite(black) && black >= 0 && black <= 361) {
      result.black = black;
      result.white = 361 - black;
      result.komi = 7.5;
    }
  }
  return result;
}
