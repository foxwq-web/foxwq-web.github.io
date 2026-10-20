import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Controller } from './controller';
import type { PlayerInfo } from './player-info';

export function PlayerName({ controller: c, uid, name, rank = '', id }: {
  controller: Controller; uid?: number; name: string; rank?: string; id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const trigger = useRef<HTMLButtonElement>(null), card = useRef<HTMLDivElement>(null);
  const enter = useRef<ReturnType<typeof setTimeout>>(undefined), leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dismissing = useRef(false);
  const cardId = useId();
  const info = c.state.session.playerInfo;
  const visible = open && info?.uid === uid && info?.anchor === cardId;
  const close = () => {
    clearTimeout(enter.current); clearTimeout(leave.current);
    if (card.current?.contains(document.activeElement)) {
      dismissing.current = true;
      trigger.current?.focus();
      dismissing.current = false;
    }
    setOpen(false);
  };
  const show = () => {
    clearTimeout(leave.current); clearTimeout(enter.current);
    if (!uid) return;
    c.session.playerInfo.open(uid, name, rank, cardId);
    setOpen(true);
  };
  const delayClose = () => {
    clearTimeout(enter.current);
    leave.current = setTimeout(() => {
      if (!card.current?.contains(document.activeElement) && document.activeElement !== trigger.current) close();
    }, 180);
  };
  useEffect(() => () => { clearTimeout(enter.current); clearTimeout(leave.current); }, []);
  useEffect(() => {
    if (!visible) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); close(); } };
    const outside = (event: PointerEvent) => {
      if (!card.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', outside); };
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), popup = card.current;
      if (!anchor || !popup) return;
      const width = popup.offsetWidth, height = popup.offsetHeight;
      const right = anchor.right + 8;
      const left = right + width <= innerWidth - 8 ? right
        : anchor.left - width - 8 >= 8 ? anchor.left - width - 8
        : Math.min(Math.max(8, anchor.left), innerWidth - width - 8);
      setPosition({ left, top: Math.max(8, Math.min(anchor.top, innerHeight - height - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [visible, info]);
  const label = `${name}${rank ? ` (${rank})` : ''}`;
  if (!uid) return <span id={id}>{label}</span>;
  return <>
    <button ref={trigger} id={id} type="button" className="player-name" aria-expanded={!!visible}
      aria-controls={visible ? cardId : undefined} aria-haspopup="dialog"
      onPointerEnter={event => { if (event.pointerType === 'mouse') {
        clearTimeout(leave.current);
        if (c.session.playerInfo.ready(uid)) show();
        else enter.current = setTimeout(show, 180);
      } }}
      onPointerLeave={delayClose} onFocus={() => { if (!dismissing.current) show(); }} onBlur={event => {
        if (!card.current?.contains(event.relatedTarget as Node)) delayClose();
      }} onClick={show} onKeyDown={event => {
        if (event.key === 'ArrowDown' && visible) { event.preventDefault(); card.current?.focus(); }
      }}>{label}</button>
    {visible && info && createPortal(<div ref={card} id={cardId} role="dialog" aria-label={`${info.name} player information`}
      className="player-info" tabIndex={-1} style={position}
      onPointerEnter={() => clearTimeout(leave.current)} onPointerLeave={delayClose}
      onFocus={() => clearTimeout(leave.current)} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) delayClose();
      }}>
      <InfoContent info={info} />
    </div>, document.body)}
  </>;
}
function InfoContent({ info: h }: { info: PlayerInfo }) {
  const progress: ReactNode[] = [];
  if (h.promotion) progress.push(<span key="up">{h.promotion} wins to promote{h.doublePromotion ? ` (${h.doublePromotion} for 2 ranks)` : ''}</span>);
  if (h.demotion) progress.push(<span key="down">{h.demotion} losses to demote{h.doubleDemotion ? ` (${h.doubleDemotion} for 2 ranks)` : ''}</span>);
  return <>
    <h2>{h.name}{h.rank ? ` (${h.rank})` : ''}</h2>
    <div className="player-info-summary" aria-live="polite">
      {h.summaryLoading && !h.recent && h.wins === undefined && <p role="status">Loading player details…</p>}
      {h.summaryError && <p className="is-error">{h.summaryError}</p>}
      {h.wins !== undefined && <p>{h.wins} wins / {h.losses} losses{h.draws ? ` / ${h.draws} draws` : ''}</p>}
      {h.recent && <p className="player-recent" aria-label={`Ranked results, oldest first: ${[...h.recent].map(r => r === '+' ? 'win' : r === '-' ? 'loss' : 'draw').join(', ')}`}>
        {[...h.recent].map((r, i) => <span key={i} className={r === '+' ? 'win' : r === '-' ? 'loss' : ''} aria-hidden="true" />)}
      </p>}
      {progress.length > 0 && <p className="player-rank-progress">{progress.map((item, index) => <span key={index}>{index > 0 && ' / '}{item}</span>)}</p>}
    </div>
    <div className="player-info-games" aria-live="polite">
      {h.loading && !h.games.length && <p role="status">Loading recent games…</p>}
      {h.error && <p className="is-error">{h.error}</p>}
      {!h.loading && !h.error && !h.games.length && <p>No recent games available.</p>}
      {!!h.games.length && <table><thead><tr><th>Date</th><th>Opponent</th><th>Result</th><th>Moves</th></tr></thead>
        <tbody>{h.games.slice(0, 10).map(g => <tr key={g.id}>
          <td title={new Date(g.date * 1000).toLocaleString()}>{new Date(g.date * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
          <td><span className="history-opponent"><span className={`player-stone ${g.color === 'Black' ? 'white' : 'black'}`} role="img" aria-label={g.color === 'Black' ? 'White' : 'Black'} />
            <span className="history-opponent-name" title={g.opponent}>{g.opponent}{g.opponentRank ? ` (${g.opponentRank})` : ''}</span></span></td>
          <td className={g.outcome}>{g.result}</td>
          <td>{g.moves ?? "—"}</td>
        </tr>)}</tbody></table>}
    </div>
  </>;
}
