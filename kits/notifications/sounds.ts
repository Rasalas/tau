import type { SoundCue, SoundName } from "./present.js";

/** A struck note: pitch (Hz), when (s), how long it rings (s) and how loud (0–1). */
type Note = readonly [frequency: number, offset: number, ring: number, level?: number];

/** Overtones as [ratio, level, ring factor]; the ratio makes the material. */
type Timbre = ReadonlyArray<readonly [number, number, number]>;

interface Voice {
  timbre: Timbre;
  /** Low-pass corner; it takes the edge off the highest partials. */
  brightness: number;
  /** Seconds to full level; shorter strikes harder. */
  attack?: number;
  cues: Record<SoundCue, readonly Note[]>;
}

// Done falls to rest; a question rises and stays open.
const VOICES: Record<SoundName, Voice> = {
  chime: {
    timbre: [[1, 1, 1], [2, 0.16, 0.7], [2.76, 0.14, 0.35], [5.4, 0.03, 0.18]],
    brightness: 4_000,
    attack: 0.014,
    cues: {
      done: [[1046.5, 0, 0.9, 0.8], [783.99, 0.12, 1.1]],
      attention: [[783.99, 0, 0.5, 0.8], [1046.5, 0.13, 0.5, 0.85], [1318.51, 0.26, 0.95]],
    },
  },
  ping: {
    timbre: [[1, 1, 1], [3, 0.08, 0.35]],
    brightness: 7_000,
    cues: {
      done: [[1567.98, 0, 0.55]],
      attention: [[1567.98, 0, 0.3, 0.8], [2093, 0.14, 0.6]],
    },
  },
  marimba: {
    timbre: [[1, 1, 1], [3.93, 0.28, 0.18], [9.8, 0.06, 0.08]],
    brightness: 3_600,
    cues: {
      done: [[659.25, 0, 0.45, 0.75], [523.25, 0.11, 0.6]],
      attention: [[523.25, 0, 0.35, 0.75], [659.25, 0.1, 0.35, 0.8], [783.99, 0.2, 0.55]],
    },
  },
};

let audio: AudioContext | undefined;

function context(): AudioContext | undefined {
  if (audio) return audio;
  const Audio = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  audio = Audio ? new Audio() : undefined;
  return audio;
}

/** A page may only start sound after a gesture; call this from one so later sounds play. */
export function unlockSound(): void {
  void context()?.resume().catch(() => undefined);
}

/** Synthesised rather than shipped as files: no asset, no loader, no media policy to widen. */
export function playSound(name: SoundName, cue: SoundCue = "done"): boolean {
  const ctx = context();
  if (!ctx) return false;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  const voice = VOICES[name];
  const start = ctx.currentTime + 0.01;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = voice.brightness;
  const master = ctx.createGain();
  master.gain.value = 0.14;
  filter.connect(master).connect(ctx.destination);
  for (const [frequency, offset, ring, level = 1] of voice.cues[cue]) {
    for (const [ratio, partLevel, ringFactor] of voice.timbre) {
      const at = start + offset;
      const length = ring * ringFactor;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency * ratio;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(level * partLevel, at + (voice.attack ?? 0.006));
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      oscillator.connect(gain).connect(filter);
      oscillator.start(at);
      oscillator.stop(at + length + 0.02);
    }
  }
  return true;
}
