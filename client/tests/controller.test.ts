import { setupFoxGame } from './fox-game.ts';
import { encode, decode } from '../src/wire.ts';
import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../src/controller";
import { Session } from "../src/session.ts";
import type { UIState } from "../src/state";
import { playablePoint } from "../src/BoardView";
import { applyDevScreen } from "../src/dev-screens";

function initial(session = new Session()): UIState {
  return {
    roomMenuOpen: false,
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
test("quitting a finished room preserves its result and history until matchmaking starts", async () => {
  const controller = new Controller();
  try {
    await applyDevScreen(controller.session, "finished");
    controller.emit({ type: "initialize", state: initial(controller.session) });
    const finished = controller.snapshot();
    controller.command("quit-room");
    assert.equal(controller.state.roomMenuOpen, true);
    assert.deepEqual(controller.snapshot(), finished);
    controller.emit({ type: "room-menu.close" });
    assert.equal(controller.state.roomMenuOpen, false);
    assert.deepEqual(controller.state.session, finished);
    controller.command("quit-room");
    controller.command("select-time", { id: 2 });
    assert.equal(controller.state.roomMenuOpen, true);
    controller.command("match");
    assert.equal(controller.state.session.phase, "matching");
    assert.equal(controller.state.roomMenuOpen, false);
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

test("subscribers receive the controller state without replaying transitions", () => {
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
  } finally {
    controller.dispose();
  }
});

test("opponent-turn actions are ignored without prompts or sending commands", () => {
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

test("login submissions retain live credentials", () => {
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
    assert.equal(controller.state.form.username, "TestPlayer");
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
