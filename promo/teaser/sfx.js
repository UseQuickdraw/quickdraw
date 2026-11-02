// Sound effects for the promo videos, synthesised with Web Audio into an
// OfflineAudioContext: no samples, no music, no voice. Noise comes from a
// seeded generator, so a render always sounds the same. A classic script,
// loaded after common.js; a page's `sounds(sfx)` schedules effects at times
// matching its animation.
(() => {
  const SR = 48_000;

  /** Seeded noise in [-1, 1]. */
  function noiseBuffer(ac, seconds, seed = 1) {
    const buf = ac.createBuffer(1, Math.ceil(seconds * SR), SR);
    const d = buf.getChannelData(0);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < d.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      d[i] = ((x >>> 0) / 0xffffffff) * 2 - 1;
    }
    return buf;
  }

  /** A short decaying impulse response, for a little room on everything. */
  function room(ac, seconds = 1.6) {
    const n = Math.ceil(seconds * SR);
    const buf = ac.createBuffer(2, n, SR);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let x = (ch + 7) * 2654435761;
      for (let i = 0; i < n; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        d[i] = (((x >>> 0) / 0xffffffff) * 2 - 1) * Math.pow(1 - i / n, 3.2);
      }
    }
    return buf;
  }

  function make(ac) {
    const master = ac.createDynamicsCompressor();
    master.threshold.value = -14;
    master.ratio.value = 4;
    master.attack.value = 0.004;
    master.release.value = 0.2;
    const out = ac.createGain();
    out.gain.value = 0.9;
    master.connect(out).connect(ac.destination);
    const verb = ac.createConvolver();
    verb.buffer = room(ac);
    const wet = ac.createGain();
    wet.gain.value = 0.22;
    verb.connect(wet).connect(master);
    const noise = noiseBuffer(ac, 4, 12345);

    /** A gain node into the mix (dry, plus some room). */
    const bus = (level = 1, pan = 0, reverb = 1) => {
      const g = ac.createGain();
      g.gain.value = level;
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(master);
      if (reverb > 0) {
        const s = ac.createGain();
        s.gain.value = reverb;
        p.connect(s).connect(verb);
      }
      return g;
    };
    /** Attack/decay envelope on a gain param. */
    const env = (param, t, peak, attack, decay) => {
      param.setValueAtTime(0.0001, t);
      param.exponentialRampToValueAtTime(peak, t + attack);
      param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    };
    const osc = (t, type, f0, f1, dur, level, dest, attack = 0.005) => {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ac.createGain();
      env(g.gain, t, level, attack, dur);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + attack + dur + 0.05);
    };
    const noiseSrc = (t, dur, offset = 0) => {
      const s = ac.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.start(t, offset % 3.5, dur + 0.1);
      return s;
    };

    return {
      /** Filtered noise sweeping up (in) or down (out): text and scenes arriving. */
      whoosh(t, dur = 0.55, { level = 0.5, up = true, pan = 0, from = 300, to = 3200 } = {}) {
        const s = noiseSrc(t, dur, t * 1.7);
        const f = ac.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = 1.4;
        f.frequency.setValueAtTime(up ? from : to, t);
        f.frequency.exponentialRampToValueAtTime(up ? to : from, t + dur);
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(level, t + dur * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f).connect(g).connect(bus(1, pan, 0.6));
      },
      /** A UI click: a tiny noise tick and a high blip. */
      click(t, level = 0.55) {
        const s = noiseSrc(t, 0.03, t * 3.1);
        const f = ac.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = 2500;
        const g = ac.createGain();
        env(g.gain, t, level, 0.001, 0.025);
        const b = bus(1, 0, 0.3);
        s.connect(f).connect(g).connect(b);
        osc(t, 'sine', 1800, 1200, 0.04, level * 0.5, b, 0.001);
      },
      /** A soft pop with a falling pitch: cards and icons appearing. */
      pop(t, pitch = 520, level = 0.5, pan = 0) {
        const b = bus(1, pan, 0.5);
        osc(t, 'sine', pitch * 1.6, pitch, 0.12, level, b, 0.004);
        osc(t, 'triangle', pitch * 3.2, pitch * 2, 0.06, level * 0.25, b, 0.002);
      },
      /** The panel's "landed" chime: two quick rising notes. */
      landed(t, level = 0.4, pan = 0) {
        const b = bus(1, pan, 0.8);
        osc(t, 'sine', 880, 880, 0.18, level, b, 0.006);
        osc(t + 0.085, 'sine', 1320, 1320, 0.32, level, b, 0.006);
        osc(t + 0.085, 'sine', 2640, 2640, 0.12, level * 0.12, b, 0.004);
      },
      /** A counter tick. */
      tick(t, pitch = 2200, level = 0.18) {
        osc(t, 'square', pitch, pitch, 0.018, level, bus(1, 0, 0.2), 0.001);
      },
      /** A swipe: the strike-through. */
      swipe(t, dur = 0.35, level = 0.5) {
        this.whoosh(t, dur, { level, from: 1200, to: 7000 });
        osc(t, 'sawtooth', 220, 140, dur, level * 0.12, bus(1, 0, 0.2), 0.005);
      },
      /** A bright confirming chord: a good number appearing. */
      success(t, level = 0.35) {
        const b = bus(1, 0, 1);
        for (const [i, f] of [523.25, 659.25, 783.99, 1046.5].entries()) osc(t + i * 0.035, 'sine', f, f, 0.6, level * (i === 3 ? 0.5 : 1), b, 0.01);
      },
      /** A low thump. */
      thud(t, level = 0.8) {
        const b = bus(1, 0, 0.4);
        osc(t, 'sine', 140, 42, 0.35, level, b, 0.003);
        const s = noiseSrc(t, 0.08, t * 2.3);
        const f = ac.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 900;
        const g = ac.createGain();
        env(g.gain, t, level * 0.35, 0.002, 0.07);
        s.connect(f).connect(g).connect(b);
      },
      /** An alert: a thump and a two-tone warning beep. */
      alert(t, level = 0.4, pan = 0) {
        this.thud(t, level * 1.4);
        const b = bus(1, pan, 0.5);
        osc(t + 0.02, 'square', 880, 880, 0.09, level * 0.35, b, 0.003);
        osc(t + 0.14, 'square', 660, 660, 0.12, level * 0.35, b, 0.003);
      },
      /** Digital glitch: crushed noise bursts and stuttering blips. */
      glitch(t, dur = 0.16, level = 0.45) {
        const b = bus(1, 0, 0.15);
        const s = noiseSrc(t, dur, t * 5.3);
        const f = ac.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 2400;
        f.Q.value = 0.8;
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        // Choppy gate: on/off every 18 ms.
        for (let k = 0; k * 0.018 < dur; k++) g.gain.setValueAtTime(k % 2 ? 0.0001 : level, t + k * 0.018);
        g.gain.setValueAtTime(0.0001, t + dur);
        s.connect(f).connect(g).connect(b);
        osc(t, 'square', 1500 + ((t * 977) % 900), 300, dur * 0.7, level * 0.25, b, 0.001);
      },
      /** A low tension rumble from a to b. */
      rumble(a, b, level = 0.22) {
        const s = noiseSrc(a, b - a, 0.3);
        const f = ac.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 160;
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, a);
        g.gain.exponentialRampToValueAtTime(level, a + 1.2);
        g.gain.setValueAtTime(level, b - 1.2);
        g.gain.exponentialRampToValueAtTime(0.0001, b);
        s.connect(f).connect(g).connect(bus(1, 0, 0));
        const o = ac.createOscillator();
        o.type = 'sine';
        o.frequency.value = 46;
        const og = ac.createGain();
        og.gain.setValueAtTime(0.0001, a);
        og.gain.exponentialRampToValueAtTime(level * 0.6, a + 1.2);
        og.gain.setValueAtTime(level * 0.6, b - 1.2);
        og.gain.exponentialRampToValueAtTime(0.0001, b);
        o.connect(og).connect(bus(1, 0, 0));
        o.start(a);
        o.stop(b + 0.05);
      },
      /** A rising noise and tone into `t + dur`: tension before a reveal. */
      riser(t, dur = 1.2, level = 0.35) {
        this.whoosh(t, dur, { level, from: 200, to: 6000 });
        osc(t, 'sawtooth', 110, 880, dur, level * 0.08, bus(1, 0, 0.6), dur * 0.8);
      },
      /** The logo outro: a pop as the hand lands, a shimmer as the name reveals, a soft chord under the tagline. */
      outro(T0) {
        this.pop(T0 + 0.12, 380, 0.6);
        this.thud(T0 + 0.12, 0.35);
        this.whoosh(T0 + 0.85, 0.7, { level: 0.35, from: 800, to: 9000 });
        this.success(T0 + 1.9, 0.22);
      },
    };
  }

  /** Renders a page's `sounds(sfx)` into stereo PCM for `duration` seconds, its loudest moment at -1 dBFS. */
  async function render(sounds, duration) {
    const ac = new OfflineAudioContext(2, Math.ceil(duration * SR), SR);
    sounds(make(ac));
    const buf = await ac.startRendering();
    let peak = 0;
    for (let c = 0; c < 2; c++) for (const x of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
    if (peak > 0) {
      const k = 0.89 / peak;
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] *= k;
      }
    }
    return buf;
  }

  window.sfx = { SR, render };
})();
