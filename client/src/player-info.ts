import { PerfromanceType } from "./protocol.ts";
import { panelFields as Panel } from "./protocol-fields.ts";
import { Buffer } from 'buffer';
import SparkMD5 from 'spark-md5';
import { rankLabel } from './game';
import { logError } from './error-message';
import { playerName } from './player-name';
import { historyGames, type HistoryGame, type PlayerHistory } from './player-history';
import { parseRoomId, roomId, type RoomKey } from './room-id';
import { decode, type Fields, type Message } from './wire';

function readRoomKey(m: Message): RoomKey | null {
  return parseRoomId([1, 2, 3, 4].map(tag => m.number(tag)).join(':'));
}

export { SVR_TYPE_USER_INFO_PANEL_SVR } from "./protocol.ts";
export interface PlayerInfo extends PlayerHistory {
  country?: number;
  rooms?: { id: string; role: 'playing' | 'watching' }[];
  ai?: boolean;
  anchor?: string;
  summaryLoading: boolean;
  summaryLoaded: boolean;
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
  if (m.number(Panel.FetchPanelUserInfoResponse.result) !== 0) throw Error(`fox could not load this player ${m.number(Panel.FetchPanelUserInfoResponse.result)}`);
  // dst_uid echoes the request (zero for a name lookup); uid is the resolved account.
  const uid = m.number(Panel.FetchPanelUserInfoResponse.uid) || m.number(Panel.FetchPanelUserInfoResponse.dst_uid);
  if (uid !== info.uid) throw Error('fox returned a different player');
  const account = m.sub(Panel.FetchPanelUserInfoResponse.account_info), progress = m.sub(Panel.FetchPanelUserInfoResponse.updown_info), remaining = progress.sub(Panel.UpDownInfo.up_down_condition);
  info.name = playerName(account.text(Panel.AccountInfo.englishname), account.text(Panel.AccountInfo.username), info.name);
  if (account.has(Panel.AccountInfo.country)) info.country = account.number(Panel.AccountInfo.country);
  info.rank = m.has(Panel.FetchPanelUserInfoResponse.grade) ? rankLabel(m.number(Panel.FetchPanelUserInfoResponse.grade)) : info.rank;
  const certification = m.sub(Panel.FetchPanelUserInfoResponse.cert_info);
  if (certification.has(Panel.CertificationInfo.ai)) info.ai = certification.number(Panel.CertificationInfo.ai) > 0;
  info.rooms = undefined;
  if (m.has(Panel.FetchPanelUserInfoResponse.user_status)) {
    const status = m.sub(Panel.FetchPanelUserInfoResponse.user_status);
    const rooms = new Map<string, 'playing' | 'watching'>();
    if (status.number(Panel.UserStatus.is_online)) for (const bytes of status.get(Panel.UserStatus.room_loc_infos) ?? []) {
      const location = decode(bytes), key = readRoomKey(location.sub(Panel.RoomLocInfo.room_key));
      const role = location.number(Panel.RoomLocInfo.room_role);
      if (key && (role === 1 || role === 2)) {
        const id = roomId(key);
        if (role === 2 || !rooms.has(id)) rooms.set(id, role === 2 ? 'playing' : 'watching');
      }
    }
    info.rooms = [...rooms].map(([id, role]) => ({ id, role })).sort((a, b) => a.role.localeCompare(b.role));
  }
  // Keep the current run intact: removing separators would join results across
  // a rank change. Fox's rank-progress record is ordered oldest first.
  info.recent = (progress.text(Panel.UpDownInfo.last_perf).match(/[+\-=]*$/)?.[0] ?? '').slice(-20);
  for (const [field, key] of [[Panel.UpDownCondition.upgrade1, 'promotion'], [Panel.UpDownCondition.upgrade2, 'doublePromotion'], [Panel.UpDownCondition.downgrade1, 'demotion'], [Panel.UpDownCondition.downgrade2, 'doubleDemotion']] as const)
    info[key] = remaining.number(field) || undefined;
  // Ranked (type 2) matches lobby total_won/total_lost. Overall (type 0)
  // also includes free games; never substitute it for the ranked record.
  const ranked = (m.get(Panel.FetchPanelUserInfoResponse.perf_records) ?? [])
    .map(decode).find(record => record.number(Panel.PerfromanceRecord.type) === PerfromanceType.Promotion);
  if (ranked) {
    info.wins = ranked.number(Panel.PerfromanceRecord.won);
    info.losses = ranked.number(Panel.PerfromanceRecord.lost);
    info.draws = ranked.number(Panel.PerfromanceRecord.drawn);
  }
  info.summaryLoaded = true;
}

export type PlayerInfoSeed = Pick<PlayerInfo, 'country' | 'wins' | 'losses'>;

