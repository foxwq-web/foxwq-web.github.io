import { setupFoxGame } from './fox-game.ts';
import { encode, decode } from '../src/wire.ts';
import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../src/controller";
import { Session } from "../src/session.ts";
import { boardAvailable, type UIState } from "../src/state";
import { BoardView, playablePoint } from "../src/BoardView";
import { Board } from "../src/board";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyDevScreen } from "../src/dev-screens";

function initial(session = new Session()): UIState {
  return {
    session: session.snapshot(),
    now: 1000,
    frozen: false,
    preview: null,
    prompt: null,
    menuError: "",
    error: "",
    focused: null,
    form: { username: "", passwordLength: 0, remember: false },
  };
}
test("opponent stone appears while the rendered estimate markers stay unchanged", async () => {
  const s = new Session();
  try {
    await applyDevScreen(s, "board-black");
    s.board = new Board();
    s.board.play(10, 9, s.color);
    s.estimationFetcher = async () => ({ ret: 0, board_size: 19, judge_status: '2'.repeat(361) });
    await s.estimateScore();
    const render = () => renderToStaticMarkup(createElement(BoardView, {
      state: initial(s), hover() {}, play() {},
    }));
    const before = render();
    s.gameMessage(203, decode(encode({1: 10, 2: 10, 3: 3 - s.color})), decode(encode({})));
    const after = render();
    const markers = (svg: string) => svg.match(/<g class="estimated-territory"[^>]*>.*?<\/g>/)![0];
    assert.equal(markers(after), markers(before));
    assert.equal((after.match(/class="stone stone-white"/g) ?? []).length,
      (before.match(/class="stone stone-white"/g) ?? []).length + 1);
  } finally { s.close(); }
});

test("quitting a finished room preserves its result and history until matchmaking starts", async () => {
  const controller = new Controller();
  try {
    await applyDevScreen(controller.session, "finished");
    controller.emit({ type: "initialize", state: initial(controller.session) });
    const finished = controller.snapshot();
    controller.command("quit-room");
    assert.equal(controller.state.session.phase, "ready");
    assert.equal(boardAvailable(controller.state.session), false);
    assert.deepEqual(controller.session.roomKey, {});
    assert.equal(controller.state.session.result, finished.result);
    assert.equal(controller.state.session.moves, finished.moves);
    assert.deepEqual(controller.state.session.stones, finished.stones);
    controller.command("select-time", { id: 2 });
    assert.equal(controller.state.session.phase, "ready");
    controller.command("match");
    assert.equal(controller.state.session.phase, "matching");
    assert.equal(controller.state.session.game_over, false);
  } finally {
    controller.dispose();
  }
});

test("preview legality is computed from UI state, including ko, without session access", () => {
  const session = new Session();
  setupFoxGame(session);
  for (const [x, y] of [
    [1, 2],
    [2, 2],
    [2, 1],
    [1, 3],
    [3, 2],
    [3, 3],
    [10, 10],
    [2, 4],
    [2, 3],
  ])
    session.board.play(x, y);
  session.color = session.board.turn;
  const state = initial(session);
  assert.equal(playablePoint(state, 2 + 2 * 19), null);
  assert.notEqual(playablePoint(state, 11 + 11 * 19), null);
  assert.equal(
    playablePoint(
      { ...state, session: { ...state.session, pending: true } },
      11 + 11 * 19,
    ),
    null,
  );
});

test("subscribers receive the controller state without replaying transitions", async () => {
  const controller = new Controller();
  try {
    let rendered = initial();
    const unsubscribe = controller.subscribe(() => {
      rendered = controller.getState();
    });
    controller.emit({ type: "initialize", state: rendered });
    setupFoxGame(controller.session);
    controller.session.flushChanges();
    controller.emit({ type: "board.hover", point: 60 });
    controller.command("play", { x: 3, y: 3 });
    controller.emit({
      type: "prompt.open",
      prompt: {
        action: "resign",
        title: "Resign?",
        description: "",
        label: "Resign",
      },
    });
    controller.command("resign");
    assert.equal(controller.state, rendered);
    unsubscribe();
    controller.emit({ type: "board.hover", point: null });
    assert.notEqual(controller.state, rendered);
    assert.deepEqual(JSON.parse(await controller.session.networkLog.serialize()), []);
  } finally {
    controller.dispose();
  }
});

test("opponent-turn actions are ignored without prompts or sending commands", async () => {
  const controller = new Controller();
  try {
    controller.preview = true;
    controller.emit({ type: "initialize", state: initial(controller.session) });
    const session = controller.session;
    session.phase = "playing";
    session.color = 2;
    controller.session.changed();
    controller.session.flushChanges();
    session.passTurn = () => assert.fail("must not pass during the opponent's turn");
    session.requestCounting = () => assert.fail("must not request counting during the opponent's turn");
    for (const command of ["pass", "request-score"] as const) {
      controller.command(command);
      assert.equal(controller.state.prompt, null);
      assert.equal(controller.state.error, "");
      assert.deepEqual(JSON.parse(await session.networkLog.serialize()), []);
    }
    session.board.turn = 2;
    controller.session.changed();
    controller.session.flushChanges();
    assert.equal(controller.state.prompt, null);
    let passes = 0, requests = 0;
    session.passTurn = () => { passes++; };
    session.requestCounting = () => { requests++; };
    controller.command("pass");
    controller.command("request-score");
    assert.equal(passes, 1);
    assert.equal(requests, 1);
  } finally {
    controller.dispose();
  }
});

