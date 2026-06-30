'use strict';

const $ = (id) => document.getElementById(id);

// ---------------- shared state ----------------
let cfg;                 // current working config
let wf;                  // cfg.waveform shortcut
let duration = 300;

let screen = 'config';   // 'config' | 'visualizer'
let state = 'idle';      // visualizer sub-state: idle | recording | finishing | done

// canvas / waveform buffers
let canvas, g, dpr = 1, numBins = 0;
let peakAbs;             // per-bin peak absolute amplitude (raw — never altered by visual controls)
let renderPeaks;        // peakAbs after optional smoothing, used only for drawing
let gainScale = 1;      // effective vertical scale used for the current draw
let geoL = 0, geoW = 0; // horizontal extent (px) the waveform is drawn into (full width, or a region)

// live visual overrides for a shown recording (review/done) — do NOT touch the
// audio or the configured recording amplitude/smoothing
let reviewGain = 1;
let reviewSmooth = 0;
let reviewCompress = 0;
let compressAmt = 0;      // effective compression for the current draw
let reviewChannel = null; // decoded mono samples of a reviewed file (for re-binning on resize)
let reviewBytes = null;   // original WAV bytes of the reviewed recording (for playback)
let currentFile = null;

// playback
let audioEl = null, playUrl = null;
let playing = false, loopOn = false, playFrac = 0, playRaf = 0;

// reusable buffers for the smoothing (box blur) filter
let _smoothBuf = null, _prefix = null;

// audio
let stream, audioCtx, srcNode, node, gainNode, recSampleRate = 48000;
let recordedChunks = null;
let samplesReceived = 0, samplesPerBin = 1, currentBin = -1;

// timing
let startTime = 0, rafId = 0, recArmTime = 0;
const START_FALLBACK_MS = 2000; // if no audio arrives, start the countdown anyway

// transition guards
let entering = false;
let starting = false;

// ================================================================
// helpers
// ================================================================
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function pad(n) { return String(n).padStart(2, '0'); }

