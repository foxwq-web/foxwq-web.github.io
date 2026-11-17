import type { Screen } from './dev-screens';
import type { Session } from './session';
import { PREVIEW_PLAYERS } from './dev-players';

// The signed-in account is shown above the time controls.
const profileTrigger = '#matchmaking-player .player-name';

type HistoryState = 'loading' | 'summary-pending' | 'games-pending' | 'missing' | 'no-recent' |
  'no-progress' | '9d' | 'professional' | 'short' | 'empty' | 'error' | 'scrolled';

async function history(session: Session, state: HistoryState) {
  const self = PREVIEW_PLAYERS[0];
  const info = session.playerInfo.prefetch(self.uid, self.name, '2d')!;
  for (let turn = 0; turn < 40 && !session.playerInfo.ready(self.uid); turn++)
    await new Promise(resolve => setTimeout(resolve));
  if (!session.playerInfo.ready(self.uid)) throw Error('offline player profile did not load');
  // Start with the real decoded profile. Hold selected responses after their
  // timers finish so loading previews stay stable while developers inspect them.
  if (state === 'loading' || state === 'summary-pending') Object.assign(info, {
    summaryLoading: true, summaryLoaded: false, recent: '', wins: undefined, losses: undefined,
    promotion: undefined, doublePromotion: undefined, demotion: undefined, doubleDemotion: undefined,
  });
  if (state === 'loading' || state === 'games-pending') Object.assign(info, { games: [], loading: true });
  if (state === 'missing') {
    Object.assign(info, { rank: '', recent: '', wins: undefined, losses: undefined, draws: undefined,
      promotion: undefined, doublePromotion: undefined, demotion: undefined, doubleDemotion: undefined });
    info.games = info.games.map(game => ({ ...game, opponentRank: '' }));
  }
  if (state === 'no-recent') info.recent = '';
  if (state === 'no-progress') Object.assign(info, {
    promotion: undefined, doublePromotion: undefined, demotion: undefined, doubleDemotion: undefined,
  });
  if (state === '9d' || state === 'professional') {
    info.rank = state === '9d' ? '9d' : '1p';
    // Keep promotion data present to exercise max-rank suppression.
    info.promotion = 6;
    info.demotion = info.doubleDemotion = undefined;
  }
  if (state === 'short') info.games = info.games.slice(0, 3);
  if (state === 'empty') info.games = [];
  if (state === 'error') Object.assign(info, { games: [], error: 'could not load recent games',
    wins: undefined, recent: '', promotion: undefined, demotion: undefined, summaryError: 'could not load player details' });
}

export const REGRESSION_SCREENS: Screen[] = [
  ...(['loading', 'summary-pending', 'games-pending', 'missing', 'no-recent', 'no-progress', '9d', 'professional', 'short', 'empty', 'error', 'scrolled'] as const)
    .map((state): Screen => ({ id: `history-${state}`, label: `Player history: ${state}`, group: 'Player history',
      stage: 'discovery', phase: 'ready', visualSuite: 'regression', playerName: profileTrigger,
      reach: `Click your player name above the time controls (${state})`, run: ({ session }) => history(session, state),
      ...(state === 'scrolled' ? { afterMount: () => requestAnimationFrame(() => {
        const table = document.querySelector('.player-info-games');
        if (table) table.scrollTop = table.scrollHeight;
      }) } : {}),
    })),
  { id: 'board-player-labels', label: 'AI labels and missing ranks in a game', group: 'Player history',
    stage: 'playing', phase: 'playing', visualSuite: 'regression', playerName: '#black-player-name',
    reach: 'Player ranks are absent; open the AI player’s history', run: async ({ session }) => {
      for (const player of Object.values(session.players)) player.rank = '';
      session.playerInfo.rememberAI(PREVIEW_PLAYERS[0].uid, true);
      await history(session, 'missing');
      session.playerInfo.rememberAI(session.playerInfo.prefetch(PREVIEW_PLAYERS[0].uid, '')!.games[0].opponentId!, true);
    } },
  ...(['ready', 'loading', 'error', 'variation', 'small-board', 'variant'] as const).map(record => ({
    id: `record-review-${record}`, label: `Archived game: ${record === 'small-board' ? 'unsupported board size' : record === 'variant' ? 'unsupported rules' : record}`, group: 'Archived games',
    stage: 'login' as const, phase: 'finished', visualSuite: 'record' as const, record,
    reach: 'Open a history row to review the recorded game and download its original SGF',
  })),
];
