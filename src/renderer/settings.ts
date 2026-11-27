// Settings (SPEC appendix K). Stored by the main process in settings.json.
export interface Settings {
  "graphics.tier": "Medium" | "High" | "Ultra"; "graphics.resolutionScale": number; "graphics.vsync": boolean; "graphics.fov": number; "graphics.filmGrain": boolean;
  "camera.guide916": boolean; "controls.sensitivity": number; "controls.invertY": boolean; "comfort.headBob": boolean; "comfort.cameraEase": boolean; "comfort.textScale": number;
  "audio.master": number; "audio.world": number; "audio.ui": number; "sim.pauseWhenUnfocused": boolean;
  "claude.autonomy": "Advise" | "Operate" | "Full"; "claude.bootInto": boolean; "terminal.workspace": string; "terminal.fontSize": number;
  "streamer.enabled": boolean; "demo.director": boolean; "replay.logging": boolean;
  "first.noticesSeen": boolean; "graphics.steppedDown": string; "controls.keys": Record<string, string>;
}
export const DEFAULTS: Settings = {
  "graphics.tier": "High", "graphics.resolutionScale": 1, "graphics.vsync": true, "graphics.fov": 75, "graphics.filmGrain": true,
  "camera.guide916": false, "controls.sensitivity": 1, "controls.invertY": false, "comfort.headBob": false, "comfort.cameraEase": true, "comfort.textScale": 1,
  "audio.master": 0.8, "audio.world": 1, "audio.ui": 0.7, "sim.pauseWhenUnfocused": false,
  "claude.autonomy": "Operate", "claude.bootInto": false, "terminal.workspace": "", "terminal.fontSize": 14,
  "streamer.enabled": false, "demo.director": false, "replay.logging": false,
  "first.noticesSeen": false, "graphics.steppedDown": "", "controls.keys": {},
};
