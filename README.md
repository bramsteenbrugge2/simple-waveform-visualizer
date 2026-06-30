# Simple Waveform Visualizer

A full-screen audio recording visualizer. You start in an **in-app settings
screen**, press **Start**, and the app goes full-screen black with a large
countdown timer. Press **Space** and it records from your chosen input while
drawing a beautiful, accurate waveform left → right. The entire screen width
represents the full duration you configured — so a 5-minute timer fills the
whole width with 5 minutes of waveform. When the countdown hits zero the
recording stops, the complete waveform stays on screen, and the audio is saved
as a **WAV** plus a **PNG** of the waveform.

Built with Electron, so the same code runs on **Windows** and **macOS**.

---

## Quick start

```bash
npm install      # first time only
npm start        # launch the app (opens the settings screen)
```

List your audio inputs from the terminal (optional — the settings screen also
has a live dropdown):

```bash
npm run devices
```

> First launch asks for **microphone permission**. On macOS allow it when
> prompted (System Settings → Privacy & Security → Microphone).

---

## How to use

1. **Settings screen** — pick your audio input, set the duration (seconds),
   tweak the waveform look, timer, and output folder. Click **Save settings**
   to remember them, or just press **Start** (which also saves).
2. **Visualizer** (full screen):

   | Key            | Action                                            |
   | -------------- | ------------------------------------------------- |
   | `Space`        | Start the countdown + recording                   |
   | `R`            | Restart (clear waveform, re-arm the timer)        |
   | `Esc`          | Stop and go back to the settings screen           |
   | `Ctrl/⌘ + Q`   | Quit the app                                       |

3. When the timer reaches `00:00` the recording stops automatically and the
   files are written. The on-screen status shows where they were saved.

---

## Interactive web remote

The app runs a small web server so you can review recordings and reshape the
waveform from any browser — including your phone — and mirror the result onto the
full-screen display in real time.

- The URL(s) are shown in the **Web remote** bar at the bottom of the settings
  screen (e.g. `http://localhost:8080` and a LAN address like
  `http://192.168.1.118:8080`). Click **Open in browser**, or type the LAN URL on
  another device.
- Pick a recording → its waveform is re-rendered from the actual WAV audio.
- **Height / gain slider** rescales the waveform vertically (great when a take
  was recorded too quietly). A PNG can't be rescaled, so this re-renders live.
- **Mirror to full screen** (on by default): the selected recording loads onto
  the full-screen window and the slider rescales it there too, live.
- **Export PNG** saves a new image at the adjusted height (originals untouched),
  named `<recording>_x<scale>.png` in the output folder.
- **Set as app default** persists the current height as `waveform.amplitudeScale`
  so future full-screen recordings use it (this is manual — nothing is changed
  automatically).

Settings live in `config.json` under `web`:

```jsonc
"web": {
  "enabled": true,   // serve the web remote
  "port": 8080,
  "lan": true        // true = reachable from other devices on your network; false = localhost only
}
```

> Security: with `lan: true` the page and your recordings are reachable by any
> device on the local network. Use it on trusted networks; set `lan: false` (or
> untick **Allow LAN devices**) to restrict to this computer.

## Configuration

Settings are stored in **`config.json`** (next to `package.json` in dev, or next
to the executable in a packaged build). The in-app settings screen reads and
writes this file, and you can also edit it by hand. Anything missing falls back
to the defaults in `src/config-defaults.js`.

```jsonc
{
  "durationSeconds": 300,        // countdown length; full width = this duration
  "inputDevice": "",             // part of a device name; "" = system default
  "channels": 1,                 // 1 = mono, 2 = stereo
  "sampleRate": 0,               // 0 = device default (e.g. 48000)
  "background": "#000000",

  "output": {
    "saveWav": true,
    "savePng": true,
    "directory": "./recordings",      // base folder for everything (relative paths resolve next to config.json)
    "filenamePrefix": "recording",    // files: <prefix>_<YYYY-MM-DD_HH-MM-SS>.wav / .png
    "subfolderPerRecording": false    // true = each recording gets its own timestamped subfolder
  },

  "waveform": {
    "style": "glowLine",         // glowLine | filledGradient | bars
    "color": "#27e0ff",
    "glow": 26,
    "lineWidth": 2.5,
    "centerLineWidth": 1.5,      // (advanced — file only)
    "amplitudeScale": 1.0,
    "headroom": 0.9,
    "showBaseline": true,
    "barWidth": 2,               // bars style only (advanced — file only)
    "barGap": 1                  // bars style only (advanced — file only)
  },

  "timer": {
    "position": "top",           // top | center | bottom
    "color": "#ffffff",
    "fontSize": 140,
    "opacity": 0.92,             // (advanced — file only)
    "showMilliseconds": false,
    "fontFamily": "'SF Mono','Consolas','Menlo','Roboto Mono',monospace"
  },

  "hints": { "show": true, "color": "#7a8a90" }
}
```