function hexA(hex, a) {
  hex = String(hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const gg = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  return `rgba(${r},${gg},${b},${a})`;
}

function fmtTime(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  let o = pad(m) + ':' + pad(s);
  if (cfg && cfg.timer.showMilliseconds) {
    o += '.' + String(Math.floor((sec * 1000) % 1000)).padStart(3, '0');
  }
  return o;
}

// ================================================================
// config form
// ================================================================
function setVal(id, v) { const el = $(id); if (el) el.value = v; }
function setChk(id, v) { const el = $(id); if (el) el.checked = !!v; }

function updatePretty() {
  const secs = Math.max(1, parseInt($('f-duration').value, 10) || 0);
  $('f-duration-pretty').textContent = '(' + fmtTimeRaw(secs) + ')';
}
function fmtTimeRaw(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return pad(m) + ':' + pad(s); }

function syncRangeLabels() {
  $('f-glow-val').textContent = $('f-glow').value;
  $('f-linewidth-val').textContent = (+$('f-linewidth').value).toFixed(1);
  $('f-amp-val').textContent = (+$('f-amp').value).toFixed(1) + '×';
  $('f-smooth-val').textContent = Math.round((+$('f-smooth').value) * 100) + '%';
  $('f-compress-val').textContent = Math.round((+$('f-compress').value) * 100) + '%';
  $('f-headroom-val').textContent = Math.round((+$('f-headroom').value) * 100) + '%';
  $('f-timersize-val').textContent = $('f-timersize').value + 'px';
}

function populateForm(c) {
  setVal('f-duration', c.durationSeconds);
  setVal('f-channels', String(c.channels));
  setVal('f-samplerate', String(c.sampleRate));
  setVal('f-style', c.waveform.style);
  setVal('f-color', c.waveform.color);
  setVal('f-glow', c.waveform.glow);
  setVal('f-linewidth', c.waveform.lineWidth);
  setVal('f-amp', c.waveform.amplitudeScale);
  setVal('f-smooth', c.waveform.smoothing || 0);
  setVal('f-compress', c.waveform.compress || 0);
  setVal('f-headroom', c.waveform.headroom);
  setChk('f-baseline', c.waveform.showBaseline);
  setChk('f-single', c.waveform.singleSided);
  setChk('f-timershow', c.timer.show !== false);
  setVal('f-timerpos', c.timer.position);
  setVal('f-timersize', c.timer.fontSize);
  setVal('f-timercolor', c.timer.color);
  setChk('f-ms', c.timer.showMilliseconds);
  setChk('f-savewav', c.output.saveWav);
  setChk('f-savepng', c.output.savePng);
  setVal('f-dir', c.output.directory);
  setVal('f-prefix', c.output.filenamePrefix);
  setChk('f-subfolder', c.output.subfolderPerRecording);
  setVal('f-bg', c.background);
  if (c.web) {
    setChk('f-web-enabled', c.web.enabled);
    setVal('f-web-port', c.web.port);
    setChk('f-web-lan', c.web.lan);
  }
  updatePretty();
  syncRangeLabels();
}

function readForm() {
  // start from current cfg so advanced keys (centerLineWidth, barWidth/gap,
  // opacity, fontFamily, hints) that aren't in the form are preserved.
  const out = JSON.parse(JSON.stringify(cfg));
  out.durationSeconds = Math.max(1, parseInt($('f-duration').value, 10) || 1);
  out.inputDevice = $('f-device').value;
  out.outputDevice = $('f-output') ? $('f-output').value : (cfg.outputDevice || '');
  out.channels = parseInt($('f-channels').value, 10) || 1;
  out.sampleRate = parseInt($('f-samplerate').value, 10) || 0;
  out.background = $('f-bg').value;

  out.output.saveWav = $('f-savewav').checked;
  out.output.savePng = $('f-savepng').checked;
  out.output.directory = $('f-dir').value.trim() || './recordings';
  out.output.filenamePrefix = $('f-prefix').value.trim() || 'recording';
  out.output.subfolderPerRecording = $('f-subfolder').checked;

  out.waveform.style = $('f-style').value;
  out.waveform.color = $('f-color').value;
  out.waveform.glow = +$('f-glow').value;
  out.waveform.lineWidth = +$('f-linewidth').value;
  out.waveform.amplitudeScale = +$('f-amp').value;
  out.waveform.smoothing = +$('f-smooth').value;
  out.waveform.compress = +$('f-compress').value;
  out.waveform.headroom = +$('f-headroom').value;
  out.waveform.showBaseline = $('f-baseline').checked;
  out.waveform.singleSided = $('f-single').checked;

  out.timer.show = $('f-timershow').checked;
  out.timer.position = $('f-timerpos').value;
  out.timer.fontSize = +$('f-timersize').value;
  out.timer.color = $('f-timercolor').value;
  out.timer.showMilliseconds = $('f-ms').checked;

  out.web = out.web || {};
  out.web.enabled = $('f-web-enabled').checked;
  out.web.port = parseInt($('f-web-port').value, 10) || 8080;
  out.web.lan = $('f-web-lan').checked;
  return out;
}

function updateWebInfo(info) {
  const el = $('web-urls');
  if (!el) return;
  if (info && info.enabled && info.urls && info.urls.length) {
    el.textContent = info.urls.join('    ');
  } else {
    el.textContent = info && !info.enabled ? 'disabled' : '(starting…)';
  }
}

async function updateAbsPath() {
  const el = $('f-dir-abs');
  if (!el) return;
  try {
    const abs = await api.resolveOutputDir($('f-dir').value || './recordings');
    el.innerHTML = 'Saves to: <b></b>';
    el.querySelector('b').textContent = abs;
  } catch (_) {
    el.textContent = '';
  }
}

// fill a <select> with a default option + device labels, restoring `prev`
// (exact, then partial, else a synthetic "Configured:" entry)
function fillDeviceSelect(sel, defLabel, labels, prev) {
  if (!sel) return;
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = defLabel;
  sel.appendChild(def);
  labels.forEach((label) => {
    const opt = document.createElement('option');
    opt.value = label; opt.textContent = label;
    sel.appendChild(opt);
  });
  if (!prev) { sel.value = ''; return; }
  const opts = Array.from(sel.options);
  let pick = opts.find((o) => o.value === prev) || opts.find((o) => o.value && o.value.toLowerCase().includes(prev.toLowerCase()));
  if (pick) { sel.value = pick.value; return; }
  const synthetic = document.createElement('option');
  synthetic.value = prev; synthetic.textContent = 'Configured: ' + prev;
  sel.appendChild(synthetic);
  sel.value = prev;
}

async function refreshDevices() {
  const inputs = [];
  const outputs = [];
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    tmp.getTracks().forEach((t) => t.stop());
    devices.forEach((d) => {
      if (isPseudoDevice(d)) return;
      if (d.kind === 'audioinput') inputs.push(d.label || 'Microphone');
      else if (d.kind === 'audiooutput') outputs.push(d.label || 'Speaker');
    });
  } catch (_) { /* permission denied — leave lists empty */ }
  fillDeviceSelect($('f-device'), 'System default input', inputs, cfg ? cfg.inputDevice : '');
  fillDeviceSelect($('f-output'), 'System default output', outputs, cfg ? cfg.outputDevice : '');
  try { api.reportHostDevices({ inputs, outputs }); } catch (_) {} // share with the web remote
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ================================================================
// apply config to the visualizer screen
// ================================================================
function applyVizConfig(c) {
  cfg = c;
  wf = c.waveform;
  duration = c.durationSeconds;
  document.body.style.background = c.background;

  const t = $('timer');
  t.style.fontSize = c.timer.fontSize + 'px';
  t.style.color = c.timer.color;
  t.style.opacity = c.timer.opacity;
  t.style.fontFamily = c.timer.fontFamily;
  t.style.display = (c.timer.show === false) ? 'none' : '';
  t.className = 'overlay pos-' + (c.timer.position || 'top');

  $('device').style.color = c.hints.color;
  $('status').style.color = c.hints.color;
  $('hint').style.color = c.hints.color;
  $('device').style.display = c.hints.show ? 'block' : 'none';
  $('hint').style.display = c.hints.show ? 'block' : 'none';
  $('device').textContent = c.inputDevice ? 'Input: ' + c.inputDevice : 'Input: system default';
}

// ================================================================
// canvas sizing
// ================================================================
function sizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  numBins = w;
  peakAbs = new Float32Array(numBins);
}

