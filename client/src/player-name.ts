// Fox supplies localized and international names in different protocol fields.
// Prefer Chinese, Japanese, or Korean names, retaining the supplied order otherwise.
export function playerName(...names: (string | undefined)[]): string {
  const available = names.map(name => name?.trim() ?? '').filter(Boolean);
  return available.find(name => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(name)) || available[0] || '';
}
