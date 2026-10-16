export class Board {
  constructor(size = 19) {
    this.size = size; this.stones = Array(size * size).fill(0); this.turn = 1;
    this.captures = [0, 0, 0]; this.history = []; this.moves = []; this.passes = 0;
  }
  clone() { return Object.assign(new Board(this.size), structuredClone(this)); }
  *neighbors(point) {
    const x = point % this.size, y = Math.floor(point / this.size);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < this.size && ny >= 0 && ny < this.size) yield ny * this.size + nx;
    }
  }
  group(point, stones = this.stones) {
    const color = stones[point], members = new Set(), liberties = new Set(), pending = [point];
    while (pending.length) {
      const p = pending.pop();
      if (members.has(p)) continue;
      members.add(p);
      for (const n of this.neighbors(p)) {
        if (!stones[n]) liberties.add(n);
        else if (stones[n] === color && !members.has(n)) pending.push(n);
      }
    }
    return [members, liberties];
  }
  play(x, y, color = this.turn, authoritative = false) {
    if (![1, 2].includes(color) || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= this.size || y < 0 || y >= this.size) throw Error('invalid move');
    const p = y * this.size + x;
    if (this.stones[p]) throw Error('intersection is occupied');
    const candidate = [...this.stones], removed = new Set(); candidate[p] = color;
    for (const n of this.neighbors(p)) if (candidate[n] === 3 - color) {
      const [group, liberties] = this.group(n, candidate);
      if (!liberties.size) for (const q of group) { removed.add(q); candidate[q] = 0; }
    }
    if (!this.group(p, candidate)[1].size) throw Error('suicide is not allowed');
    if (!authoritative && this.history.length && candidate.every((v, i) => v === this.history.at(-1)[i])) throw Error('ko: this position cannot be immediately repeated');
    this.history.push([...this.stones]); this.stones = candidate; this.captures[color] += removed.size;
    this.turn = 3 - color; this.passes = 0; this.moves.push([color, x, y]);
  }
  passTurn(color = this.turn) {
    if (![1, 2].includes(color)) throw Error('invalid color');
    this.history.push([...this.stones]); this.moves.push([color, null, null]); this.turn = 3 - color; this.passes++;
  }
  areaScore(komi = 7.5, dead = []) {
    const stones = [...this.stones], score = [0, 0, komi], seen = new Set();
    for (const p of dead) stones[p] = 0;
    stones.forEach((stone, p) => {
      if (stone) score[stone]++;
      else if (!seen.has(p)) {
        const region = new Set(), border = new Set(), pending = [p];
        while (pending.length) {
          const q = pending.pop(); if (region.has(q)) continue; region.add(q);
          for (const n of this.neighbors(q)) {
            if (stones[n]) border.add(stones[n]); else if (!region.has(n)) pending.push(n);
          }
        }
        for (const q of region) seen.add(q);
        if (border.size === 1) score[[...border][0]] += region.size;
      }
    });
    return score.slice(1);
  }
  sgf(result = '', black = 'Black', white = 'White', komi = 7.5) {
    const escape = s => String(s).replaceAll('\\', '\\\\').replaceAll(']', '\\]');
    let text = `(;GM[1]FF[4]CA[UTF-8]SZ[${this.size}]KM[${komi}]PB[${escape(black)}]PW[${escape(white)}]`;
    if (result) text += `RE[${escape(result)}]`;
    for (const [color, x, y] of this.moves) text += `;${color === 1 ? 'B' : 'W'}[${x === null ? '' : String.fromCharCode(97 + x, 97 + y)}]`;
    return text + ')\n';
  }
}
