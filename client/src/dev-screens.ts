import { ErrorCode } from "./protocol.ts";
import { gameFields as Game, roomFields as Room, fgwFields as Fgw, panelFields as Panel } from "./protocol-fields.ts";
import { GoGameMessageID, RoomMessageID, LegacyMsgTypeID, ClientMessageID, CLINET_MSG_ID, StoneColor, SpecialResult, ENGameEndReason, CalculateProcessType, BoardSize, GameTypeTag, ENAdditionalRuleType } from "./protocol.ts";
import { PlayerInfoStore, SVR_TYPE_USER_INFO_PANEL_SVR } from "./player-info";
import { PREVIEW_PLAYERS } from "./dev-players";
import { COUNTING_PREVIEW } from "./dev-counting";

import type { Session } from "./session.ts";
import { promptForAction, type Command, type Prompt } from "./state";
import * as game from "./game.ts";
import { encode, type Fields } from "./wire.ts";
import { Buffer } from "buffer";
import { localEstimate } from '../../score-estimator/src/local-score-estimation.ts';

type Stage = "login" | "connecting" | "authenticating" | "bootstrap" |
  "gateway" | "discovery" | "matching" | "joining" | "started" | "playing";
type Scenario = {
  session: Session;
  notify: (op: number, fields?: Fields) => void;
  room: (op: number, fields?: Fields) => void;
  ask: (command: Command) => void;
  error: (action: () => void) => void;
};
type Screen = {
  id: string;
  label: string;
  group: string;
  stage: Stage;
  phase: string;
  reach: string;
  playerName?: string;
  coordinates?: boolean;
  variation?: [number, number][];
  run?: (scenario: Scenario) => void | Promise<void>;
};
const screen = (id: string, label: string, group: string, stage: Stage,
  phase: string, reach: string, run?: Screen["run"]): Screen =>
  ({ id, label, group, stage, phase, reach, run });

const blackMove = ({ session, notify }: Scenario) => {
  if (session.color === StoneColor.BLACK) {
    session.play(10, 10);
    notify(GoGameMessageID.GC_SET_PIECE_REQUEST, { [Game.SetPieceResponse.result]: 0 });
  }
  notify(GoGameMessageID.GC_SET_PIECE_NOTIFY, { [Game.SetPieceNotify.x]: 10, [Game.SetPieceNotify.y]: 10, [Game.SetPieceNotify.color]: StoneColor.BLACK,
    ...(session.board.moveTimings.some(Boolean) ? { [Game.SetPieceNotify.countdown]: { [Game.GameCountdownNotify.remaining_jushi_time]: 540 } } : {}) });
};
const requestCounting = ({ session }: Scenario) => session.requestCounting();
const countingAcknowledged = (s: Scenario) => {
  requestCounting(s);
  s.notify(GoGameMessageID.GC_CALCULATE_REQUEST, { [Game.CalculateResponse.result]: 0 });
};
const opponentCounting = (s: Scenario) => {
  blackMove(s);
  s.notify(GoGameMessageID.GC_CALCULATE_CONFIRM_NOTIFY, { [Game.CalculateConfirmNotify.result]: 0, [Game.CalculateConfirmNotify.type]: CalculateProcessType.CPT_START });
};
const countingResult = (s: Scenario) => {
  opponentCounting(s);
  s.session.confirm(true);
  s.notify(GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST, { [Game.CalculateAnswerResponse.result]: 0 });
  s.notify(GoGameMessageID.GC_CALCULATE_ANSWER_NOTIFY, { [Game.CalculateAnswerNotify.accept]: 1, [Game.CalculateAnswerNotify.type]: CalculateProcessType.CPT_START });
  const area = new DataView(new ArrayBuffer(4));
  area.setFloat32(0, COUNTING_PREVIEW.black, true);
  s.notify(GoGameMessageID.GC_CALCULATE_CONFIRM_NOTIFY, { [Game.CalculateConfirmNotify.result]: 0, [Game.CalculateConfirmNotify.type]: CalculateProcessType.CPT_RESULT, [Game.CalculateConfirmNotify.china_position_judge]: COUNTING_PREVIEW.ownership + "00",
    [Game.CalculateConfirmNotify.win_color]: COUNTING_PREVIEW.winner, [Game.CalculateConfirmNotify.black_shuzi]: area.getUint32(0, true) });
};
const finishedCounting = (s: Scenario) => {
  countingResult(s);
  s.session.confirm(true);
  s.notify(GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST, { [Game.CalculateAnswerResponse.result]: 0 });
  s.notify(GoGameMessageID.GC_SET_GAME_END_NOTIFY, { [Game.SetGameEndNotify.result]: 0, [Game.SetGameEndNotify.winner]: COUNTING_PREVIEW.winner, [Game.SetGameEndNotify.points]: COUNTING_PREVIEW.margin * 50, [Game.SetGameEndNotify.reason]: ENGameEndReason.EER_OPP_OVERTIME });
};
const finishedResignation = (s: Scenario) => {
  s.session.resign();
  s.notify(GoGameMessageID.GC_GIVE_UP_REQUEST, { [Game.GiveUpResponse.result]: 0 });
  s.notify(GoGameMessageID.GC_SET_GAME_END_NOTIFY, { [Game.SetGameEndNotify.result]: 0, [Game.SetGameEndNotify.winner]: StoneColor.WHITE, [Game.SetGameEndNotify.points]: SpecialResult.SR_MID_GAME, [Game.SetGameEndNotify.reason]: ENGameEndReason.EER_OPP_RESIGN });
};



