import React, { type PointerEvent, type MouseEvent } from "react";
import { Board } from "./board.ts";
import { clockReading } from "./clock.ts";
import { blocked, boardAvailable, type UIState } from "./state";
const extent = 840,
  margin = 48,
  size = 19;
const step = (extent - 2 * margin) / (size - 1),
  radius = step / 2;
const edgePadding = step * 0.025;
const inset = margin - radius - edgePadding,
  width = extent - 2 * inset;
const location = (p: number) => ({
  cx: margin + (p % size) * step,
  cy: margin + Math.floor(p / size) * step,
});
export function pointAt(
  event: MouseEvent<SVGSVGElement> | PointerEvent<SVGSVGElement>,
): number | null {
  const rect = event.currentTarget.getBoundingClientRect();
  if (
    !rect.width ||
    !rect.height ||
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    return null;
  const px = inset + ((event.clientX - rect.left) * width) / rect.width;
  const py = inset + ((event.clientY - rect.top) * width) / rect.height;
  const x = Math.round((px - margin) / step),
    y = Math.round((py - margin) / step);
  if (x < 0 || x >= size || y < 0 || y >= size) return null;
  return (px - margin - x * step) ** 2 + (py - margin - y * step) ** 2 <=
    radius ** 2
    ? y * size + x
    : null;
}
export function playablePoint(
  state: UIState,
  point: number | null,
): number | null {
  const s = state.session;
  if (
    point === null ||
    !boardAvailable(s) ||
    blocked(s) ||
    !!state.prompt ||
    s.color !== s.turn ||
    !s.gameId
  )
    return null;
  const board = new Board();
  board.stones = s.stones;
  board.turn = s.turn;
  board.history = s.koStones ? [s.koStones] : [];
  try {
    board.checkMove(point % size, Math.floor(point / size));
    return point;
  } catch {
    return null;
  }
}
function Stone({
  point,
  color,
}: {
  point: number;
  color: number;
}) {
  const { cx, cy } = location(point),
    name = color === 1 ? "black" : "white";
  const glowX = cx - radius * 0.2,
    glowY = cy - radius * 0.24;
  return (
    <g
      className={`stone stone-${name}`}
      filter="url(#stone-shadow)"
    >
      <circle cx={cx} cy={cy} r={radius} fill={`url(#${name}-stone)`} />
      {color !== 1 && (
        <ellipse
          cx={glowX}
          cy={glowY}
          rx={radius * 0.66}
          ry={radius * 0.48}
          transform={`rotate(-45 ${glowX} ${glowY})`}
          fill="url(#white-stone-glow)"
        />
      )}
    </g>
  );
}
export function BoardView({
  state,
  hover,
  play,
}: {
  state: UIState;
  hover: (p: number | null) => void;
  play: (p: number) => void;
}) {
  const s = state.session,
    ownership =
      s.estimation?.phase === "result" ? s.estimation.ownership : null;
  const preview = playablePoint(state, state.preview);
  const last = s.last_move;
  const marker =
    last && last[1] !== null && last[2] !== null
      ? location(last[2] * size + last[1])
      : null;
  const clock = s.clocks[s.turn];
  const reading = clock && clockReading(
    clock,
    state.frozen ? 0 : Math.max(0, state.now - clock.at),
    60,
    s.turn === s.color,
  );
  const countdown =
    s.phase === "playing" && !state.review && !s.pending && !s.counting &&
    !s.confirmation && !(s.turn !== s.color && s.opponentDisconnectDeadline != null) &&
    reading?.overtime && reading.periods > 0 &&
    reading.seconds >= 1 && reading.seconds <= 9
      ? reading.seconds
      : null;
  return (
    <svg
      id="board"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${inset} ${inset} ${width} ${width}`}
      tabIndex={-1}
      style={{ cursor: "default" }}
      onPointerMove={(e) => hover(playablePoint(state, pointAt(e)))}
      onPointerLeave={() => hover(null)}
      onPointerCancel={() => hover(null)}
      onClick={(e) => {
        const point = pointAt(e);
        const p = playablePoint(state, point);
        if (p !== null) play(p);
      }}
    >
      <defs>
        <radialGradient id="black-stone" cx="50%" cy="50%" r="50%">
          {[
            [0, "#090909"],
            [0.55, "#050505"],
            [0.9, "#010101"],
            [1, "#000000"],
          ].map(([offset, color]) => (
            <stop key={offset} offset={offset} stopColor={String(color)} />
          ))}
        </radialGradient>
        <radialGradient id="white-stone" cx="32%" cy="26%" r="78%">
          {[
            [0, "#ffffff"],
            [0.35, "#fffefd"],
            [0.65, "#f9f7f1"],
            [0.85, "#efeae1"],
            [1, "#ded6c8"],
          ].map(([offset, color]) => (
            <stop key={offset} offset={offset} stopColor={String(color)} />
          ))}
        </radialGradient>
        <radialGradient id="white-stone-glow" cx="50%" cy="50%" r="50%">
          {[
            [0, 0.45],
            [0.35, 0.325],
            [0.7, 0.1],
            [1, 0],
          ].map(([offset, opacity]) => (
            <stop
              key={offset}
              offset={offset}
              stopColor="#fff"
              stopOpacity={opacity}
            />
          ))}
        </radialGradient>
        <filter id="stone-shadow" x="-25%" y="-25%" width="150%" height="160%">
          <feDropShadow
            dx={1}
            dy={1.6}
            stdDeviation={1.1}
            floodColor="#21190c"
            floodOpacity={0.38}
          />
        </filter>
      </defs>
      <rect
        className="board-surface"
        x={inset}
        y={inset}
        width={width}
        height={width}
        fill="#d6b77d"
      />
      <g stroke="#000" strokeWidth={1}>
        {Array.from({ length: size }, (_, i) => {
          const p = margin + i * step;
          return (
            <path
              key={i}
              vectorEffect="non-scaling-stroke"
              d={`M ${margin} ${p} H ${extent - margin} M ${p} ${margin} V ${extent - margin}`}
            />
          );
        })}
      </g>
      <g fill="#000">
        {[3, 9, 15].flatMap((y) =>
          [3, 9, 15].map((x) => (
            <circle key={`${x}:${y}`} {...location(y * size + x)} r={4} />
          )),
        )}
      </g>
      <g className="board-stones" pointerEvents="none">
        {s.stones.map((color, p) =>
          color ? (
            <Stone
              key={p}
              point={p}
              color={color}
            />
          ) : null,
        )}
      </g>
      <g pointerEvents="none">
        {marker && (countdown !== null ? (
          <text
            className="byoyomi-countdown"
            x={marker.cx}
            y={marker.cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="Arial, sans-serif"
            fontSize={24}
            fontWeight="bold"
            fill={last?.[0] === 1 ? "#fff" : "#000"}
          >
            {countdown}
          </text>
        ) : (
          <polygon
            points={`${marker.cx},${marker.cy} ${marker.cx},${marker.cy + radius} ${marker.cx + radius},${marker.cy}`}
            fill={last?.[0] === 1 ? "#fff" : "#000"}
          />
        ))}
      </g>
      <g
        className="estimated-territory"
        pointerEvents="none"
      >
        {ownership?.map((color, p) => {
          // Keep the overlay fixed even as incoming moves change the live stones.
          if (!color || (s.estimation?.phase === "result" && s.estimation.stones[p] === color))
            return null;
          const side = step * 0.28,
            { cx, cy } = location(p);
          return (
            <rect
              key={p}
              className={`territory-${color === 1 ? "black" : "white"}`}
              x={cx - side / 2}
              y={cy - side / 2}
              width={side}
              height={side}
              fill={color === 1 ? "#111" : "#fff"}
              stroke={color === 1 ? "#fff" : "#111"}
              strokeWidth={0.7}
            />
          );
        })}
      </g>
      <g className="stone-preview" opacity={0.4} pointerEvents="none">
        {preview !== null && <Stone point={preview} color={s.turn} />}
      </g>
    </svg>
  );
}
