import { useEffect, useState, useSyncExternalStore } from 'preact/compat';
import { App } from './Application';
import { useRecordedGame } from './RecordedGame';
import type { Controller } from './controller';
import { recordedGameId } from './routes';

const subscribe = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
};

type InitializeController = () => Promise<Controller>;

function useLiveController(initializeController: InitializeController, enabled: boolean) {
  const [controller, setController] = useState<Controller | null>(null);
  const active = enabled || !!controller;
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let live: Controller | undefined;
    const hide = () => { live?.dispose(); };
    const flush = () => {
      if (document.visibilityState === 'hidden') void live?.session.networkLog.flush();
    };
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', flush);
    void initializeController().then(c => {
      if (disposed) { c.dispose(); return; }
      live = c;
      setController(c);
    });
    return () => {
      disposed = true;
      hide();
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [initializeController, active]);
  return controller;
}

export function AppRouter({ initializeController }: { initializeController: InitializeController }) {
  const path = useSyncExternalStore(subscribe, () => location.pathname);
  const id = recordedGameId(path);
  const live = useLiveController(initializeController, !id);
  const record = useRecordedGame(id, live?.preparedArchive);
  // Keep the current board mounted until the archive controller is ready.
  // Both sources render through the same App, so the handoff preserves its DOM.
  const controller = id ? record.controller ?? live : live;
  return controller ? <App controller={controller} recordError={id ? record.error || undefined : undefined} /> : null;
}