export const DEV_SCREENS: Screen[] = [
  screen("login", "Login", "Connection", "login", "disconnected", "Open the app"),
  screen("connecting", "Connecting", "Connection", "connecting", "connecting", "Submit Login; navigation connection is pending"),
  screen("authenticating", "Authenticating", "Connection", "authenticating", "authenticating", "Navigation connects; login response is pending"),
  screen("bootstrap", "Server discovery", "Connection", "bootstrap", "bootstrap", "Login succeeds; server list is pending"),
  screen("gateway", "Gateway connection", "Connection", "gateway", "gateway", "Server list arrives; gateway connection is pending"),
  screen("resuming", "Restoring a game", "Connection", "discovery", "resuming", "Login discovers an existing game; synchronization is pending"),
  screen("login-error", "Login or connection error", "Connection", "authenticating", "error", "Fox rejects credentials; transport failures use this same error screen"),

  screen("matchmaking", "Choose time control", "Matchmaking", "discovery", "ready", "Login completes; show the advertised 1m20s, 5m30s and 20m60s controls and player counts"),
  { ...screen("matchmaking-player-info", "Your player info", "Matchmaking", "discovery", "ready", "Hover your player name in matchmaking"), playerName: "#matchmaking-player .player-name" },
  screen("matching", "Searching", "Matchmaking", "matching", "matching", "Play; Fox accepts the search"),
  screen("matchmaking-rejected", "Search rejected", "Matchmaking", "matching", "ready", "Play; Fox rejects the search", s => s.room(RoomMessageID.RM_AUTO_INVITE_REQUEST, { [Room.AutoInviteResponse.result]: -1 })),
  screen("joining", "Joining a room", "Matchmaking", "joining", "joining", "A match is found; game environment is pending"),
  screen("room-left", "Ready for the next game", "Matchmaking", "playing", "ready", "Finished game → Quit room; return to matchmaking", s => { finishedResignation(s); s.session.quitRoom(); }),

  screen("board-black", "Your turn as Black", "Playing", "playing", "playing", "Game starts as Black; legal moves produce this sample position"),
  { ...screen("board-coordinates", "Board coordinates", "Playing", "playing", "playing", "Sample board with coordinates always visible on all four edges"), coordinates: true },
  { ...screen("board-black-player-info", "Black player info", "Playing", "playing", "playing", "Hover Black’s player name in the main view"), playerName: "#black-player-name" },
  { ...screen("board-white-player-info", "White player info", "Playing", "playing", "playing", "Hover White’s player name in the main view"), playerName: "#white-player-name" },
  screen("board-white", "Your turn as White", "Playing", "playing", "playing", "AlphaGo vs Lee Sedol, game 2, after move 37"),
  screen("opponent-turn", "Opponent’s turn", "Playing", "playing", "playing", "Black plays; White is next", blackMove),
  screen("opponent-passed", "Opponent passed", "Playing", "playing", "playing", "Opponent’s turn → opponent passes", s => { blackMove(s); s.notify(GoGameMessageID.GC_SKIP_SET_PIECE_NOTIFY); }),
  screen("both-passed", "Both players passed", "Playing", "playing", "playing", "Pass → Fox confirms → opponent passes; counting is available", s => { s.session.passTurn(); s.notify(GoGameMessageID.GC_SKIP_SET_PIECE_REQUEST, { [Game.SkipSetPieceResponse.result]: 0 }); s.notify(GoGameMessageID.GC_SKIP_SET_PIECE_NOTIFY); s.notify(GoGameMessageID.GC_SKIP_SET_PIECE_NOTIFY); }),
  screen("byoyomi", "Final byoyomi period", "Playing", "playing", "playing", "Fox clock notification exhausts main time and leaves one period", s => s.notify(GoGameMessageID.GC_GAME_COUNTDOWN_NOTIFY, { [Game.GameCountdownNotify.uid]: s.session.uid, [Game.GameCountdownNotify.remaining_jushi_time]: 0, [Game.GameCountdownNotify.remaining_dumiao_num]: 1, [Game.GameCountdownNotify.remaining_dumiao_time]: 9 })),
  screen("action-rejected", "Move rejected", "Playing", "playing", "playing", "Play a stone; Fox rejects it and rolls it back", s => { s.session.play(10, 10); s.notify(GoGameMessageID.GC_SET_PIECE_REQUEST, { [Game.SetPieceResponse.result]: -1 }); }),

  screen("counting-waiting", "Waiting for opponent", "Counting", "playing", "playing", "Fox acknowledges your counting request", countingAcknowledged),
  screen("counting-request", "Opponent requests counting", "Counting", "playing", "playing", "Fox forwards the opponent’s request", opponentCounting),
  screen("counting-accepted", "Waiting for counting result", "Counting", "playing", "playing", "Request counting → opponent accepts", s => { countingAcknowledged(s); s.notify(GoGameMessageID.GC_CALCULATE_ANSWER_NOTIFY, { [Game.CalculateAnswerNotify.accept]: 1, [Game.CalculateAnswerNotify.type]: CalculateProcessType.CPT_START }); }),
  screen("counting-result", "Confirm counting result", "Counting", "playing", "playing", "Accept counting → Fox returns areas and winner", countingResult),
  screen("counting-rejected", "Counting rejected", "Counting", "playing", "playing", "Request counting → opponent rejects", s => { countingAcknowledged(s); s.notify(GoGameMessageID.GC_CALCULATE_ANSWER_NOTIFY, { [Game.CalculateAnswerNotify.accept]: 0, [Game.CalculateAnswerNotify.type]: CalculateProcessType.CPT_START }); }),
  screen("counting-error", "Counting failed", "Counting", "playing", "playing", "Request counting → Fox reports a failure", s => { countingAcknowledged(s); s.notify(GoGameMessageID.GC_CALCULATE_CONFIRM_NOTIFY, { [Game.CalculateConfirmNotify.result]: -1, [Game.CalculateConfirmNotify.type]: CalculateProcessType.CPT_START }); }),

  screen("score-estimation", "Score estimate", "Estimation", "playing", "playing", "Estimate score → complete local engine calculation", s => {
    s.session.estimationFetcher = localEstimate;
    return s.session.estimateScore();
  }),
  screen("score-estimation-loading", "Estimate pending", "Estimation", "playing", "playing", "Estimate score; calculation is pending", s => { s.session.estimationFetcher = () => new Promise(() => {}); void s.session.estimateScore(); }),

  { ...screen("replay-variation", "5-move variation", "Replay", "playing", "finished", "Finished game → Previous → replay moves 38–42 of AlphaGo vs Lee Sedol, game 2", finishedResignation),
    // Actual continuation after move 37, from the SGF cited in position().
    variation: [
      [14, 8], [13, 9], [12, 7], [6, 15], [6, 16],
    ] },
  screen("finished", "Game ended by counting", "Results", "playing", "finished", "Confirm counting result → Fox ends the game; downloads and Quit room appear", finishedCounting),
  screen("finished-resign", "Game ended by resignation", "Results", "playing", "finished", "Resign → Fox ends the game (W+R)", finishedResignation),
  screen("finished-void", "Game cancelled", "Results", "started", "finished", "Fox cancels an initial-start game with the observed reason (8)", s => s.notify(GoGameMessageID.GC_SET_GAME_RESULT_NOTIFY, { [Game.SetGameResultNotify.winner]: StoneColor.EMPTY, [Game.SetGameResultNotify.reason]: ENGameEndReason.EER_INVALIDGAME_ROUNDNUM_TOO_SMALL })),
];


