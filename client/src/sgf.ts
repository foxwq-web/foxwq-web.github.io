import { Board } from './board';

type Node = Record<string, string[]>;

// SGF FF[4] trees, property lists and escaping: https://www.red-bean.com/sgf/sgf4.html
// Read the first variation as the recorded game's main line.
function mainLine(source: string): Node[] {
  let cursor = 0;
  const whitespace = () => {
    while (cursor < source.length) {
      if (/\s/.test(source[cursor])) cursor++;
      // Some Fox archive records use literal \\r\\n between SGF tokens.
      // Handle these here so escapes inside property values stay unchanged.
      else if (source.startsWith('\\r\\n', cursor)) cursor += 4;
      else break;
    }
  };
  const expect = (character: string) => {
    whitespace();
    if (source[cursor++] !== character) throw Error('invalid sgf record');
  };
  const nodes: Node[] = [];
  // Fox analysis records can nest a tree for every move. Track trees explicitly
  // so valid long games do not depend on a depth limit or the JS call stack.
  const stack: { main: boolean; hasNodes: boolean; hasChildren: boolean }[] = [];
  expect('(');
  stack.push({ main: true, hasNodes: false, hasChildren: false });
  while (stack.length) {
    whitespace();
    const frame = stack[stack.length - 1];
    if (source[cursor] === ';') {
      if (frame.hasChildren) throw Error('invalid sgf record');
      cursor++;
      const node: Node = Object.create(null);
      whitespace();
      while (/[A-Za-z]/.test(source[cursor] ?? '') && cursor < source.length) {
        let key = '';
        while (/[A-Za-z]/.test(source[cursor] ?? '') && cursor < source.length) key += source[cursor++];
        key = key.replace(/[a-z]/g, '');
        const values: string[] = [];
        whitespace();
        while (source[cursor] === '[') {
          cursor++;
          let value = '';
          while (cursor < source.length && source[cursor] !== ']') {
            let character = source[cursor++];
            if (character === '\\') {
              if (cursor >= source.length) throw Error('invalid sgf record');
              character = source[cursor++];
              if (character === '\r' || character === '\n') {
                if ((character === '\r' && source[cursor] === '\n') || (character === '\n' && source[cursor] === '\r')) cursor++;
                continue;
              }
            }
            value += character;
          }
          expect(']');
          values.push(value);
          whitespace();
        }
        if (!values.length) throw Error('invalid sgf record');
        node[key] = [...(node[key] ?? []), ...values];
      }
      if (frame.main) nodes.push(node);
      frame.hasNodes = true;
    } else if (source[cursor] === '(') {
      if (!frame.hasNodes) throw Error('invalid sgf record');
      cursor++;
      stack.push({ main: frame.main && !frame.hasChildren, hasNodes: false, hasChildren: false });
      frame.hasChildren = true;
    } else if (source[cursor] === ')') {
      if (!frame.hasNodes) throw Error('invalid sgf record');
      cursor++;
      stack.pop();
    } else {
      throw Error('invalid sgf record');
    }
  }
  whitespace();
  if (cursor !== source.length) throw Error('invalid sgf record');
  return nodes;
}

