'use strict';

const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { createWebServer } = require('./server');
const DEFAULTS = require('./config-defaults');

const LIST_MODE = process.argv.includes('--list-devices');

let CONFIG_PATH;
let config = DEFAULTS;
let mainWin = null;
let webServer = null;
let webUrls = [];

// ---------- config helpers ----------
function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function configPath() {
  if (process.env.WAVEVIZ_CONFIG) return process.env.WAVEVIZ_CONFIG;
  // packaged builds install to a read-only location (Program Files / signed .app),
  // so keep the editable config + recordings in the per-user data dir instead
  if (app.isPackaged) return path.join(app.getPath('userData'), 'config.json');
  return path.join(app.getAppPath(), 'config.json');
}

function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { /* missing/invalid */ }
  return deepMerge(DEFAULTS, user);
}

function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2)); } catch (_) {}
  }
}

function resolveDir(dir) {
  if (!dir) dir = './recordings';
  if (path.isAbsolute(dir)) return dir;
  return path.resolve(path.dirname(CONFIG_PATH), dir);
}

function pad(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function getOutputDir() { return resolveDir(config.output && config.output.directory); }

async function listRecordings() {
  const dir = getOutputDir();
  let files = [];
  try { files = await fsp.readdir(dir); } catch (_) { return []; }
  const set = new Set(files);
  const wavs = files.filter((f) => /\.wav$/i.test(f));
  const out = [];
  for (const f of wavs) {
    try {
      const st = await fsp.stat(path.join(dir, f));
      const png = f.replace(/\.wav$/i, '.png');
      out.push({ file: f, size: st.size, mtimeMs: st.mtimeMs, png: set.has(png) ? png : null });
    } catch (_) {}
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// host audio devices reported by the renderer (the web UI lists these)
let deviceCache = { inputs: [], outputs: [] };
let deviceWaiters = [];
function requestDevices() {
  return new Promise((resolve) => {
    deviceWaiters.push(resolve);
    send('request-devices');
    setTimeout(() => {
      const i = deviceWaiters.indexOf(resolve);
      if (i >= 0) { deviceWaiters.splice(i, 1); resolve(deviceCache); }
    }, 2500);
  });
}

// last known visualizer state (the web UI polls this)
let stateCache = { state: 'idle', screen: 'config', remaining: null, file: null, duration: 0 };
// last downsampled envelope snapshot (so the web can mirror the full screen live)
let peaksCache = {};

async function persistConfig(incoming, notify) {
  const prevWeb = JSON.stringify(config.web || {});
  config = deepMerge(DEFAULTS, incoming || {});
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  if (JSON.stringify(config.web || {}) !== prevWeb) startWeb();
  if (notify) send('viz:config', { full: config, waveform: config.waveform });
  return config;
}

// ---------- web remote server ----------
function startWeb() {
  const launch = () => {
    webUrls = [];
    const web = config.web || {};
    if (!web.enabled) { send('web:info', { enabled: false, urls: [] }); return; }
    const port = parseInt(web.port, 10) || 8080;
    const host = web.lan ? '0.0.0.0' : '127.0.0.1';

    const srv = createWebServer({
      webRoot: path.join(__dirname, 'web'),
      getConfig: () => config,
      getOutputDir,
      listRecordings,
      saveConfig: (incoming) => persistConfig(incoming, true),
      getDevices: () => deviceCache,
      refreshDevices: () => requestDevices(),
      getState: () => stateCache,
      getPeaks: () => peaksCache,
      onStart: () => send('viz:start'),
      onReset: () => send('viz:reset'),
      onPlay: () => send('viz:play'),
      onPause: () => send('viz:pause'),
      onLoop: (v) => send('viz:loop', !!v),
      onShow: async (name) => {
        const fp = path.join(getOutputDir(), name);
        const buf = await fsp.readFile(fp);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        send('viz:show', { file: name, bytes: ab });
        return { ok: true };
      },
      onGain: (v) => { if (isFinite(v)) send('viz:gain', Math.max(0.05, Math.min(16, v))); },
      onSmooth: (v) => { if (isFinite(v)) send('viz:smooth', Math.max(0, Math.min(1, v))); },
      onCompress: (v) => { if (isFinite(v)) send('viz:compress', Math.max(0, Math.min(1, v))); },
      onSetDefault: async (body) => {
        const amp = Number(body && body.amplitudeScale);
        const sm = Number(body && body.smoothing);
        const cm = Number(body && body.compress);
        if (isFinite(amp)) config.waveform.amplitudeScale = Math.max(0.1, Math.min(16, amp));
        if (isFinite(sm)) config.waveform.smoothing = Math.max(0, Math.min(1, sm));
        if (isFinite(cm)) config.waveform.compress = Math.max(0, Math.min(1, cm));
        try { await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2)); }
        catch (e) { return { error: String((e && e.message) || e) }; }
        send('viz:config', { waveform: config.waveform });
        return { ok: true, amplitudeScale: config.waveform.amplitudeScale, smoothing: config.waveform.smoothing, compress: config.waveform.compress };
      },
      saveExport: async ({ file, amplitudeScale, png }) => {
        if (!png || typeof png !== 'string') return { error: 'no image' };
        const b64 = png.replace(/^data:image\/png;base64,/, '');
        const buf = Buffer.from(b64, 'base64');
        // reject anything that isn't actually a PNG
        if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return { error: 'not a PNG' };
        const base = path.basename(String(file || 'recording')).replace(/\.(wav|png)$/i, '');
        const scale = Number(amplitudeScale) || 1;
        const dir = getOutputDir();
        await fsp.mkdir(dir, { recursive: true });
        let outPath = path.join(dir, `${base}_x${scale.toFixed(2)}.png`);
        if (fs.existsSync(outPath)) outPath = path.join(dir, `${base}_x${scale.toFixed(2)}_${stamp()}.png`);
        await fsp.writeFile(outPath, buf);
        return { ok: true, path: outPath };
      }
    });

    srv.on('error', (e) => {
      const msg = e.code === 'EADDRINUSE' ? `Port ${port} is already in use` : e.message;
      console.error('Web server error:', msg);
      if (webServer === srv) webServer = null;
      webUrls = [];
      send('web:info', { enabled: true, error: msg, urls: [] });
    });
    srv.listen(port, host, () => {
      const addrs = web.lan ? lanAddresses() : [];
      webUrls = [`http://localhost:${port}`, ...addrs.map((a) => `http://${a}:${port}`)];
      send('web:info', { enabled: true, port, urls: webUrls });
    });
    webServer = srv;
  };

  // close the old server first; close() is async, so wait for it to avoid EADDRINUSE
  if (webServer) {
    const old = webServer; webServer = null;
    try { if (old.closeAllConnections) old.closeAllConnections(); } catch (_) {}
    try { old.close(() => launch()); } catch (_) { launch(); }
  } else {
    launch();
  }
}

// ---------- permissions (mic) ----------
function setupPermissions() {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  try { s.setPermissionCheckHandler(() => true); } catch (_) {}
}

// ---------- main window ----------
async function createMain() {
  mainWin = new BrowserWindow({
    width: 1120,
    height: 900,
    minWidth: 760,
    minHeight: 600,
    center: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWin.setMenuBarVisibility(false);

  const notify = () => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('layout-changed'); };
  mainWin.on('resize', notify);
  mainWin.on('enter-full-screen', notify);
  mainWin.on('leave-full-screen', notify);

  await mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.show();
  mainWin.on('closed', () => { mainWin = null; });
}

// ---------- device list helper (`npm run devices`) ----------
async function createDeviceList() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const timeout = setTimeout(() => {
    console.error('Timed out waiting for device enumeration.');
    app.quit();
  }, 12000);
  ipcMain.once('devices-report', (_e, list) => {
    clearTimeout(timeout);
    printDevices(list);
    app.quit();
  });
  await win.loadFile(path.join(__dirname, 'devices.html'));
}

function printDevices(list) {
  if (list.length === 1 && list[0].error) {
    console.error('\nCould not list devices: ' + list[0].error + '\n');
    return;
  }
  console.log('\nAvailable audio input devices:\n');
  if (!list.length) { console.log('  (none found)\n'); return; }
  list.forEach((d) => {
    console.log(`  [${d.index}] ${d.label}`);
    console.log(`        deviceId: ${d.deviceId}`);
  });
  console.log('\nSet "inputDevice" in config.json (or pick it in the app) to any part of a');
  console.log('device name. Leave it empty ("") to use the system default input.\n');
}

// ---------- IPC ----------
ipcMain.handle('get-config', () => config);

// the write inside persistConfig throws on failure so the renderer can report it
ipcMain.handle('save-config', (_e, incoming) => persistConfig(incoming, false));

// renderer reports the host's audio inputs/outputs (for the web device dropdowns)
ipcMain.on('devices-list', (_e, d) => {
  if (Array.isArray(d)) deviceCache = { inputs: d, outputs: [] };           // back-compat
  else deviceCache = { inputs: (d && d.inputs) || [], outputs: (d && d.outputs) || [] };
  const ws = deviceWaiters; deviceWaiters = [];
  ws.forEach((r) => r(deviceCache));
});

// renderer reports its current state (for the web status / polling)
ipcMain.on('viz:state', (_e, s) => { if (s && typeof s === 'object') stateCache = Object.assign({}, stateCache, s); });

// renderer streams the downsampled envelope (for the web live mirror)
ipcMain.on('viz:peaks', (_e, p) => { if (p && typeof p === 'object') peaksCache = p; });

ipcMain.handle('get-web-info', () => ({ enabled: !!(config.web && config.web.enabled), urls: webUrls, port: (config.web && config.web.port) || 8080 }));

ipcMain.handle('open-external', async (_e, url) => { if (url) await shell.openExternal(url); return true; });

ipcMain.handle('set-fullscreen', (e, flag) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) {
    // On macOS, native fullscreen uses a separate Space where the menu bar
    // reveals on hover. "Simple" fullscreen covers the menu bar + Dock fully.
    if (process.platform === 'darwin') w.setSimpleFullScreen(!!flag);
    else w.setFullScreen(!!flag);
    if (!w.isDestroyed()) w.webContents.send('layout-changed');
  }
  return true;
});

