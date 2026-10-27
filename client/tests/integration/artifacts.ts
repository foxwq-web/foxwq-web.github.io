import { isDeepStrictEqual } from 'node:util';
import { access, readFile, writeFile, rm } from 'node:fs/promises';

export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };
export function artifacts(path: string) {
  const stem = path.replace(/(?:\.network)?\.json$/, '');
  return { golden: `${stem}.golden.json`, actual: `${stem}.actual.json` };
}

export async function checkGolden(path: string, value: unknown, { update = false, ci = false } = {}) {
  const { golden, actual } = artifacts(path), missing = !await exists(golden);
  if (ci && missing) throw Error(`Missing golden: ${golden}. Record it locally and commit it.`);
  const snapshot = JSON.parse(json(value));
  if (!update && !missing && !isDeepStrictEqual(JSON.parse(await readFile(golden, 'utf8')), snapshot)) {
    await writeFile(actual, json(snapshot));
    throw Error(`UI differs from ${golden}. Actual state: ${actual}. Review with: diff -u ${golden} ${actual}`);
  }
  if (update || missing) await writeFile(golden, json(snapshot));
  await rm(actual, { force: true });
  return missing ? 'RECORDED' : update ? 'UPDATED' : 'PASS';
}
