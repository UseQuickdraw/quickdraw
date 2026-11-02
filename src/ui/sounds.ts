// Short cues for a trade's on-chain result, synthesised with Web Audio: no
// sound files to ship or fetch. The page has had a click (the trade) by the
// time one plays, so autoplay rules allow it.

let ctx: AudioContext | null = null;

function tone(at: number, freq: number, ms: number, volume: number, type: OscillatorType): void {
  const c = ctx!;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  // A quick fade in and out, so it doesn't click.
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + ms / 1000 + 0.02);
}

/** Landed: two rising notes. Failed: two falling, lower and buzzier. `volume` is 0..1. */
export function playResult(kind: 'landed' | 'failed', volume: number): void {
  if (volume <= 0) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + 0.01;
    const v = 0.25 * Math.min(1, volume);
    if (kind === 'landed') {
      tone(t, 880, 110, v, 'sine');
      tone(t + 0.09, 1320, 160, v, 'sine');
    } else {
      tone(t, 330, 140, v * 0.8, 'triangle');
      tone(t + 0.12, 220, 220, v * 0.8, 'triangle');
    }
  } catch {
    // No audio here (or blocked): the pop-up still shows.
  }
}