type Entry = { info: PlayerInfo; stale: boolean; request: string; abort: AbortController; games?: Promise<void>; timer?: ReturnType<typeof setTimeout> };
export class PlayerInfoStore {
  current: PlayerInfo | null = null;
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed() {
    this.onChange();
    for (const listener of this.listeners) listener();
  }
  private aiUsers = new Set<number>();
  get aiPlayers() { return [...this.aiUsers]; }
  isAI(uid?: number) { return !!uid && this.aiUsers.has(uid); }
  rememberAI(uid: number, ai: boolean) {
    if (!Number.isSafeInteger(uid) || uid <= 0) return;
    const changed = this.isAI(uid) !== ai;
    if (ai) this.aiUsers.add(uid); else this.aiUsers.delete(uid);
    const info = this.entries.get(uid)?.info;
    if (info) info.ai = ai;
    if (changed) this.changed();
  }
  private entries = new Map<number, Entry>();
  private serial = 0;
  constructor(
    private send: (fields: Fields) => void,
    private onChange: () => void,
    private config: () => { proxyUrl: string; proxyToken: string; uid: number; token: Uint8Array },
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  ready(uid: number | undefined) {
    const info = uid ? this.entries.get(uid)?.info : undefined;
    return !!info && !info.summaryLoading && !info.loading;
  }
  open(uid: number, name: string, rank = '', anchor?: string, seed: PlayerInfoSeed = {}) {
    const info = this.prefetch(uid, name, rank, seed);
    if (!info) return;
    // Room locations can change independently of cached results and history.
    // Refresh the small profile response on reopening, without refetching games.
    if (info.rooms !== undefined && !info.summaryLoading) {
      info.rooms = undefined;
      this.loadSummary(this.entries.get(uid)!);
    }
    info.anchor = anchor;
    this.current = info;
    this.changed();
  }
  // Starts both reads without opening a card. Results and history remain
  // cached until game end; open refreshes room locations separately.
  prefetch(uid: number, name: string, rank = '', seed: PlayerInfoSeed = {}, refresh = false) {
    if (!Number.isSafeInteger(uid) || uid <= 0) return;
    const cached = this.entries.get(uid);
    if (cached && !cached.stale && !refresh) {
      this.seed(cached.info, seed);
      return cached.info;
    }
    if (cached) this.remove(uid);
    if (this.entries.size >= 24) this.remove(this.entries.keys().next().value!);
    const info: PlayerInfo = cached?.info ?? {
      uid, name, rank, loading: true, error: '', games: [], summaryLoading: true, summaryLoaded: false, summaryError: '', recent: '',
    };
    this.seed(info, seed);
    if (this.isAI(uid)) info.ai = true;
    info.rooms = undefined;
    info.summaryLoading = info.loading = true;
    info.error = info.summaryError = '';
    const entry: Entry = { info, stale: false, request: '', abort: new AbortController() };
    this.entries.set(uid, entry);
    this.loadSummary(entry);
    entry.games = this.loadGames(entry);
    return info;
  }
  // Shared documents await the same request, including work started by preloads.
  async history(uid: number, refresh = false) {
    const info = this.prefetch(uid, '', '', {}, refresh);
    if (!info) throw Error('invalid player identifier');
    const entry = this.entries.get(uid)!;
    await entry.games;
    if (this.entries.get(uid) !== entry || entry.stale) throw Error('recent games were invalidated');
    if (info.error) throw Error(info.error);
    return info.games;
  }
  private seed(info: PlayerInfo, seed: PlayerInfoSeed) {
    // List and profile counts both describe ranked games. Preserve details
    // already returned by the profile when reopening from an older list.
    for (const key of ['country', 'wins', 'losses'] as const)
      if (info[key] === undefined && seed[key] !== undefined) info[key] = seed[key];
  }
  private loadSummary(entry: Entry) {
    const { info } = entry;
    clearTimeout(entry.timer);
    info.summaryLoading = true;
    info.summaryError = '';
    entry.request = `player-${++this.serial}`;
    entry.timer = setTimeout(() => {
      info.summaryLoading = false;
      info.summaryError = 'player details timed out';
      logError(info.summaryError);
      if (this.current === info) this.changed();
    }, 8000);
    entry.timer.unref?.();
    try { this.send({ [Panel.FetchPanelUserInfoRequest.dst_uid]: info.uid, [Panel.FetchPanelUserInfoRequest.transparent]: entry.request }); }
    catch {
      clearTimeout(entry.timer);
      info.summaryLoading = false;
      info.summaryError = 'player details are unavailable while disconnected';
      logError(info.summaryError);
    }
  }
  receive(m: Message) {
    const entry = [...this.entries.values()].find(e => e.request === m.text(Panel.FetchPanelUserInfoResponse.transparent));
    if (!entry || !entry.info.summaryLoading) return;
    clearTimeout(entry.timer);
    try {
      applyPlayerSummary(entry.info, m);
      if (entry.info.ai !== undefined) this.rememberAI(entry.info.uid, entry.info.ai);
    }
    catch (error) {
      entry.info.summaryError = (error as Error).message;
      logError(entry.info.summaryError);
    }
    entry.info.summaryLoading = false;
    if (this.current === entry.info || !entry.info.summaryError) this.changed();
    return entry.info.summaryError ? undefined : entry.info;
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
    this.aiUsers.clear();
  }
  private async request(uid: number, signal: AbortSignal) {
    const { proxyUrl, proxyToken, uid: srcuid, token } = this.config();
    if (!Number.isSafeInteger(srcuid) || srcuid <= 0 || !token.length)
      throw Error('sign in to load recent games');
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
      ? 'game history needs the updated proxy' : `could not load the fox record http ${response.status}`);
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
      if (this.entries.get(info.uid) === entry) {
        info.error = abort.signal.aborted ? 'recent games timed out' : (error as Error).message;
        logError(info.error);
      }
    }
    finally {
      clearTimeout(timer);
      if (this.entries.get(info.uid) === entry) {
        info.loading = false;
        this.changed();
      }
    }
  }
}
