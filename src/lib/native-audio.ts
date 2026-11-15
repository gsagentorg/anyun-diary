import { Capacitor, registerPlugin } from '@capacitor/core';

export const usesNativeAudio = () => typeof window !== 'undefined' && Capacitor.getPlatform() === 'ios';
export interface NativeQueueItem { id: string; url: string; title: string; key: string; lyrics?: { t: number; text: string }[]; clipDuration?: number; album?: string; }
export interface NativeConfig {
  queue: NativeQueueItem[]; pos: number; shuffle: boolean; skipSame: boolean;
  history: number[]; redo: number[]; played: string[]; rate: number;
  sleepRevision: string; sleepUntil: number | null; sleepStarted: number | null; sleepMode: string; afterTrack: boolean;
}
export interface NativeState extends NativeConfig {
  revision: string; position: number; duration: number; playing: boolean; loading: boolean;
  error: string; sleepFired: boolean; sequence: number;
}
type CatalogFields = 'queue' | 'history' | 'redo' | 'played';
export type NativeStateEvent = Omit<NativeState, CatalogFields> & Partial<Pick<NativeState, CatalogFields>>;
export interface PlaybackBridge {
  configure(options: NativeConfig & { revision: string; replace?: boolean }): Promise<NativeState>;
  command(options: { action: string; value?: number }): Promise<NativeState>;
  getState(): Promise<NativeState>;
  addListener(event: 'state', callback: (state: NativeStateEvent) => void): Promise<{ remove(): Promise<void> }>;
}
const bridge = registerPlugin<PlaybackBridge>('NativePlayback');

/** Small media-event adapter shared by the playback bar and lyrics. Never creates a web audio element. */
export class NativeAudio extends EventTarget {
  src = '';
  preload = 'metadata';
  crossOrigin: string | null = null;
  volume = 1;
  paused = true;
  duration = 0;
  private position = 0;
  private rate = 1;
  private revision = '';
  private sequence = -1;
  private disposed = false;
  private lastState?: NativeState;
  private lastError = "";
  private wasLoading = false;
  private listener?: { remove(): Promise<void> };
  private onVisibility = () => {
    if (!document.hidden) void this.enqueue(() => this.driver.getState()).catch(() => {});
  };
  private serial: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<NativeState>;
  constructor(private config: () => NativeConfig, private update: (state: NativeState) => void, private fail: (message: string) => void, private driver: PlaybackBridge = bridge) {
    super();
    this.ready = this.driver.addListener('state', state => this.accept(state)).then(listener => {
      this.listener = listener;
      if (this.disposed) void listener.remove();
      return this.driver.getState();
    }).then(state => {
      this.accept(state);
      return state;
    });
    this.serial = this.ready.catch(error => this.error(error));
    document.addEventListener('visibilitychange', this.onVisibility);
  }
  private error(error: unknown) {
    this.fail(error instanceof Error ? error.message : String(error));
    this.dispatchEvent(new Event('error'));
  }
  private enqueue(work: () => Promise<NativeState>): Promise<void> {
    const result = this.serial.then(work).then(state => this.accept(state));
    this.serial = result.catch(error => this.error(error));
    return result;
  }
  private accept(event: NativeStateEvent) {
    // A delta is only meaningful after a complete snapshot of the same revision.
    const complete = event.queue && event.history && event.redo && event.played;
    if (!complete && this.lastState?.revision !== event.revision) return;
    const state = { ...this.lastState, ...event } as NativeState;
    if (this.disposed) return;
    if (this.revision && state.revision !== this.revision) return;
    if (state.sequence < this.sequence) return;
    this.sequence = state.sequence;
    this.lastState = state;
    const wasPaused = this.paused;
    const durationChanged = state.duration !== this.duration;
    const itemChanged = this.src !== (state.queue[state.pos]?.url ?? '');
    this.src = state.queue[state.pos]?.url ?? '';
    this.paused = !state.playing && !state.loading;
    this.duration = state.duration;
    this.position = state.position;
    this.rate = state.rate;
    this.update(state);
    if (durationChanged || itemChanged) this.dispatchEvent(new Event('loadedmetadata'));
    if (durationChanged) this.dispatchEvent(new Event('durationchange'));
    if (wasPaused !== this.paused) this.dispatchEvent(new Event(this.paused ? 'pause' : 'play'));
    if (this.wasLoading !== state.loading || itemChanged) this.dispatchEvent(new Event(state.loading ? 'waiting' : 'canplay'));
    this.wasLoading = state.loading;
    this.dispatchEvent(new Event('timeupdate'));
    if (state.error && state.error !== this.lastError) this.error(new Error(state.error));
    this.lastError = state.error;
  }
  dispose() {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.listener?.remove();
  }
  sync(replace = false) {
    const config = this.config();
    const revision = `${Date.now()}-${Math.random()}`;
    this.revision = revision;
    return this.enqueue(() => this.driver.configure({ ...config, revision, replace }));
  }
  command(action: string, value?: number) { return this.enqueue(() => this.driver.command({ action, value })); }
  load() { void this.sync(true).catch(() => {}); }
  play() { return this.command('play'); }
  pause() { void this.command('pause').catch(() => {}); }
  get currentTime() { return this.position; }
  set currentTime(value: number) {
    if (!Number.isFinite(value)) return;
    this.position = Math.max(0, value);
    void this.command('seek', this.position).catch(() => {});
  }
  get playbackRate() { return this.rate; }
  set playbackRate(value: number) {
    if (value === this.rate) return;
    this.rate = value;
    void this.command('rate', value).catch(() => {});
  }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  setAttribute(name: string, value: string) { if (name === 'src') this.src = value; }
}
