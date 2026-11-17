// Fox timestamps are Unix seconds; display dates in the viewer's local timezone.
export function formatDateTime(seconds?: number): string {
  if (!Number.isSafeInteger(seconds) || !seconds || seconds < 0) return '—';
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
