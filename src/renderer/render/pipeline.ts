import * as THREE from "three/webgpu";
import { texture3D, renderOutput, emissive, vec3, pass, mrt, output, normalView, velocity, metalness, roughness, vec2, vec4, float, uniform, screenUV, mix, smoothstep, length, hash, packNormalToRGB, unpackRGBToNormal, sample } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import { lut3D } from "three/addons/tsl/display/Lut3DNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { timeU as time } from "../clock";

export const GI = { intensity: 1.2, mix: 0.3 };
export type Tier = "medium" | "high" | "ultra" | "capture";
export interface TierCfg { scale: number; reflector: number; ssr: boolean; ssgi: boolean; ao: boolean; traa: boolean }
export const TIERS: Record<Tier, TierCfg> = {
  medium: { scale: 0.75, reflector: 0.25, ssr: false, ssgi: false, ao: true, traa: true },
  high: { scale: 1.0, reflector: 0.5, ssr: true, ssgi: false, ao: true, traa: true },
  ultra: { scale: 1.0, reflector: 1.0, ssr: true, ssgi: true, ao: true, traa: true },
  capture: { scale: 2.0, reflector: 1.0, ssr: true, ssgi: true, ao: true, traa: true },
};

export interface Pipeline { render(): void; setTier(t: Tier): void; tier: Tier; grain: { value: number }; dispose(): void; /** depth of field: bokeh 0 turns it off */ setFocus(distance: number, bokeh: number): void; lut: { value: number } }

/** The house grade as a 3D LUT: a soft S-curve, cool shadows, slightly warm highlights. Built in code, no file. */
function makeLut(size = 24): THREE.Data3DTexture {
  const d = new Uint8Array(size * size * size * 4); let i = 0;
  const sc = (x: number) => { const t = Math.min(1, Math.max(0, x)); return Math.pow(t * t * (3 - 2 * t) * 0.45 + t * 0.55, 0.92); };
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    let R = sc(r / (size - 1)), G = sc(g / (size - 1)), B = sc(b / (size - 1));
    const l = 0.2126 * R + 0.7152 * G + 0.0722 * B, sh = (1 - l) * (1 - l), hi = l * l;
    R += -0.006 * sh + 0.016 * hi; G += 0.003 * sh + 0.006 * hi; B += 0.012 * sh - 0.014 * hi;
    d[i++] = Math.round(Math.min(1, Math.max(0, R)) * 255); d[i++] = Math.round(Math.min(1, Math.max(0, G)) * 255); d[i++] = Math.round(Math.min(1, Math.max(0, B)) * 255); d[i++] = 255;
  }
  const t = new THREE.Data3DTexture(d, size, size, size); t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; return t;
}

