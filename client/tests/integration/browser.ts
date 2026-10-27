import type { Page } from 'playwright';
import type { Action } from './log.ts';

export interface ReplayOptions { channels: { id: string; address: string }[] }
export interface SentPacket { connection: string; payload: string }
interface ReplayBrowser {
  ticks: number;
  sent: SentPacket[];
  errors: string[];
  deliver(connection: string, payload: string): void;
  captureHeartbeat(): void;
  fireHeartbeat(): void;
}
declare global { interface Window { __networkReplay: ReplayBrowser } }

// Only external I/O and browser scheduling boundaries are replaced. No
// Controller, Session or React state is exposed; actions use DOM controls.
export function installReplay({ channels }: ReplayOptions) {
  const sockets = new Map<string, ReplaySocket>();
  // Recorded tabs may throttle timers for minutes. Keep the real heartbeat
  // callback, but dispatch it at recorded sends instead of inventing idle sends.
  const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let heartbeat: (() => void) | undefined, heartbeatId: number | undefined, firingHeartbeat = false;
  window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
    const callback = () => { if (typeof handler === 'function') handler(...args); else throw Error('String timer in replay'); };
    if (firingHeartbeat && delay === 5000) {
      heartbeat = callback; heartbeatId = nativeTimeout(() => {}, 2 ** 30); return heartbeatId;
    }
    const id = nativeTimeout(() => { timers.delete(id); callback(); }, delay);
    timers.set(id, { callback, delay });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined) timers.delete(id);
    if (id === heartbeatId) { heartbeat = undefined; heartbeatId = undefined; }
    nativeClear(id);
  }) as typeof window.clearTimeout;
  const encode = (bytes: Uint8Array) => {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  };
  const replay: ReplayBrowser = window.__networkReplay = {
    ticks: 0, sent: [], errors: [],
    captureHeartbeat() {
      const candidates = [...timers].filter(([, timer]) => timer.delay === 5000);
      if (candidates.length !== 1) throw Error(`Expected one scheduled heartbeat, got ${candidates.length}`);
      const [id, timer] = candidates[0];
      nativeClear(id); timers.delete(id); heartbeat = timer.callback; heartbeatId = id;
    },
    fireHeartbeat() {
      if (!heartbeat) throw Error('No production heartbeat timer is scheduled');
      const callback = heartbeat; nativeClear(heartbeatId); heartbeat = undefined; heartbeatId = undefined; firingHeartbeat = true;
      try { callback(); } finally { firingHeartbeat = false; }
    },
    deliver(id, payload) {
      const socket = sockets.get(id);
      if (!socket || socket.readyState !== 1) throw Error(`Replay connection ${id} is not open.`);
      const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
      socket.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }));
    },
  };
  Object.defineProperty(performance, 'now', { value: () => replay.ticks });
  Object.defineProperty(crypto, 'getRandomValues', { value: (array: Uint8Array) => { array.fill(0); return array; } });
  class ReplaySocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    binaryType = 'arraybuffer';
    id: string;
    constructor(url: string | URL) {
      super();
      const target = new URL(url);
      const address = `${target.searchParams.get('host')}:${target.searchParams.get('port')}`;
      const channel = channels.find(channel => channel.address === address && !sockets.has(channel.id));
      if (!channel) {
        const error = `Unexpected WebSocket destination ${address}`;
        replay.errors.push(error); throw Error(error);
      }
      this.id = channel.id;
      sockets.set(this.id, this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); } });
    }
    send(data: ArrayBuffer | ArrayBufferView) {
      if (this.readyState !== 1) throw Error('WebSocket is closed');
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      replay.sent.push({ connection: this.id, payload: encode(bytes) });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
    }
  }
  window.WebSocket = ReplaySocket as unknown as typeof WebSocket;
}

export async function act(page: Page, action: Action, username: string, password: string) {
  const click = async (selector: string) => {
    const element = page.locator(selector);
    if (!await element.isVisible() || !await element.isEnabled()) throw Error(`Cannot infer ${action.type}: ${selector} is hidden or disabled.`);
    await element.dispatchEvent('click');
  };
  switch (action.type) {
    case 'login':
      await page.locator('#username').fill(username);
      await page.locator('#password').fill(password);
      await page.locator('#login-form').dispatchEvent('submit');
      break;
    case 'match': {
      // Leaving a finished room is a local-only action, but a new match implies
      // it when the matchmaking controls are not already shown.
      if (!await page.locator('#match').isVisible()) await click('#quit-room');
      const control = page.locator(`input[name="time-control"][value="${action.id}"]`);
      await control.check({ force: true });
      await click('#match');
      break;
    }
    case 'play':
      await page.locator('#board').evaluate((board, { x, y }) => {
        const svg = board as SVGSVGElement, point = svg.createSVGPoint();
        point.x = 48 + x! * (744 / 18); point.y = 48 + y! * (744 / 18);
        const screen = point.matrixTransform(svg.getScreenCTM()!);
        svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: screen.x, clientY: screen.y }));
      }, action);
      break;
    case 'cancel': await click('#cancel-match'); break;
    case 'pass': await click('#pass'); break;
    case 'count': await click('#request-score'); break;
    case 'confirm': await click(action.accept ? '#counting-accept' : '#counting-reject'); break;
    case 'resign':
      await click('#resign');
      if (await page.locator('#resign').textContent() === 'Confirm Resignation') await click('#resign');
      break;
    default: throw Error(`Unsupported inferred action: ${action.type}`);
  }
}

export async function uiSnapshot(page: Page) {
  const dom = await page.evaluate(() => {
    const visible = (element: Element) => element.checkVisibility() && !element.closest('[hidden], dialog:not([open])');
    const board = document.querySelector('#board')!;
    return {
      title: document.title,
      controls: [...document.querySelectorAll('button, input, select, a')].filter(visible).map(element => {
        const input = element as HTMLInputElement;
        return {
          tag: element.tagName.toLowerCase(), id: element.id,
          text: element.textContent?.replace(/\s+/g, ' ').trim(),
          disabled: 'disabled' in input ? input.disabled : undefined,
          value: input.tagName === 'INPUT' ? input.type === 'password' ? '<redacted>' : input.value : undefined,
          checked: input.type === 'radio' || input.type === 'checkbox' ? input.checked : undefined,
          expanded: element.getAttribute('aria-expanded') ?? undefined,
        };
      }),
      board: {
        visible: !!visible(board),
        stones: [...board.querySelectorAll('.board-stones .stone')].map(stone => {
          const circle = stone.querySelector('circle')!;
          return { color: stone.classList.contains('stone-black') ? 'black' : 'white', x: circle.getAttribute('cx'), y: circle.getAttribute('cy') };
        }),
        annotations: [...board.querySelectorAll('polygon, text, .estimated-territory rect')].map(element => element.outerHTML),
      },
    };
  });
  return { ...dom, accessibility: await page.locator('body').ariaSnapshot() };
}