ipcMain.handle('choose-directory', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// turn a (possibly relative) output dir into the absolute path actually used
ipcMain.handle('resolve-output-dir', (_e, dir) => resolveDir(dir));

ipcMain.handle('get-config-path', () => CONFIG_PATH);

// open the output folder in the OS file manager (creating it if needed)
ipcMain.handle('open-path', async (_e, dir) => {
  const target = resolveDir(dir && dir.length ? dir : (config.output && config.output.directory));
  await fsp.mkdir(target, { recursive: true }).catch(() => {});
  const err = await shell.openPath(target);
  return { path: target, error: err || null };
});

ipcMain.handle('save-recording', async (_e, payload) => {
  const out = config.output || {};
  const baseDir = resolveDir(out.directory);
  const name = `${(payload && payload.prefix) || 'recording'}_${stamp()}`;
  // optionally give each recording its own timestamped subfolder
  const targetDir = out.subfolderPerRecording ? path.join(baseDir, name) : baseDir;
  await fsp.mkdir(targetDir, { recursive: true });

  const res = { dir: targetDir };
  if (out.saveWav && payload && payload.wav) {
    const p = path.join(targetDir, name + '.wav');
    await fsp.writeFile(p, Buffer.from(payload.wav));
    res.wav = p;
  }
  if (out.savePng && payload && payload.png) {
    const p = path.join(targetDir, name + '.png');
    await fsp.writeFile(p, Buffer.from(payload.png));
    res.png = p;
  }
  return res;
});

ipcMain.on('quit', () => app.quit());

// ---------- lifecycle ----------
app.whenReady().then(() => {
  CONFIG_PATH = configPath();
  ensureConfigFile();
  config = loadConfig();
  setupPermissions();

  if (LIST_MODE) {
    createDeviceList();
  } else {
    createMain().then(startWeb);
    app.on('activate', () => {
      if (!LIST_MODE && BrowserWindow.getAllWindows().length === 0) createMain();
    });
  }
});

app.on('before-quit', () => { if (webServer) { try { webServer.close(); } catch (_) {} } });

app.on('window-all-closed', () => app.quit());
