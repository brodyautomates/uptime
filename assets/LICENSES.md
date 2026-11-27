# Third-party assets

Everything else in UPTIME (geometry, the server front panel, monitor and wall display textures, hum, fans, alarms and one-shot sounds) is generated in code at start-up.

## Textures (`assets/textures`, resized to 512 px)

| File | Source | Licence |
|---|---|---|
| `metal_roughness.jpg`, `metal_normal.jpg` | ambientCG, **Metal009** (ambientcg.com) | CC0 1.0 |
| `rubber_roughness.jpg`, `rubber_normal.jpg` | ambientCG, **Rubber004** | CC0 1.0 |
| `perforation_alpha.jpg` | ambientCG, **SheetMetal001** (opacity map) | CC0 1.0 |
| `epoxy_roughness.jpg` | Poly Haven, **concrete_floor_painted** (roughness map, polyhaven.com) | CC0 1.0 |

## Audio (`assets/audio/footsteps`)

| File | Source | Licence |
|---|---|---|
| `hard_1..4.wav`, `perforated_1..4.wav` (footsteps) | Synthesised for this project by its build script; no third-party recording | Dedicated to the public domain, CC0 1.0 |

## Fonts

| What | Source | Licence |
|---|---|---|
| Terminal font, **JetBrains Mono** 400 and 700 | The JetBrains Mono Project Authors, via the `@fontsource/jetbrains-mono` package | SIL Open Font License 1.1 |
| Interface font | The system's own SF Pro; not bundled | n/a |

## Code dependencies

Listed in `package.json`. The main ones and their licences: three.js (MIT), Electron (MIT), xterm.js (MIT), node-pty (MIT), Model Context Protocol SDK (MIT), React (MIT), zustand (MIT), zod (MIT).
