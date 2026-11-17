import { useEffect, useState } from 'preact/compat';
import { Controller } from './controller';
import { logError } from './error-message';
import { fetchGameSgf } from './sgf';

export function useRecordedGame(id?: string, prepared?: Controller) {
  const ready = id && prepared?.recordedGame?.id === id ? prepared : undefined;
  const [controller, setController] = useState<Controller | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    if (ready) return; // The live controller retains ownership of its session.
    const abort = new AbortController();
    const c = new Controller();
    const params = new URLSearchParams(location.search);
    const hasPosition = params.has('move') || params.has('variation');
    setError('');
    void (async () => {
      try {
        await c.initialize({ id, loading: true });
        if (abort.signal.aborted) return;
        const snapshot = history.state?.archive;
        if (snapshot?.id === id && typeof snapshot.sgf === 'string') {
          await c.initialize({ id, sgf: snapshot.sgf });
          if (!abort.signal.aborted) setController(c);
          return;
        }
        setController(c);
        let preview;
        let previewSgf: string | undefined;
        if (import.meta.env.DEV) {
          const { DEV_SCREENS } = await import('./dev-screens');
          preview = DEV_SCREENS.find(fixture => fixture.id === new URLSearchParams(location.search).get('dev-screen'))?.record;
          if (preview === 'small-board') previewSgf = '(;GM[1]SZ[13]RU[Chinese])';
          if (preview === 'variant') previewSgf = '(;GM[1]SZ[19]RU[Chinese]RL[3])';
          if (preview === 'ready' || preview === 'variation') previewSgf = (await import('../tests/fixtures/fox-history.sgf?raw')).default;
        }
        if (preview === 'loading') return;
        if (preview === 'error') throw Error('could not load game record');
        const sgf = previewSgf ?? await fetchGameSgf(id, abort.signal);
        if (abort.signal.aborted) return;
        await c.initialize({ id, sgf });
        if (preview === 'variation' && !hasPosition) {
          c.review('previous');
          c.playVariation(9, 9);
          c.playVariation(10, 9);
        }
        if (!abort.signal.aborted) setController(c);
      } catch (error) {
        if (!abort.signal.aborted) {
          const message = error instanceof Error ? error.message : 'could not load game record';
          logError(message);
          setController(c);
          setError(message);
        }
      }
    })();
    return () => { abort.abort(); c.dispose(); };
  }, [id, ready]);
  return { controller: ready ?? (controller?.recordedGame?.id === id ? controller : null), error: ready ? '' : error };
}
