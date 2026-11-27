import * as THREE from "three/webgpu";
import { reflector, positionWorld, cameraPosition, float, vec3, mix, smoothstep, fract, abs, min, max, texture, color, step } from "three/tsl";
import { hashBlur } from "three/addons/tsl/display/hashBlur.js";

// CC0 texture maps (assets/textures, see assets/LICENSES.md): brushed metal and rubber from ambientCG, perforation alpha from ambientCG,
// floor roughness from Poly Haven.
const loader = new THREE.TextureLoader();
function tex(name: string, repeat = 1, srgb = false): THREE.Texture {
  const t = loader.load(new URL(`../../../assets/textures/${name}.jpg`, import.meta.url).href);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); t.anisotropy = 8; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; return t;
}
export const TEX = { metalRough: tex("metal_roughness", 2), metalNormal: tex("metal_normal", 2), rubberRough: tex("rubber_roughness", 3), rubberNormal: tex("rubber_normal", 3), perforation: tex("perforation_alpha"), epoxyRough: tex("epoxy_roughness") };

export interface Floor { material: THREE.MeshStandardNodeMaterial; target: THREE.Object3D; setResolution(scale: number): void; /** Keep small props (layer 1) out of the mirrored render. */ excludeSmall(camera: THREE.Camera): boolean }

/** Polished epoxy floor with a true planar mirror reflection (SPEC section 6, reflection stack 1). */
export function makeFloor(resolutionScale = 0.5): Floor {
  const refl = reflector({ resolutionScale, generateMipmaps: false, bounces: false });
  refl.target.rotateX(-Math.PI / 2);

  const m = new THREE.MeshStandardNodeMaterial();
  // 0.6 m tile seams, very faint
  const g = positionWorld.xz.div(0.6);
  const fx = abs(fract(g.x).sub(0.5));
  const fz = abs(fract(g.y).sub(0.5));
  const seam = smoothstep(0.492, 0.5, max(fx, fz));
  // hot aisles (behind the rack rows) use perforated tiles
  const x = positionWorld.x, z = positionWorld.z;
  const band = (v: any, a: number, b: number) => step(a, v).mul(step(v, b));
  const hotAB = band(z, 0.0, 2.1).add(band(z, 6.3, 9.0)).mul(band(x, 3.0, 9.0).add(band(x, 14.4, 21.6)));
  const hotC = band(z, 9.9, 11.1).add(band(z, 15.3, 16.5)).add(band(z, 20.7, 21.0)).mul(band(x, 5.4, 12.6));
  const hot = min(hotAB.add(hotC), 1.0);
  const solid = texture(TEX.perforation, positionWorld.xz.div(0.3)).r;          // white = metal, black = hole
  const hole = hot.mul(solid.oneMinus());
  // micro-variation in the epoxy finish
  const epoxy = texture(TEX.epoxyRough, positionWorld.xz.mul(0.22)).r;
  const rough = mix(float(0.1), float(0.26), epoxy).add(seam.mul(0.3)).add(hot.mul(0.12));
  m.colorNode = mix(mix(color(0x0d1014), color(0x06080a), seam), color(0x010101), hole);
  m.roughnessNode = rough;
  m.metalnessNode = hot.mul(0.6);

  // Fresnel-weighted mirror term added as emissive radiance, blurred by roughness.
  const V = cameraPosition.sub(positionWorld).normalize();
  const ndv = max(V.dot(vec3(0, 1, 0)), 0.0);
  const fres = float(0.07).add(float(0.93).mul(ndv.oneMinus().pow(4.0)));
  const strength = min(fres.mul(1.15), 0.92).mul(seam.oneMinus().mul(0.7).add(0.3)).mul(hole.oneMinus());
  const blurred = (hashBlur as any)(refl, rough.mul(0.035), { repeats: float(3) });
  m.emissiveNode = blurred.rgb.mul(strength);
  return { material: m, target: refl.target, setResolution: (s) => { (refl as any).reflector.resolutionScale = s; },
    excludeSmall: (camera) => { try { const vc = (refl as any).reflector.getVirtualCamera(camera); vc.layers.disable(1); return !vc.layers.isEnabled(1); } catch { return false; } } };
}

/**
 * A self-lit surface (LEDs, light bars, screens). It is an unlit standard material whose light goes out through `emissive`,
 * so the scene pass can tell real light sources from lit surfaces and weight the bloom toward them.
 */
export function glow(node: any): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial(); m.lights = false; m.colorNode = color(0x000000); m.emissiveNode = node; m.roughness = 1; m.metalness = 0; return m;
}

export const mats = {
  rackMetal: () => { const m = new THREE.MeshStandardNodeMaterial({ color: 0x0b0c0e, roughness: 0.75, metalness: 0.85, roughnessMap: TEX.metalRough, normalMap: TEX.metalNormal }); m.normalScale = new THREE.Vector2(0.25, 0.25); return m; },
  rubber: () => { const m = new THREE.MeshStandardNodeMaterial({ color: 0x0c0d0e, roughness: 1.0, metalness: 0, roughnessMap: TEX.rubberRough, normalMap: TEX.rubberNormal }); m.normalScale = new THREE.Vector2(0.6, 0.6); return m; },
  perforated: () => { const m = new THREE.MeshStandardNodeMaterial({ color: 0x0a0b0d, roughness: 0.5, metalness: 0.8, alphaMap: TEX.perforation, alphaTest: 0.5, side: THREE.DoubleSide }); return m; },
  darkPlastic: () => new THREE.MeshStandardNodeMaterial({ color: 0x0a0b0c, roughness: 0.6, metalness: 0.1 }),
  wall: () => new THREE.MeshStandardNodeMaterial({ color: 0x23272c, roughness: 0.82, metalness: 0.0 }),
  wallDark: () => new THREE.MeshStandardNodeMaterial({ color: 0x14171a, roughness: 0.75, metalness: 0.1 }),
  ceiling: () => new THREE.MeshStandardNodeMaterial({ color: 0x0b0c0e, roughness: 0.9, metalness: 0.0 }),
  steel: () => new THREE.MeshStandardNodeMaterial({ color: 0x6d737a, roughness: 0.35, metalness: 1.0 }),
  glass: () => { const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x9fb4c4, roughness: 0.03, metalness: 0.0, transparent: true, opacity: 0.16 }); m.depthWrite = false; m.envMapIntensity = 2.2; m.side = THREE.DoubleSide; return m; },
  emissive: (hex: number, intensity: number) => glow(color(hex).mul(intensity)),
};
