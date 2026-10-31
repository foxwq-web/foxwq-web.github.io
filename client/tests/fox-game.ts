import { gameFields as Game } from "../src/protocol-fields.ts";
import { GAME_SVR } from "../src/protocol.ts";
import type { Session } from '../src/session.ts';

export function setupFoxGame(session: Session) {
  session.phase = 'playing';
  session.color = session.board.turn;
  session.roomKey = { [Game.RoomKey.server_type]: GAME_SVR, [Game.RoomKey.server_id]: 63, [Game.RoomKey.room_id]: 23, [Game.RoomKey.create_time]: 202 };
  session.fgwConnection = { send() {}, close() {} } as unknown as Session['fgwConnection'];
  session.changed();
}
