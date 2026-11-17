export interface ArchivePosition {
  move: number;
  variation?: { origin: number; moves: [number | null, number | null][] };
}

// URLs use `move` as the main-line origin and `variation` as the displayed
// branch in SGF coordinates. Internally, `move` is the displayed move number.
export function readArchivePosition(search: string, total: number): ArchivePosition | null {
  const params = new URLSearchParams(search);
  const value = params.get('move');
  if (value !== null && !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const move = value === null ? total : Number(value);
  if (!Number.isSafeInteger(move)) return null;
  const branch = params.get('variation');
  if (branch === null) return { move: Math.min(move, total) };
  // Continue accepting links shared with the previous origin.coordinates format.
  const legacy = /^(0|[1-9][0-9]*)\.((?:[a-s]{2}|--)+)$/.exec(branch);
  const coordinates = legacy ? legacy[2] : branch;
  const match = /^(?:[a-s]{2}|--)+$/.test(coordinates);
  if (!match) return null;
  const origin = legacy ? Number(legacy[1]) : move;
  if (!legacy && value === null) return null;
  const moves: [number | null, number | null][] = [];
  for (let i = 0; i < coordinates.length; i += 2) {
    const point = coordinates.slice(i, i + 2);
    moves.push(point === '--' ? [null, null] : [point.charCodeAt(0) - 97, point.charCodeAt(1) - 97]);
  }
  const cursor = !legacy || value === null ? moves.length : move - origin;
  if (!Number.isSafeInteger(origin) || origin > total || cursor < 1 || cursor > moves.length) return null;
  return { move: origin + cursor, variation: { origin, moves } };
}

export function archivePositionUrl(href: string, position: ArchivePosition, total?: number): string {
  const url = new URL(href);
  if (!position.variation && position.move === total) url.searchParams.delete('move');
  else url.searchParams.set('move', String(position.variation?.origin ?? position.move));
  if (position.variation) {
    const { origin, moves } = position.variation;
    const coordinates = moves.slice(0, position.move - origin).map(([x, y]) => x === null || y === null ? '--' : String.fromCharCode(97 + x, 97 + y)).join('');
    url.searchParams.set('variation', coordinates);
  } else url.searchParams.delete('variation');
  return url.pathname + url.search + url.hash;
}