// ================================================================
// drawing
// ================================================================
// box-blur (moving average) over the peak envelope — visual smoothing only.
// Only the filled range [0, len) is averaged so the moving wavefront doesn't
// sag toward the not-yet-recorded (zero) bins.
function smoothInto(src, radius, len) {
  const n = src.length;
  if (len == null || len > n) len = n;
  if (!radius || len <= 0) return src;
  if (!_smoothBuf || _smoothBuf.length !== n) _smoothBuf = new Float32Array(n);
  if (!_prefix || _prefix.length !== n + 1) _prefix = new Float64Array(n + 1);
  const pre = _prefix;
  pre[0] = 0;
  for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + src[i];
  const out = _smoothBuf;
  for (let i = 0; i < len; i++) {
    const a = i - radius < 0 ? 0 : i - radius;
    const b = i + radius >= len ? len - 1 : i + radius;
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

// slider value (0..1) -> blur radius in px. Gentle curve so a small value barely
// smooths and ~75% gives what the old linear 4% gave (per user calibration).
function smoothRadius(amount, bins) {
  const e = amount * amount;
  return Math.min(900, Math.round(e * bins * 0.0034));
}

// log-ish compression of a normalized peak (0..1 -> 0..1); 0 = linear
function compressCurve(p, amount) {
  if (amount <= 0) return p;
  const k = Math.pow(10, amount * 2) - 1; // 0 .. 99
  return Math.log(1 + k * p) / Math.log(1 + k);
}

function scaledAmp(value, maxAmp) {
  let a = compressCurve(value, compressAmt) * gainScale * maxAmp;
  return a > maxAmp ? maxAmp : a;
}

function ampAt(b, maxAmp) {
  return scaledAmp(renderPeaks[b], maxAmp);
}

// map a bin index to its x pixel within the current drawing extent [geoL, geoL+geoW]
function xOf(b) { return geoL + (numBins > 1 ? (b / (numBins - 1)) * geoW : 0); }

function draw() {
  if (!canvas) return;
  const W = canvas.width, H = canvas.height;

  g.fillStyle = cfg.background;
  g.fillRect(0, 0, W, H);

  // optional projection region — draw the waveform only inside a sub-rectangle
  const reg = (cfg.region && cfg.region.enabled) ? cfg.region : null;
  geoL = reg ? Math.round(clamp(reg.x, 0, 1) * W) : 0;
  geoW = reg ? Math.max(2, Math.round(clamp(reg.width, 0.02, 1) * W)) : W;
  const regT = reg ? Math.round(clamp(reg.y, 0, 1) * H) : 0;
  const regH = reg ? Math.max(2, Math.round(clamp(reg.height, 0.02, 1) * H)) : H;

  const single = !!wf.singleSided;
  const baseY = regT + regH / 2;       // zero line stays centered (in the region)
  const maxAmp = (regH / 2) * wf.headroom;

  if (wf.showBaseline) {
    g.save();
    g.globalAlpha = 0.12;
    g.strokeStyle = wf.color;
    g.lineWidth = Math.max(1, dpr);
    g.beginPath();
    g.moveTo(geoL, baseY);
    g.lineTo(geoL + geoW, baseY);
    g.stroke();
    g.restore();
  }

  // region outline on the projection (alignment aid) — shown in any state
  if (reg && reg.showOutline) {
    g.save();
    g.strokeStyle = wf.color;
    g.globalAlpha = 0.6;
    g.lineWidth = Math.max(1, 2 * dpr);
    g.setLineDash([10 * dpr, 8 * dpr]);
    g.strokeRect(geoL + dpr, regT + dpr, geoW - 2 * dpr, regH - 2 * dpr);
    g.restore();
  }

  // full-height left/right markers (body alignment guides) — shown in any state
  if (reg && reg.markers) {
    g.save();
    g.strokeStyle = wf.color;
    g.globalAlpha = 0.85;
    g.lineWidth = Math.max(2, 3 * dpr);
    g.beginPath();
    g.moveTo(geoL, 0); g.lineTo(geoL, H);
    g.moveTo(geoL + geoW, 0); g.lineTo(geoL + geoW, H);
    g.stroke();
    g.restore();
  }

  const drawing = state === 'recording' || state === 'finishing' || state === 'done' || state === 'review';
  if (!drawing) return;
  const last = Math.min(numBins - 1, currentBin);
  if (last < 0) return;

  // pick the live visual overrides for a shown recording, else the configured values
  const reviewing = state === 'review' || state === 'done';
  gainScale = reviewing ? reviewGain : wf.amplitudeScale;
  compressAmt = reviewing ? reviewCompress : (wf.compress || 0);
  const smoothAmt = reviewing ? reviewSmooth : (wf.smoothing || 0);
  const radius = smoothRadius(smoothAmt, numBins);
  renderPeaks = radius > 0 ? smoothInto(peakAbs, radius, last + 1) : peakAbs;

  if (wf.style === 'bars') drawBars(baseY, maxAmp, last, single);
  else if (wf.style === 'filledGradient') drawFilled(baseY, maxAmp, last, single);
  else drawGlow(baseY, maxAmp, last, single);

  // playback playhead (review/done only) — within the region
  if (reviewing && (playing || playFrac > 0)) {
    const x = geoL + Math.max(0, Math.min(1, playFrac)) * geoW;
    g.save();
    g.strokeStyle = '#ffcf4a';
    g.shadowColor = '#ffcf4a';
    g.shadowBlur = 14 * dpr;
    g.lineWidth = 2 * dpr;
    g.globalAlpha = 0.95;
    g.beginPath();
    g.moveTo(x, regT);
    g.lineTo(x, regT + regH);
    g.stroke();
    g.restore();
  }
}

function drawGlow(baseY, maxAmp, last, single) {
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.shadowColor = wf.color;
  g.shadowBlur = wf.glow * dpr;
  g.strokeStyle = wf.color;

  // bright zero line over the filled region
  g.lineWidth = wf.centerLineWidth * dpr;
  g.globalAlpha = 0.85;
  g.beginPath();
  g.moveTo(geoL, baseY);
  g.lineTo(xOf(Math.max(0, last)), baseY);
  g.stroke();

  // top envelope (+ bottom mirror unless single-sided)
  g.globalAlpha = 1;
  g.lineWidth = wf.lineWidth * dpr;
  g.beginPath();
  for (let b = 0; b <= last; b++) {
    const y = baseY - ampAt(b, maxAmp);
    if (b === 0) g.moveTo(xOf(b), y); else g.lineTo(xOf(b), y);
  }
  g.stroke();
  if (!single) {
    g.beginPath();
    for (let b = 0; b <= last; b++) {
      const y = baseY + ampAt(b, maxAmp);
      if (b === 0) g.moveTo(xOf(b), y); else g.lineTo(xOf(b), y);
    }
    g.stroke();
  }
  g.restore();
}

function drawFilled(baseY, maxAmp, last, single) {
  g.save();
  g.shadowColor = wf.color;
  g.shadowBlur = wf.glow * dpr;
  if (single) {
    const grad = g.createLinearGradient(0, baseY - maxAmp, 0, baseY);
    grad.addColorStop(0, hexA(wf.color, 0.08));
    grad.addColorStop(1, hexA(wf.color, 0.95));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(geoL, baseY);
    for (let b = 0; b <= last; b++) g.lineTo(xOf(b), baseY - ampAt(b, maxAmp));
    g.lineTo(xOf(last), baseY);
    g.closePath();
    g.fill();
  } else {
    const grad = g.createLinearGradient(0, baseY - maxAmp, 0, baseY + maxAmp);
    grad.addColorStop(0, hexA(wf.color, 0.05));
    grad.addColorStop(0.5, hexA(wf.color, 0.95));
    grad.addColorStop(1, hexA(wf.color, 0.05));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(geoL, baseY - ampAt(0, maxAmp));
    for (let b = 1; b <= last; b++) g.lineTo(xOf(b), baseY - ampAt(b, maxAmp));
    for (let b = last; b >= 0; b--) g.lineTo(xOf(b), baseY + ampAt(b, maxAmp));
    g.closePath();
    g.fill();
  }
  g.restore();
}

function drawBars(baseY, maxAmp, last, single) {
  g.save();
  g.shadowColor = wf.color;
  g.shadowBlur = (wf.glow * 0.5) * dpr;
  g.fillStyle = wf.color;
  const bw = Math.max(1, wf.barWidth * dpr);
  const step = Math.max(bw + 1, (wf.barWidth + wf.barGap) * dpr);
  const xEnd = xOf(last);
  const binAt = (px) => Math.round((geoW > 0 ? (px - geoL) / geoW : 0) * (numBins - 1));
  for (let px = geoL; px <= xEnd; px += step) {
    let p = 0;
    const b0 = Math.max(0, binAt(px));
    const b1 = Math.min(last, binAt(px + step));
    for (let b = b0; b <= b1; b++) if (renderPeaks[b] > p) p = renderPeaks[b];
    let a = scaledAmp(p, maxAmp);
    if (a < dpr * 0.5) a = dpr * 0.5;
    if (single) g.fillRect(px, baseY - a, bw, a);
    else g.fillRect(px, baseY - a, bw, a * 2);
  }
  g.restore();
}

// ================================================================
// status helpers
// ================================================================
function setTimer(sec) { $('timer').textContent = fmtTime(sec); }
function status(t) { $('status').textContent = t || ''; }
function hint(t) { $('hint').textContent = t || ''; }
function showRec(on) { $('rec').classList.toggle('on', !!on); }

// ================================================================
// audio capture
// ================================================================
function isPseudoDevice(d) {
  // Windows/Chromium synthetic entries that track the rotating OS default
  if (d.deviceId === 'default' || d.deviceId === 'communications') return true;
  const l = (d.label || '').toLowerCase();
  return l.startsWith('default - ') || l.startsWith('communications - ');
}

async function pickDeviceId(match) {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    tmp.getTracks().forEach((t) => t.stop());
    if (!match) return undefined; // system default
    const m = match.toLowerCase();
    // only consider real devices, never the "Default -"/"Communications -" aliases
    const inputs = devices.filter((d) => d.kind === 'audioinput' && !isPseudoDevice(d));
    const exact = inputs.find((d) => d.label && d.label.toLowerCase() === m);
    if (exact) return exact.deviceId;
    const partial = inputs.find((d) => d.label && d.label.toLowerCase().includes(m));
    return partial ? partial.deviceId : undefined;
  } catch (e) {
    if (!match) return undefined;
    throw e;
  }
}

function onAudio(e) {
  if (state !== 'recording') return;
  // Start the countdown on the first real sample so the timer, the horizontal
  // fill, and "full width = full duration" all share one origin (no warm-up gap).
  if (startTime === 0) startTime = performance.now();
  const chans = e.data;
  if (!recordedChunks) recordedChunks = chans.map(() => []);
  for (let c = 0; c < chans.length && c < recordedChunks.length; c++) {
    recordedChunks[c].push(chans[c]);
  }
  const data = chans[0];
  const base = samplesReceived;
  for (let i = 0; i < data.length; i++) {
    const gi = base + i;
    let b = Math.floor(gi / samplesPerBin);
    if (b < 0) b = 0; else if (b >= numBins) b = numBins - 1;
    const v = data[i];
    const a = v < 0 ? -v : v;
    if (a > peakAbs[b]) peakAbs[b] = a;
  }
  samplesReceived += data.length;
  currentBin = Math.min(numBins - 1, Math.floor(samplesReceived / samplesPerBin));
}

async function stopAudio() {
  try { if (node) { node.port.onmessage = null; node.disconnect(); } } catch (_) {}
  try { if (srcNode) srcNode.disconnect(); } catch (_) {}
  try { if (gainNode) gainNode.disconnect(); } catch (_) {}
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close(); } catch (_) {}
  node = srcNode = gainNode = audioCtx = stream = null;
}

