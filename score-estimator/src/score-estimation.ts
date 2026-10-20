import type { Board } from "../../client/src/board.ts";
export interface EstimateResponse {
  ret: number;
  board_size?: number;
  judge_status?: string;
  black_penalty?: number;
  white_penalty?: number;
}
export type Estimator = (options: {
  payload: { status: string };
  signal: AbortSignal;
}) => Promise<EstimateResponse>;

export function decodeEstimate(
  response: EstimateResponse,
  board: Board,
  komi: number,
) {
  if (!response || !Number.isInteger(response.ret))
    throw Error("Invalid score-estimation response");
  if (response.ret !== 0)
    throw Error(`Score estimation failed (${response.ret}).`);
  if (
    response.board_size !== 19 ||
    typeof response.judge_status !== "string" ||
    !/^[012]{361}$/.test(response.judge_status)
  )
    throw Error("Invalid ownership map");
  const ownership = [...response.judge_status].map(Number);
  const blackPenalty = response.black_penalty ?? 0,
    whitePenalty = response.white_penalty ?? 0;
  if (![blackPenalty, whitePenalty].every(n => Number.isInteger(n) && n >= 0 && n <= 127))
    throw Error("Invalid estimator penalty");
  // Fox's estimate panel calls 00593da0 with Chinese area scoring disabled
  // (006f7e40). Count territory and prisoners, even in a Chinese-rules game.
  const points = [0, board.captures[1] - blackPenalty, board.captures[2] - whitePenalty];
  let neutral = 0;
  ownership.forEach((owner, p) => {
    const stone = board.stones[p];
    if (owner && owner !== stone) points[owner] += stone ? 2 : 1;
    else if (!owner && !stone) neutral++;
  });

  const black = points[1],
    white = points[2],
    lead = black - white - komi;
  return { ownership, black, white, komi, neutral, lead };
}