/** `emissiveTarget`: write emissive to its own fifth render target (SPEC section 6). False only where the GPU cannot take five targets; the weight then rides in a spare channel. */
export function createPipeline(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, tier: Tier, onReflector: (s: number) => void, emissiveTarget = true): Pipeline {
  const grainAmt = uniform(0.02), lutAmt = uniform(1.0), focusU = uniform(1.0), focalU = uniform(0.5), bokehU = uniform(0.0);
  const lutTex = makeLut(); const LUT_SIZE = 24;
  let rp: THREE.RenderPipeline | null = null; let rpDof: THREE.RenderPipeline | null = null; let dofOn = false; let buildDof: (() => THREE.RenderPipeline) | null = null;
  let current = tier;

  const build = (t: Tier) => {
    const cfg = TIERS[t];
    onReflector(cfg.reflector);
    rp?.dispose?.();
    rp = new THREE.RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const emLum = emissive.r.max(emissive.g).max(emissive.b).min(1.0);
    if (emissiveTarget) scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView), metalrough: vec2(metalness, roughness), velocity, emissive: vec4(emissive, 1) }));
    else scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView), metalrough: vec4(metalness, roughness, emLum, 1), velocity }));
    scenePass.getTexture("normal").type = THREE.UnsignedByteType; scenePass.getTexture("metalrough").type = THREE.UnsignedByteType;
    if (emissiveTarget) scenePass.getTexture("emissive").type = THREE.UnsignedByteType;
    const color = scenePass.getTextureNode("output");
    const depth = scenePass.getTextureNode("depth");
    const normalTex = scenePass.getTextureNode("normal");
    const mr = scenePass.getTextureNode("metalrough");
    const vel = scenePass.getTextureNode("velocity");
    const sceneNormal = sample((uv: any) => unpackRGBToNormal(normalTex.sample(uv)));

    let beauty: any = color;
    if (cfg.ao) {
      const aoPass = ao(depth, sceneNormal, camera);
      aoPass.resolutionScale = 0.5; (aoPass as any).samples.value = t === "capture" ? 16 : 8;
      (aoPass as any).radius.value = 0.35; (aoPass as any).thickness.value = 1.2; (aoPass as any).scale.value = 1.1;
      beauty = beauty.mul(vec4(aoPass.getTextureNode().r.pow(1.4).xxx, 1));
    }
    if (cfg.ssr) {
      const ssrPass = ssr(color, depth, sceneNormal, { metalnessNode: mr.r, roughnessNode: mr.g, camera });
      (ssrPass as any).resolutionScale = 0.5;
      const s: any = ssrPass;
      if (s.maxDistance) s.maxDistance.value = 6;
      if (s.thickness) s.thickness.value = 0.08;
      if (s.opacity) s.opacity.value = 0.9;
      if (s.quality) s.quality.value = t === "capture" ? 0.6 : 0.3;
      beauty = vec4(beauty.rgb.add(s.rgb.mul(s.a)), beauty.a);
    }
    if (cfg.ssgi) {
      try {
        const gi: any = ssgi(color, depth, sceneNormal, camera);
        // Offline renders must be repeatable frame for frame (gate G12). The GI node's temporal rotation is the one effect that is not,
        // so offline it runs with a fixed pattern and more samples instead.
        if (t === "capture" || new URLSearchParams(location.search).has("replay")) gi.useTemporalFiltering = false;
        if (gi.sliceCount) gi.sliceCount.value = t === "capture" ? 4 : 1;
        if (gi.stepCount) gi.stepCount.value = t === "capture" ? 12 : 4;
        if (gi.radius) gi.radius.value = t === "capture" ? 5 : 3.5;
        if (gi.giIntensity) gi.giIntensity.value = GI.intensity;
        if (t !== "capture" && "resolutionScale" in gi) gi.resolutionScale = 0.5;
        // bounce light tinted by the surface it lands on, kept subtle: it should read as LED spill, not as extra exposure
        beauty = vec4(beauty.rgb.add(gi.rgb.mul(color.rgb.add(0.03)).mul(GI.mix)), beauty.a);
      } catch (e) { console.warn("SSGI unavailable", e); }
    }
    // bloom is emissive-weighted with a threshold of 1.0: LEDs, light bars and screens glow fully, lit surfaces only where they clip
    const emTex = emissiveTarget ? scenePass.getTextureNode("emissive") : null;
    const emW = emTex ? emTex.r.max(emTex.g).max(emTex.b).min(1.0) : mr.b;
    const bloomIn = vec4(beauty.rgb.mul(emW.mul(0.75).add(0.25)), 1);
    const bloomPass = bloom(bloomIn, 1.15, 0.6, 1.0);
    const hdr: any = beauty.add(bloomPass);
    // Everything after anti-aliasing: tone map, grade (LUT), vignette, grain. The pipeline's own output transform is off
    // so the LUT works on display-referred colour.
    const finish = (rpX: THREE.RenderPipeline, withDof: boolean) => {
      let out: any = cfg.traa ? traa(hdr, depth, vel, camera) : hdr;
      if (withDof) out = dof(out, scenePass.getViewZNode(), focusU, focalU, bokehU);
      const display: any = renderOutput(vec4(out.rgb, 1), renderer.toneMapping, THREE.SRGBColorSpace);
      const graded: any = lut3D(display, texture3D(lutTex), LUT_SIZE, lutAmt);
      const d = length(screenUV.sub(0.5));
      const vig = mix(float(1.0), float(0.84), smoothstep(0.35, 0.85, d));
      const n = hash(screenUV.mul(1973.0).add(time.mul(60.0).floor())).sub(0.5).mul(grainAmt);
      rpX.outputColorTransform = false;
      rpX.outputNode = vec4(graded.rgb.mul(vig).add(n.mul(graded.rgb.add(0.02))), 1);
    };
    finish(rp, false);
    rpDof?.dispose?.(); rpDof = null;
    // The depth-of-field variant is built the first time it is needed (inspect mode, capture) and then kept.
    buildDof = () => { const r = new THREE.RenderPipeline(renderer); finish(r, true); return r; };
    current = t;
  };
  build(tier);

  return {
    get tier() { return current; },
    grain: grainAmt as any,
    lut: lutAmt as any,
    setFocus(distance: number, bokeh: number) { focusU.value = distance; focalU.value = Math.max(0.12, distance * 0.35); bokehU.value = bokeh; dofOn = bokeh > 0.001; if (dofOn && !rpDof && buildDof) rpDof = buildDof(); },
    render() { (dofOn && rpDof ? rpDof : rp!).render(); },
    setTier(t: Tier) { build(t); },
    dispose() { rp?.dispose?.(); rpDof?.dispose?.(); },
  };
}