test("login submissions retain live credentials without adding them to the network log", async () => {
  const controller = new Controller();
  try {
    controller.preview = true;
    const saved = initial(controller.session);
    saved.form.username = "RememberedPlayer";
    saved.form.passwordLength = 8;
    controller.emit({ type: "initialize", state: saved });
    controller.emit({ type: "form.username", value: "TestPlayer" });
    controller.editPassword("private-test-password");
    controller.session.login = () => {
      throw Error("Rejected login");
    };
    controller.command("login");
    assert.equal(
      controller.state.form.passwordLength,
      "private-test-password".length,
    );
    controller.session.login = (username, password) => {
      assert.equal(username, "TestPlayer");
      assert.equal(password, "private-test-password");
    };
    controller.command("login");
    assert.equal(controller.state.form.passwordLength, "private-test-password".length);
    assert.equal(controller.password, "private-test-password");
    assert.ok(
      !(await controller.session.networkLog.serialize()).includes("private-test-password"),
    );
    for (const username of ["RememberedPlayer", "TestPlayer"])
      assert.equal((await controller.session.networkLog.serialize()).includes(username), false);
    assert.equal(controller.state.form.username, "TestPlayer");
    assert.deepEqual(JSON.parse(await controller.session.networkLog.serialize()), []);
  } finally {
    controller.dispose();
  }
});

test("commands publish one detached session snapshot immediately without a second microtask update", async () => {
  const controller = new Controller();
  try {
    controller.preview = true;
    controller.emit({ type: "initialize", state: initial(controller.session) });
    setupFoxGame(controller.session);
    controller.session.flushChanges();
    const snapshot = controller.session.snapshot.bind(controller.session);
    let snapshots = 0, sessionUpdates = 0;
    controller.session.snapshot = () => { snapshots++; return snapshot(); };
    let previous = controller.state.session;
    controller.subscribe(() => {
      if (controller.state.session !== previous) {
        sessionUpdates++;
        previous = controller.state.session;
      }
    });
    controller.command("play", { x: 3, y: 3 });
    assert.equal(controller.state.session.stones[60], 1);
    assert.equal(snapshots, 1);
    assert.equal(sessionUpdates, 1);
    assert.notEqual(controller.state.session.stones, controller.session.board.stones);
    await Promise.resolve();
    assert.equal(snapshots, 1);
    assert.equal(sessionUpdates, 1);
    controller.session.pending = false;
    controller.session.pendingMove = null;
    controller.session.gameMessage(206, decode(encode({})), decode(encode({})));
    await Promise.resolve();
    assert.equal(controller.state.session.moves, 2);
    assert.equal(snapshots, 2);
    assert.equal(sessionUpdates, 2);
  } finally {
    controller.dispose();
  }
});

test("reconnection ignores game commands and keeps the board visible without allowing placement", () => {
  const controller = new Controller();
  try {
    setupFoxGame(controller.session);
    controller.emit({ type: "initialize", state: initial(controller.session) });
    controller.state.session = {
      ...controller.state.session, phase: "reconnecting", color: 1,
    };
    let commands = 0;
    controller.session.play = () => { commands++; };
    controller.session.resign = () => { commands++; };
    controller.session.passTurn = () => { commands++; };
    controller.session.estimateScore = async () => { commands++; };
    for (const command of ["play", "resign", "pass", "estimate-score"] as const)
      controller.command(command, { x: 3, y: 3 });
    assert.equal(commands, 0);
    assert.equal(playablePoint(controller.state, 3 + 3 * 19), null);
    assert.equal(controller.state.prompt, null);
  } finally { controller.dispose(); }
});

test("gameplay assets start once after login, including a directly restored game", () => {
  for (const destination of ["ready", "playing"]) {
    const controller = new Controller();
    try {
      let preloads = 0;
      controller.sounds.preload = () => { preloads++; };
      controller.emit({ type: "initialize", state: initial(controller.session) });
      for (const phase of ["connecting", "authenticating", "bootstrap", "gateway", "resuming", "error"]) {
        controller.session.phase = phase;
        controller.session.changed();
        controller.session.flushChanges();
        assert.equal(preloads, 0, phase);
      }
      for (const phase of [destination, "matching", "playing", "disconnected", "ready"]) {
        controller.session.phase = phase;
        controller.session.changed();
        controller.session.flushChanges();
        assert.equal(preloads, 1, phase);
      }
    } finally { controller.dispose(); }
  }
});

test('controller persists the native rollover anchor before rendering and announcing it', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const controller = new Controller(), voices: string[] = [];
  context.mock.method(controller.sounds, 'play', (name: string) => { voices.push(name); });
  try {
    const session = controller.session;
    session.phase = 'playing'; session.color = 1;
    session.clocks[1] = { main: 0, periods: 3, byoyomi: 1, periodLength: 30, at: 0 };
    controller.emit({ type: 'initialize', state: { ...initial(session), now: 0 } });
    controller.audio(); controller.scheduleClock();
    context.mock.timers.tick(500);
    assert.equal(session.clocks[1].periods, 3, 'zero still belongs to the current period');
    assert.deepEqual(voices, ['count-1']);
    context.mock.timers.tick(1000);
    assert.equal(controller.state.session.clocks[1].periods, 2);
    assert.equal(controller.state.session.clocks[1].byoyomi, 30);
    assert.equal(controller.state.session.clocks[1].at, 1.5);
    assert.equal(controller.state.now, 1.5);
    assert.deepEqual(voices, ['count-1', 'periods-2']);
    context.mock.timers.tick(500);
    assert.equal(session.clocks[1].at, 1.5, 'ordinary ticks do not restart the anchor');
    assert.deepEqual(voices, ['count-1', 'periods-2']);
  } finally { controller.dispose(); }
});
