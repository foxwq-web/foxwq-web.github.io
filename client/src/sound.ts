
export function placementSound(captures: number) {
  if (captures >= 16) return "stone-capture-large";
  if (captures >= 3) return "stone-capture-medium";
  if (captures >= 1) return "stone-capture-small";
  return "stone";
}


export class FoxSounds {
  output: GainNode | null;
  context: AudioContext | null;
  buffers: Map<string, AudioBuffer>;
  loading: Promise<void[]> | null;
  names: string[];
  voice: AudioBufferSourceNode | null = null;
  voiceName: string | null = null;
  active = false;
  private downloads: Promise<([string, ArrayBuffer] | null)[]> | null = null;
  private resuming: Promise<void> | null = null;
  private voiceRevision = 0;
  private pendingVoiceName: string | null = null;
  constructor() {
    this.output = null;
    this.context = null;
    this.buffers = new Map();
    this.loading = null;
    this.names = [
      "stone",
      "stone-capture-small",
      "stone-capture-medium",
      "stone-capture-large",
      ...Array.from({ length: 9 }, (_, i) => `count-${i + 1}`),
      "periods-1",
      "periods-2",
      "start-play",
      "byoyomi-start",
    ];
  }
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.prepare();
      this.preload();
      return;
    }
    this.stopVoice();
    const context = this.context;
    this.context = null;
    this.output = null;
    this.loading = null;
    this.resuming = null;
    this.buffers.clear();
    // Closing the context also stops overlapping effects and releases the device.
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }
  prepare() {
    if (!this.active) return;
    const Context =
      globalThis.AudioContext ||
      (
        globalThis as typeof globalThis & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!Context) return;
    this.context ??= new Context({ latencyHint: "interactive" });
    if (!this.output) {
      this.output = this.context.createGain();
      this.output.connect(this.context.destination);
    }
  }
  preload() {
    // Fetch before a game without opening an audio device. Decode only once
    // an active game has created its context; keep the bytes for later games.
    this.downloads ??= Promise.all(
      this.names.map(async (name) => {
        try {
          const response = await fetch(
            `${import.meta.env?.BASE_URL ?? "/"}sounds/${name}.mp3`,
          );
          if (response.ok) return [name, await response.arrayBuffer()] as [string, ArrayBuffer];
        } catch {
        }
        return null;
      }),
    );
    const context = this.context;
    if (!context) return;
    this.loading ??= this.downloads.then(files => Promise.all(files.map(async file => {
      if (!file || this.context !== context) return;
      try {
        const [name, bytes] = file;
        const buffer = await context.decodeAudioData(bytes.slice(0));
        if (this.context === context) this.buffers.set(name, buffer);
      } catch { /* A closed context or unavailable sound must not interrupt play. */ }
    })));
  }
  unlock() {
    if (!this.active) return;
    this.prepare();
    // iOS otherwise treats Web Audio as ambient/ringer audio, which is silent
    // with the phone's Silent switch enabled. Request media playback on a tap.
    const session = (globalThis.navigator as Navigator & {
      audioSession?: { type: string };
    } | undefined)?.audioSession;
    try {
      if (session && session.type !== "playback")
        session.type = "playback";
    } catch { /* Older browsers may expose an unavailable audio session. */ }
    // A resume requested outside a gesture can stay pending indefinitely.
    // Retry inside this gesture rather than reusing that blocked request.
    void this.resumeContext(true).catch(() => {});
  }
  private resumeContext(fromGesture = false) {
    if (!this.context || this.context.state === "closed")
      return Promise.reject(new Error("Audio context unavailable"));
    if (this.context.state === "running") return Promise.resolve();
    if (this.resuming && !fromGesture) return this.resuming;
    const pending: Promise<void> = this.context.resume().finally(() => {
      if (this.resuming === pending) this.resuming = null;
    });
    this.resuming = pending;
    return pending;
  }
  play(name: string) {
    if (!this.active || !this.context || this.context.state === "closed") return;
    const placement = name === "stone" || name.startsWith("stone-capture-");
    const voiceName = this.pendingVoiceName ?? this.voiceName;
    if (
      name.startsWith("count-") &&
      (this.voice || this.pendingVoiceName) &&
      !voiceName?.startsWith("count-")
    )
      return;
    const buffer = this.buffers.get(name);
    if (!buffer) {
      if (!this.loading) return;
      const context = this.context, requestedAt = performance.now();
      const revision = placement ? null : ++this.voiceRevision;
      if (!placement) this.pendingVoiceName = name;
      void this.loading.then(() => {
        if (revision !== null && revision !== this.voiceRevision) return;
        if (!placement) this.pendingVoiceName = null;
        if (this.active && this.context === context && this.buffers.has(name) &&
            performance.now() - requestedAt <= 250)
          this.play(name);
      });
      return;
    }
    if (this.context.state !== "running") {
      const context = this.context, requestedAt = performance.now();
      const revision = placement ? null : ++this.voiceRevision;
      if (!placement) this.pendingVoiceName = name;
      void this.resumeContext().then(() => {
        if (revision !== null && revision !== this.voiceRevision) return;
        if (!placement) this.pendingVoiceName = null;


        if (this.context !== context || context.state !== "running" ||
            performance.now() - requestedAt > 250)
          return;
        this.play(name);
      }).catch(() => {
        if (revision !== null && revision === this.voiceRevision)
          this.pendingVoiceName = null;
      });
      return;
    }
    if (!placement) {
      this.voiceRevision++;
      this.pendingVoiceName = null;
      this.voice?.stop();
      this.voice = null;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output!);
    source.start();
    if (!placement) {
      this.voice = source;
      this.voiceName = name;
      source.onended = () => {
        if (this.voice === source) this.voice = null;
      };
    }
  }
  stopCountdown() {
    if ((this.pendingVoiceName ?? this.voiceName) !== "start-play") this.stopVoice();
  }
  stopVoice() {
    this.voiceRevision++;
    this.pendingVoiceName = null;
    this.voice?.stop();
    this.voice = null;
  }
}

export function bindAudioUnlock(sounds: Pick<FoxSounds, "unlock">, target: EventTarget = window) {
  const unlock = () => sounds.unlock();
  // A touch pointerdown does not activate audio on every Safari version.
  // touchend/click run in the accepted tap gesture, before gameplay handlers.
  const events = ["pointerdown", "touchend", "click", "keydown"];
  const options = { capture: true, passive: true };
  for (const event of events) target.addEventListener(event, unlock, options);
  return () => {
    for (const event of events) target.removeEventListener(event, unlock, options);
  };
}
