import { gameFields as Game, roomFields as Room, commonFields as Common } from "./protocol-fields.ts";
import { GAME_SVR, GoGameMessageID as ID, RoomMessageID } from "./protocol.ts";
import { decode, type Message } from "./wire.ts";

// ProtoMember tags from Android 6.9.9, not C# declaration positions.
// See research/android-room-identity-tags.json and its extraction script.
const roomKeyFields: Partial<Record<number, number>> = {
  [ID.GC_START_SET_PIECE_NOTIFY]: Game.StartSetPieceNotify.room_key,
  [ID.GC_GAME_COUNTDOWN_NOTIFY]: Game.GameCountdownNotify.room_key,
  [ID.GC_RESUME_COUNTDOWN_NOTIFY]: Game.ResumeCountdownNotify.room_key,
  [ID.GC_HEART_BEAT_REQUEST]: Game.HeartBeatResponse.room_key,
  [ID.GC_SET_PIECE_REQUEST]: Game.SetPieceResponse.room_key,
  [ID.GC_SET_PIECE_NOTIFY]: Game.SetPieceNotify.room_key,
  [ID.GC_SKIP_SET_PIECE_REQUEST]: Game.SkipSetPieceResponse.room_key,
  [ID.GC_SKIP_SET_PIECE_NOTIFY]: Game.SkipSetPieceNotify.room_key,
  [ID.GC_GAME_PAUSE_NOTIFY]: Game.GamePauseNotify.room_key,
  [ID.GC_GAME_RESUME_NOTIFY]: Game.GameResumeNotify.room_key,
  [ID.GC_CALCULATE_REQUEST]: Game.CalculateResponse.room_key,
  [ID.GC_CALCULATE_CONFIRM_NOTIFY]: Game.CalculateConfirmNotify.room_key,
  [ID.GC_CALCULATE_ANSWER_REQUEST]: Game.CalculateAnswerResponse.room_key,
  [ID.GC_CALCULATE_ANSWER_NOTIFY]: Game.CalculateAnswerNotify.room_key,
  [ID.GC_GIVE_UP_REQUEST]: Game.GiveUpResponse.room_key,
  [ID.GC_SET_GAME_END_NOTIFY]: Game.SetGameEndNotify.room_key,
  [ID.GC_SET_GAME_RESULT_NOTIFY]: Game.SetGameResultNotify.room_key,
  [ID.LEGACY_GC_SET_GAME_END_NOTIFY]: Game.SetGameEndNotify.room_key,
  [ID.GC_ROOM_DESTROY_NOTIFY]: Game.RoomDestroyNotify.room_key,
  [ID.GC_FETCH_GAME_ENV_REQUEST]: Game.FetchGameEnvResponse.room_key,
  [ID.GC_OPPONENT_OFFLINE_NOTIFY]: Game.OpponentOfflineNotify.room_key,
  [ID.GC_OPPONENT_RECONNECT_NOTIFY]: Game.OpponentReconnectNotify.room_key,
};
const countdownFields: Partial<Record<number, number>> = {
  [ID.GC_SET_PIECE_NOTIFY]: Game.SetPieceNotify.countdown,
  [ID.GC_SKIP_SET_PIECE_NOTIFY]: Game.SkipSetPieceNotify.countdown,
  [ID.GC_RESUME_COUNTDOWN_NOTIFY]: Game.ResumeCountdownNotify.countdown,
};

export interface ValidatedGameRoom {
  roomKey: Record<number, number>;
  completeBodyIdentity: boolean;
}

/** Check every supplied identity against the expected room and each other.
 * Missing optional fields remain compatible with older Fox messages.
 */
export function validateGameRoom(
  messageId: number,
  message: Message,
  header: Message | undefined,
  expected: Record<number, number>,
): ValidatedGameRoom | null {
  const identity: Record<number, number> = {};
  const bodyFields = new Set<number>();
  function add(value: unknown, field: number, body: boolean) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return false;
    if ((expected[field] !== undefined && expected[field] !== value) ||
        (identity[field] !== undefined && identity[field] !== value)) return false;
    identity[field] = value;
    if (body) bodyFields.add(field);
    return true;
  }
  function fields(source: Message, tags: number[], body = true) {
    return tags.every((tag, index) => !source.has(tag) || add(source.one(tag), index + 1, body));
  }
  function nested(source: Message, tag: number) {
    return !source.has(tag) || fields(source.sub(tag), [Game.RoomKey.server_type, Game.RoomKey.server_id, Game.RoomKey.room_id, Game.RoomKey.create_time]);
  }
  try {
    if (!add(GAME_SVR, Game.RoomKey.server_type, false) || (header && !fields(header, [Common.FGWHead.server_type, Common.FGWHead.server_id], false))) return null;
    const roomTag = roomKeyFields[messageId];
    if (roomTag !== undefined && !nested(message, roomTag)) return null;
    if (messageId === ID.GC_START_SET_PIECE_NOTIFY && !fields(message, [Game.StartSetPieceNotify.server_type, Game.StartSetPieceNotify.server_id, Game.StartSetPieceNotify.room_id, Game.StartSetPieceNotify.room_create_time])) return null;
    if (messageId === ID.GC_FETCH_GAME_ENV_REQUEST && !fields(message, [Game.FetchGameEnvResponse.server_type, Game.FetchGameEnvResponse.server_id, Game.FetchGameEnvResponse.room_id, Game.FetchGameEnvResponse.room_create_time])) return null;
    if ([RoomMessageID.RM_ENTER_ROOM_NOTIFY, RoomMessageID.RM_QUERY_GAME_LOCK_REQUEST].includes(messageId) &&
        !fields(message, [Room.EnterRoomNotify.server_type, Room.EnterRoomNotify.server_id, Room.EnterRoomNotify.room_id, Room.EnterRoomNotify.room_create_time])) return null;
    if (messageId === ID.GS_OP_ERROR && !fields(message, [Game.GameRoomOpErrorCode.server_type, Game.GameRoomOpErrorCode.server_id])) return null;
    const countdownTag = countdownFields[messageId];
    if (countdownTag !== undefined) {
      for (const bytes of message.get(countdownTag) ?? []) {
        if (!nested(decode(bytes), Game.GameCountdownNotify.room_key)) return null;
      }
    }
    return {
      roomKey: { ...expected, ...identity },
      completeBodyIdentity: [Game.RoomKey.server_type, Game.RoomKey.server_id, Game.RoomKey.room_id, Game.RoomKey.create_time].every(field => bodyFields.has(field)),
    };
  } catch {
    // Malformed room metadata cannot be allowed to change the current game.
    return null;
  }
}