function position({ session, notify }: Scenario, timed = false) {
  // AlphaGo (Black) vs Lee Sedol, game 2, 2016-03-10, through move 37 (P10).
  // https://media-iframe.britgo.org/files/2016/deepmind/alphago-leesedol2.sgf
  const moves = [
    [15, 3], [3, 15], [2, 3], [16, 15], [14, 15], [14, 16],
    [13, 16], [15, 16], [2, 13], [5, 16], [12, 15], [16, 13],
    [8, 2], [3, 9], [15, 14], [16, 14], [2, 15], [2, 16],
    [1, 16], [2, 14], [1, 15], [1, 14], [3, 14], [1, 13],
    [3, 16], [4, 15], [3, 17], [2, 12], [9, 15], [2, 6],
    [4, 3], [16, 5], [16, 4], [15, 5], [13, 3], [15, 8],
    [14, 9],
  ];
  // Black-to-play previews include Lee Sedol’s reply, move 38 (P11).
  if (session.color === StoneColor.BLACK) moves.push([14, 8]);
  moves.forEach(([x, y], i) => {
    const color = i % 2 + 1;
    if (session.color === color) {
      session.play(x, y);
      notify(GoGameMessageID.GC_SET_PIECE_REQUEST, { [Game.SetPieceResponse.result]: 0 });
    }
    // Synthetic clocks make finished-game review exercise the real timing path.
    // Each player's last two turns show 11:11, then 09:09 for sizing checks.
    const remaining = i >= moves.length - 2 ? 549 :
      671 + Math.floor((moves.length - 3 - i) / 2) * 10;
    notify(GoGameMessageID.GC_SET_PIECE_NOTIFY, { [Game.SetPieceNotify.x]: x, [Game.SetPieceNotify.y]: y, [Game.SetPieceNotify.color]: color,
      ...(timed ? { [Game.SetPieceNotify.countdown]: { [Game.GameCountdownNotify.remaining_jushi_time]: remaining } } : {}) });
  });
}

