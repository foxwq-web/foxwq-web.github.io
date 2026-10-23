
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
  run?: (scenario: Scenario) => void | Promise<void>;
};
const screen = (id: string, label: string, group: string, stage: Stage,
  phase: string, reach: string, run?: Screen["run"]): Screen =>
  ({ id, label, group, stage, phase, reach, run });

const blackMove = ({ session, notify }: Scenario) => {
  if (session.color === 1) {
    session.play(10, 10);
    notify(201, { 1: 0 });
  }
  notify(203, { 1: 10, 2: 10, 3: 1 });
};
const requestCounting = ({ session }: Scenario) => session.requestCounting();
const countingAcknowledged = (s: Scenario) => {
  requestCounting(s);
  s.notify(301, { 1: 0 });
};
const opponentCounting = (s: Scenario) => {
  blackMove(s);
  s.notify(303, { 1: 0, 2: 1 });
};
const countingResult = (s: Scenario) => {
  opponentCounting(s);
  s.session.confirm(true);
  s.notify(304, { 1: 0 });
  s.notify(306, { 1: 1, 2: 1 });
  const area = new DataView(new ArrayBuffer(4));
  area.setFloat32(0, 185.5, true);
  s.notify(303, { 1: 0, 2: 2, 8: 1, 6: area.getUint32(0, true) });
};
const finishedCounting = (s: Scenario) => {
  countingResult(s);
  s.session.confirm(true);
  s.notify(304, { 1: 0 });
  s.notify(402, { 1: 0, 2: 1, 3: 125, 4: 2 });
};
const finishedResignation = (s: Scenario) => {
  s.session.resign();
  s.notify(311, { 1: 0 });
  s.notify(402, { 1: 0, 2: 2, 3: -1, 4: 3 });
};



export const DEV_SCREENS: Screen[] = [
  screen("login", "Login", "Connection", "login", "disconnected", "Open the app"),
  screen("connecting", "Connecting", "Connection", "connecting", "connecting", "Submit Login; navigation connection is pending"),
  screen("authenticating", "Authenticating", "Connection", "authenticating", "authenticating", "Navigation connects; login response is pending"),
  screen("bootstrap", "Server discovery", "Connection", "bootstrap", "bootstrap", "Login succeeds; server list is pending"),
  screen("gateway", "Gateway connection", "Connection", "gateway", "gateway", "Server list arrives; gateway connection is pending"),
  screen("resuming", "Restoring a game", "Connection", "discovery", "resuming", "Login discovers an existing game; synchronization is pending"),
  screen("login-error", "Login or connection error", "Connection", "authenticating", "error", "Fox rejects credentials; transport failures use this same error screen"),

  screen("matchmaking", "Choose time control", "Matchmaking", "discovery", "ready", "Login completes; populations include unknown, zero, one and many players"),
  screen("matching", "Searching", "Matchmaking", "matching", "matching", "Play; Fox accepts the search"),
  screen("matchmaking-rejected", "Search rejected", "Matchmaking", "matching", "ready", "Play; Fox rejects the search", s => s.room(100130, { 1: -1 })),
  screen("joining", "Joining a room", "Matchmaking", "joining", "joining", "A match is found; game environment is pending"),
  screen("room-left", "Ready for the next game", "Matchmaking", "playing", "ready", "Finished game → Quit room; return to matchmaking", s => { finishedResignation(s); s.session.quitRoom(); }),

  screen("board-black", "Your turn as Black", "Playing", "playing", "playing", "Game starts as Black; legal moves produce this sample position"),
  screen("board-white", "Your turn as White", "Playing", "playing", "playing", "Game starts as White; Black plays", blackMove),
  screen("opponent-turn", "Opponent’s turn", "Playing", "playing", "playing", "Black plays; White is next", blackMove),
  screen("move-pending", "Action awaiting confirmation", "Playing", "playing", "playing", "Play a stone; Fox confirmation is pending. Pass and counting answers share these disabled controls", s => s.session.play(10, 10)),
  screen("opponent-passed", "Opponent passed", "Playing", "playing", "playing", "Opponent’s turn → opponent passes", s => { blackMove(s); s.notify(206); }),
  screen("both-passed", "Both players passed", "Playing", "playing", "playing", "Pass → Fox confirms → opponent passes; counting is available", s => { s.session.passTurn(); s.notify(204, { 1: 0 }); s.notify(206); s.notify(206); }),
  screen("byoyomi", "Final byoyomi period", "Playing", "playing", "playing", "Fox clock notification exhausts main time and leaves one period", s => s.notify(108, { 5: 42, 2: 0, 3: 1, 4: 9 })),
  screen("action-rejected", "Move rejected", "Playing", "playing", "playing", "Play a stone; Fox rejects it and rolls it back", s => { s.session.play(10, 10); s.notify(201, { 1: -1 }); }),
  screen("board-error", "Illegal move", "Playing", "playing", "playing", "Click an occupied intersection", s => s.error(() => s.session.play(3, 3))),

  screen("resign-confirm", "Confirm resignation", "Questions", "playing", "playing", "Resign → inline confirmation with cancel; other actions disabled", s => s.ask("resign")),

  screen("counting-waiting", "Waiting for opponent", "Counting", "playing", "playing", "Fox acknowledges your counting request", countingAcknowledged),
  screen("counting-request", "Opponent requests counting", "Counting", "playing", "playing", "Fox forwards the opponent’s request", opponentCounting),
  screen("counting-accepted", "Waiting for counting result", "Counting", "playing", "playing", "Request counting → opponent accepts", s => { countingAcknowledged(s); s.notify(306, { 1: 1, 2: 1 }); }),
  screen("counting-result", "Confirm counting result", "Counting", "playing", "playing", "Accept counting → Fox returns areas and winner", countingResult),
  screen("counting-rejected", "Counting rejected", "Counting", "playing", "playing", "Request counting → opponent rejects", s => { countingAcknowledged(s); s.notify(306, { 1: 0, 2: 1 }); }),
  screen("counting-error", "Counting failed", "Counting", "playing", "playing", "Request counting → Fox reports a failure", s => { countingAcknowledged(s); s.notify(303, { 1: -1, 2: 1 }); }),

  screen("score-estimation", "Score estimate", "Estimation", "playing", "playing", "Estimate score → display sample ownership", s => s.session.estimateScore()),
  screen("score-estimation-local", "Local GoStar estimate", "Estimation", "playing", "playing", "Estimate score → complete local engine calculation", s => {
    s.session.estimationFetcher = localEstimate;
    return s.session.estimateScore();
  }),
  screen("score-estimation-loading", "Estimate pending", "Estimation", "playing", "playing", "Estimate score; calculation is pending", s => { s.session.estimationFetcher = () => new Promise(() => {}); void s.session.estimateScore(); }),

  screen("finished", "Game ended by counting", "Results", "playing", "finished", "Confirm counting result → Fox ends the game; downloads and Quit room appear", finishedCounting),
  screen("finished-resign", "Game ended by resignation", "Results", "playing", "finished", "Resign → confirm → Fox ends the game (W+R)", finishedResignation),
  screen("finished-void", "Game cancelled", "Results", "started", "finished", "Fox cancels an initial-start game with the observed reason (8)", s => s.notify(403, { 2: 0, 4: 8 })),
];


