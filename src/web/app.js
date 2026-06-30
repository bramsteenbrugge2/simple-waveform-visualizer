'use strict';

const $ = (id) => document.getElementById(id);

let cfg = { waveform: { style: 'glowLine', color: '#27e0ff', glow: 26, lineWidth: 2.5, centerLineWidth: 1.5, amplitudeScale: 1, smoothing: 0, headroom: 0.9, showBaseline: true, barWidth: 2, barGap: 1 }, background: '#000000' };
let cur = null;        // { file, channel, sampleRate, duration, peaks, numBins }
let amplitude = 1;
let smoothing = 0;
let compress = 0;
let mirror = true;
let mirrorMode = false; // true while mirroring the full screen's live recording
let playState = { playing: false, loop: false, playPos: 0, canPlay: false, file: null };
let loadSeq = 0;       // guards against stale async loads
let canvas, g;

// ---------------- helpers ----------------
function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(s) { s = Math.max(0, s); return pad(Math.floor(s / 60)) + ':' + pad(Math.floor(s % 60)); }
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'; }

let toastT = 0;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2400);
}

function hexA(hex, a) {
  hex = String(hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16) || 0, gg = parseInt(hex.slice(2, 4), 16) || 0, b = parseInt(hex.slice(4, 6), 16) || 0;
  return `rgba(${r},${gg},${b},${a})`;
}

function peaksAtWidth(ch, numBins) {
  const total = ch.length;
  const spb = Math.max(1, total / numBins);
  const peaks = new Float32Array(numBins);
  for (let i = 0; i < total; i++) {
    let b = Math.floor(i / spb);
    if (b >= numBins) b = numBins - 1;
    const v = ch[i]; const a = v < 0 ? -v : v;
    if (a > peaks[b]) peaks[b] = a;
  }
  return peaks;
}

// visual-only smoothing (moving average) — same mapping/curve as the desktop app
let _wsbuf = null, _wpre = null;
function smoothPeaks(src, radius) {
  const n = src.length;
  if (!radius) return src;
  if (!_wsbuf || _wsbuf.length !== n) _wsbuf = new Float32Array(n);
  if (!_wpre || _wpre.length !== n + 1) _wpre = new Float64Array(n + 1);
  const pre = _wpre; pre[0] = 0;
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i];
  const out = _wsbuf;
  for (let i = 0; i < n; i++) {
    const a = i - radius < 0 ? 0 : i - radius;
    const b = i + radius >= n ? n - 1 : i + radius;
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}
// slider (0..1) -> radius px; gentle curve, with extra headroom toward 100%
function smoothRadiusFor(amount, bins) {
  const e = (amount || 0) * (amount || 0);
  return Math.min(900, Math.round(e * bins * 0.0034));
}
// log-ish peak compression (0..1 -> 0..1); 0 = linear
function compressCurve(p, amount) {
  if (amount <= 0) return p;
  const k = Math.pow(10, amount * 2) - 1;
  return Math.log(1 + k * p) / Math.log(1 + k);
}
function decodePeaks(b64) {
  const bin = atob(b64); const n = bin.length; const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
}
function resampleTo(arr, W) {
  const out = new Float32Array(W); const n = arr.length;
  for (let x = 0; x < W; x++) out[x] = arr[Math.min(n - 1, Math.floor((x / W) * n))];
  return out;
}

