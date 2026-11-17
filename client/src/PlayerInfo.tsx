import { createPortal, memo, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'preact/compat';
import { formatDateTime } from './date-time';
import type { Controller } from './controller';
import type { PlayerInfo, PlayerInfoSeed } from './player-info';
import { playerFlags } from './player-flags';
import { HISTORY_PAGE_SIZE } from './player-history';
import { navigateTo, reviewPath } from './routes';

const HISTORY_VISIBLE_ROWS = 9;
const HISTORY_COLUMNS = [
  { key: 'date', className: 'history-date', heading: 'Date' },
  { key: 'opponent', className: 'history-opponent-cell', heading: 'Opponent' },
  { key: 'rank', className: 'history-rank', heading: 'Rank' },
  { key: 'result', className: 'history-result', heading: 'Result' },
  { key: 'moves', className: 'history-moves', heading: 'Moves' },
];

export function playerLabel(name: string, rank?: string, ai = false) {
  return `${name}${ai ? ' AI' : ''}${rank !== undefined ? ` (${rank || '—'})` : ''}`;
}
export function PlayerFlag({ country }: { country?: number }) {
  const flag = country === undefined ? undefined : playerFlags[country];
  return flag ? <img className="player-flag" src={flag.src} alt={flag.name} title={flag.name}
    width={flag.width} height={flag.height} /> : null;
}
function PlayerRank({ rank }: { rank?: string }) {
  return <span className="player-rank">{rank || '—'}</span>;
}
function RankedPlayerLabel({ name, rank, country, ai }: { name: string; rank?: string; country?: number; ai?: boolean }) {
  return <span className="player-name-with-rank"><PlayerFlag country={country} />
    <span>{playerLabel(name, undefined, ai)}</span>{' '}<PlayerRank rank={rank} /></span>;
}
export function PlayerName({ controller: c, uid, name, rank = '', country, wins, losses, showRank = true, id, rowTrigger = false }: {
  controller: Controller; uid?: number; name: string; rank?: string; showRank?: boolean; id?: string; rowTrigger?: boolean;
} & PlayerInfoSeed) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), card = useRef<HTMLDialogElement>(null);
  const cardId = useId();
  const info = c.state.session.playerInfo;
  const visible = open && info?.uid === uid && info?.anchor === cardId;
  const close = () => {
    card.current?.close();
    setOpen(false);
  };
  const show = () => {
    if (!uid) return;
    c.session.playerInfo.open(uid, name, rank, cardId, { country, wins, losses });
    setOpen(true);
  };
  useEffect(() => {
    if (!rowTrigger) return;
    const row = trigger.current?.closest('tr');
    if (!row) return;
    const click = (event: MouseEvent) => {
      if (!trigger.current?.contains(event.target as Node)) show();
    };
    row.addEventListener('click', click);
    return () => row.removeEventListener('click', click);
  });
  useLayoutEffect(() => {
    const dialog = card.current;
    if (!visible || !dialog || dialog.open) return;
    dialog.showModal();
    // Native dialogs focus their first control on opening. Start without a
    // focused control; keyboard navigation can still reach every action.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && dialog.contains(focused)) focused.blur();
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [visible]);
  const ai = !!uid && c.state.session.aiPlayers?.includes(uid);
  const label = showRank ? <RankedPlayerLabel name={name} rank={rank} ai={ai} />
    : playerLabel(name, undefined, ai);
  if (c.recordedGame && c.preparedArchive !== c) return <span id={id} className="player-name-with-rank"><span>{name}</span>
    {showRank && rank && <> <PlayerRank rank={rank} /></>}</span>;
  if (!uid) return <span id={id}>{label}</span>;
  return <>
    <button ref={trigger} id={id} type="button" className={`text-button player-name${rowTrigger ? ' player-row-trigger' : ''}`}
      onClick={show}>{label}</button>
    {visible && info && createPortal(<dialog ref={card} id={cardId}
      className="player-info"
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}
      onCancel={event => { event.preventDefault(); close(); }}
      onClose={event => {
        // Ignore the close event of a dismissed dialog that Preact reuses.
        if (event.currentTarget !== card.current) return;
        setOpen(false);
        trigger.current?.focus();
      }}>
      <button type="button" className="player-info-close text-button" onClick={close}>
        <span className="clear-icon" />
      </button>
      <InfoContent info={info} aiPlayers={c.state.session.aiPlayers} />
    </dialog>, document.body)}
  </>;
}
// Keep the history table stable during parent clock updates.
const InfoContent = memo(function InfoContent({ info: h, aiPlayers }: {
  info: PlayerInfo; aiPlayers?: number[];
}) {
  const progress: ReactNode[] = [];
  if (h.promotion && h.rank !== '9d' && !h.rank.endsWith('p')) progress.push(<span key="up">{h.promotion} wins to promote{h.doublePromotion ? ` (${h.doublePromotion} for 2 ranks)` : ''}</span>);
  if (h.demotion) progress.push(<span key="down">{h.demotion} losses to demote{h.doubleDemotion ? ` (${h.doubleDemotion} for 2 ranks)` : ''}</span>);
  const summaryLoading = h.summaryLoading && !h.summaryLoaded;
  const totals = h.wins !== undefined ? <>{h.wins} wins / {h.losses ?? '—'} losses</> : undefined;
  const historyLoading = h.loading && !h.games.length;
  return <>
    <h2><RankedPlayerLabel name={h.name} rank={h.rank} country={h.country} ai={h.ai || aiPlayers?.includes(h.uid)} /></h2>
    <div className="player-info-summary">
      {summaryLoading && <>
        <span className="player-info-loading">Loading player details…</span>
        <div className="player-summary-skeleton">
          <p>{totals ?? <span className="player-skeleton" />}</p>
          <p className="player-recent-placeholder"><span className="player-skeleton" /></p>
          <p className="player-rank-progress"><span className="player-skeleton" /></p>
        </div>
      </>}
      {!summaryLoading && <>
        <p>{totals ?? <span className="player-data-placeholder">—</span>}</p>
        <p className="player-recent">
          {h.recent ? [...h.recent].map((r, i) => <span key={i} className={r === '+' ? 'win' : r === '-' ? 'loss' : ''} />)
            : <span className="player-recent-empty player-data-placeholder">—</span>}
        </p>
        <p className="player-rank-progress">{progress.length
          ? progress.map((item, index) => <span key={index}>{index > 0 && ' / '}{item}</span>) : <span className="player-data-placeholder">—</span>}</p>
      </>}
    </div>
    <div className="player-info-games"
      style={{ '--history-visible-rows': HISTORY_VISIBLE_ROWS } as CSSProperties}>
      {historyLoading && <span className="player-info-loading">Loading recent games…</span>}
      {!h.loading && !h.error && !h.games.length && <p>No recent games available.</p>}
      {(historyLoading || !!h.games.length) && <table className={historyLoading ? 'player-history-skeleton' : undefined}><thead><tr>{HISTORY_COLUMNS.map(column => <th key={column.key} className={column.className}>{column.heading}</th>)}</tr></thead>
        <tbody>{historyLoading ? Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => <tr key={i}>
          {HISTORY_COLUMNS.map(column => <td key={column.key} className={column.className}><span className="player-skeleton" /></td>)}
        </tr>) : h.games.map(g => <tr key={g.id}>
          <td className="history-date"><span className="history-date-text">{formatDateTime(g.date)}</span>
            <a className="history-game-link" title={formatDateTime(g.date)} href={reviewPath(g.id)}
              onClick={event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigateTo(event.currentTarget.pathname);
              }} />
          </td>
          <td className="history-opponent-cell"><span className="history-opponent"><span className={`player-stone ${g.color === 'Black' ? 'white' : 'black'}`} />
            <span className="history-opponent-name">{playerLabel(g.opponent, undefined, !!g.opponentId && aiPlayers?.includes(g.opponentId))}</span></span></td>
          <td className="history-rank"><PlayerRank rank={g.opponentRank} /></td>
          <td className={`history-result ${g.outcome}`}>{g.result}</td>
          <td className="history-moves">{g.moves ?? "—"}</td>
        </tr>)}</tbody></table>}
    </div>
  </>;
});