### Output files & folders

Everything is written under the configured **Output folder** (`output.directory`).
Each recording is named with the date and time it finished, so files sort
chronologically and never overwrite each other:

```
recordings/
  recording_2026-06-25_14-03-09.wav
  recording_2026-06-25_14-03-09.png
  recording_2026-06-25_15-21-44.wav
  recording_2026-06-25_15-21-44.png
```

Enable **Subfolder per recording** (`output.subfolderPerRecording: true`) to
instead group each take in its own folder:

```
recordings/
  recording_2026-06-25_14-03-09/
    recording_2026-06-25_14-03-09.wav
    recording_2026-06-25_14-03-09.png
  recording_2026-06-25_15-21-44/
    recording_2026-06-25_15-21-44.wav
    recording_2026-06-25_15-21-44.png
```

### Choosing an input device

Set `inputDevice` to any part of a device name (case-insensitive), e.g.
`"Scarlett"` or `"MacBook Pro Microphone"`. Run `npm run devices` or use the
settings dropdown to see exact names. Leave it empty (`""`) for the system
default.

---

## How the waveform stays accurate

Audio is captured as raw PCM on the audio thread via an `AudioWorklet`, so every
sample is seen regardless of the UI frame rate. The timeline is divided into one
bin per horizontal pixel; each incoming sample updates the **peak** of the bin
it falls into (`bin = floor(sampleIndex / samplesPerBin)`, where
`samplesPerBin = duration × sampleRate / width`). Bins fill from the left as
time advances, so at `00:00` the full width is exactly the full duration. The
saved WAV is the same captured PCM (16-bit), and the PNG is the rendered
waveform canvas.

---

## Packaging into a real app

Build installers locally (each on its own OS):

```bash
npm run dist:win    # Windows installer (.exe / NSIS)  — run on Windows
npm run dist:mac    # macOS .dmg                        — run on macOS
```

Output lands in `dist/`. In a packaged build the install location is read-only,
so `config.json` and the default `recordings/` folder live in the per-user data
directory instead (Windows: `%APPDATA%\Waveform Visualizer\`, macOS:
`~/Library/Application Support/Waveform Visualizer/`). Editing settings inside
the app writes there. Set an absolute `output.directory` to save recordings
anywhere you like. The macOS microphone entitlement is configured in
`build/entitlements.mac.plist`; code signing/notarization is not set up here.

### Releases (Windows .exe + macOS .dmg)

`.github/workflows/release.yml` builds both installers on GitHub Actions and
attaches them to a GitHub Release. To cut a release, bump the version and push a
matching tag:

```bash
npm version patch        # or: minor / major  (updates package.json + creates the tag)
git push && git push --tags
```

The workflow runs on `windows-latest` (builds the `.exe`) and `macos-latest`
(builds the `.dmg`), then publishes a Release for the tag with both files
attached. You can also run it manually from the Actions tab. The macOS build is
**unsigned**, so first launch needs right-click → Open (or
`xattr -dr com.apple.quarantine` on the `.app`).

### LAN access (use the web remote from your phone)

With `web.lan: true` (default) the server listens on all interfaces and the
settings screen shows your LAN URL, e.g. `http://192.168.1.118:8080`. On Windows
you also need to allow inbound traffic through the firewall once:

```powershell
# run in an elevated PowerShell (Administrator)
New-NetFirewallRule -DisplayName "Waveform Visualizer (8080)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -Profile Private,Domain
```

Then open the LAN URL on any device on the same network. Set `web.lan: false`
(or untick **Allow LAN devices**) to restrict to this computer.

---

## Project layout

```
config.json              persisted settings (created on first run)
src/
  main.js                Electron main process (window, config I/O, file saving)
  preload.js             secure bridge (contextBridge) to the renderer
  index.html             settings screen + visualizer markup
  styles.css             styling for both screens
  renderer.js            UI logic, audio capture, timeline binning, drawing
  recorder-worklet.js    AudioWorklet that forwards raw PCM
  config-defaults.js     default configuration
  devices.html/js        headless helper for `npm run devices`
```