// ---------------- drawing ----------------
function drawWave(ctx, rawPeaks, W, H, wf, scale, smooth, comp, bg, sx) {
  ctx.fillStyle = bg || '#000';
  ctx.fillRect(0, 0, W, H);
  const single = !!wf.singleSided;
  const radius = smoothRadiusFor(smooth, rawPeaks.length);
  const peaks = radius > 0 ? smoothPeaks(rawPeaks, radius) : rawPeaks;
  const last = peaks.length - 1;
  const n = peaks.length;

  // optional projection region (mirrors the desktop) — fractions of the canvas
  const reg = (cfg.region && cfg.region.enabled) ? cfg.region : null;
  const geoL = reg ? Math.round(Math.min(Math.max(reg.x, 0), 1) * W) : 0;
  const geoW = reg ? Math.max(2, Math.round(Math.min(Math.max(reg.width, 0.02), 1) * W)) : W;
  const regT = reg ? Math.round(Math.min(Math.max(reg.y, 0), 1) * H) : 0;
  const regH = reg ? Math.max(2, Math.round(Math.min(Math.max(reg.height, 0.02), 1) * H)) : H;
  const baseY = regT + regH / 2;
  const maxAmp = (regH / 2) * (wf.headroom || 0.9);
  const xOf = (b) => geoL + (n > 1 ? (b / (n - 1)) * geoW : 0);
  const ampAt = (b) => { let a = compressCurve(peaks[b], comp || 0) * scale * maxAmp; return a > maxAmp ? maxAmp : a; };

  if (wf.showBaseline) {
    ctx.save(); ctx.globalAlpha = 0.12; ctx.strokeStyle = wf.color; ctx.lineWidth = Math.max(1, sx);
    ctx.beginPath(); ctx.moveTo(geoL, baseY); ctx.lineTo(geoL + geoW, baseY); ctx.stroke(); ctx.restore();
  }
  if (last < 0) return;

  if (wf.style === 'bars') {
    ctx.save(); ctx.shadowColor = wf.color; ctx.shadowBlur = (wf.glow * 0.5) * sx; ctx.fillStyle = wf.color;
    const bw = Math.max(1, wf.barWidth * sx);
    const step = Math.max(bw + 1, (wf.barWidth + wf.barGap) * sx);
    const xEnd = xOf(last);
    const binAt = (px) => Math.round((geoW > 0 ? (px - geoL) / geoW : 0) * (n - 1));
    for (let px = geoL; px <= xEnd; px += step) {
      let p = 0; const b0 = Math.max(0, binAt(px)); const b1 = Math.min(last, binAt(px + step));
      for (let b = b0; b <= b1; b++) if (peaks[b] > p) p = peaks[b];
      let a = compressCurve(p, comp || 0) * scale * maxAmp; if (a > maxAmp) a = maxAmp; if (a < sx * 0.5) a = sx * 0.5;
      if (single) ctx.fillRect(px, baseY - a, bw, a); else ctx.fillRect(px, baseY - a, bw, a * 2);
    }
    ctx.restore();
  } else if (wf.style === 'filledGradient') {
    ctx.save();
    ctx.shadowColor = wf.color; ctx.shadowBlur = wf.glow * sx;
    if (single) {
      const grad = ctx.createLinearGradient(0, baseY - maxAmp, 0, baseY);
      grad.addColorStop(0, hexA(wf.color, 0.08)); grad.addColorStop(1, hexA(wf.color, 0.95));
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(geoL, baseY);
      for (let b = 0; b <= last; b++) ctx.lineTo(xOf(b), baseY - ampAt(b));
      ctx.lineTo(xOf(last), baseY); ctx.closePath(); ctx.fill();
    } else {
      const grad = ctx.createLinearGradient(0, baseY - maxAmp, 0, baseY + maxAmp);
      grad.addColorStop(0, hexA(wf.color, 0.05)); grad.addColorStop(0.5, hexA(wf.color, 0.95)); grad.addColorStop(1, hexA(wf.color, 0.05));
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(geoL, baseY - ampAt(0));
      for (let b = 1; b <= last; b++) ctx.lineTo(xOf(b), baseY - ampAt(b));
      for (let b = last; b >= 0; b--) ctx.lineTo(xOf(b), baseY + ampAt(b));
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  } else {
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.shadowColor = wf.color; ctx.shadowBlur = wf.glow * sx; ctx.strokeStyle = wf.color;
    ctx.lineWidth = (wf.centerLineWidth || 1.5) * sx; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(geoL, baseY); ctx.lineTo(xOf(Math.max(0, last)), baseY); ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineWidth = (wf.lineWidth || 2.5) * sx;
    ctx.beginPath(); for (let b = 0; b <= last; b++) { const y = baseY - ampAt(b); b ? ctx.lineTo(xOf(b), y) : ctx.moveTo(xOf(b), y); } ctx.stroke();
    if (!single) { ctx.beginPath(); for (let b = 0; b <= last; b++) { const y = baseY + ampAt(b); b ? ctx.lineTo(xOf(b), y) : ctx.moveTo(xOf(b), y); } ctx.stroke(); }
    ctx.restore();
  }
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
}
function drawPlayhead() {
  if (!(playState.playing || playState.playPos > 0)) return;
  // only meaningful when the host is showing the same recording the web shows
  if (!cur || (playState.file && playState.file !== cur.file)) return;
  const sx = window.devicePixelRatio || 1;
  const x = Math.max(0, Math.min(canvas.width, playState.playPos * canvas.width));
  g.save();
  g.strokeStyle = '#ffcf4a'; g.shadowColor = '#ffcf4a'; g.shadowBlur = 12 * sx; g.lineWidth = 2 * sx; g.globalAlpha = 0.95;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, canvas.height); g.stroke();
  g.restore();
}
function render() {
  if (mirrorMode || !cur) return; // during a live mirror the poll loop owns the canvas
  drawWave(g, cur.peaks, canvas.width, canvas.height, cfg.waveform, amplitude, smoothing, compress, cfg.background, window.devicePixelRatio || 1);
  drawPlayhead();
}
function recompute() {
  if (!cur) return;
  sizeCanvas();
  cur.peaks = peaksAtWidth(cur.channel, canvas.width);
  render();
}