export async function applyDevScreen(session: Session, id: string) {
  const fixture = DEV_SCREENS.find(screen => screen.id === id);
  if (!fixture) return null;
  const [self, opponent] = PREVIEW_PLAYERS;
  const [black, white] = id === "board-white" ? [opponent, self] : [self, opponent];
  const player = (uid: number) => PREVIEW_PLAYERS.find(player => player.uid === uid)!;
  const transport = { send() {}, close() {} };
  const waiting = () => new Promise<never>(() => {});
  session.connectionFactory = async () => {
    return fixture.stage === "connecting" ||
      (fixture.stage === "gateway" && session.phase === "gateway") ? waiting() : transport;
  };
  session.proxyUrl = "ws://offline.invalid";
  session.proxyToken = "offline-preview";
  session.preferredTimeControl = null;
  session.estimationFetcher = async ({ payload }) => sampleEstimate(payload.status);
  const sound = session.onSound;
  session.onSound = () => {};
  let prompt: Prompt | null = null, menuError = "", boardError = "";
  const packet = (msgTypeID: number, fields: Fields) => session.receive(
    session.generation, { msgTypeID, flag: 0, rawProto: encode(fields) });
  const message = (service: number, op: number, fields: Fields = {}) => session.receive(
    session.generation, { msgTypeID: LegacyMsgTypeID.MTID_CS_GATEWAYSERVER_PACKET, flag: 0,
      rawProto: game.encodeFgwMessage(self.uid, service, op, fields, 63) });
  // Hover cards use the same store and wire response path in offline previews.
  session.playerInfo = new PlayerInfoStore(fields => {
    const profile = player(Number(fields[Panel.FetchPanelUserInfoRequest.dst_uid]));
    queueMicrotask(() => message(SVR_TYPE_USER_INFO_PANEL_SVR, CLINET_MSG_ID.MTID_FETCH_PANEL_USER_INFO, {
      ...profile.summary, [Panel.FetchPanelUserInfoResponse.transparent]: fields[Panel.FetchPanelUserInfoRequest.transparent],
    }));
  }, () => session.changed(), () => session, async input => {
    const profile = player(Number(new URL(String(input)).searchParams.get("uid")));
    return Response.json({ result: 0, chesslist: profile.games });
  });
  const scenario: Scenario = {
    session,
    room: (op, fields) => message(game.GAME_SVR_MGR, op, fields),
    notify: (op, fields) => message(game.GAME_SVR, op, fields),
    ask: command => { prompt = promptForAction(command) ?? null; },
    error: action => {
      try { action(); } catch (error) {
        const text = (error as Error).message;
        if (fixture.stage === "login") menuError = text; else boardError = text;
        return;
      }
      throw Error(`Preview ${id} expected a rejected command`);
    },
  };
  const settled = async (ready: () => boolean) => {
    for (let turn = 0; turn < 20; turn++) {
      if (ready()) return;
      await Promise.resolve();
    }
    throw Error(`Preview ${id} did not settle its offline transport`);
  };
  const setup = async () => {
    const { stage } = fixture;
    if (stage === "login") return;
    session.login(self.name, "sample-password");
    if (stage === "connecting") return;
    await settled(() => !!session.connection);
    if (stage === "authenticating") return;
    packet(2005, { 1: 0, 2: self.uid, 3: { 1: self.uid, 2: self.name, 3: self.name, 4: self.rank }, 8: Buffer.from("sample-token") });
    if (stage === "bootstrap") return;
    packet(3005, { 3: [{ 1: 1, 21: "offline.invalid", 22: 10000 }] });
    if (stage === "gateway") return;
    await settled(() => !!session.fgwConnection);
    message(game.SVR_TYPE_FGW, ClientMessageID.MID_LOGIN_REQUEST, { [Fgw.LoginResponse.op_code]: 0 });
    scenario.room(RoomMessageID.RM_LOGIN_GAME_SVR_MGR_REQUEST, { [Room.LoginGameSvrMgrResponse.result]: 0 });
    scenario.room(RoomMessageID.RM_QUERY_GAME_LOCK_REQUEST, id === "resuming"
      ? { [Room.QueryGameLockResponse.result]: 0, [Room.QueryGameLockResponse.server_type]: game.GAME_SVR, [Room.QueryGameLockResponse.server_id]: 63 } : { [Room.QueryGameLockResponse.result]: ErrorCode.NEC_LOCK_NOT_EXIST_ERR });
    scenario.room(RoomMessageID.RM_FETCH_FIELD_CFG, { [Room.FetchFieldCfgResponse.field_cfgs]: [
      [1, 60, 20], [2, 300, 30], [3, 1200, 60],
    ].map(([field, main, byoyomi]) => ({
      [Game.FieldCfg.field_id]: field, [Game.FieldCfg.board_size]: BoardSize.E_Board_Size_19, [Game.FieldCfg.jushi_sec]: main, [Game.FieldCfg.dumiao_num]: 3, [Game.FieldCfg.dumiao_sec]: byoyomi, [Game.FieldCfg.additional_rule]: ENAdditionalRuleType.EN_ADDI_BASIC, [Game.FieldCfg.game_type_tag]: GameTypeTag.GAME_TYPE_TAG_NORMAL,
    })) });

    scenario.room(RoomMessageID.RM_FETCH_ALL_FIELD_INFO_REQUEST, { [Room.FetchAllFieldInfoResponse.result]: 0, [Room.FetchAllFieldInfoResponse.field_infos]: [[1, 727], [2, 612], [3, 493]]
      .map(([field, count]) => ({ [Room.FieldInfo.field_id]: field, [Room.FieldInfo.people_num]: count })) });
    if (stage === "discovery") return;
    session.match();
    if (id !== "matchmaking-rejected") scenario.room(RoomMessageID.RM_AUTO_INVITE_REQUEST, { [Room.AutoInviteResponse.result]: 0 });
    if (stage === "matching") return;
    scenario.room(RoomMessageID.RM_ENTER_ROOM_NOTIFY, { [Room.EnterRoomNotify.result]: 0, [Room.EnterRoomNotify.server_type]: game.GAME_SVR, [Room.EnterRoomNotify.server_id]: 63, [Room.EnterRoomNotify.room_id]: 100, [Room.EnterRoomNotify.room_create_time]: 200 });
    if (stage === "joining") return;
    scenario.notify(GoGameMessageID.GC_START_SET_PIECE_NOTIFY, { [Game.StartSetPieceNotify.rule]: { [Game.GameRule.dumiao_time]: 60 }, [Game.StartSetPieceNotify.room_id]: 100, [Game.StartSetPieceNotify.room_create_time]: 200, [Game.StartSetPieceNotify.game_users]: [
      { [Game.GameUserInfo.uid]: black.uid, [Game.GameUserInfo.nickname]: black.name, [Game.GameUserInfo.grade]: black.rank,
        [Game.GameUserInfo.stone_color]: StoneColor.BLACK, [Game.GameUserInfo.remaining_jushi_time]: 425, [Game.GameUserInfo.remaining_dumiao_num]: 3, [Game.GameUserInfo.remaining_dumaio_time]: 60 },
      { [Game.GameUserInfo.uid]: white.uid, [Game.GameUserInfo.nickname]: white.name, [Game.GameUserInfo.grade]: white.rank,
        [Game.GameUserInfo.stone_color]: StoneColor.WHITE, [Game.GameUserInfo.remaining_jushi_time]: 192, [Game.GameUserInfo.remaining_dumiao_num]: 2, [Game.GameUserInfo.remaining_dumaio_time]: 60 },
    ] });
    if (stage === "started") return;
    position(scenario, fixture.phase === "finished");
  };
  try {
    await setup();
    if (id === "login-error") packet(2005, { 1: ErrorCode.NEC_USERNAME_PASSWORD_ERROR });
    else await fixture.run?.(scenario);
    if (session.phase !== fixture.phase)
      throw Error(`Preview ${id}: reached ${session.phase}, expected ${fixture.phase}`);
  } finally {
    clearTimeout(session.timer ?? undefined);
    clearTimeout(session.bootstrapTimer);
    session.timer = null;
    session.onSound = sound;
    session.login = () => { throw Error("Offline preview. Remove dev-screen to connect to Fox."); };
    session.connectionFactory = async () => { throw Error("Offline development preview"); };
  }
  return { fixture, prompt, menuError, boardError };
}



