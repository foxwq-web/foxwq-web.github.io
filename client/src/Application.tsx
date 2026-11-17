import { faBackwardStep, faArrowLeft, faArrowRight, faForwardStep, faDownload } from "@fortawesome/free-solid-svg-icons";
import { Icon } from "./Icon";
import { formatError } from "./error-message";
import { PlayerName } from "./PlayerInfo";
import {
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  useRef,
  useState,
  lazy,
  memo,
  Suspense,
  type CSSProperties,
} from "preact/compat";
import { BoardView, coordinateGutterPixels } from "./BoardView";
import { Controller } from "./controller";
import {
  boardAvailable,
  quitRoomPrompt,
  reviewAvailable,
  actionsBlocked,
  isLoginStep,
  type UIState,
  type Command,
} from "./state";
import { timeLabel } from "./game.ts";
import { clockInputValue, clockReading } from "./clock.ts";
import { bindAudioUnlock } from "./sound.ts";
import { rememberedCoordinates, rememberCoordinates } from "./coordinate-preference.ts";

const DevMenu = import.meta.env.DEV ? lazy(() => import("./DevMenu")) : null;

const TimeControls = memo(function TimeControls({ fields, populations, selected, searching, disabled, controller: c }: {
  fields: UIState["session"]["matchFields"];
  populations: UIState["session"]["fieldPlayers"];
  selected: UIState["session"]["fieldId"];
  searching: boolean;
  disabled: boolean;
  controller: Controller;
}) {
  return (
    <section id="time-settings" aria-label="Time control">
      <div id="time-controls" className="time-controls">
        {fields.map((field) => {
          const active = searching && selected === field.id;
          return (
            <button
              key={field.id}
              type="button"
              id={selected === field.id ? "match" : undefined}
              className="button matchmaking-button"
              data-field-id={field.id}
              disabled={disabled || searching}
              onClick={() => c.command("select-time", { id: field.id })}
            >
              {active
                ? <span id="matchmaking-title" role="status">{`Searching for 19,${timeLabel(field)}...`}</span>
                : <>
                    <span>{`19,${timeLabel(field)}`}</span>
                    <span className="field-population" data-field-id={field.id}>
                      {populations[field.id] == null ? "(—)" : `(${populations[field.id]})`}
                    </span>
                  </>}
            </button>
          );
        })}
      </div>
    </section>
  );
});