// ---------------- server I/O ----------------
async function loadConfig() {
  try { const r = await fetch('/api/config'); const j = await r.json(); if (j.waveform) cfg = j; } catch (_) {}
  if (!cfg.region) cfg.region = { enabled: false, showOutline: false, markers: false, x: 0.3, y: 0.1, width: 0.4, height: 0.8 };
  amplitude = (cfg.waveform && cfg.waveform.amplitudeScale) || 1;
  smoothing = (cfg.waveform && cfg.waveform.smoothing) || 0;
  compress = (cfg.waveform && cfg.waveform.compress) || 0;
  $('amp').value = amplitude; $('amp-val').textContent = amplitude.toFixed(1) + '×';
  $('smooth').value = smoothing; $('smooth-val').textContent = Math.round(smoothing * 100) + '%';
  $('compress').value = compress; $('compress-val').textContent = Math.round(compress * 100) + '%';
}

async function loadList() {
  const sel = $('rec');
  try {
    const r = await fetch('/api/recordings'); const j = await r.json();
    const recs = j.recordings || [];
    const keep = sel.value;
    sel.innerHTML = '';
    if (!recs.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '(no recordings yet)'; sel.appendChild(o); return; }
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Select a recording…'; sel.appendChild(ph);
    recs.forEach((rec) => { const o = document.createElement('option'); o.value = rec.file; o.textContent = rec.file + '  ·  ' + fmtSize(rec.size); sel.appendChild(o); });
    if (keep && recs.some((rc) => rc.file === keep)) sel.value = keep;
  } catch (e) { /* ignore */ }
}

async function selectFile(file) {
  if (!file) { cur = null; $('empty').classList.remove('hidden'); return; }
  playState.playPos = 0; // drop any stale playhead until the host confirms this file
  const seq = ++loadSeq;
  $('meta').textContent = 'Loading ' + file + '…';
  let ctx;
  try {
    const r = await fetch('/api/audio/' + encodeURIComponent(file));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ab = await r.arrayBuffer();
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(ab);
    if (seq !== loadSeq) return; // a newer selection won — drop this stale result
    cur = { file, channel: audio.getChannelData(0).slice(0), sampleRate: audio.sampleRate, duration: audio.duration };
    $('empty').classList.add('hidden');
    $('meta').textContent = fmtTime(audio.duration) + '  ·  ' + audio.sampleRate + ' Hz';
    recompute();
    if (mirror) { postShow(file); postGain(true); postSmooth(true); postCompress(true); }
  } catch (e) {
    if (seq === loadSeq) $('meta').textContent = 'Could not load: ' + ((e && e.message) || e);
  } finally {
    if (ctx) { try { await ctx.close(); } catch (_) {} }
  }
}

