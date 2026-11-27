// The 12 named camera poses (SPEC appendix H). pos is the eye position; yaw 0 looks toward -z, +yaw turns left.
export interface Bookmark { name: string; pos: [number, number, number]; yaw: number; pitch: number; fov: number; mode?: string }
const E = -Math.PI / 2, W = Math.PI / 2, N = Math.PI, S = 0;
export const BOOKMARKS: Bookmark[] = [
  { name: "entry_aisle", pos: [0.6, 1.68, 4.2], yaw: E, pitch: -0.02, fov: 75 },
  { name: "aisle_low_floor", pos: [1.6, 0.3, 4.2], yaw: E, pitch: 0.05, fov: 60 },
  { name: "aisle_end_back", pos: [11.2, 1.68, 4.2], yaw: W, pitch: -0.03, fov: 75 },
  { name: "rack_front_close", pos: [4.9, 1.45, 4.55], yaw: S + 0.25, pitch: -0.05, fov: 60 },
  { name: "server_pulled", pos: [4.5, 1.5, 4.5], yaw: S, pitch: -0.5, fov: 60, mode: "pulled" },
  { name: "server_exploded", pos: [4.5, 1.5, 4.5], yaw: S, pitch: -0.5, fov: 60, mode: "exploded" },
  { name: "desk_seated", pos: [-1.55, 1.25, 4.5], yaw: E, pitch: -0.04, fov: 50, mode: "seated" },
  { name: "desk_over_shoulder", pos: [-2.6, 1.7, 5.3], yaw: E + 0.35, pitch: -0.18, fov: 55 },
  { name: "hall_through_glass", pos: [-3.2, 1.68, 4.9], yaw: E + 0.05, pitch: -0.02, fov: 65 },
  { name: "loading_bay_delivery", pos: [-0.5, 1.68, 8.6], yaw: W - 0.5, pitch: -0.34, fov: 70 },
  { name: "hot_aisle_rear", pos: [2.6, 1.68, 1.0], yaw: E, pitch: -0.02, fov: 70 },
  { name: "hall_b_reveal", pos: [9.0, 1.68, 4.2], yaw: E, pitch: 0.0, fov: 70, mode: "hallB" },
];
void N;
