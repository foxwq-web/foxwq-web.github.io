"""Board display and legal-move checks. Online positions remain server-authoritative."""
from dataclasses import dataclass, field


@dataclass
class Board:
    size: int = 19
    stones: list = field(default_factory=lambda: [0] * 361)
    turn: int = 1
    captures: list = field(default_factory=lambda: [0, 0, 0])
    history: list = field(default_factory=list)
    moves: list = field(default_factory=list)
    passes: int = 0

    def neighbors(self, point):
        x, y = point % self.size, point // self.size
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < self.size and 0 <= ny < self.size:
                yield ny * self.size + nx

    def group(self, point, stones=None):
        stones = self.stones if stones is None else stones
        color = stones[point]
        members, liberties, pending = set(), set(), [point]
        while pending:
            p = pending.pop()
            if p in members:
                continue
            members.add(p)
            for n in self.neighbors(p):
                if stones[n] == 0:
                    liberties.add(n)
                elif stones[n] == color and n not in members:
                    pending.append(n)
        return members, liberties

    def play(self, x, y, color=None, authoritative=False):
        color = self.turn if color is None else color
        if color not in (1, 2) or not 0 <= x < self.size or not 0 <= y < self.size:
            raise ValueError('invalid move')
        p = y * self.size + x
        if self.stones[p]:
            raise ValueError('intersection is occupied')
        candidate = self.stones.copy()
        candidate[p] = color
        removed = set()
        for n in self.neighbors(p):
            if candidate[n] == 3 - color:
                group, liberties = self.group(n, candidate)
                if not liberties:
                    removed.update(group)
                    for q in group:
                        candidate[q] = 0
        group, liberties = self.group(p, candidate)
        if not liberties:
            raise ValueError('suicide is not allowed')
        if not authoritative and self.history and candidate == self.history[-1]:
            raise ValueError('ko: this position cannot be immediately repeated')
        self.history.append(self.stones.copy())
        self.stones = candidate
        self.captures[color] += len(removed)
        self.turn = 3 - color
        self.passes = 0
        self.moves.append((color, x, y))

    def pass_turn(self, color=None):
        color = self.turn if color is None else color
        self.history.append(self.stones.copy())
        self.moves.append((color, None, None))
        self.turn = 3 - color
        self.passes += 1

    def area_score(self, komi=7.5, dead=()):
        stones = self.stones.copy()
        for p in dead:
            stones[p] = 0
        score = [0, 0, komi]
        seen = set()
        for p, stone in enumerate(stones):
            if stone:
                score[stone] += 1
            elif p not in seen:
                region, border, pending = set(), set(), [p]
                while pending:
                    q = pending.pop()
                    if q in region:
                        continue
                    region.add(q)
                    for n in self.neighbors(q):
                        if stones[n]:
                            border.add(stones[n])
                        elif n not in region:
                            pending.append(n)
                seen.update(region)
                if len(border) == 1:
                    score[next(iter(border))] += len(region)
        return score[1:]

    def sgf(self, result='', black='Black', white='White', komi=7.5):
        def escape(s):
            return str(s).replace('\\', '\\\\').replace(']', '\\]')
        text = f'(;GM[1]FF[4]CA[UTF-8]SZ[{self.size}]KM[{komi}]PB[{escape(black)}]PW[{escape(white)}]'
        if result:
            text += f'RE[{escape(result)}]'
        for color, x, y in self.moves:
            coord = '' if x is None else chr(97 + x) + chr(97 + y)
            text += f';{"B" if color == 1 else "W"}[{coord}]'
        return text + ')\n'