export function parseSgf(source: string) {
  const nodes = mainLine(source), root = nodes[0];
  if ((root.GM?.[0] ?? '1') !== '1') throw Error('non-standard rules');
  const [width, height = width] = (root.SZ?.[0] ?? '19').split(':');
  if (width !== '19' || height !== '19') throw Error(`${width}x${height} game`);
  // Fox's RL is its additional-rule setting. Gold/clock options keep the
  // ordinary Go rules; capture games, Fly Cutter and other variants do not.
  const additional = Number(root.RL?.[0] ?? 0);
  const rules = root.RU?.[0] ?? 'Chinese';
  if (![0, 1, 5].includes(additional) ||
      !/^(Chinese|Japanese|Korean|AGA|NZ|New Zealand|Tromp[- ]Taylor|Ing)(?:[ :_-]+[0-9.]+)?$/i.test(rules))
    throw Error('non-standard rules');
  const board = new Board();
  const point = (value: string) => {
    if (!/^[a-s]{2}$/.test(value)) throw Error('invalid sgf coordinates');
    return [value.charCodeAt(0) - 97, value.charCodeAt(1) - 97] as const;
  };
  // Fox may put handicap stones in separate nodes before the first move.
  const firstMove = nodes.findIndex(node => node.B || node.W);
  const setupEnd = firstMove < 0 ? nodes.length : Math.max(1, firstMove);
  board.turn = Number(root.HA?.[0]) > 1 ? 2 : 1;
  for (const node of nodes.slice(0, setupEnd)) {
    for (const [property, color] of [['AB', 1], ['AW', 2], ['AE', 0]] as const) {
      for (const value of node[property] ?? []) {
        const [from, to = from] = value.split(':');
        const [x1, y1] = point(from), [x2, y2] = point(to);
        if (x2 < x1 || y2 < y1) throw Error('invalid sgf setup');
        for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) board.stones[y * board.size + x] = color;
      }
    }
    if (node.PL) board.turn = node.PL[0] === 'W' ? 2 : 1;
  }
  const overtime = /^(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*byo-yomi/i.exec(root.OT?.[0] ?? '');
  if (root.TM) board.timeControl = {
    main: Math.max(0, Number(root.TM[0]) || 0),
    periods: Number(overtime?.[1] ?? root.TC?.[0]) || 0,
    byoyomi: Number(overtime?.[2] ?? root.TT?.[0]) || 0,
  };
  const date = Date.parse(root.DT?.[0] ?? '');
  if (Number.isFinite(date)) board.startedAt = date / 1000;
  const initialBoard = board.clone();
  for (const [index, node] of nodes.entries()) {
    if (index >= setupEnd && (node.AB || node.AW || node.AE || node.PL)) throw Error('this record contains unsupported changes to the board setup');
    if (node.B && node.W) throw Error('invalid sgf move');
    const color = node.B ? 1 : node.W ? 2 : 0;
    if (!color) continue;
    const name = color === 1 ? 'B' : 'W', move = node[name][0];
    if (move === '' || move === 'tt') board.passTurn(color);
    else board.play(...point(move), color);
    const remaining = Number(node[`${name}L`]?.[0]);
    if (Number.isFinite(remaining) && remaining >= 0) {
      const periods = Number(node[`O${name}`]?.[0]);
      board.moveTimings[board.moves.length - 1] = { remaining,
        ...(Number.isInteger(periods) && periods >= 0 ? { periods } : {}) };
    }
  }
  const rank = (value = '') => value.replace(/^P([1-9])段$/, '$1p').replace(/段$/, 'd').replace(/级$/, 'k');
  let komi = Number(root.KM?.[0] ?? 0);
  // Fox exports Chinese komi in hundredths of a stone (375 = 7.5 points).
  if (root.AP?.some(value => /^foxwq\b/i.test(value)) && Math.abs(komi) >= 100)
    komi /= /japanese|korean/i.test(root.RU?.[0] ?? '') ? 100 : 50;
  return { board, initialBoard, komi: Number.isFinite(komi) ? komi : 0,
    result: root.RE?.[0] ?? '',
    players: { 1: { name: root.PB?.[0] || 'Black', rank: rank(root.BR?.[0]) },
      2: { name: root.PW?.[0] || 'White', rank: rank(root.WR?.[0]) } } };
}

export async function fetchGameSgf(id: string, signal?: AbortSignal): Promise<string> {
  if (!/^\d+$/.test(id)) throw Error('invalid game record id');
  const response = await fetch(`https://h5.foxwq.com/yehuDiamond/chessbook_local/YHWQFetchChess?chessid=${encodeURIComponent(id)}`,
    { referrerPolicy: 'no-referrer', signal });
  if (!response.ok) throw Error('could not load game record');
  const record = await response.json();
  if (record?.result !== 0 || typeof record.chess !== 'string') throw Error('the game record is unavailable');
  return record.chess;
}