// ================================================================
// recording lifecycle (inside the visualizer)
// ================================================================
function frame(now) {
  if (startTime === 0) {
    // waiting for the first audio sample; fall back so a dead input can't hang
    if (now - recArmTime > START_FALLBACK_MS) startTime = now;
    else { setTimer(duration); draw(); rafId = requestAnimationFrame(frame); return; }
  }
  const elapsed = (now - startTime) / 1000;
  const remaining = duration - elapsed;
  setTimer(remaining);
  draw();
  // report the countdown to the web UI a few times a second
  if (now - _lastStatePush > 300) { _lastStatePush = now; pushState({ remaining: Math.max(0, remaining) }); }
  // stream the growing envelope to the web mirror a bit more often
  if (now - _lastPeaksPush > 120) { _lastPeaksPush = now; reportPeaks(); }
  if (remaining <= 0) { finish(); return; }
  rafId = requestAnimationFrame(frame);
}

async function startRec() {
  if (state !== 'idle') return;
  state = 'arming'; // claim it synchronously so a concurrent caller can't also pass the guard
  // re-fit to the real (now fullscreen) size in case Space was pressed before
  // the OS fullscreen resize event landed — keeps numBins == actual pixel width
  sizeCanvas();
  status('Requesting microphone…');
  hint('');
  try {
    const deviceId = await pickDeviceId(cfg.inputDevice);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: cfg.channels || 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });

    audioCtx = cfg.sampleRate ? new AudioContext({ sampleRate: cfg.sampleRate }) : new AudioContext();
    recSampleRate = audioCtx.sampleRate;
    await audioCtx.audioWorklet.addModule('recorder-worklet.js');

    // Esc / Reset (or anything that left 'arming') may have fired during setup — bail cleanly
    if (state !== 'arming') { await stopAudio(); return; }

    srcNode = audioCtx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(audioCtx, 'capture-processor');
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 0; // no monitoring / no feedback, but keeps the graph pulling
    srcNode.connect(node);
    node.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    peakAbs.fill(0);
    samplesReceived = 0;
    currentBin = -1;
    recordedChunks = null;
    samplesPerBin = Math.max(1, (duration * recSampleRate) / numBins);

    node.port.onmessage = onAudio;
    state = 'recording';
    currentFile = null;
    showRec(true);
    status('');
    startTime = 0;                    // set by the first onAudio (or the fallback)
    recArmTime = performance.now();
    pushState();
    rafId = requestAnimationFrame(frame);
  } catch (err) {
    state = 'idle';
    showRec(false);
    status('Microphone error: ' + ((err && err.message) || err));
    hint('Check the audio input in settings · Press SPACE to retry · Esc to go back');
    pushState();
  }
}

