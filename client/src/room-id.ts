export type RoomKey = Record<number, number>;

export const PC_LOBBY = 20010;

export function roomId(key: RoomKey) { return [1, 2, 3, 4].map(tag => key[tag]).join(':'); }

export function parseRoomId(id: string): RoomKey | null {
  if (!/^\d+:\d+:\d+:\d+$/.test(id)) return null;
  const values = id.split(':').map(Number);
  if (!values.every(Number.isSafeInteger) || !values[0] || !values[2]) return null;
  return Object.fromEntries(values.map((value, i) => [i + 1, value]));
}
