// Procedural audio (SPEC section 12, appendix J). Everything is synthesised; no sample files are required.
import * as THREE from "three/webgpu";

function noiseBuffer(ctx: BaseAudioContext, kind: "pink" | "brown" | "white", seconds = 4): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0, seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  for (let i = 0; i < n; i++) {
    const w = rnd();
    if (kind === "white") d[i] = w * 0.5;
    else if (kind === "brown") { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else { b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926; }
  }
  return buf;
}

export interface HumSource { pos: THREE.Vector3; servers: number; fanLoad: number; strain: number }
interface Hum { panner: PannerNode; gain: GainNode; t1: OscillatorNode; t2: OscillatorNode; shelf: BiquadFilterNode; alive: boolean }

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode; private world!: GainNode; private uiBus!: GainNode; private hallBus!: GainNode; private hallLP!: BiquadFilterNode;
  private hums = new Map<string, Hum>();
  private pink!: AudioBuffer; private brown!: AudioBuffer; private white!: AudioBuffer;
  private alarmUntil = 0; private alarmStart = 0; private alarmPos = new THREE.Vector3(); private nextAlarm = 0;
  private stepAcc = 0; private steps: { hard: AudioBuffer[]; perforated: AudioBuffer[] } = { hard: [], perforated: [] }; private stepN = 0;
  vol = { master: 0.8, world: 1, ui: 0.7 };

  /** Must be called from a user gesture the first time. */
  start(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const ctx = (this.ctx = new AudioContext());
    this.pink = noiseBuffer(ctx, "pink"); this.brown = noiseBuffer(ctx, "brown"); this.white = noiseBuffer(ctx, "white", 1);
    const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.2;
    this.master = ctx.createGain(); this.master.connect(limiter); limiter.connect(ctx.destination);
    this.world = ctx.createGain(); this.world.connect(this.master);
    this.uiBus = ctx.createGain(); this.uiBus.connect(this.master);
    this.hallLP = ctx.createBiquadFilter(); this.hallLP.type = "lowpass"; this.hallLP.frequency.value = 20000;
    this.hallBus = ctx.createGain(); this.hallBus.gain.value = HALL_TRIM; this.hallBus.connect(this.hallLP); this.hallLP.connect(this.world);
    // room tone
    const tone = ctx.createBufferSource(); tone.buffer = this.brown; tone.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 120; const g = ctx.createGain(); g.gain.value = 0.5;
    tone.connect(lp); lp.connect(g); g.connect(this.hallBus); tone.start();
    this.applyVolume();
    // footsteps are CC0 samples (assets/audio/footsteps): four for the hard floor, four for perforated tile
    for (const kind of ["hard", "perforated"] as const) for (let n = 1; n <= 4; n++) void fetch(new URL(`../../../assets/audio/footsteps/${kind}_${n}.wav`, import.meta.url).href).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).then((buf) => { this.steps[kind][n - 1] = buf; }).catch(() => {});
  }
  applyVolume(): void { if (!this.ctx) return; this.master.gain.value = this.vol.master * 0.5; this.world.gain.value = this.vol.world; this.uiBus.gain.value = this.vol.ui; }

  private makeHum(): Hum {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = this.pink; src.loop = true; src.loopStart = Math.random() * 2;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 180; bp.Q.value = 0.7;
    const shelf = ctx.createBiquadFilter(); shelf.type = "highshelf"; shelf.frequency.value = 2000; shelf.gain.value = 0;
    const t1 = ctx.createOscillator(), t2 = ctx.createOscillator(); t1.type = "sine"; t2.type = "sine";
    const tg = ctx.createGain(); tg.gain.value = 0.03;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const panner = ctx.createPanner(); panner.panningModel = "HRTF"; panner.distanceModel = "inverse"; panner.refDistance = 1; panner.maxDistance = 25; panner.rolloffFactor = 1.1;
    src.connect(bp); bp.connect(shelf); const raw = ctx.createGain(); raw.gain.value = 0.35; src.connect(raw); raw.connect(shelf);
    t1.connect(tg); t2.connect(tg); tg.connect(shelf); shelf.connect(gain); gain.connect(panner); panner.connect(this.hallBus);
    src.start(); t1.start(); t2.start();
    return { panner, gain, t1, t2, shelf, alive: true };
  }

  /** Per-frame update: listener pose, rack hum sources, control-room muffling, alarm. */
  update(camera: THREE.Camera, sources: Map<string, HumSource>, inControlRoom: boolean, criticalAt: THREE.Vector3 | null): void {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime, L = ctx.listener;
    const p = camera.getWorldPosition(new THREE.Vector3()), f = camera.getWorldDirection(new THREE.Vector3());
    if (L.positionX) { L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02); L.forwardX.setTargetAtTime(f.x, t, 0.02); L.forwardY.setTargetAtTime(f.y, t, 0.02); L.forwardZ.setTargetAtTime(f.z, t, 0.02); L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
    for (const [id, s] of sources) {
      let h = this.hums.get(id); if (!h) { h = this.makeHum(); this.hums.set(id, h); }
      h.panner.positionX.value = s.pos.x; h.panner.positionY.value = s.pos.y; h.panner.positionZ.value = s.pos.z;
      h.gain.gain.setTargetAtTime(Math.min(1, 0.1 + s.servers * 0.035), t, 0.3);
      const fq = 90 + 60 * s.fanLoad; h.t1.frequency.setTargetAtTime(fq, t, 0.4); h.t2.frequency.setTargetAtTime(fq * 2.01, t, 0.4);
      h.shelf.gain.setTargetAtTime(Math.max(0, (s.strain - 0.8) * 30), t, 0.4);
    }
    for (const [id, h] of this.hums) if (!sources.has(id)) { h.gain.gain.setTargetAtTime(0, t, 0.2); }
    this.hallLP.frequency.setTargetAtTime(inControlRoom ? 600 : 20000, t, 0.15);
    this.hallBus.gain.setTargetAtTime((inControlRoom ? 0.2 : 1) * HALL_TRIM, t, 0.15);
    if (criticalAt) {
      if (performance.now() > this.alarmUntil) this.alarmStart = performance.now();
      this.alarmUntil = performance.now() + 2500; this.alarmPos.copy(criticalAt);
      if (performance.now() > this.nextAlarm) { this.nextAlarm = performance.now() + 2000; const quiet = performance.now() - this.alarmStart > 10000; this.blip(660, 0.25, quiet ? 0.05 : 0.16, 0, this.alarmPos); this.blip(880, 0.25, quiet ? 0.05 : 0.16, 0.25, this.alarmPos); }
    }
  }

  private out(at?: THREE.Vector3, ui = false): AudioNode {
    const ctx = this.ctx!;
    if (!at || ui) return ui ? this.uiBus : this.world;
    const pn = ctx.createPanner(); pn.panningModel = "HRTF"; pn.distanceModel = "inverse"; pn.refDistance = 1; pn.maxDistance = 25;
    pn.positionX.value = at.x; pn.positionY.value = at.y; pn.positionZ.value = at.z; pn.connect(this.world); return pn;
  }
  private blip(freq: number, dur: number, vol: number, delay = 0, at?: THREE.Vector3, ui = false, type: OscillatorType = "sine"): void {
    const ctx = this.ctx; if (!ctx) return; const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.out(at, ui)); o.start(t); o.stop(t + dur + 0.02);
  }
  private burst(kind: "white" | "pink", dur: number, vol: number, f0: number, f1: number, q: number, delay = 0, at?: THREE.Vector3): void {
    const ctx = this.ctx; if (!ctx) return; const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource(); s.buffer = kind === "white" ? this.white : this.pink; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = q; bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp); bp.connect(g); g.connect(this.out(at)); s.start(t); s.stop(t + dur + 0.05);
  }

  /** Named one-shots. */
  play(name: string, at?: THREE.Vector3): void {
    if (!this.ctx) return;
    switch (name) {
      case "rail": this.burst("pink", 0.55, 0.5, 900, 2600, 3, 0, at); this.blip(140, 0.08, 0.2, 0.52, at, false, "triangle"); break;
      case "latch": this.burst("white", 0.05, 0.5, 2400, 1200, 1.2, 0, at); this.blip(320, 0.04, 0.12, 0.01, at, false, "square"); break;
      case "seat": this.blip(180, 0.07, 0.3, 0, at, false, "triangle"); this.burst("white", 0.04, 0.35, 3000, 1500, 1, 0.02, at); break;
      case "click": this.burst("white", 0.025, 0.4, 3200, 2000, 1.5, 0, at); break;
      case "door": this.burst("pink", 0.35, 0.3, 300, 700, 2, 0, at); this.blip(90, 0.1, 0.25, 0.32, at, false, "triangle"); break;
      case "breaker": this.blip(70, 0.25, 0.6, 0, at, false, "square"); this.burst("white", 0.08, 0.6, 1800, 600, 1, 0, at); break;
      case "roller": this.burst("pink", 2.2, 0.45, 220, 480, 4, 0, at); for (let i = 0; i < 14; i++) this.blip(110, 0.05, 0.1, i * 0.15, at, false, "square"); break;
      case "truck": for (let i = 0; i < 4; i++) this.blip(1040, 0.3, 0.08, i * 0.7, at, false, "square"); break;
      case "chair": this.burst("pink", 0.25, 0.2, 500, 250, 2); break;
      case "deny": this.blip(196, 0.12, 0.2, 0, undefined, true, "square"); this.blip(147, 0.16, 0.2, 0.1, undefined, true, "square"); break;
      case "tick": this.blip(1400, 0.03, 0.12, 0, undefined, true); break;
      case "cash": this.blip(1175, 0.08, 0.14, 0, undefined, true); this.blip(1568, 0.14, 0.14, 0.07, undefined, true); break;
      case "claude": this.blip(1320, 0.06, 0.2, 0, at); this.blip(1760, 0.09, 0.2, 0.06, at); break;
      case "strike": this.blip(60, 0.5, 0.35, 0, at, false, "triangle"); this.burst("white", 0.12, 0.25, 5000, 2000, 1, 0, at); break;
      case "gantry": this.burst("pink", 1.2, 0.3, 700, 1500, 6, 0, at); break;
      case "milestone": [784, 988, 1175, 1568].forEach((f, i) => this.blip(f, 0.18, 0.14, i * 0.09, undefined, true)); break;
    }
  }
  /** Footsteps: call with metres walked this frame. Plays the next sample of the surface's set, with a little pitch and level variation. */
  step(dist: number, perforated: boolean): void {
    this.stepAcc += dist;
    if (this.stepAcc <= 0.72 || !this.ctx) return;
    this.stepAcc = 0; const set = this.steps[perforated ? "perforated" : "hard"].filter(Boolean); if (!set.length) return;
    const src = this.ctx.createBufferSource(); src.buffer = set[this.stepN++ % set.length]; src.playbackRate.value = 0.94 + ((this.stepN * 7) % 5) * 0.03;
    const g = this.ctx.createGain(); g.gain.value = 0.32 + ((this.stepN * 3) % 4) * 0.03; src.connect(g); g.connect(this.world); src.start();
  }
  /**
   * Offline render of the hall bed as heard from the middle of the cold aisle, measured with BS.1770 K-weighting
   * (ungated integrated loudness). Mirrors the live graph: room tone plus one hum per rack through the same gains.
   */
  static async measureBed(rackPositions: [number, number][], listener: [number, number] = [6, 4.2], serversPerRack = 10, seconds = 6): Promise<{ lufs: number; peak: number }> {
    const sr = 48000, ctx = new OfflineAudioContext(1, sr * seconds, sr);
    const pink = noiseBuffer(ctx, "pink"), brown = noiseBuffer(ctx, "brown");
    // K-weighting: high-pass at 38 Hz, then a +4 dB shelf above 1.5 kHz
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 38; hp.Q.value = 0.5;
    const shelf = ctx.createBiquadFilter(); shelf.type = "highshelf"; shelf.frequency.value = 1500; shelf.gain.value = 4;
    const master = ctx.createGain(); master.gain.value = 0.8 * 0.5;       // default master volume x the engine's master trim
    const hall = ctx.createGain(); hall.gain.value = HALL_TRIM; hall.connect(master); master.connect(hp); hp.connect(shelf); shelf.connect(ctx.destination);
    const tone = ctx.createBufferSource(); tone.buffer = brown; tone.loop = true; const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 120; const tg = ctx.createGain(); tg.gain.value = 0.5; tone.connect(lp); lp.connect(tg); tg.connect(hall); tone.start();
    rackPositions.forEach(([x, z], i) => {
      const s = ctx.createBufferSource(); s.buffer = pink; s.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 180; bp.Q.value = 0.7; const raw = ctx.createGain(); raw.gain.value = 0.35;
      const t1 = ctx.createOscillator(), t2 = ctx.createOscillator(); t1.frequency.value = 90 + 60 * 0.6; t2.frequency.value = (90 + 60 * 0.6) * 2.01; const tgn = ctx.createGain(); tgn.gain.value = 0.03; t1.connect(tgn); t2.connect(tgn);
      const g = ctx.createGain(); const dist = Math.max(1, Math.hypot(x - listener[0], z - listener[1], 0.6));
      g.gain.value = Math.min(1, 0.1 + serversPerRack * 0.035) * (1 / (1 + 1.1 * (dist - 1)));      // inverse-distance model, refDistance 1, rolloff 1.1
      s.connect(bp); bp.connect(g); s.connect(raw); raw.connect(g); tgn.connect(g); g.connect(hall); s.start(0, (i * 0.37) % 2); t1.start(); t2.start();
    });
    const buf = await ctx.startRendering(); const d = buf.getChannelData(0);
    let sum = 0, peak = 0; const skip = sr; for (let i = skip; i < d.length; i++) { sum += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); }
    return { lufs: -0.691 + 10 * Math.log10(sum / (d.length - skip) + 1e-12), peak };
  }
}
/** Trim on the hall bus, calibrated so a full Hall A sits at about -24 LUFS from the middle of the aisle (gate G14). */
export const HALL_TRIM = 1.0;