function position({ session, notify }: Scenario) {
  const moves = [
    [1, 0], [0, 0], [0, 1], [15, 15], [3, 3], [15, 3], [3, 15],
    [4, 3], [4, 4], [4, 2], [5, 3], [14, 15], [9, 9], [14, 3],
    [10, 9], [15, 14], [9, 10], [14, 14],
  ];
  moves.forEach(([x, y], i) => {
    const color = i % 2 + 1;
    if (session.color === color) {
      session.play(x, y);
      notify(201, { 1: 0 });
    }
    notify(203, { 1: x, 2: y, 3: color });
  });
}

export async function applyDevScreen(session: Session, id: string) {
  const fixture = DEV_SCREENS.find(screen => screen.id === id);
  if (!fixture) return null;
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
  const packet = (command: number, fields: Fields) => session.receive(
    session.generation, { command, flags: 0, payload: encode(fields) });
  const message = (service: number, op: number, fields: Fields = {}) => session.receive(
    session.generation, { command: 26200, flags: 0,
      payload: game.envelope(42, service, op, fields, 63) });
  const scenario: Scenario = {
    session,
    room: (op, fields) => message(game.ROOM, op, fields),
    notify: (op, fields) => message(game.GAME, op, fields),
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
    session.login("StoneRiver", "sample-password");
    if (stage === "connecting") return;
    await settled(() => !!session.connection);
    if (stage === "authenticating") return;
    packet(2005, { 1: 0, 2: 42, 3: { 1: 42, 2: "StoneRiver", 3: "StoneRiver", 4: 20 }, 8: Buffer.from("sample-token") });
    if (stage === "bootstrap") return;
    packet(3005, { 3: [{ 1: 1, 21: "offline.invalid", 22: 10000 }] });
    if (stage === "gateway") return;
    await settled(() => !!session.gateway);
    message(game.GATEWAY, 1, { 1: 0 });
    scenario.room(100008, { 1: 0 });
    scenario.room(100115, id === "resuming"
      ? { 1: 0, 2: game.GAME, 3: 63 } : { 1: 107004 });
    scenario.room(100150, { 1: [
      [1, 0, 30], [2, 300, 30], [3, 600, 60], [4, 1200, 60],
    ].map(([field, main, byoyomi]) => ({
      1: field, 2: 19, 3: main, 4: 3, 5: byoyomi, 7: 0, 12: 1,
    })) });

    scenario.room(100145, { 1: 0, 2: [[1, 128], [2, 1], [3, 0]]
      .map(([field, count]) => ({ 1: field, 2: count })) });
    if (stage === "discovery") return;
    session.match();
    if (id !== "matchmaking-rejected") scenario.room(100130, { 1: 0 });
    if (stage === "matching") return;
    scenario.room(100140, { 1: 0, 2: game.GAME, 3: 63, 4: 100, 7: 200 });
    if (stage === "joining") return;
    scenario.notify(107, { 1: { 7: 60 }, 6: 100, 7: 200, 9: [
      { 1: id === "board-white" ? 43 : 42, 3: "StoneRiver", 4: 20,
        6: 1, 7: 425, 8: 3, 9: 60 },
      { 1: id === "board-white" ? 42 : 43, 3: "BambooMoon", 4: 19,
        6: 2, 7: 192, 8: 2, 9: 60 },
    ] });
    if (stage === "started") return;
    position(scenario);
  };
  try {
    await setup();
    if (id === "login-error") packet(2005, { 1: 111231 });
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
    url.searchParams.set("mute", "1");
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
