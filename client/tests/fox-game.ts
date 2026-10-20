import type { Session } from '../src/session.ts';

export function setupFoxGame(session: Session) {
  session.phase = 'playing';
  session.color = session.board.turn;
  session.roomKey = { 1: 31000, 2: 63, 3: 23, 4: 202 };
  session.gateway = { send() {}, close() {} } as unknown as Session['gateway'];
  session.changed();
}