function postShow(file) { fetch('/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) }).catch(() => {}); }

function makeThrottle(url, key) {
  let last = 0, timer = 0;
  const fn = (value, force) => {
    if (!mirror) return;
    clearTimeout(timer);
    const flush = () => { last = performance.now(); fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }) }).catch(() => {}); };
    const dt = performance.now() - last;
    if (force || dt >= 50) flush(); else timer = setTimeout(flush, 50 - dt);
  };
  fn.cancel = () => clearTimeout(timer);
  return fn;
}
const postGainThrottled = makeThrottle('/api/gain', 'amplitudeScale');
const postSmoothThrottled = makeThrottle('/api/smooth', 'smoothing');
const postCompressThrottled = makeThrottle('/api/compress', 'compress');
function postGain(force) { postGainThrottled(amplitude, force); }
function postSmooth(force) { postSmoothThrottled(smoothing, force); }
function postCompress(force) { postCompressThrottled(compress, force); }

async function exportPng() {
  if (!cur) { toast('Select a recording first'); return; }
  const W = 1920, H = 1080;
  const off = document.createElement('canvas'); off.width = W; off.height = H;
  const peaks = peaksAtWidth(cur.channel, W);
  drawWave(off.getContext('2d'), peaks, W, H, cfg.waveform, amplitude, smoothing, compress, cfg.background, 2);
  const png = off.toDataURL('image/png');
  try {
    const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: cur.file, amplitudeScale: amplitude, png }) });
    const j = await r.json();
    toast(j.ok ? 'Exported: ' + j.path : 'Export failed: ' + (j.error || ''));
  } catch (e) { toast('Export failed: ' + ((e && e.message) || e)); }
}

