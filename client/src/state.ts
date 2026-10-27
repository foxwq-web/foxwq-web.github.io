import type { PlayerInfo } from "./player-info";

export interface TimeControl {
  id: number;
  size: number;
  main: number;
  periods: number;
  byoyomi: number;
}
export interface Clock {
  main: number;
  periods: number;
  byoyomi: number;
  periodLength?: number;
  at: number;
}
export interface SessionState {
  phase: string;
  status: string;
  stones: number[];
  turn: number;
  komi: number;
  captures: number[];
  passes: number;
  moves: number;
  result: string;
  game_over: boolean;
  time: string;
  matchFields: TimeControl[];
  fieldPlayers: Record<string, number>;
  fieldId: number | null;
  color: number;
  pending: boolean;
  pendingMove?: boolean;
  quitRequested: boolean;
  account: { name: string; rank: string } | null;
  players: Record<string, { id?: number; name: string; rank?: string }>;
  clocks: Record<string, Clock>;
  opponentDisconnectDeadline?: number | null;
  gameId: string;
  last_move: [number, number | null, number | null] | null;
  confirmation: boolean;
  counting: boolean;
  confirmationKind: string | null;
  countingResult: {
    winner?: string | null;
    black?: number;
    white?: number;
    komi?: number;
  } | null;
  estimation:
    | null
    | { phase: "loading" }
    | { phase: "error"; error: string }
    | { phase: "result"; lead: number; ownership: number[]; stones: number[] };
  playerInfo?: PlayerInfo | null;
  gatewayAvailable: boolean;
  koStones: number[] | null;
}
export type Command =
  | "login"
  | "disconnect"
  | "quit-room"
  | "select-time"
  | "match"
  | "cancel"
  | "estimate-score"
  | "return-game"
  | "request-score"
  | "confirm"
  | "play"
  | "pass"
  | "resign";
export interface Prompt {
  action: Command | null;
  title: string;
  description: string;
  label: string;
}
export interface UIState {
  session: SessionState;
  review?: Pick<SessionState, "stones" | "captures" | "turn" | "passes" | "moves" | "last_move"> & {
    koStones?: number[] | null;
    variation?: { origin: number; moves: [number, number | null, number | null][]; cursor: number };
    moveNumbers?: Record<number, number>;
  } | null;
  now: number;
  frozen: boolean;
  preview: number | null;
  prompt: Prompt | null;
  menuError: string;
  error: string;
  focused: string | null;
  form: { username: string; passwordLength: number; remember: boolean };
}
export type UIEvent =
  | { type: "initialize"; state: UIState }
  | { type: "session.updated"; session: SessionState }
  | { type: "review.position"; position: NonNullable<UIState["review"]> }
  | { type: "clock.tick"; now: number }
  | { type: "board.hover"; point: number | null }
  | { type: "prompt.open"; prompt: Prompt }
  | { type: "prompt.close" }
  | { type: "form.username"; value: string }
  | { type: "form.password"; length: number }
  | { type: "form.remember"; value: boolean }
  | { type: "focus.changed"; id: string | null }
  | { type: "command" }
  | { type: "error.raised"; message: string; menu: boolean }
  | { type: "error.dismissed" };

export function boardAvailable(s: SessionState): boolean {
  return (
    ["playing", "finished", "reconnecting"].includes(s.phase) &&
    [1, 2].includes(s.color)
  );
}
export function blocked(s: SessionState): boolean {
  return (
    s.phase !== "playing" ||
    s.pending ||
    s.counting ||
    s.confirmation ||
    !!s.estimation
  );
}

export function actionsBlocked(s: SessionState): boolean {
  return s.phase !== "playing" || (s.pending && !s.pendingMove) || !!s.estimation ||
    (s.confirmationKind !== "counting-request" && (s.counting || s.confirmation));
}

export function reducer(state: UIState, event: UIEvent): UIState {
  switch (event.type) {
    case "initialize":
      return event.state;
    case "session.updated":
      return {
        ...state,
        session: event.session,
        error: boardAvailable(event.session) ? state.error : "",
        review: event.session.phase === "finished" && event.session.game_over &&
          event.session.gameId === state.session.gameId && event.session.moves === state.session.moves
          ? state.review : null,
        prompt:
          actionsBlocked(event.session) ||
          (state.prompt?.action === null &&
            event.session.turn === event.session.color)
            ? null
            : state.prompt,
        preview:
          blocked(event.session) || !boardAvailable(event.session)
            ? null
            : state.preview,
      };
    case "review.position":
      return { ...state, review: event.position, preview: null };
    case "clock.tick":
      return { ...state, now: event.now };
    case "board.hover":
      return { ...state, preview: event.point };
    case "prompt.open":
      return { ...state, prompt: event.prompt };
    case "prompt.close":
      return { ...state, prompt: null };
    case "form.username":
      return { ...state, form: { ...state.form, username: event.value } };
    case "form.password":
      return {
        ...state,
        form: { ...state.form, passwordLength: event.length },
      };
    case "form.remember":
      return { ...state, form: { ...state.form, remember: event.value } };
    case "focus.changed":
      return { ...state, focused: event.id };
    case "command":
      return {
        ...state,
        prompt: null,
        menuError: "",
      };
    case "error.raised":
      return event.menu
        ? { ...state, menuError: event.message }
        : { ...state, error: event.message };
    case "error.dismissed":
      return { ...state, error: "" };
  }
}

export const actionPrompts: Partial<Record<Command, Prompt>> = {
  resign: {
    action: "resign",
    title: "Resign this game?",
    description: "",
    label: "Resign",
  },
  "quit-room": {
    action: "quit-room",
    title: "Leave this room?",
    description: "",
    label: "Leave",
  },
};

export function outOfTurn(s: Pick<SessionState, "phase" | "color" | "turn">, command: Command): boolean {
  return s.phase === "playing" && s.color !== s.turn &&
    ["pass", "request-score"].includes(command);
}

export function promptForAction(command: Command): Prompt | undefined {
  return actionPrompts[command];
}
