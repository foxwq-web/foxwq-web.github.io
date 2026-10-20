export interface MoveTiming {
  remaining: number;
  periods?: number;
}
export interface GameTimeControl {
  main: number;
  periods: number;
  byoyomi: number;
}

export class Board {
  size: number;
  stones: number[];
  turn: number;
  captures: number[];
  history: number[][];
  moves: [number, number | null, number | null][];
  passes: number;
  moveTimings: (MoveTiming | null)[];
  timeControl: GameTimeControl | null;
  constructor(size = 19) {
    this.size = size;
    this.stones = Array(size * size).fill(0);
    this.turn = 1;
    this.captures = [0, 0, 0];
    this.history = [];
    this.moves = [];
    this.moveTimings = [];
    this.timeControl = null;
    this.passes = 0;
  }
  clone() {
    return Object.assign(new Board(this.size), structuredClone(this));
  }
  *neighbors(point: number) {
    const x = point % this.size,
      y = Math.floor(point / this.size);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        ny = y + dy;
      if (nx >= 0 && nx < this.size && ny >= 0 && ny < this.size)
        yield ny * this.size + nx;
    }
  }
  group(point: number, stones = this.stones) {
    const color = stones[point],
      members = new Set<number>(),
      liberties = new Set<number>(),
      pending = [point];
    while (pending.length) {
      const p = pending.pop()!;
      if (members.has(p)) continue;
      members.add(p);
      for (const n of this.neighbors(p)) {
        if (!stones[n]) liberties.add(n);
        else if (stones[n] === color && !members.has(n)) pending.push(n);
      }
    }
    return [members, liberties];
  }
  checkMove(x: number, y: number, color = this.turn) {
    if (
      ![1, 2].includes(color) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      x >= this.size ||
      y < 0 ||
      y >= this.size
    )
      throw Error("invalid move");
    const p = y * this.size + x;
    if (this.stones[p]) throw Error("intersection is occupied");
    const candidate = [...this.stones],
      removed = new Set<number>();
    candidate[p] = color;
    for (const n of this.neighbors(p))
      if (candidate[n] === 3 - color) {
        const [group, liberties] = this.group(n, candidate);
        if (!liberties.size)
          for (const q of group) {
            removed.add(q);
            candidate[q] = 0;
          }
      }
    if (!this.group(p, candidate)[1].size)
      throw Error("suicide is not allowed");
    if (
      this.history.length &&
      candidate.every((v, i) => v === this.history.at(-1)![i])
    )
      throw Error("ko: this position cannot be immediately repeated");
    return { stones: candidate, captures: removed.size };
  }
  play(x: number, y: number, color = this.turn) {
    const candidate = this.checkMove(x, y, color);
    this.history.push([...this.stones]);
    this.stones = candidate.stones;
    this.captures[color] += candidate.captures;
    this.turn = 3 - color;
    this.passes = 0;
    this.moves.push([color, x, y]);
    this.moveTimings.push(null);
    return candidate.captures;
  }
  passTurn(color = this.turn) {
    if (![1, 2].includes(color)) throw Error("invalid color");
    this.history.push([...this.stones]);
    this.moves.push([color, null, null]);
    this.moveTimings.push(null);
    this.turn = 3 - color;
    this.passes++;
  }
  sgf(result = "", black = "Black", white = "White", komi = 7.5) {
    const escape = (s: string) =>
      String(s).replaceAll("\\", "\\\\").replaceAll("]", "\\]");
    let text = `(;GM[1]FF[4]CA[UTF-8]SZ[${this.size}]KM[${komi}]PB[${escape(black)}]PW[${escape(white)}]`;
    if (this.timeControl) {
      const { main, periods, byoyomi } = this.timeControl;
      text += `TM[${main}]`;
      if (periods > 0 && byoyomi > 0) text += `OT[${periods}x${byoyomi} byo-yomi]`;
    }
    if (result) text += `RE[${escape(result)}]`;
    for (const [index, [color, x, y]] of this.moves.entries()) {
      const name = color === 1 ? "B" : "W";
      text += `;${name}[${x === null ? "" : String.fromCharCode(97 + x, 97 + y!)}]`;
      const timing = this.moveTimings[index];
      if (timing) {
        text += `${name}L[${Number(timing.remaining.toFixed(3))}]`;
        if (timing.periods !== undefined) text += `O${name}[${timing.periods}]`;
      }
    }
    return text + ")\n";
  }
}
