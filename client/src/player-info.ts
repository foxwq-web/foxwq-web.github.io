import { Buffer } from 'buffer';
import SparkMD5 from 'spark-md5';
import { rankLabel } from './game';
import { historyGames, type PlayerHistory } from './player-history';
import { decode, type Fields, type Message } from './wire';

export const PLAYER_INFO_SERVICE = 20043;
export interface PlayerInfo extends PlayerHistory {
  anchor?: string;
  summaryLoading: boolean;
  summaryError: string;
  wins?: number;
  losses?: number;
  draws?: number;
  recent: string;
  promotion?: number;
  doublePromotion?: number;
  demotion?: number;
  doubleDemotion?: number;
}

// FetchPanelUserInfoRequest: decompiled/00740f60.c (a29b2bb), service 20043/1001.
// Request field 3 is echoed as response field 2 to correlate overlapping hovers.
// Response mapping verified live against Fox. Rank progress
// contains the *remaining* wins/losses from Fox, rather than inferred thresholds.
export function applyPlayerSummary(info: PlayerInfo, m: Message) {
  if (m.number(1) !== 0) throw Error(`Fox could not load this player (${m.number(1)}).`);
  if (m.number(3) !== info.uid) throw Error('Fox returned a different player.');
  const account = m.sub(8), progress = m.sub(9), remaining = progress.sub(1);
  info.name = account.text(5) || account.text(4) || info.name;
  info.rank = m.has(7) ? rankLabel(m.number(7)) : info.rank;
  // Keep the current run intact: removing separators would join results across
  // a rank change. Fox's rank-progress record is ordered oldest first.
  info.recent = (progress.text(2).match(/[+\-=]*$/)?.[0] ?? '').slice(-20);
  for (const [field, key] of [[1, 'promotion'], [2, 'doublePromotion'], [3, 'demotion'], [4, 'doubleDemotion']] as const)
    info[key] = remaining.number(field) || undefined;
  const total = (m.get(16) ?? []).map(value => {
    // Repeated PerfromanceRecord: type 0 is the overall Go record.
    return decode(value);
  }).find(record => record.number(1) === 0);
  if (total) {
    info.wins = total.number(2);
    info.losses = total.number(3);
    info.draws = total.number(4);
  }
}

type Entry = { info: PlayerInfo; stale: boolean; request: string; abort: AbortController; timer?: ReturnType<typeof setTimeout> };
export class PlayerInfoStore {
  current: PlayerInfo | null = null;
  private entries = new Map<number, Entry>();
  private serial = 0;
  constructor(
    private send: (fields: Fields) => void,
    private changed: () => void,
    private config: () => { proxyUrl: string; proxyToken: string; uid: number; token: Uint8Array },
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  ready(uid: number | undefined) {
    const info = uid ? this.entries.get(uid)?.info : undefined;
    return !!info && !info.summaryLoading && !info.loading;
  }
  open(uid: number, name: string, rank = '', anchor?: string) {
    const info = this.prefetch(uid, name, rank);
    if (!info) return;
    info.anchor = anchor;
    this.current = info;
    this.changed();
  }
  // Starts both reads without opening a card. Hover reuses the same data and
  // in-flight requests until game end invalidates them. Previous results stay
  // visible while they refresh.
  prefetch(uid: number, name: string, rank = '') {
    if (!Number.isSafeInteger(uid) || uid <= 0) return;
    const cached = this.entries.get(uid);
    if (cached && !cached.stale) return cached.info;
    if (cached) this.remove(uid);
    if (this.entries.size >= 24) this.remove(this.entries.keys().next().value!);
    const info: PlayerInfo = cached?.info ?? {
      uid, name, rank, loading: true, error: '', games: [], summaryLoading: true, summaryError: '', recent: '',
    };
    info.summaryLoading = info.loading = true;
    info.error = info.summaryError = '';
    const entry: Entry = { info, stale: false, request: `player-${++this.serial}`, abort: new AbortController() };
    this.entries.set(uid, entry);
    entry.timer = setTimeout(() => {
      info.summaryLoading = false;
      info.summaryError = 'Player details timed out.';
      if (this.current === info) this.changed();
    }, 8000);
    entry.timer.unref?.();
    try { this.send({ 1: uid, 3: entry.request }); }
    catch {
      clearTimeout(entry.timer);
      info.summaryLoading = false;
      info.summaryError = 'Player details are unavailable while disconnected.';
    }
    void this.loadGames(entry);
    return info;
  }
  receive(m: Message) {
    const entry = [...this.entries.values()].find(e => e.request === m.text(2));
    if (!entry || !entry.info.summaryLoading) return;
    clearTimeout(entry.timer);
    try { applyPlayerSummary(entry.info, m); }
    catch (error) { entry.info.summaryError = (error as Error).message; }
    entry.info.summaryLoading = false;
    if (this.current === entry.info) this.changed();
  }
  invalidate() { for (const entry of this.entries.values()) entry.stale = true; }
  close() { this.current = null; this.changed(); }
  private remove(uid: number) {
    const entry = this.entries.get(uid);
    if (entry) { clearTimeout(entry.timer); entry.abort.abort(); }
    this.entries.delete(uid);
  }
  reset() {
    for (const uid of this.entries.keys()) this.remove(uid);
    this.current = null;
  }
  private async request(uid: number, signal: AbortSignal) {
    const { proxyUrl, proxyToken, uid: srcuid, token } = this.config();
    if (!Number.isSafeInteger(srcuid) || srcuid <= 0 || !token.length)
      throw Error('Sign in to load recent games.');
    // Desktop 0097de10/0097df70: base64 login-response field 8, plus
    // MD5(srcuid + Unix seconds + salt). The relay only forwards this request.
    const time = String(Math.floor(Date.now() / 1000));
    const url = new URL(proxyUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/fox/chessbook/TXWQFetchChessList'; url.hash = '';
    url.search = new URLSearchParams({
      type: '1', lastCode: '', FindUserName: '', uid: String(uid),
      token: Buffer.from(token).toString('base64'), srcuid: String(srcuid), time,
      session: SparkMD5.hash(`${srcuid}${time}mD!VaWbS9uz6joCn0T8c`),
    }).toString();
    const response = await this.fetcher(url, {
      method: 'GET', signal, cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${proxyToken}` },
    });
    if (!response.ok) throw Error(response.status === 404
      ? 'Game history needs the updated proxy.' : `Could not load the Fox record (HTTP ${response.status}).`);
    return response.json();
  }
  private async loadGames(entry: Entry) {
    const { info, abort } = entry;
    const timer = setTimeout(() => abort.abort(), 20000);
    try {
      const games = historyGames(await this.request(info.uid, abort.signal), info.uid);
      if (this.entries.get(info.uid) === entry) info.games = games;
    }
    catch (error) {
      if (this.entries.get(info.uid) === entry)
        info.error = abort.signal.aborted ? 'Recent games timed out.' : (error as Error).message;
    }
    finally {
      clearTimeout(timer);
      if (this.entries.get(info.uid) === entry) {
        info.loading = false;
        if (this.current === info) this.changed();
      }
    }
  }
}
