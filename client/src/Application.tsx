import { faBackwardStep, faArrowLeft, faArrowRight, faForwardStep, faXmark, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { Icon } from "./Icon";
import { PlayerName } from "./PlayerInfo";
import {
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  useRef,
  lazy,
  Suspense,
} from "react";
import { BoardView } from "./BoardView";
import { Controller } from "./controller";
import {
  boardAvailable,
  actionsBlocked,
  promptForAction,
  type UIState,
  type Command,
  type Prompt,
} from "./state";
import { timeLabel } from "./game.ts";
import { clockInputValue, clockReading } from "./clock.ts";
import { bindAudioUnlock } from "./sound.ts";

const DevMenu = import.meta.env.DEV ? lazy(() => import("./DevMenu")) : null;

function Player({ state, color, controller }: { state: UIState; color: number; controller: Controller }) {
  const s = state.session,
    name = color === 1 ? "black" : "white",
    player = s.players[color];
  const komi = color === 1 ? Math.max(0, -s.komi) : Math.max(0, s.komi);
  const clock = s.clocks[color];
  const elapsed =
    clock && !state.review && !state.frozen && !s.counting && s.phase === "playing" && s.turn === color &&
    !(color === 3 - s.color && s.opponentDisconnectDeadline != null)
      ? Math.max(0, state.now - clock.at)
      : 0;
  const reading = clock ? clockReading(clock, elapsed, 60, color === s.color) : null;
  const seconds = reading
    ? Math.ceil(reading.overtime ? reading.seconds : reading.main)
    : 0;
  const total =
    state.review?.totalPeriods ?? s.matchFields.find((field) => field.id === s.fieldId)?.periods ?? 3;
  const clockId = color === (s.color === 2 ? 2 : 1) ? "hours" : `${name}-hours`;
  const clockValue = clockInputValue(seconds);
  const clockText = seconds < 3600 ? clockValue.slice(3) : clockValue;
  return (
    <section
      id={`${name}-player`}
      aria-labelledby={`${name}-player-title`}
      className={`player-panel${!state.review && s.phase === "playing" && s.turn === color ? " to-play" : ""}`}
    >
      <p id={`${name}-player-title`} className="player-title">
        <span className={`player-stone ${name}`} />
        <PlayerName controller={controller} id={`${name}-player-name`} uid={player?.id}
          name={player?.name || (color === 1 ? "Black" : "White")} rank={player?.rank} />
      </p>
      <p
        id={`${name}-captures`}
        className="player-captures"
      >{`Captures: ${s.captures[color]}${komi ? ` + ${komi}` : ""}`}</p>
      <dl className="player-clock">
        <div>
          <dt id={`${name}-time-label`}>
            {reading?.overtime && clock?.periods
              ? <>Byoyomi: <span id={`${name}-periods`}>{reading.periods}/{total}</span></>
              : "Main time"}
          </dt>
          <dd id={`${name}-time`} className={`remaining-time${clock ? "" : " no-clock"}`}>
            {clock
              ? <time
                  className="clock-display"
                  id={clockId}
                  dateTime={`PT${seconds}S`}
                >
                  <span className="clock-text">{clockText}</span>
              </time>
              : "—"}
          </dd>
        </div>
      </dl>
    </section>
  );
}
function countingText(s: UIState["session"]) {
  if (s.confirmationKind !== "counting-result") return "";
  const score = s.countingResult;
  if (score?.winner === "Draw") return "Draw";
  if (!score?.winner) return "Unknown";
  const margin = [score.black, score.white, score.komi].every(Number.isFinite)
    ? Math.abs(score.black! - score.white! - score.komi!)
    : null;
  return `${score.winner === "Black wins" ? "B" : "W"}+${margin ?? ""}`;
}

export function App({ controller: c }: { controller: Controller }) {
  const state = useSyncExternalStore(c.subscribe, c.getState);
  const displayState = state.review
    ? { ...state, session: { ...state.session, ...state.review } }
    : state;
  const variation = state.review && "variation" in state.review ? state.review.variation : undefined;
  const reviewMove = state.review?.moves ?? state.session.moves;
  const s = state.session,
    playing = s.phase === "playing";
  const available = boardAvailable(s),
    reviewing = available && s.phase === "finished" && s.game_over,
    showMenu = !available;
  const loginStep =
    [
      "disconnected",
      "error",
      "connecting",
      "authenticating",
      "bootstrap",
      "gateway",
      "resuming",
    ].includes(s.phase);
  const resignConfirm = state.prompt?.action === "resign";
  const loginPending = [
    "connecting",
    "authenticating",
    "bootstrap",
    "gateway",
    "resuming",
  ].includes(s.phase);
  const disabled = actionsBlocked(s) || s.pending || !!state.prompt,
    yourTurn = s.color === s.turn,
    countingOpen = !!s.confirmationKind?.startsWith("counting-");
  const menu = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    passwordInput = useRef<HTMLInputElement>(null);
  const previous = useRef<{
    menu: boolean;
    login: boolean;
    prompt: Prompt | null;
    counting: boolean;
  } | null>(null);
  const statusError = !!state.menuError || s.phase === "error";
  const statusHidden =
    !state.menuError &&
    (s.phase === "disconnected" ||
      (["ready", "finished"].includes(s.phase) && s.matchFields.length > 0));
  const promptCounting = playing && s.passes >= 2 && !disabled && !s.counting && !s.confirmation;
  const gameMessage =
    playing &&
    (s.counting ||
      /passed|counting|rejected|failed|leaving/i.test(s.status));
  const countingRequested =
    s.counting && s.status === "Counting requested; waiting for opponent";
  const countingResultPending =
    playing && s.counting && !s.pending && !s.confirmation && !countingRequested;
  const gameHidden =
    s.phase !== "reconnecting" &&
    !s.game_over &&
    !promptCounting &&
    ((s.counting && !countingRequested && !countingResultPending) || s.pending || !gameMessage || s.confirmation || !!s.estimation || !!state.prompt);
  const boardStatus = s.game_over
    ? `Result: ${s.result || "Unknown"}`
    : countingRequested
      ? "Waiting for opponent..."
      : countingResultPending
        ? "Waiting for counting result..."
        : s.pending && !s.counting && !s.quitRequested
          ? "Waiting to confirm action"
          : s.status;
  const disconnectSeconds = Math.max(0, Math.ceil((s.opponentDisconnectDeadline ?? 0) - state.now));
  const ask = (command: Command) => {
    const prompt = promptForAction(command);
    if (prompt) c.emit({ type: "prompt.open", prompt });
  };
  const command = (name: Command) => c.command(name);

  useLayoutEffect(() => {
    document.body.classList.toggle("board-unavailable", !available);
    if (dialog.current) {
      if (countingOpen && !dialog.current.open) dialog.current.show();
      if (!countingOpen && dialog.current.open) dialog.current.close();
    }
    if (countingOpen && !previous.current?.counting)
      document.getElementById("counting-reject")?.focus();
    else if (state.prompt && state.prompt !== previous.current?.prompt)
      document.getElementById(state.prompt.action === "resign" ? "resign" : "action-cancel")?.focus();
    else if (
      showMenu &&
      (!previous.current?.menu || previous.current.login !== loginStep)
    ) {
      const match = document.getElementById("match") as HTMLButtonElement;
      (loginStep
        ? menu.current
        : match?.disabled
          ? menu.current
          : match
      )?.focus();
    } else if (
      showMenu &&
      (document.activeElement as HTMLButtonElement)?.disabled &&
      menu.current?.contains(document.activeElement)
    ) {
      menu.current?.focus();
    } else if (!showMenu && previous.current?.menu)
      document.getElementById("board")?.focus();
    const focused = (document.activeElement as HTMLElement)?.id || null;
    if (focused !== c.state.focused)
      c.emit({ type: "focus.changed", id: focused });
    previous.current = {
      menu: showMenu,
      login: loginStep,
      prompt: state.prompt,
      counting: countingOpen,
    };
  }, [
    available,
    countingOpen,
    state.prompt,
    showMenu,
    loginStep,
    s.phase,
    state.focused,
    c,
  ]);
  useLayoutEffect(() => {
    if (passwordInput.current)
      passwordInput.current.value = c.password;
  }, [state.form.passwordLength, loginStep, c]);
  useEffect(() => {
    const clear = () => {
      if (c.state.preview !== null)
        c.emit({ type: "board.hover", point: null });
    };
    const focus = (event: FocusEvent) => {
      if ((event.target as Element)?.closest("#dev-menu"))
        return;
      const id = (event.target as HTMLElement)?.id || null;
      if (id !== c.state.focused) c.emit({ type: "focus.changed", id });
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.type === "keydown" &&
        event.key.toLowerCase() === "f" &&
        !event.repeat &&
        !event.isComposing &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !(event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            event.target.closest("input, textarea, select")))
      ) {
        event.preventDefault();
        const toggle = document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen?.();
        void toggle?.catch(() => {});
        return;
      }
      const current = c.state,
        menuShown = !boardAvailable(current.session);
      if (
        event.type === "keydown" && !menuShown && current.session.game_over &&
        current.session.phase === "finished" &&
        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) &&
        !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !(event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest("input, textarea, select, [role='dialog'], #dev-menu")))
      ) {
        event.preventDefault();
        c.review(event.key === "Home" ? "first" : event.key === "End" ? "last"
          : event.key === "ArrowLeft" ? "previous" : "next");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (event.type !== "keydown" || event.repeat) return;
        if (menuShown) {
          event.stopImmediatePropagation();
          return;
        }
        if (current.prompt) c.emit({ type: "prompt.close" });
        else if (current.session.confirmationKind?.startsWith("counting-"))
          c.command("confirm", { accept: false });
        else if (current.review && "variation" in current.review && current.review.variation)
          c.review("first");
      }
      if (
        !menuShown ||
        event.type !== "keydown" ||
        event.key !== "Tab"
      )
        return;
      const controls = [
        ...(menu.current?.querySelectorAll<HTMLElement>(
          'a[href], button, input, [tabindex="0"]',
        ) ?? []),
        ...document.querySelectorAll<HTMLElement>(
          "#dev-menu summary, #dev-menu button, #dev-menu input, #dev-menu a",
        ),
      ].filter(
        (control) =>
          !(control as HTMLButtonElement).disabled &&
          control.getClientRects().length &&
          control.checkVisibility(),
      );
      const first = controls[0],
        last = controls.at(-1);
      if (!first) {
        event.preventDefault();
        menu.current?.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first ||
          !controls.includes(document.activeElement as HTMLElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !controls.includes(document.activeElement as HTMLElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    for (const type of ["blur", "resize", "scroll"])
      window.addEventListener(type, clear, true);
    const unbindAudio = bindAudioUnlock(c.sounds);
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", key, true);
    const hide = () => c.dispose();
    // pagehide permanently disposes the controller, even when the browser caches
    // this document. Start a fresh session rather than restore a frozen UI.
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      for (const type of ["blur", "resize", "scroll"])
        window.removeEventListener(type, clear, true);
      unbindAudio();
      document.removeEventListener("focusin", focus);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("keyup", key, true);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, [c]);
  const status = (
    <span
      id="status"
      hidden={statusHidden}
      className={statusError ? "is-error" : ""}
    >
      {!statusHidden && loginStep && statusError && <Icon icon={faTriangleExclamation} />}
      {!statusHidden && `${statusError ? "Error: " : ""}${statusError ? state.menuError || s.status : s.status}`}
    </span>
  );
  const bottomColor = s.color === 2 ? 2 : 1,
    estimate = s.estimation;
  return (
    <>
      <main
        inert={showMenu}
      >
        <div className="layout">
          <section className="board-wrap">
            <BoardView
              state={displayState}
              hover={(point) => {
                if (point !== c.state.preview)
                  c.emit({ type: "board.hover", point });
              }}
              play={(p) =>
                c.command("play", { x: p % 19, y: Math.floor(p / 19) })
              }
            />
          </section>
          <aside>
            <div id="sidebar-content">
              <Player
                key={3 - bottomColor}
                state={displayState}
                controller={c}
                color={3 - bottomColor}
              />
              <Player key={bottomColor} state={displayState} controller={c} color={bottomColor} />
              <div className="primary-actions-slot">
                <div id="primary-actions">
                  <button
                    id="pass"
                    className="secondary"
                    disabled={disabled || !yourTurn}
                    onClick={() => command("pass")}
                  >
                    Pass
                  </button>
                  <button
                    id="request-score"
                    className="secondary"
                    disabled={disabled || !yourTurn || s.counting}
                    onClick={() => command("request-score")}
                  >
                    Request Counting
                  </button>
                  <div className="resign-actions">
                    <button
                      id="resign"
                      className={resignConfirm ? "secondary resign-confirm" : "secondary"}
                      disabled={actionsBlocked(s)}
                      onClick={() => resignConfirm ? command("resign") : ask("resign")}
                    >
                      {resignConfirm ? "Confirm Resignation" : "Resign"}
                    </button>
                    <button
                      id="resign-cancel"
                      className="secondary"
                      aria-label="Cancel resignation" title="Cancel resignation"
                      hidden={!resignConfirm}
                      onClick={() => c.emit({ type: "prompt.close" })}
                    ><Icon icon={faXmark} standalone /></button>
                  </div>
                  <button
                    id="estimate-score"
                    className="secondary"
                    disabled={(!playing && !reviewing) || !!state.prompt || (!estimate && (reviewing ? s.pending : actionsBlocked(s)))}
                    onClick={() => command(estimate ? "return-game" : "estimate-score")}
                  >
                    {estimate ? "Return to Game" : "Estimate Score"}
                  </button>
                </div>
              </div>
              <div id="sidebar-quests">
                <section
                  id="action-panel"
                  className="quest-panel"
                  hidden={!state.prompt || resignConfirm}
                >
                  <p id="action-title">{state.prompt?.title}</p>
                  <p id="action-description" hidden={!state.prompt?.description}>
                    {state.prompt?.description}
                  </p>
                  <div className="actions">
                    <button
                      id="action-cancel"
                      className="secondary"
                      onClick={() => c.emit({ type: "prompt.close" })}
                    >
                      {state.prompt?.action ? "Cancel" : state.prompt?.label}
                    </button>
                    <button
                      id="action-confirm"
                      hidden={!state.prompt?.action}
                      onClick={() => {
                        const action = c.state.prompt?.action;
                        if (action) command(action);
                      }}
                    >
                      {state.prompt?.label}
                    </button>
                  </div>
                </section>
                <dialog
                  ref={dialog}
                  className="quest-panel"
                  id="counting-dialog"
                >
                  <p id="counting-title">
                    {s.confirmationKind === "counting-result"
                      ? <>Counting result: <span id="counting-result">{countingText(s)}</span></>
                      : "Opponent requested counting"}
                  </p>
                  <div className="actions">
                    <button
                      id="counting-accept"
                      disabled={s.pending || !!state.prompt}
                      onClick={() => c.command("confirm", { accept: true })}
                    >
                      Accept
                    </button>
                    <button
                      id="counting-reject"
                      className="secondary"
                      disabled={s.pending || !!state.prompt}
                      onClick={() => c.command("confirm", { accept: false })}
                    >
                      Reject
                    </button>
                  </div>
                </dialog>
                <section
                  id="estimation-panel"
                  className="quest-panel"
                  hidden={!estimate || estimate.phase === "loading"}
                >
                  <p id="estimation-status" hidden={estimate?.phase !== "error"}>
                    {estimate?.phase === "error" ? estimate.error : ""}
                  </p>
                  <p id="estimation-lead" hidden={estimate?.phase !== "result"}>
                    {estimate?.phase === "result"
                      ? estimate.lead === 0
                        ? "Estimated draw"
                        : `${estimate.lead > 0 ? "Black" : "White"} leads by ${Math.abs(estimate.lead)} points`
                      : ""}
                  </p>
                  <button
                    id="estimation-retry"
                    hidden={estimate?.phase !== "error"}
                    onClick={() => command("estimate-score")}
                  >
                    Try Again
                  </button>
                </section>
                <section
                  id="opponent-connection-panel"
                  className="quest-panel"
                  hidden={!playing || s.opponentDisconnectDeadline == null}
                >
                  <p id="opponent-connection-status" role="status">
                    Opponent disconnected ({Math.floor(disconnectSeconds / 60)}:{String(disconnectSeconds % 60).padStart(2, "0")})
                  </p>
                </section>
                <section
                  id="game-state-panel"
                  className="quest-panel"
                  hidden={gameHidden}
                >
                  <p id="game-state-title" hidden={!s.game_over && !promptCounting}>
                    {s.game_over
                      ? "Game over"
                      : promptCounting
                        ? "Both players passed"
                        : ""}
                  </p>
                  <p
                    id="board-status"
                    role="status"
                    hidden={promptCounting || !boardStatus}
                    className={
                      /failed|rejected|error/i.test(s.status) ? "is-error" : ""
                    }
                  >
                    {boardStatus}
                  </p>
                  <div id="game-downloads" hidden={!s.game_over}>
                    <button
                      id="save-sgf"
                      type="button"
                      className="secondary"
                      disabled={!!estimate}
                      onClick={() => c.save("sgf")}
                    >
                      Download SGF
                    </button>
                  </div>
                  <button
                    id="quit-room"
                    className="secondary"
                    hidden={s.phase !== "finished"}
                    disabled={s.pending || s.quitRequested || !!estimate}
                    onClick={() =>
                      playing ? ask("quit-room") : command("quit-room")
                    }
                  >
                    Quit Room
                  </button>
                </section>
                <div id="game-review" hidden={!s.game_over}>
                  <div className="actions" role="group" aria-label="Review game">
                    {([
                      ["first", "First move", faBackwardStep, !!variation || reviewMove === 0],
                      ["previous", "Previous move", faArrowLeft, reviewMove === 0],
                      ["next", "Next move", faArrowRight, variation ? variation.cursor === variation.moves.length : reviewMove === s.moves],
                      ["last", "Last move", faForwardStep, !!variation || reviewMove === s.moves],
                    ] as const).map(([direction, label, icon, disabled]) => (
                      <button key={direction} id={`review-${direction}`} type="button"
                        className="secondary" aria-label={label} title={label}
                        disabled={disabled || !!estimate} onClick={() => c.review(direction)}>
                        <svg viewBox={`0 0 ${icon.icon[0]} ${icon.icon[1]}`} aria-hidden="true" focusable="false">
                          <path fill="currentColor" d={Array.isArray(icon.icon[4]) ? icon.icon[4].join(" ") : icon.icon[4]} />
                        </svg>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </main>
      <div
        id="connection-layer"
        hidden={!showMenu}
      >
        <div
          ref={menu}
          id="connection-menu"
          tabIndex={-1}
        >
          <h2 id="menu-title">{loginStep ? "Foxwq-web" : "Matchmaking"}</h2>
          <p className="login-intro login-copy" hidden={!loginStep}>
            <a id="github-source" href="https://github.com/foxwq-web/foxwq-web.github.io" target="_blank" rel="noopener noreferrer">A web client</a> for {" "}
            the <a id="fox-server" href="https://foxwq.com" target="_blank" rel="noopener noreferrer">Fox go server</a>.
          </p>
          <p id="matchmaking-player" className="login-intro login-copy" hidden={loginStep}>
            Playing as <PlayerName controller={c} uid={loginStep ? undefined : c.session.uid}
              name={s.account?.name || state.form.username} rank={s.account?.rank} />.
          </p>
          {/* Retire the credential form after login, before game downloads. */}
          {loginStep && <form
            id="login-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const username = (
                form.elements.namedItem("username") as HTMLInputElement
              ).value;
              if (username !== c.state.form.username)
                c.emit({ type: "form.username", value: username });
              c.editPassword(
                (form.elements.namedItem("password") as HTMLInputElement).value,
              );
              c.remember(
                (form.elements.namedItem("remember") as HTMLInputElement)
                  .checked,
              );
              command("login");
            }}
          >
            <label htmlFor="username">
              <input
                id="username"
                name="username"
                placeholder="Username"
                autoComplete="username"
                required
                disabled={loginPending}
                value={state.form.username}
                onChange={(e) =>
                  c.emit({ type: "form.username", value: e.target.value })
                }
              />
            </label>
            <label htmlFor="password">
              <input
                ref={passwordInput}
                id="password"
                name="password"
                placeholder="Password"
                type="password"
                autoComplete="current-password"
                required
                disabled={loginPending}
                defaultValue={c.password}
                onChange={(e) => c.editPassword(e.target.value)}
              />
            </label>
            <div className="login-options login-copy">
              <label className="remember">
                <input
                  id="remember"
                  name="remember"
                  type="checkbox"
                  disabled={loginPending}
                  checked={state.form.remember}
                  onChange={(e) => c.remember(e.target.checked)}
                />
                Remember me
              </label>
              <a href="https://account.foxwq.com/reg/foreign.html" target="_blank" rel="noopener noreferrer">Sign up</a>
            </div>
            <button
              id="login"
              type="submit"
              disabled={!state.form.username.trim() || state.form.passwordLength === 0 || loginPending}
            >
              {statusHidden || statusError ? "Log in" : null}
              {loginStep && !statusError && status}
            </button>
            {loginStep && statusError && status}
          </form>}
          <div id="matchmaking" hidden={loginStep}>
            <section id="time-settings" aria-label="Time control">
              <div id="time-controls" className="time-controls" role="radiogroup" aria-label="Time control">
                {s.matchFields.map((field) => (
                  <label key={field.id} className="time-option">
                    <input
                      type="radio"
                      id={`time-control-${field.id}`}
                      name="time-control"
                      value={field.id}
                      checked={s.fieldId === field.id}
                      disabled={!["ready", "finished"].includes(s.phase)}
                      onChange={() =>
                        c.command("select-time", { id: field.id })
                      }
                    />
                    <span>
                      <span>19,{timeLabel(field)}</span>
                      <span
                        className="field-population"
                        data-field-id={field.id}
                      >
                        {s.fieldPlayers[field.id] == null
                          ? "(— players)"
                          : `(${s.fieldPlayers[field.id]} ${s.fieldPlayers[field.id] === 1 ? "player" : "players"})`}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
            <button
              id="match"
              disabled={
                !(
                  ["ready", "finished"].includes(s.phase) &&
                  s.fieldId !== null &&
                  s.gatewayAvailable
                )
              }
              onClick={() => command("match")}
            >
              {statusHidden || statusError ? "Play" : null}
              {!loginStep && !statusError && status}
            </button>
            {!loginStep && statusError && status}
          </div>
        </div>
      </div>
      <div id="error" hidden={!state.error}>
        {state.error}
      </div>
      {DevMenu && (
        <Suspense fallback={null}>
          <DevMenu controller={c} />
        </Suspense>
      )}
    </>
  );
}