function concatChannels() {
  return recordedChunks.map((chunks) => {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Float32Array(len);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  });
}

function encodeWav(channels, sr) {
  const numCh = channels.length;
  const frames = channels[0].length;
  const blockAlign = numCh * 2;
  const dataSize = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);          // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);         // bits per sample
  ws(36, 'data');
  v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}

function canvasToPng() {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (!b) return reject(new Error('PNG export failed'));
      b.arrayBuffer().then(resolve, reject);
    }, 'image/png');
  });
}

async function buildOutputs() {
  const payload = { prefix: cfg.output.filenamePrefix };
  if (cfg.output.saveWav && recordedChunks && recordedChunks[0] && recordedChunks[0].length) {
    payload.wav = encodeWav(concatChannels(), recSampleRate);
  }
  if (cfg.output.savePng) {
    payload.png = await canvasToPng();
  }
  return payload;
}

async function finish() {
  if (state !== 'recording') return;
  state = 'finishing';
  cancelAnimationFrame(rafId);
  setTimer(0);
  showRec(false);
  await stopAudio();
  // recording is complete by definition: extend the fill to the right edge so
  // the frozen waveform (and the saved PNG) spans the full configured duration
  if (currentBin >= 0 && currentBin < numBins - 1) currentBin = numBins - 1;
  draw(); // final full waveform

  // freshly recorded take becomes reviewable; its visual overrides start at the configured values
  reviewGain = wf.amplitudeScale;
  reviewSmooth = wf.smoothing || 0;
  reviewCompress = wf.compress || 0;
  reviewBytes = null;
  currentFile = null;

  if (cfg.output.saveWav || cfg.output.savePng) {
    status('Saving…');
    hint('');
    try {
      const payload = await buildOutputs();
      if (payload.wav) reviewBytes = payload.wav.slice(0); // keep a copy for playback
      const res = await api.saveRecording(payload);
      if (res.wav) currentFile = res.wav.replace(/^.*[\\/]/, '');
      const parts = [];
      if (res.wav) parts.push(res.wav);
      if (res.png) parts.push(res.png);
      status(parts.length ? 'Saved: ' + parts.join('   |   ') : 'Done');
    } catch (err) {
      status('Save failed: ' + ((err && err.message) || err));
    }
  } else {
    status('Done');
  }
  hint('R reset  ·  Esc settings  ·  Ctrl/⌘+Q quit');
  state = 'done';
  reportPeaks();
  pushState();
}

function armIdle() {
  state = 'idle';
  duration = cfg.durationSeconds; // restore configured length (a review may have changed it)
  stopPlayback();
  if (peakAbs) peakAbs.fill(0);
  samplesReceived = 0;
  currentBin = -1;
  recordedChunks = null;
  currentFile = null;
  reviewChannel = null;
  reviewBytes = null;
  showRec(false);
  setTimer(duration);
  status('Press SPACE to start');
  hint('Esc settings  ·  Ctrl/⌘+Q quit');
  draw();
  pushState();
}

