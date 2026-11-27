# UPTIME

UPTIME is a first-person data center game for macOS. You walk the floor, pull servers out of racks, swap their parts and sell compute. The desk in the game has three monitors: an operations app, a real terminal that runs your own shell, and a floor map that can switch to a live view of a desktop.

This is release 0.1, the first in an ongoing series. Expect rough edges.

## Requirements

- macOS on Apple silicon. The packaging script and the terminal helper target `darwin-arm64`. Other platforms are untested.
- Node.js and npm. The render script runs a TypeScript file with `node` directly, so use a Node version that supports that (22.18 or later).
- Optional: [Claude Code](https://claude.com/claude-code) installed as `claude`, if you want an AI agent to run the facility from the in-game terminal.
- Optional: `ffmpeg`, for rendering replays to video.

## Install and run

```
npm install
npm run dev          # run in development
npm run build        # compile to out/
npm run start        # run the compiled build
npm run dist         # build dist/UPTIME-0.1.0-arm64.dmg (unsigned)
```

Launch options:

| Command | Effect |
|---|---|
| `npx electron . --demo` | Turns on the director keys (F1 to F9). Run `npm run build` first. |
| `UPTIME_PRESET=demo npx electron .` | Skips the menu and starts in a preset: `fresh`, `demo`, `showcase` or `mega` |
| `npx electron . --windowed` | Starts in a window instead of full screen |

## Controls

| Key | Action |
|---|---|
| W A S D, mouse | Walk and look. Shift to move faster. Click the view to capture the mouse. |
| E / Q | Use / put back or close |
| X | Exploded view while a server is open |
| F, H, Tab, P | Flashlight, hide the HUD, tablet, pause |
| Cmd+E | Stand up from the desk |
| Cmd+1 / 2 / 3 | Ops app, terminal, floor map |
| Cmd+D | Switch the right monitor between the floor map and a desktop |
| Ctrl+Cmd+F | Toggle full screen |

Every key except the Cmd chords can be rebound under Settings on the left monitor. The game is locked to 60 fps by default. The lock is a setting.

## The terminal

The center monitor is a real shell with your permissions. Anything you run there runs on your computer. Streamer mode gives it a short prompt, but it cannot hide what your tools print.

To let Claude Code run the facility, sit at the desk, focus the center monitor and type `claude`. The terminal starts in the game's workspace folder, which holds a `.mcp.json` pointing at the game and a `CLAUDE.md` describing the tools. Claude Code asks once whether to trust that project server. The server listens on 127.0.0.1 only and needs a token that is created fresh on every launch.

How much the agent may spend is set by **Claude autonomy** in Settings: Advise (read only), Operate (no purchase over 25% of cash) or Full.

## Showing your own machines

Cmd+D on the right monitor shows a desktop. There are two modes.

**This computer's screen (default).** With nothing configured, the monitor mirrors your Mac's screen, view only. macOS asks for the Screen Recording permission the first time.

**A remote computer over VNC.** To show and control another machine:

1. Copy `uptime.config.example.json` to `uptime.config.json`. That file is ignored by git.
2. Set `remoteDesktop.url` to the WebSocket address of the machine's VNC server (`ws://` or `wss://`), and `remoteDesktop.name` to a label for it.

```json
{
  "remoteDesktop": {
    "name": "my-server",
    "url": "wss://vnc.example.com/websockify"
  }
}
```

The game looks for the config file at the path in `UPTIME_CONFIG`, then in its user data folder, then next to `package.json`. You can also skip the file and set `UPTIME_REMOTE_URL` and `UPTIME_REMOTE_NAME` in the environment.

Limits:

- The mouse uses the KasmVNC pointer message, so the remote machine must run KasmVNC. Other VNC servers are not supported in this release.
- The game does not send a VNC password. Put the machine behind your own VPN or an authenticating proxy, and treat the URL as a secret if it carries a credential.

## Recording

- **Live:** record the window. Settings has a 9:16 guide frame.
- **Replay:** press F8 in demo mode to start and stop a replay log, then run

  ```
  npm run render-replay -- "<path to the .uptime-replay folder>" --size 2160x3840 --fps 60
  ```

  This re-renders the session offline and writes a ProRes master and an H.264 preview. `--camera track.json` replaces the recorded view with an authored camera path.

## Checks

```
npm run typecheck    # TypeScript
npm run lint         # project lint rules
npm test             # simulation tests
npm run gates        # builds, then runs the end-to-end gates and writes gates-report.md
node scripts/gates.mjs G6 G12                    # run only some gates
UPTIME_GATES_PACKAGED=1 node scripts/gates.mjs   # run the gates against the packaged app in dist/
```

The gates open the game and take a while. Gates G11 and G13 use your Claude login and a little usage. G16 does too when `claude` is installed.

Code comments that mention "SPEC" refer to an internal design document that is not part of this repository.

## Third-party assets

See [assets/LICENSES.md](assets/LICENSES.md).
