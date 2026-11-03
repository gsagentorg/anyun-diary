import { sleepGain, type SleepMode } from './sleep-curves';

/** One graph per media element. Never disconnect a routed source or close its context:
 * doing so would silence the normal player as well. No new graph for each track. */
export class SleepAudio {
  private context?: AudioContext;
  private gain?: GainNode;
  private source?: MediaElementAudioSourceNode;
  private baseVolume: number | null = null;
  private route: 'web-audio' | 'volume' | 'none' = 'none';
  private revision = 0;
  constructor(private audio: HTMLAudioElement) {}

  async prepare(): Promise<string | null> {
    const revision = ++this.revision;
    const host = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Context = host.AudioContext ?? host.webkitAudioContext;
    if (Context) {
      try {
        this.context ??= new Context();
        // Invoked synchronously from the sleep button's user gesture.
        if (this.context.state !== 'running') await this.context.resume();
        if (revision !== this.revision) return null;
        if (this.context.state !== 'running') throw new Error('audio context not running');
        if (!this.source) {
          const gain = this.context.createGain();
          gain.connect(this.context.destination);
          this.source = this.context.createMediaElementSource(this.audio);
          this.source.connect(gain);
          this.gain = gain;
        }
        this.route = 'web-audio';
        return null;
      } catch {
        // Once a source is routed, a suspended context cannot be bypassed by volume.
        if (this.source) return '音频引擎未能恢复，请点播放重试；后台渐弱仍受系统限制。';
      }
    }
    if (revision !== this.revision) return null;
    // Some mobile browsers ignore media.volume; verify the setter rather than UA-sniff.
    const base = this.audio.volume;
    try {
      const probe = base > 0.5 ? base - 0.001 : base + 0.001;
      this.audio.volume = probe;
      const writable = Math.abs(this.audio.volume - probe) < 0.00001;
      this.audio.volume = base;
      if (writable) {
        this.baseVolume ??= base;
        this.route = 'volume';
        return '当前使用兼容渐弱；锁屏或后台时可能延迟，到时停止也受浏览器限制。';
      }
    } catch { /* Unsupported setter; keep ordinary playback unchanged. */ }
    this.route = 'none';
    return '当前浏览器不支持网页音量渐弱，将仅在到时停止。';
  }

  schedule(mode: SleepMode, started: number, until: number, now: number) {
    if (!this.gain || !this.context || this.route !== 'web-audio') return;
    const remaining = (until - now) / 1000;
    const param = this.gain.gain;
    param.cancelScheduledValues(this.context.currentTime);
    if (remaining <= 0) { param.setValueAtTime(0, this.context.currentTime); return; }
    const values = Float32Array.from({ length: 301 }, (_, i) =>
      sleepGain(mode, (now + (until - now) * i / 300 - started) / (until - started)));
    // AudioParam automation, not a foreground-only JS animation loop.
    param.setValueCurveAtTime(values, this.context.currentTime, remaining);
  }

  tick(mode: SleepMode, progress: number) {
    if (this.route === 'volume' && this.baseVolume != null) {
      this.audio.volume = this.baseVolume * sleepGain(mode, progress);
    }
  }

  restore(immediate = false) {
    ++this.revision; // Late resume promises must not re-arm a cancelled timer.
    if (this.gain && this.context) {
      const param = this.gain.gain;
      const now = this.context.currentTime;
      const value = param.value;
      param.cancelScheduledValues(now);
      param.setValueAtTime(immediate ? 1 : value, now);
      if (!immediate) param.linearRampToValueAtTime(1, now + 0.25);
    }
    if (this.baseVolume != null) {
      this.audio.volume = this.baseVolume;
      this.baseVolume = null;
    }
  }

  /** Called from a user play action/foreground recovery after OS suspension. */
  async resume() {
    if (this.context && this.context.state !== 'running') {
      try { await this.context.resume(); } catch { /* UI retains platform caveat. */ }
    }
  }
}