async function restartViz() {
  if (state === 'finishing' || state === 'stopping') return;
  if (state === 'recording') { state = 'stopping'; cancelAnimationFrame(rafId); await stopAudio(); }
  armIdle();
}

// ================================================================
// web remote: live mirror of a chosen recording onto the full screen
// ================================================================
function computePeaksFromChannel(ch) {
  const total = ch.length;
  const spb = Math.max(1, total / numBins);
  peakAbs.fill(0);
  for (let i = 0; i < total; i++) {
    let b = Math.floor(i / spb);
    if (b >= numBins) b = numBins - 1;
    const v = ch[i];
    const a = v < 0 ? -v : v;
    if (a > peakAbs[b]) peakAbs[b] = a;
  }
}

async function decodeMono(bytes) {
  const tmp = new AudioContext();
  try {
    const audio = await tmp.decodeAudioData(bytes.slice(0));
    return { channel: audio.getChannelData(0).slice(0), duration: audio.duration };
  } finally {
    try { await tmp.close(); } catch (_) {} // always release the context, even on decode failure
  }
}

async function showRecording(d) {
  if (state === 'recording' || state === 'finishing' || state === 'stopping') return; // never interrupt a live take
  let decoded;
  try {
    decoded = await decodeMono(d.bytes);
  } catch (err) {
    if (screen === 'visualizer') status('Could not load recording: ' + ((err && err.message) || err));
    return;
  }
  // re-check after the await: a live take may have started while decoding
  if (state === 'recording' || state === 'finishing' || state === 'stopping') return;

  if (screen !== 'visualizer') {
    applyVizConfig(cfg);
    $('config').hidden = true;
    $('viz').hidden = false;
    document.body.classList.add('viz');
    screen = 'visualizer';
    await api.setFullscreen(true);
  }
  sizeCanvas();
  stopPlayback();           // releases any prior playback before swapping recordings
  reviewChannel = decoded.channel;
  reviewBytes = d.bytes;    // keep the original WAV for playback
  currentFile = d.file;
  computePeaksFromChannel(reviewChannel);
  currentBin = numBins - 1;
  duration = decoded.duration;
  reviewGain = wf.amplitudeScale;
  reviewSmooth = wf.smoothing || 0;
  reviewCompress = wf.compress || 0;
  state = 'review';
  showRec(false);
  setTimer(decoded.duration);
  status('Reviewing: ' + d.file);
  hint('Adjust from the web remote  ·  R reset  ·  Esc settings');
  draw();
  reportPeaks();
  pushState();
}

// live visual overrides from the web remote (review/done only — never the audio)
function setLiveGain(v) {
  if (!isFinite(v)) return;
  reviewGain = v;
  if (screen === 'visualizer' && (state === 'review' || state === 'done')) draw();
}
function setLiveSmooth(v) {
  if (!isFinite(v)) return;
  reviewSmooth = Math.max(0, Math.min(1, v));
  if (screen === 'visualizer' && (state === 'review' || state === 'done')) draw();
}
function setLiveCompress(v) {
  if (!isFinite(v)) return;
  reviewCompress = Math.max(0, Math.min(1, v));
  if (screen === 'visualizer' && (state === 'review' || state === 'done')) draw();
}

// ---------------- playback of a reviewed recording ----------------
async function pickOutputDeviceId(match) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!match) return undefined;
    const m = match.toLowerCase();
    const outs = devices.filter((d) => d.kind === 'audiooutput' && !isPseudoDevice(d));
    const exact = outs.find((d) => d.label && d.label.toLowerCase() === m);
    if (exact) return exact.deviceId;
    const partial = outs.find((d) => d.label && d.label.toLowerCase().includes(m));
    return partial ? partial.deviceId : undefined;
  } catch (_) { return undefined; }
}

let _lastPlayPush = 0;
function startPlayLoop() {
  cancelAnimationFrame(playRaf);
  const step = () => {
    if (!playing || !audioEl) return;
    if (audioEl.ended && !loopOn) { onPlayEnded(); return; } // belt-and-suspenders for the 'ended' event
    const dur = audioEl.duration || duration || 1;
    playFrac = dur ? Math.min(1, audioEl.currentTime / dur) : 0;
    draw();
    const now = performance.now();
    if (now - _lastPlayPush > 150) { _lastPlayPush = now; pushState(); }
    playRaf = requestAnimationFrame(step);
  };
  playRaf = requestAnimationFrame(step);
}

function onPlayEnded() {
  if (loopOn) return; // audioEl.loop restarts it
  playing = false;
  playFrac = 0;
  cancelAnimationFrame(playRaf);
  draw();
  pushState();
}

function playable() { return reviewBytes && (state === 'review' || state === 'done'); }

async function play() {
  if (!playable()) return;
  if (!audioEl) { audioEl = new Audio(); audioEl.addEventListener('ended', onPlayEnded); }
  if (!playUrl) { playUrl = URL.createObjectURL(new Blob([reviewBytes], { type: 'audio/wav' })); audioEl.src = playUrl; }
  // always reconcile the sink (falls back to the default output)
  try {
    const sink = await pickOutputDeviceId(cfg.outputDevice);
    if (audioEl.setSinkId) await audioEl.setSinkId(sink || 'default');
  } catch (_) {}
  // a recording/reset/exit may have fired during the awaits — bail if so
  if (!playable() || !playUrl) return;
  audioEl.loop = loopOn;
  try { await audioEl.play(); } catch (_) { return; }
  if (!playable()) { try { audioEl.pause(); } catch (_) {} return; }
  playing = true;
  startPlayLoop();
  pushState();
}