async function setDefault() {
  try {
    const r = await fetch('/api/set-default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amplitudeScale: amplitude, smoothing, compress }) });
    const j = await r.json();
    toast(j.ok ? 'Saved as app default' : 'Failed: ' + (j.error || ''));
  } catch (e) { toast('Failed: ' + ((e && e.message) || e)); }
}

// ---------------- settings drawer (live) ----------------
function sv(id, v) { const el = $(id); if (el) el.value = v; }
function sc(id, v) { const el = $(id); if (el) el.checked = !!v; }
let devicesReady = false;

function ensureOption(selectId, value, label) {
  const sel = $(selectId);
  if (!sel) return;
  const v = String(value);
  if (!Array.from(sel.options).some((o) => o.value === v)) {
    const o = document.createElement('option'); o.value = v; o.textContent = label || v; sel.appendChild(o);
  }
}

function fillSel(sel, defLabel, labels, prev) {
  if (!sel) return;
  sel.innerHTML = '';
  const def = document.createElement('option'); def.value = ''; def.textContent = defLabel; sel.appendChild(def);
  (labels || []).forEach((l) => { const o = document.createElement('option'); o.value = l; o.textContent = l; sel.appendChild(o); });
  if (!prev) { sel.value = ''; return; }
  const opts = Array.from(sel.options);
  let pick = opts.find((o) => o.value === prev) || opts.find((o) => o.value && o.value.toLowerCase().includes(prev.toLowerCase()));
  if (pick) { sel.value = pick.value; return; }
  const o = document.createElement('option'); o.value = prev; o.textContent = 'Configured: ' + prev; sel.appendChild(o); sel.value = prev;
}

async function loadDevices() {
  let d = { inputs: [], outputs: [] };
  try { d = (await (await fetch('/api/devices')).json()).devices || d; } catch (_) {}
  if (Array.isArray(d)) d = { inputs: d, outputs: [] };
  fillSel($('s-device'), 'System default input', d.inputs, cfg.inputDevice || '');
  fillSel($('s-output'), 'System default output', d.outputs, cfg.outputDevice || '');
  devicesReady = true;
}

function populateSettings() {
  const w = cfg.waveform, t = cfg.timer || {}, o = cfg.output || {};
  // keep selects valid even when the saved value isn't a preset option
  ensureOption('s-channels', cfg.channels, cfg.channels === 2 ? 'Stereo' : 'Mono');
  ensureOption('s-samplerate', cfg.sampleRate, cfg.sampleRate ? cfg.sampleRate + ' Hz' : 'Device default');
  sv('s-duration', cfg.durationSeconds); sv('s-channels', String(cfg.channels)); sv('s-samplerate', String(cfg.sampleRate));
  sv('s-style', w.style); sv('s-color', w.color); sv('s-glow', w.glow); sv('s-linewidth', w.lineWidth);
  sv('s-headroom', w.headroom); sc('s-baseline', w.showBaseline); sc('s-single', w.singleSided);
  sc('s-timershow', t.show !== false); sv('s-timerpos', t.position); sv('s-timersize', t.fontSize); sv('s-timercolor', t.color); sc('s-ms', t.showMilliseconds);
  sc('s-savewav', o.saveWav); sc('s-savepng', o.savePng); sv('s-dir', o.directory); sv('s-prefix', o.filenamePrefix); sc('s-subfolder', o.subfolderPerRecording);
  sv('s-bg', cfg.background);
  const rg = cfg.region || {};
  sc('s-region', rg.enabled); sc('s-region-outline', rg.showOutline); sc('s-region-markers', rg.markers);
  sv('s-rx', rg.x != null ? rg.x : 0.3); sv('s-ry', rg.y != null ? rg.y : 0.1);
  sv('s-rw', rg.width != null ? rg.width : 0.4); sv('s-rh', rg.height != null ? rg.height : 0.8);
}

function buildConfig() {
  const out = JSON.parse(JSON.stringify(cfg));
  out.durationSeconds = Math.max(1, parseInt($('s-duration').value, 10) || 1);
  // don't clobber a configured device before the host list has loaded
  out.inputDevice = (devicesReady || $('s-device').value) ? $('s-device').value : (cfg.inputDevice || '');
  out.outputDevice = (devicesReady || $('s-output').value) ? $('s-output').value : (cfg.outputDevice || '');
  out.channels = parseInt($('s-channels').value, 10) || 1;
  out.sampleRate = parseInt($('s-samplerate').value, 10) || 0;
  out.background = $('s-bg').value;
  out.waveform.style = $('s-style').value;
  out.waveform.color = $('s-color').value;
  out.waveform.glow = +$('s-glow').value;
  out.waveform.lineWidth = +$('s-linewidth').value;
  out.waveform.headroom = +$('s-headroom').value;
  out.waveform.showBaseline = $('s-baseline').checked;
  out.waveform.singleSided = $('s-single').checked;
  // keep the live main-panel slider values so a drawer change doesn't revert them
  out.waveform.amplitudeScale = amplitude;
  out.waveform.smoothing = smoothing;
  out.waveform.compress = compress;
  out.timer = out.timer || {};
  out.timer.show = $('s-timershow').checked;
  out.timer.position = $('s-timerpos').value;
  out.timer.fontSize = +$('s-timersize').value;
  out.timer.color = $('s-timercolor').value;
  out.timer.showMilliseconds = $('s-ms').checked;
  out.output = out.output || {};
  out.output.saveWav = $('s-savewav').checked;
  out.output.savePng = $('s-savepng').checked;
  out.output.directory = $('s-dir').value.trim() || './recordings';
  out.output.filenamePrefix = $('s-prefix').value.trim() || 'recording';
  out.output.subfolderPerRecording = $('s-subfolder').checked;
  out.region = out.region || {};
  out.region.enabled = $('s-region').checked;
  out.region.showOutline = $('s-region-outline').checked;
  out.region.markers = $('s-region-markers').checked;
  out.region.x = +$('s-rx').value;
  out.region.y = +$('s-ry').value;
  out.region.width = +$('s-rw').value;
  out.region.height = +$('s-rh').value;
  return out;
}

// live apply: update the local preview instantly, and push to the app (throttled,
// so the full screen follows during a slider drag without hammering the disk)
let _cfgLast = 0, _cfgTimer = 0;
function applyLive() {
  suppressSyncUntil = performance.now() + 1800; // protect this local change from a stale server echo
  cfg = buildConfig();
  render();
  positionRegionBox();
  const flush = async () => {
    _cfgLast = performance.now();
    try {
      const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      cfg = await r.json();
    } catch (_) {}
  };
  clearTimeout(_cfgTimer);
  const dt = performance.now() - _cfgLast;
  if (dt >= 90) flush(); else _cfgTimer = setTimeout(flush, 90 - dt);
}

let settingsWired = false;
function wireSettings() {
  if (settingsWired) return;
  settingsWired = true;
  const ids = ['s-duration', 's-device', 's-output', 's-channels', 's-samplerate', 's-style', 's-color', 's-glow',
    's-linewidth', 's-headroom', 's-baseline', 's-single', 's-timershow', 's-timerpos', 's-timersize',
    's-timercolor', 's-ms', 's-savewav', 's-savepng', 's-dir', 's-prefix', 's-subfolder', 's-bg',
    's-region', 's-region-outline', 's-region-markers', 's-rx', 's-ry', 's-rw', 's-rh'];
  ids.forEach((id) => { const el = $(id); if (el) { el.addEventListener('input', applyLive); el.addEventListener('change', applyLive); } });
}

async function openSettings() {
  // pull the latest config so changes made on the desktop are reflected here too
  try { const r = await fetch('/api/config'); const j = await r.json(); if (j.waveform) cfg = j; } catch (_) {}
  populateSettings();
  $('settings').classList.add('open'); $('scrim').classList.add('on');
  await loadDevices();
  wireSettings();
}
function closeSettings() { $('settings').classList.remove('open'); $('scrim').classList.remove('on'); }

// ---------------- state polling + live mirror ----------------
let lastState = '';
let prevPlaying = false;
let lastDrawnPos = -1;
let cfgPollCount = 0;
let suppressSyncUntil = 0; // ignore server-driven config/state for a moment after a local edit (avoids flip-back)
function updatePill(s) {
  const pill = $('statepill');
  let label = 'Ready';
  if (s.state === 'recording') label = '● Recording  ' + fmtTime(s.remaining != null ? s.remaining : 0);
  else if (s.state === 'review') label = 'Reviewing';
  else if (s.state === 'done') label = 'Done';
  else if (s.state === 'finishing' || s.state === 'stopping') label = 'Saving…';
  else label = s.screen === 'config' ? 'Settings' : 'Ready';
  pill.textContent = label;
  pill.classList.toggle('rec', s.state === 'recording');
}

async function renderMirror(remaining) {
  try {
    const p = await (await fetch('/api/peaks')).json();
    if (!p || !p.peaks) return;
    sizeCanvas();
    const env = resampleTo(decodePeaks(p.peaks), canvas.width);
    drawWave(g, env, canvas.width, canvas.height, cfg.waveform, p.amplitudeScale, p.smoothing, p.compress, cfg.background, window.devicePixelRatio || 1);
    $('empty').classList.add('hidden');
    $('meta').textContent = '● Recording  ' + fmtTime(remaining != null ? remaining : 0);
  } catch (_) {}
}

async function autoSelectNewest() {
  try {
    await loadList();
    const recs = (await (await fetch('/api/recordings')).json()).recordings || [];
    if (recs.length) { $('rec').value = recs[0].file; await selectFile(recs[0].file); }
  } catch (_) {}
}

function updateTransport() {
  const playBtn = $('play');
  playBtn.textContent = playState.playing ? '❚❚ Pause' : '▶ Play';
  playBtn.disabled = !playState.canPlay && !playState.playing;
  $('loop').classList.toggle('active', playState.loop);
}

function updateRegionBtn() {
  $('region').classList.toggle('active', !!(cfg.region && cfg.region.enabled));
  $('outline').classList.toggle('active', !!(cfg.region && cfg.region.showOutline));
  $('markers').classList.toggle('active', !!(cfg.region && cfg.region.markers));
}

// position the draggable outline over the stage from cfg.region (fractions)
function positionRegionBox() {
  const box = $('region-box');
  if (!box) return;
  const on = !!(cfg.region && cfg.region.enabled);
  box.hidden = !on;
  if (!on) return;
  const r = cfg.region;
  box.style.left = (r.x * 100) + '%';
  box.style.top = (r.y * 100) + '%';
  box.style.width = (r.width * 100) + '%';
  box.style.height = (r.height * 100) + '%';
}

// apply a dragged region: clamp, sync the drawer sliders, persist + mirror live
function applyRegion(r) {
  r.width = Math.max(0.05, Math.min(1, r.width));
  r.height = Math.max(0.05, Math.min(1, r.height));
  r.x = Math.max(0, Math.min(1 - r.width, r.x));
  r.y = Math.max(0, Math.min(1 - r.height, r.y));
  const set = (id, v) => { const e = $(id); if (e) e.value = v; };
  set('s-rx', r.x); set('s-ry', r.y); set('s-rw', r.width); set('s-rh', r.height);
  const cb = $('s-region'); if (cb) cb.checked = true;
  applyLive(); // cfg = buildConfig() reads the synced sliders, then persists + mirrors
}

function setupRegionDrag() {
  const box = $('region-box');
  if (!box) return;
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    if (!cfg.region || !cfg.region.enabled) return;
    const cls = typeof e.target.className === 'string' ? e.target.className : '';
    const m = /\b(nw|ne|sw|se)\b/.exec(cls);
    const stage = box.parentElement.getBoundingClientRect();
    drag = { mode: m ? m[1] : 'move', sx: e.clientX, sy: e.clientY, sw: stage.width, sh: stage.height, r0: Object.assign({}, cfg.region) };
    try { box.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / drag.sw;
    const dy = (e.clientY - drag.sy) / drag.sh;
    const r0 = drag.r0;
    let r;
    if (drag.mode === 'move') {
      r = { x: r0.x + dx, y: r0.y + dy, width: r0.width, height: r0.height };
    } else {
      let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.width, y1 = r0.y + r0.height;
      if (drag.mode.indexOf('w') >= 0) x0 = Math.min(x1 - 0.05, Math.max(0, r0.x + dx));
      if (drag.mode.indexOf('e') >= 0) x1 = Math.max(x0 + 0.05, Math.min(1, r0.x + r0.width + dx));
      if (drag.mode.indexOf('n') >= 0) y0 = Math.min(y1 - 0.05, Math.max(0, r0.y + dy));
      if (drag.mode.indexOf('s') >= 0) y1 = Math.max(y0 + 0.05, Math.min(1, r0.y + r0.height + dy));
      r = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    applyRegion(r);
  });
  const end = (e) => { if (drag) { try { box.releasePointerCapture(e.pointerId); } catch (_) {} drag = null; } };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

async function pollLoop() {
  let next = 600;
  try {
    const s = await (await fetch('/api/state')).json();
    updatePill(s);
    playState = { playing: !!s.playing, loop: !!s.loop, playPos: s.playPos || 0, canPlay: !!s.canPlay, file: s.file || null };
    updateTransport();

    // reflect region toggles made on the big screen (C / O / M) — unless we just edited locally
    if (performance.now() > suppressSyncUntil && cfg.region &&
        ((s.regionEnabled !== undefined && s.regionEnabled !== cfg.region.enabled) ||
         (s.regionOutline !== undefined && s.regionOutline !== cfg.region.showOutline) ||
         (s.regionMarkers !== undefined && s.regionMarkers !== cfg.region.markers))) {
      if (s.regionEnabled !== undefined) cfg.region.enabled = s.regionEnabled;
      if (s.regionOutline !== undefined) cfg.region.showOutline = s.regionOutline;
      if (s.regionMarkers !== undefined) cfg.region.markers = s.regionMarkers;
      const cb = $('s-region'); if (cb) cb.checked = cfg.region.enabled;
      const cb2 = $('s-region-outline'); if (cb2) cb2.checked = cfg.region.showOutline;
      const cb3 = $('s-region-markers'); if (cb3) cb3.checked = cfg.region.markers;
      updateRegionBtn();
      positionRegionBox();
      if (!mirrorMode && !playState.playing) render();
    }

    // occasionally resync the config from the host (style/single-sided/etc. may
    // have been changed on the desktop) — but not while the drawer is being edited
    if (++cfgPollCount % 12 === 0 && !$('settings').classList.contains('open') && performance.now() > suppressSyncUntil) {
      try { const j = await (await fetch('/api/config')).json(); if (j.waveform) { cfg = j; populateSettings(); updateRegionBtn(); positionRegionBox(); if (!mirrorMode && !playState.playing) render(); } } catch (_) {}
    }

    const live = s.state === 'recording' || s.state === 'finishing';
    if (live) {
      mirrorMode = true;
      next = 140;
      await renderMirror(s.remaining);
    } else {
      if (mirrorMode) {
        mirrorMode = false;
        if (s.state === 'done') await autoSelectNewest(); // keep showing the take (high-res, exportable)
      }
      if (playState.playing) { next = 100; render(); lastDrawnPos = playState.playPos; }   // animate playhead
      else if (playState.playPos !== lastDrawnPos || prevPlaying) { render(); lastDrawnPos = playState.playPos; } // paused/stopped: redraw only on change
    }
    prevPlaying = playState.playing;
    lastState = s.state;
  } catch (_) {}
  setTimeout(pollLoop, next);
}

// ---------------- init ----------------
async function init() {
  canvas = $('wave'); g = canvas.getContext('2d');
  await loadConfig();
  populateSettings();   // populate drawer fields so live config edits are accurate even before opening it
  updateRegionBtn();
  setupRegionDrag();
  positionRegionBox();
  await loadList();

  $('rec').addEventListener('change', (e) => selectFile(e.target.value));
  $('refresh').addEventListener('click', loadList);

  $('amp').addEventListener('input', () => { amplitude = +$('amp').value; $('amp-val').textContent = amplitude.toFixed(1) + '×'; render(); postGain(false); });
  $('smooth').addEventListener('input', () => { smoothing = +$('smooth').value; $('smooth-val').textContent = Math.round(smoothing * 100) + '%'; render(); postSmooth(false); });
  $('compress').addEventListener('input', () => { compress = +$('compress').value; $('compress-val').textContent = Math.round(compress * 100) + '%'; render(); postCompress(false); });
  $('mirror').addEventListener('change', () => {
    mirror = $('mirror').checked;
    if (!mirror) { postGainThrottled.cancel(); postSmoothThrottled.cancel(); postCompressThrottled.cancel(); }
    else if (cur) { postShow(cur.file); postGain(true); postSmooth(true); postCompress(true); }
  });
  $('export').addEventListener('click', exportPng);
  $('setdef').addEventListener('click', setDefault);
  $('play').addEventListener('click', () => fetch(playState.playing ? '/api/pause' : '/api/play', { method: 'POST' }).catch(() => {}));
  $('loop').addEventListener('click', () => fetch('/api/loop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loop: !playState.loop }) }).catch(() => {}));
  $('region').addEventListener('click', () => {
    if (!cfg.region) cfg.region = { enabled: false, showOutline: false, markers: false, x: 0.3, y: 0.1, width: 0.4, height: 0.8 };
    cfg.region.enabled = !cfg.region.enabled;
    const cb = $('s-region'); if (cb) cb.checked = cfg.region.enabled;
    updateRegionBtn();
    applyLive();
  });
  $('outline').addEventListener('click', () => {
    if (!cfg.region) cfg.region = { enabled: false, showOutline: false, markers: false, x: 0.3, y: 0.1, width: 0.4, height: 0.8 };
    cfg.region.showOutline = !cfg.region.showOutline;
    const cb = $('s-region-outline'); if (cb) cb.checked = cfg.region.showOutline;
    updateRegionBtn();
    applyLive();
  });
  $('markers').addEventListener('click', () => {
    if (!cfg.region) cfg.region = { enabled: false, showOutline: false, markers: false, x: 0.3, y: 0.1, width: 0.4, height: 0.8 };
    cfg.region.markers = !cfg.region.markers;
    const cb = $('s-region-markers'); if (cb) cb.checked = cfg.region.markers;
    updateRegionBtn();
    applyLive();
  });

  $('btn-start').addEventListener('click', () => fetch('/api/start', { method: 'POST' }).catch(() => {}));
  $('btn-reset').addEventListener('click', () => fetch('/api/reset', { method: 'POST' }).catch(() => {}));
  $('btn-gear').addEventListener('click', openSettings);
  $('set-close').addEventListener('click', closeSettings);
  $('scrim').addEventListener('click', closeSettings);
  $('s-devrefresh').addEventListener('click', async () => {
    try { await fetch('/api/devices/refresh', { method: 'POST' }); } catch (_) {}
    await loadDevices();
    applyLive();
  });

  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(recompute, 150); });

  pollLoop();
}

init();