function sampleEstimate(stones: string) {
  const ownership = [...stones].map((_, p) => {
    const x = p % 19, y = Math.floor(p / 19);
    return x === 9 ? "0" : x + y < 22 ? "1" : "2";
  });
  return { ret: 0, board_size: 19, judge_status: ownership.join("") };
}

export function mountDevNavigation(id: string) {
  const playerName = DEV_SCREENS.find(screen => screen.id === id)?.playerName;
  if (playerName) {
    // Focus opens the real hover card and keeps it visible for inspection.
    document.querySelector<HTMLElement>(playerName)?.focus();
    return;
  }
  if (!["all", "index"].includes(id)) return;
  const section = document.createElement("section");
  section.id = "dev-screens";
  const style = document.createElement("style");
  style.textContent = `#dev-screens{position:fixed;inset:0;z-index:100;overflow:auto;background:var(--app-background);padding:24px;color:var(--app-text);font:14px Arial, sans-serif}.dev-screen-index main,.dev-screen-index #connection-layer{display:none!important}#dev-screens li{margin:12px 0}#dev-screens small{display:block;margin-top:4px;color:#aaa}#dev-screens h2{margin-top:28px;font-size:18px}`;
  section.append(style);
  const link = (screen: string, label: string) => {
    const a = document.createElement("a"),
      url = new URL(location.href);
    url.searchParams.set("dev-screen", screen);
    a.href = url.href;
    a.textContent = label;
    a.tabIndex = 0;
    return a;
  };
  document.body.classList.add("dev-screen-index");
  const title = document.createElement("h1");
  title.textContent = "App screen previews";
  const note = document.createElement("p");
  note.textContent =
    "Each preview follows the app’s normal commands and response handlers with sample offline server inputs. The path below each link explains how to reach it. Clocks are frozen; Fox actions wait for a response offline. Downloads work. Colour and text variants share a screen.";
  section.append(title, note);
  for (const group of new Set(DEV_SCREENS.map(screen => screen.group))) {
    const heading = document.createElement("h2"), list = document.createElement("ul");
    heading.textContent = group;
    for (const screen of DEV_SCREENS.filter(screen => screen.group === group)) {
      const li = document.createElement("li"), path = document.createElement("small");
      path.textContent = screen.reach;
      li.append(link(screen.id, screen.label), path);
      list.append(li);
    }
    section.append(heading, list);
  }
  document.body.append(section);
}