function pausePlayback() {
  if (audioEl) audioEl.pause();
  playing = false;
  cancelAnimationFrame(playRaf);
  draw();
  pushState();
}

function togglePlay() { if (playing) pausePlayback(); else play(); }

function setLoop(b) {
  loopOn = !!b;
  if (audioEl) audioEl.loop = loopOn;
  pushState();
}

// fully stop and release playback (when switching recordings or leaving review)
function stopPlayback() {
  playing = false;
  playFrac = 0;
  cancelAnimationFrame(playRaf);
  try { if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); } } catch (_) {}
  if (playUrl) { try { URL.revokeObjectURL(playUrl); } catch (_) {} playUrl = null; }
}

// push a downsampled copy of the current envelope to the web UI so it can mirror
// the full screen live (especially during recording). Raw peaks + effective
// visual params; the web applies the same gain/smooth/compress pipeline.
function reportPeaks() {
  if (!peakAbs || !numBins) return;
  const N = 900;
  const out = new Uint8Array(N);
  const ratio = numBins / N;
  for (let i = 0; i < N; i++) {
    const s = Math.floor(i * ratio);
    const e = Math.min(numBins, Math.floor((i + 1) * ratio));
    let p = 0;
    for (let b = s; b < e; b++) if (peakAbs[b] > p) p = peakAbs[b];
    out[i] = p > 1 ? 255 : Math.round(p * 255);
  }
  let bin = '';
  for (let i = 0; i < N; i++) bin += String.fromCharCode(out[i]);
  const reviewing = state === 'review' || state === 'done';
  try {
    api.reportPeaks({
      peaks: btoa(bin),
      n: N,
      fill: numBins > 0 ? Math.min(1, (currentBin + 1) / numBins) : 0,
      amplitudeScale: reviewing ? reviewGain : wf.amplitudeScale,
      smoothing: reviewing ? reviewSmooth : (wf.smoothing || 0),
      compress: reviewing ? reviewCompress : (wf.compress || 0)
    });
  } catch (_) {}
}

function applyVizConfigUpdate(d) {
  if (!d) return;
  if (d.full) {
    cfg = d.full;
    wf = cfg.waveform;
    duration = cfg.durationSeconds;
    if (screen === 'config') { populateForm(cfg); updateAbsPath(); }
    else applyVizConfig(cfg);
    // re-route an active playback element if the output device changed
    if (audioEl) {
      pickOutputDeviceId(cfg.outputDevice)
        .then((s) => { try { if (audioEl.setSinkId) audioEl.setSinkId(s || 'default'); } catch (_) {} })
        .catch(() => {});
    }
  } else if (d.waveform) {
    cfg.waveform = d.waveform;
    wf = cfg.waveform;
    if ($('f-amp')) { $('f-amp').value = wf.amplitudeScale; if (typeof syncRangeLabels === 'function') syncRangeLabels(); }
  }
  if (screen === 'visualizer') draw();
}

// report the current state to the main process for the web UI to poll
let _lastStatePush = 0;
let _lastPeaksPush = 0;
function pushState(extra) {
  try {
    api.reportState(Object.assign({
      state, screen, duration,
      remaining: null, // overridden during recording by frame()
      file: currentFile || null,
      amplitudeScale: (state === 'review' || state === 'done') ? reviewGain : (wf ? wf.amplitudeScale : 1),
      smoothing: (state === 'review' || state === 'done') ? reviewSmooth : (wf ? (wf.smoothing || 0) : 0),
      compress: (state === 'review' || state === 'done') ? reviewCompress : (wf ? (wf.compress || 0) : 0),
      playing, loop: loopOn, playPos: playFrac,
      canPlay: !!reviewBytes && (state === 'review' || state === 'done'),
      regionEnabled: !!(cfg && cfg.region && cfg.region.enabled),
      regionOutline: !!(cfg && cfg.region && cfg.region.showOutline),
      regionMarkers: !!(cfg && cfg.region && cfg.region.markers)
    }, extra || {}));
  } catch (_) {}
}

// toggle the projection region (from the big-screen "C" shortcut)
function toggleRegion() {
  if (!cfg.region) cfg.region = { enabled: false, x: 0.3, y: 0.1, width: 0.4, height: 0.8 };
  cfg.region.enabled = !cfg.region.enabled;
  if (screen === 'visualizer') draw();
  pushState();
  api.saveConfig(cfg).catch(() => {});
}

// toggle the region outline on the projection (from the big-screen "O" shortcut)
function toggleRegionOutline() {
  if (!cfg.region) cfg.region = { enabled: false, x: 0.3, y: 0.1, width: 0.4, height: 0.8 };
  cfg.region.showOutline = !cfg.region.showOutline;
  if (screen === 'visualizer') draw();
  pushState();
  api.saveConfig(cfg).catch(() => {});
}

// toggle the left/right markers on the projection (from the big-screen "M" shortcut)
function toggleRegionMarkers() {
  if (!cfg.region) cfg.region = { enabled: false, x: 0.3, y: 0.1, width: 0.4, height: 0.8 };
  cfg.region.markers = !cfg.region.markers;
  if (screen === 'visualizer') draw();
  pushState();
  api.saveConfig(cfg).catch(() => {});
}

// remote Start: begin a recording (transitions to full screen if needed)
async function remoteStart() {
  if (starting || state === 'finishing' || state === 'stopping' || state === 'arming' || state === 'recording') return;
  starting = true;
  try {
    if (screen !== 'visualizer') { if (!(await enterVisualizer())) return; }
    else if (state !== 'idle') { armIdle(); }
    await startRec();
  } finally {
    starting = false;
  }
}

