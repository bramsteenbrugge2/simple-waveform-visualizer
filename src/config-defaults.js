// Default configuration. The in-app settings screen and config.json both
// build on top of this, so any missing key falls back to these values.
module.exports = {
  durationSeconds: 300,        // countdown length; the full screen width = this duration
  inputDevice: "",             // device name (or part of it); "" = system default input
  outputDevice: "",            // playback output device name (or part of it); "" = system default
  channels: 1,                 // 1 = mono, 2 = stereo
  sampleRate: 0,               // 0 = use the device's default sample rate (e.g. 48000)
  background: "#000000",

  output: {
    saveWav: true,
    savePng: true,
    directory: "./recordings",     // base folder for everything; relative paths resolve next to config.json
    filenamePrefix: "recording",   // files are named <prefix>_<YYYY-MM-DD_HH-MM-SS>.wav / .png
    subfolderPerRecording: false   // true = put each recording's files in their own timestamped subfolder
  },

  waveform: {
    style: "glowLine",         // glowLine | filledGradient | bars
    color: "#27e0ff",
    glow: 26,                  // glow / bloom radius in px
    lineWidth: 2.5,
    centerLineWidth: 1.5,
    amplitudeScale: 1.0,
    smoothing: 0.0,            // 0 = raw/edgy ... 1 = very smooth (visual only; never affects the audio)
    compress: 0.0,             // 0 = linear ... 1 = strong log compression of peaks (visual only)
    headroom: 0.9,             // 0..1 fraction of half-height the peak may reach
    showBaseline: true,
    singleSided: false,        // true = show only the part above zero (positive half)
    barWidth: 2,               // bars style only (px)
    barGap: 1                  // bars style only (px)
  },

  timer: {
    show: true,                // false = hide the countdown entirely
    position: "top",           // top | center | bottom
    color: "#ffffff",
    fontSize: 140,
    opacity: 0.92,
    showMilliseconds: false,
    fontFamily: "'SF Mono','Consolas','Menlo','Roboto Mono',monospace"
  },

  hints: {
    show: true,
    color: "#7a8a90"
  },

  // projection region: draw the waveform only inside a sub-rectangle of the screen
  // (e.g. positioned over a person's body in a projection). Values are 0..1 fractions.
  region: {
    enabled: false,
    showOutline: false,   // draw the region's rectangle outline on the projection (for alignment)
    markers: false,       // draw full-height vertical guide lines at the region's left/right edges
    x: 0.3,
    y: 0.1,
    width: 0.4,
    height: 0.8
  },

  web: {
    enabled: true,    // serve the interactive web remote / inspector
    port: 8080,
    lan: true         // true = reachable from other devices on the network; false = localhost only
  }
};
