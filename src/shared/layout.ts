// World layout (SPEC appendix I). 1 unit = 1 m. x east, z north, y up. Origin = Hall A south-west floor corner.
export type HallId = "A" | "B" | "C";

export const RACK = { w: 0.6, d: 1.2, h: 2.0, bays: 10, bayH: 0.1778, bayBase: 0.09 };
export const CEILING = 3.2;

export interface HallBox { id: HallId; x0: number; x1: number; z0: number; z1: number; slots: number; rows: { z: number; rot: number; x0: number; n: number }[] }

// rot 0 = rack front faces +z (north); rot PI = front faces -z (south). z is the row's footprint centre.
export const HALLS: Record<HallId, HallBox> = {
  A: { id: "A", x0: 0, x1: 12, z0: 0, z1: 9, slots: 12, rows: [
    { z: 2.7, rot: 0, x0: 4.5, n: 6 }, { z: 5.7, rot: Math.PI, x0: 4.5, n: 6 } ] },
  B: { id: "B", x0: 12, x1: 24, z0: 0, z1: 9, slots: 16, rows: [
    { z: 2.7, rot: 0, x0: 15.9, n: 8 }, { z: 5.7, rot: Math.PI, x0: 15.9, n: 8 } ] },
  C: { id: "C", x0: 0, x1: 18, z0: 9, z1: 21, slots: 32, rows: [
    { z: 11.7, rot: 0, x0: 6.9, n: 8 }, { z: 14.7, rot: Math.PI, x0: 6.9, n: 8 },
    { z: 17.1, rot: 0, x0: 6.9, n: 8 }, { z: 20.1, rot: Math.PI, x0: 6.9, n: 8 } ] },
};

export function slotPose(hall: HallId, slot: number): { x: number; z: number; rot: number } {
  let s = slot;
  for (const row of HALLS[hall].rows) {
    if (s < row.n) return { x: row.x0 + s * RACK.w, z: row.z, rot: row.rot };
    s -= row.n;
  }
  throw new Error(`bad slot ${hall}/${slot}`);
}

export const rackId = (hall: HallId, n: number) => `${hall}-R${String(n).padStart(2, "0")}`;
export const serverId = (rack: string, bay: number) => `${rack}-S${String(bay).padStart(2, "0")}`;

export const CONTROL = { x0: -4, x1: 0, z0: 3, z1: 6, doorZ0: 3.0, doorZ1: 3.9 };
export const LOADING = { x0: -4, x1: 0, z0: 6, z1: 9 };
export const PLANT = { x0: -3, x1: 0, z0: 0, z1: 3 };
export const SPAWN = { x: 0.6, z: 4.2, yaw: -Math.PI / 2 }; // facing +x
export const DESK = { x: -1.0, z: 4.5, top: 0.74, w: 1.8, d: 0.8 };
export const SEAT_EYE = { x: -1.55, y: 1.25, z: 4.5, fov: 50 };
export const MONITOR = { w: 0.6, h: 0.34, x: -0.75, y: 1.2, z: 4.5, sideAngle: (25 * Math.PI) / 180 };
export const EYE = 1.68;

export const STATUS = { green: 0x35e06f, amber: 0xffb020, red: 0xff3b30, cyan: 0x39d0ff, white: 0xdfe8ff };