// remote Reset: stop anything and leave a blank, armed full screen ready to record
async function resetViz() {
  if (state === 'finishing' || state === 'stopping') return;
  if (state === 'recording' || state === 'arming') { state = 'stopping'; cancelAnimationFrame(rafId); await stopAudio(); }
  if (screen !== 'visualizer') { await enterVisualizer(); } // enterVisualizer ends in armIdle (blank + ready)
  else { armIdle(); }
}

// ================================================================
// screen transitions
// ================================================================
async function enterVisualizer() {
  if (entering || screen !== 'config') return false;
  entering = true;
  try {
    cfg = readForm();
    try { await api.saveConfig(cfg); } catch (_) { /* persist failure shouldn't block recording */ }
    applyVizConfig(cfg);

    $('config').hidden = true;
    $('viz').hidden = false;
    document.body.classList.add('viz');
    screen = 'visualizer';

    await api.setFullscreen(true);
    sizeCanvas();
    armIdle();
    return true;
  } finally {
    entering = false;
  }
}

async function exitToConfig() {
  if (state === 'finishing' || state === 'stopping') return;
  if (state === 'recording') { state = 'stopping'; cancelAnimationFrame(rafId); await stopAudio(); }
  state = 'idle';
  screen = 'config';
  stopPlayback();
  currentFile = null;
  reviewChannel = null;
  reviewBytes = null;
  await api.setFullscreen(false);
  document.body.classList.remove('viz');
  $('viz').hidden = true;
  $('config').hidden = false;
  refreshDevices();
  pushState();
}

// ================================================================
// init
// ================================================================
async function init() {
  canvas = $('wave');
  g = canvas.getContext('2d');

  cfg = await api.getConfig();
  wf = cfg.waveform;
  duration = cfg.durationSeconds;

  populateForm(cfg);
  updateAbsPath();
  await refreshDevices();

  // form interactions
  $('f-duration').addEventListener('input', updatePretty);
  ['f-glow', 'f-linewidth', 'f-amp', 'f-smooth', 'f-compress', 'f-headroom', 'f-timersize'].forEach((id) =>
    $(id).addEventListener('input', syncRangeLabels)
  );
  $('f-refresh').addEventListener('click', () => { cfg = readForm(); refreshDevices(); });
  $('f-dir').addEventListener('input', updateAbsPath);
  $('f-browse').addEventListener('click', async () => {
    const dir = await api.chooseDirectory();
    if (dir) { $('f-dir').value = dir; updateAbsPath(); }
  });
  $('f-open').addEventListener('click', async () => {
    const res = await api.openPath($('f-dir').value);
    if (res && res.error) toast('Could not open: ' + res.error);
  });
  $('btn-start').addEventListener('click', () => { if (screen === 'config') enterVisualizer(); });
  $('btn-save').addEventListener('click', async () => {
    cfg = readForm();
    try { await api.saveConfig(cfg); toast('Settings saved'); }
    catch (e) { toast('Save failed: ' + ((e && e.message) || e)); }
  });
  $('btn-quit').addEventListener('click', () => api.quit());
  $('web-open').addEventListener('click', () => api.openExternal('http://localhost:' + (parseInt($('f-web-port').value, 10) || 8080)));

  // web remote info + live-mirror listeners
  api.getWebInfo().then(updateWebInfo).catch(() => {});
  api.onWebInfo(updateWebInfo);
  api.onShowRecording((d) => { showRecording(d); });
  api.onSetGain((v) => { setLiveGain(v); });
  api.onSetSmooth((v) => { setLiveSmooth(v); });
  api.onSetCompress((v) => { setLiveCompress(v); });
  api.onVizConfig((d) => { applyVizConfigUpdate(d); });
  api.onRemoteStart(() => { remoteStart(); });
  api.onRemoteReset(() => { resetViz(); });
  api.onRequestDevices(() => { refreshDevices(); });
  api.onPlay(() => { play(); });
  api.onPause(() => { pausePlayback(); });
  api.onLoop((v) => { setLoop(v); });
  pushState(); // report initial state

  // keyboard
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyQ') { e.preventDefault(); api.quit(); return; }

    if (screen === 'config') {
      const tag = (e.target && e.target.tagName) || '';
      if (e.code === 'Enter' && tag !== 'BUTTON') { e.preventDefault(); enterVisualizer(); }
      return;
    }

    // visualizer
    if (e.code === 'Space') { e.preventDefault(); if (state === 'idle') startRec(); }
    else if (e.code === 'KeyR') { e.preventDefault(); restartViz(); }
    else if (e.code === 'KeyP') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'KeyL') { e.preventDefault(); setLoop(!loopOn); }
    else if (e.code === 'KeyC') { e.preventDefault(); toggleRegion(); }
    else if (e.code === 'KeyO') { e.preventDefault(); toggleRegionOutline(); }
    else if (e.code === 'KeyM') { e.preventDefault(); toggleRegionMarkers(); }
    else if (e.code === 'Escape') { e.preventDefault(); exitToConfig(); }
  });

  // re-layout the canvas on window/fullscreen size changes (only when safe)
  const relayout = () => {
    if (screen !== 'visualizer') return;
    if (state === 'idle') { sizeCanvas(); setTimer(duration); draw(); }
    else if ((state === 'review' || state === 'done') && reviewChannel) {
      // re-fit a shown recording without losing it: re-bin from the stored samples
      sizeCanvas();
      computePeaksFromChannel(reviewChannel);
      currentBin = numBins - 1;
      draw();
    }
  };
  window.addEventListener('resize', relayout);
  if (api.onLayoutChanged) api.onLayoutChanged(relayout);
}

init();