function Player({ state, color, controller }: { state: UIState; color: number; controller: Controller }) {
  const s = state.session,
    name = color === 1 ? "black" : "white",
    player = s.players[color];
  const loading = ["joining", "resuming"].includes(s.phase);
  const komi = color === 1 ? Math.max(0, -s.komi) : Math.max(0, s.komi);
  const clock = s.clocks[color];
  const disconnected = color === 3 - s.color && s.opponentDisconnectDeadline != null;
  const elapsed =
    clock && !state.review && !state.frozen && !s.paused && !s.counting && s.phase === "playing" && !s.resignationResult && s.turn === color &&
    !disconnected
      ? Math.max(0, state.now - clock.at)
      : 0;
  const reading = clock ? clockReading(clock, elapsed, 60, color === s.color) : null;
  const seconds = reading
    ? Math.ceil(reading.overtime ? reading.seconds : reading.main)
    : 0;
  const total =
    state.review?.totalPeriods ?? s.totalPeriods ?? s.matchFields.find((field) => field.id === s.fieldId)?.periods ?? 3;
  const clockId = color === (s.color === 2 ? 2 : 1) ? "hours" : `${name}-hours`;
  const clockValue = clockInputValue(seconds);
  const clockText = seconds < 3600 ? clockValue.slice(3) : clockValue;
  return (
    <section
      id={`${name}-player`}
      className={`player-panel${!state.review && s.phase === "playing" && !s.resignationResult && s.turn === color && !disconnected ? " to-play" : ""}`}
      aria-labelledby={loading ? undefined : `${name}-player-title`}
      aria-label={loading ? `Loading ${name} player` : undefined}
    >
      {loading ? <>
        <p className="player-title"><span className="player-skeleton player-card-name-skeleton" /></p>
        <p className="player-captures"><span className="player-skeleton player-card-detail-skeleton" /></p>
        <dl className="player-clock"><div>
          <dt><span className="player-skeleton player-card-detail-skeleton" /></dt>
          <dd className="remaining-time"><span className="player-skeleton player-card-clock-skeleton" /></dd>
        </div></dl>
      </> : <>
      <p id={`${name}-player-title`} className="player-title">
        <span className={`player-stone ${name}`} />
        <PlayerName controller={controller} id={`${name}-player-name`} uid={player?.id}
          name={player?.name || (color === 1 ? "Black" : "White")} rank={player?.rank} country={player?.country} />
      </p>
      <p
        id={`${name}-captures`}
        className="player-captures"
      >{`Score: ${s.captures[color]}${komi ? ` + ${komi}` : ""}`}</p>
      <dl className="player-clock">
        <div>
          <dt id={`${name}-time-label`}>
            {reading?.overtime && clock?.periods
              ? <>Byoyomi: <span id={`${name}-periods`}>{reading.periods}/{total}</span></>
              : !clock && s.spectating ? "Time not transmitted" : "Main time"}
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
              : s.spectating
                ? <span className="clock-display unavailable" id={clockId}>
                    <span className="clock-text clock-placeholder">
                      <span>-</span><span>-</span><span>:</span><span>-</span><span>-</span>
                    </span>
                  </span>
                : "—"}
          </dd>
        </div>
      </dl>
      </>}
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

export function App({ controller: c, recordError }: {
  controller: Controller;
  recordError?: string;
}) {
  const [coordinates, setCoordinates] = useState(rememberedCoordinates);
  useEffect(() => rememberCoordinates(coordinates), [coordinates]);
  const state = useSyncExternalStore(c.subscribe, c.getState);
  const displayState = state.review
    ? { ...state, session: { ...state.session, ...state.review } }
    : state;
  const variation = state.review && "variation" in state.review ? state.review.variation : undefined;
  const reviewMove = state.review?.moves ?? state.session.moves;
  const s = state.session,
    playing = s.phase === "playing" && !s.resignationResult;
  const replayLoading = !!c.recordedGame && s.phase === "joining";
  const available = boardAvailable(s),
    reviewing = reviewAvailable(s),
    showMenu = !available;
  const loginStep = isLoginStep(s);
  const loginPending = [
    "connecting",
    "authenticating",
    "bootstrap",
    "gateway",
    "resuming",
  ].includes(s.phase);
  const [resignConfirm, setResignConfirm] = useState(false);
  const gameActionsBlocked = actionsBlocked(s);
  useEffect(() => setResignConfirm(false), [c, s.gameId, gameActionsBlocked]);
  useEffect(() => {
    if (!resignConfirm) return;
    let disabledClick: ReturnType<typeof setTimeout> | undefined;
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("#resign")) return;
      setResignConfirm(false);
    };
    // Disabled controls do not emit clicks. Wait until the pointer interaction
    // finishes before enabling them again, so this click cannot activate them.
    const dismissDisabled = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("button:disabled"))
        disabledClick = setTimeout(() => setResignConfirm(false), 0);
    };
    document.addEventListener("click", dismiss, true);
    document.addEventListener("pointerup", dismissDisabled, true);
    return () => {
      document.removeEventListener("click", dismiss, true);
      document.removeEventListener("pointerup", dismissDisabled, true);
      clearTimeout(disabledClick);
    };
  }, [resignConfirm]);
  const turnActionsBlocked = gameActionsBlocked || !!state.prompt,
    countingOpen = !!s.confirmationKind?.startsWith("counting-");
  const dialog = useRef<HTMLDialogElement>(null),
    passwordInput = useRef<HTMLInputElement>(null),
    wasSearching = useRef(false);
  useLayoutEffect(() => {
    if (s.phase === "matching") wasSearching.current = true;
    else if (wasSearching.current) {
      wasSearching.current = false;
      if (showMenu) document.getElementById("match")?.focus();
    }
  }, [s.phase, showMenu]);
  const notice = s.notice;
  const statusError = !!state.menuError ||
    s.phase === "error" ||
    notice?.kind === "matchmaking-rejected";
  const statusSeparate = statusError ||
    (s.phase === "ready" && notice?.kind === "matchmaking-cancelled");
  const statusHidden =
    !statusSeparate &&
    (s.phase === "disconnected" ||
      (["ready", "finished"].includes(s.phase) && s.matchFields.length > 0));
  const promptCounting = !s.spectating && playing && s.passes >= 2 && !turnActionsBlocked && !s.pending && !s.counting && !s.confirmation;
  const gameMessage =
    playing &&
    (s.paused || s.counting || !!notice?.game);
  const countingRequested =
    s.counting && notice?.kind === "counting-requested";
  const countingResultPending =
    playing && s.counting && !s.pending && !s.confirmation && !countingRequested;
  const showResult = s.game_over || !!s.resignationResult;
  const gameHidden =
    s.phase !== "reconnecting" &&
    s.phase !== "kicked" &&
    !showResult &&
    !promptCounting &&
    !s.paused &&
    ((s.counting && !countingRequested && !countingResultPending) || (s.pending && !notice?.game) || !gameMessage || s.confirmation || !!s.estimation || !!state.prompt);
  const result = s.resignationResult ?? s.result;
  const resultWinner = result.startsWith("B+") ? 1 : result.startsWith("W+") ? 2 : 0;
  const resultClass = resultWinner && [1, 2].includes(s.color)
    ? resultWinner === s.color ? "win" : "loss"
    : "";
  const localBoardStatus = s.resignationResult ? "" : s.paused && !s.confirmation && !s.counting
    ? "Game paused"
    : countingRequested
      ? "Waiting for opponent..."
      : countingResultPending
        ? "Waiting for counting result..."
        : s.pending && !s.pendingMove && !s.counting && !s.quitRequested && !notice?.game
          ? "Waiting to confirm action"
          : null;
  const boardStatus = state.error || (localBoardStatus ?? s.status);
  const boardStatusError = !!state.error || (!localBoardStatus && !!notice?.error);
  const disconnectSeconds = Math.max(0, Math.ceil((s.opponentDisconnectDeadline ?? 0) - state.now));
  const command = (name: Command) => c.command(name);

  useLayoutEffect(() => {
    document.body.classList.toggle("board-unavailable", !available);
    if (dialog.current) {
      const showCounting = countingOpen && !s.resignationResult;
      if (showCounting && !dialog.current.open) dialog.current.show();
      if (!showCounting && dialog.current.open) dialog.current.close();
    }
  }, [available, countingOpen, s.resignationResult]);
  useLayoutEffect(() => {
    if (passwordInput.current)
      passwordInput.current.value = c.password;
  }, [state.form.passwordLength, loginStep, c]);
  useEffect(() => {
    if (state.frozen || s.spectating || s.phase !== "playing" || s.game_over) return;
    const confirmLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers supply their own confirmation text.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmLeave);
    return () => window.removeEventListener("beforeunload", confirmLeave);
  }, [state.frozen, s.phase, s.game_over, s.spectating]);
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
        event.type === "keydown" && !menuShown &&
        event.key.toLowerCase() === "c" && !c.previewCoordinates && !event.repeat &&
        !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !(event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest("input, textarea, select, .player-info, #dev-menu")))
      ) {
        event.preventDefault();
        setCoordinates((shown) => !shown);
        return;
      }
      if (
        event.type === "keydown" && !menuShown && reviewAvailable(current.session) &&
        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) &&
        !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !(event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest("input, textarea, select, .player-info, #dev-menu")))
      ) {
        event.preventDefault();
        c.review(event.key === "Home" ? "first" : event.key === "End" ? "last"
          : event.key === "ArrowLeft" ? "previous" : "next");
        return;
      }
      if (
        event.type === "keydown" && !menuShown && event.key.toLowerCase() === "e" &&
        !event.repeat && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !(event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest("input, textarea, select, .player-info, #dev-menu")))
      ) {
        const estimateButton = document.getElementById("estimate-score") as HTMLButtonElement | null;
        if (estimateButton && !estimateButton.disabled && estimateButton.checkVisibility()) {
          event.preventDefault();
          estimateButton.click();
        }
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
          c.review("main");
      }
    };
    for (const type of ["blur", "resize", "scroll"])
      window.addEventListener(type, clear, true);
    const unbindAudio = bindAudioUnlock(c.sounds);
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", key, true);
    const hide = () => { if (c.recordedGame) c.dispose(); };
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
      {!statusHidden && (statusError ? formatError(state.menuError || s.status) : s.status)}
    </span>
  );
  const bottomColor = s.color === 2 ? 2 : 1,
    estimate = s.estimation,
    searching = s.phase === "matching";
  return (
    <>
      <main
        style={{ "--coordinate-gutter": `${coordinateGutterPixels}px` } as CSSProperties}
        inert={showMenu}
      >
        <div hidden={showMenu} className={`layout${c.previewCoordinates || coordinates ? " has-coordinates" : ""}`}>
          <section className="board-wrap">
            <BoardView
              coordinates={c.previewCoordinates || coordinates}
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
              <button
                id="quit-room"
                className="button secondary"
                hidden={!s.spectating && !s.resignationResult && s.phase !== "finished" && s.phase !== "kicked"}
                disabled={(s.pending && !s.resignationResult) || s.quitRequested || !!estimate}
                onClick={() => {
                  if (!s.spectating && playing) c.emit({ type: "prompt.open", prompt: quitRoomPrompt });
                  else command(!s.spectating && s.phase === "kicked" ? "disconnect" : "quit-room");
                }}
              >
                {s.phase === "kicked" ? "Return to Login" : "Quit Room"}
              </button>
              <div className="primary-actions-slot" hidden={!!s.spectating || showResult}>
                <div id="primary-actions">
                  <button
                    id="pass"
                    className="button secondary"
                    disabled={resignConfirm || turnActionsBlocked}
                    onClick={() => command("pass")}
                  >
                    Pass
                  </button>
                  <button
                    id="request-score"
                    className="button secondary"
                    disabled={resignConfirm || turnActionsBlocked || s.counting}
                    onClick={() => command("request-score")}
                  >
                    Request Counting
                  </button>
                  <button
                    id="resign"
                    className="button secondary"
                    disabled={gameActionsBlocked}
                    onClick={() => {
                      if (resignConfirm) {
                        setResignConfirm(false);
                        command("resign");
                      } else setResignConfirm(true);
                    }}
                  >
                    <span className={resignConfirm ? "resign-label" : undefined}>{resignConfirm ? "Confirm resignation" : "Resign"}</span>
                  </button>
                  <button
                    id="estimate-score"
                    className="button secondary"
                    disabled={resignConfirm || !!s.spectating || !playing || s.game_over || !!state.review || !!state.prompt || (!estimate && gameActionsBlocked)}
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
                  hidden={!state.prompt}
                >
                  <p id="action-title">{state.prompt?.title}</p>
                  <p id="action-description" hidden={!state.prompt?.description}>
                    {state.prompt?.description}
                  </p>
                  <div className="actions">
                    <button
                      id="action-cancel"
                      className="button secondary"
                      onClick={() => c.emit({ type: "prompt.close" })}
                    >
                      {state.prompt?.action ? "Cancel" : state.prompt?.label}
                    </button>
                    <button className="button"
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
                    <button className="button"
                      id="counting-accept"
                      disabled={s.pending || !!state.prompt}
                      onClick={() => c.command("confirm", { accept: true })}
                    >
                      Accept
                    </button>
                    <button
                      id="counting-reject"
                      className="button secondary"
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
                    {estimate?.phase === "error" ? formatError(estimate.error) : ""}
                  </p>
                  <p id="estimation-lead" hidden={estimate?.phase !== "result"}>
                    {estimate?.phase === "result"
                      ? estimate.lead === 0
                        ? "Estimated draw"
                        : `${estimate.lead > 0 ? "Black" : "White"} leads by ${Math.abs(estimate.lead)} points`
                      : ""}
                  </p>
                  <button className="button"
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
                  <p id="opponent-connection-status">
                    Opponent disconnected ({Math.floor(disconnectSeconds / 60)}:{String(disconnectSeconds % 60).padStart(2, "0")})
                  </p>
                </section>
                <section
                  id="game-state-panel"
                  className={s.spectating && !s.game_over && !replayLoading && s.phase !== "reconnecting" ? 'quest-panel spectator-actions' : 'quest-panel'}
                  hidden={gameHidden && !s.spectating && !state.error}
                >
                  <div id="game-state-heading" hidden={!showResult && !promptCounting && !replayLoading}>
                    <p id="game-state-title" className={recordError ? "is-error" : undefined} hidden={!showResult && !promptCounting && !replayLoading}>
                      {recordError
                        ? formatError(recordError)
                        : replayLoading
                        ? <span className="player-skeleton game-result-skeleton" />
                        : showResult
                        ? "Game over: "
                        : promptCounting
                          ? "Both players passed"
                          : ""}
                      <button className="text-button"
                        id="save-sgf"
                        type="button"
                        hidden={!showResult || !reviewing || replayLoading || !!recordError}
                        disabled={!!estimate || replayLoading}
                        onClick={() => c.save("sgf")}
                      >
                        <span id="game-result" className={resultClass}>{showResult && !replayLoading && !recordError ? result || "Unknown" : null}</span>
                        <span id="game-downloads" hidden={!showResult || !reviewing || replayLoading}>
                          <Icon icon={faDownload} standalone />
                        </span>
                      </button>
                    </p>
                  </div>
                  <div id="game-review" hidden={!reviewing && !replayLoading}>
                    <div className="actions">
                      {([
                        ["first", faBackwardStep, !variation && reviewMove === 0],
                        ["previous", faArrowLeft, reviewMove === 0],
                        ["next", faArrowRight, variation ? variation.cursor === variation.moves.length : reviewMove === s.moves],
                        ["last", faForwardStep, !variation && reviewMove === s.moves],
                      ] as const).map(([direction, icon, disabled]) => (
                        <button key={direction} id={`review-${direction}`} type="button"
                          className="button secondary"
                          disabled={disabled || !!estimate || s.phase === "joining"} onClick={() => c.review(direction)}>
                          <svg viewBox={`0 0 ${icon.icon[0]} ${icon.icon[1]}`}>
                            <path fill="currentColor" d={Array.isArray(icon.icon[4]) ? icon.icon[4].join(" ") : icon.icon[4]} />
                          </svg>
                        </button>
                      ))}
                    </div>
                  </div>
                  <p
                    id="board-status"
                    role={boardStatusError ? "alert" : undefined}
                    hidden={!state.error && (s.phase === "kicked" || s.game_over || promptCounting || !boardStatus || (s.spectating && s.phase === "joining"))}
                    className={
                      boardStatusError ? "is-error" : ""
                    }
                  >
                    {boardStatusError ? formatError(boardStatus) : boardStatus}
                  </p>
                  <p id="session-ended-status" hidden={s.phase !== "kicked"}>
                    {s.phase === "kicked" ? s.status : ""}
                  </p>
                </section>
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
          id="connection-menu"
        >
          <h2 id="menu-title">{loginStep ? "Foxwq-web" : "Matchmaking"}</h2>
          <p className="login-intro login-copy" hidden={!loginStep}>
            <a id="github-source" href="https://github.com/foxwq-web/foxwq-web.github.io" target="_blank" rel="noopener noreferrer">A web client</a> for {" "}
            the <a id="fox-server" href="https://foxwq.com/?lang=en" target="_blank" rel="noopener noreferrer">Fox go server</a>.
          </p>
          <p id="matchmaking-player" className="login-intro login-copy" hidden={loginStep}>
            Playing as <PlayerName controller={c} uid={loginStep ? undefined : c.session.uid}
              name={s.account?.name || state.form.username} rank={s.account?.rank}
              country={s.account?.country} />
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
                className="text-input"
                id="username"
                name="username"
                placeholder="Username"
                autoComplete="username"
                required
                disabled={loginPending}
                value={state.form.username}
                onInput={(e) =>
                  c.emit({ type: "form.username", value: e.currentTarget.value })
                }
              />
            </label>
            <label htmlFor="password">
              <input
                className="text-input"
                ref={passwordInput}
                id="password"
                name="password"
                placeholder="Password"
                type="password"
                autoComplete="current-password"
                required
                disabled={loginPending}
                defaultValue={c.password}
                onInput={(e) => c.editPassword(e.currentTarget.value)}
              />
            </label>
            <div className="login-options login-copy">
              <label className="remember">
                <input
                  id="remember"
                  name="remember"
                  type="checkbox"
                  checked={state.form.remember}
                  onChange={(e) => c.remember(e.currentTarget.checked)}
                />
                Remember me
              </label>
              <a href="https://account.foxwq.com/reg/foreign.html" target="_blank" rel="noopener noreferrer">Sign up</a>
            </div>
            <button className="button"
              id="login"
              type="submit"
              disabled={!state.form.username.trim() || state.form.passwordLength === 0 || loginPending}
            >
              {statusHidden || statusSeparate ? "Log in" : null}
              {loginStep && !statusSeparate && status}
            </button>
          </form>}
          {loginStep && statusSeparate && status}
          <div id="matchmaking" hidden={loginStep}>
            <TimeControls fields={s.matchFields} populations={s.fieldPlayers}
              selected={s.fieldId} searching={searching}
              disabled={!s.gatewayAvailable || !["ready", "finished", "matching"].includes(s.phase)}
              controller={c} />
          </div>
        </div>
      </div>
      {DevMenu && (
        <Suspense fallback={null}>
          <DevMenu controller={c} />
        </Suspense>
      )}
    </>
  );
}
