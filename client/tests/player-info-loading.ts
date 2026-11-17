import type { Page } from 'playwright';

// Hold the popup's two independent responses after opening an offline profile.
export async function delayPlayerInfo(page: Page) {
  await page.evaluate(`(async () => {
    const source = await (await fetch('/src/session.ts')).text();
    const path = source.match(/from ["']([^"']*player-info[.]ts[^"']*)["']/)[1];
    const { PlayerInfoStore } = await import(path);
    const open = PlayerInfoStore.prototype.open;
    PlayerInfoStore.prototype.open = function (...args) {
      open.apply(this, args);
      if (window.pendingPlayerInfo?.info === this.current) return;
      const info = this.current, loaded = { ...info };
      window.pendingPlayerInfo = { info, loaded, store: this };
      Object.assign(info, { summaryLoading: true, loading: true, games: [], wins: undefined,
        recent: '', promotion: undefined, demotion: undefined, doublePromotion: undefined, doubleDemotion: undefined });
      this.changed();
    };
    window.resolvePlayerInfo = stage => {
      const { info, loaded, store } = window.pendingPlayerInfo;
      if (stage === 'summary') Object.assign(info, { ...loaded, games: [], loading: true });
      else if (stage === 'error') Object.assign(info, { summaryLoading: false, loading: false,
        summaryError: 'Could not load player details.', error: 'Could not load recent games.' });
      else Object.assign(info, loaded);
      store.changed();
    };
  })()`);
}
