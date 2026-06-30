'use strict';

// Tiny dependency-free HTTP server for the interactive web remote.
// Serves the web UI, lists recordings, streams WAV bytes, and relays
// show/gain/export/set-default actions back to the Electron main process
// through injected callbacks.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, status, body, headers) {
  res.writeHead(status, headers || {});
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonBody(req, limit) {
  try { return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}'); }
  catch (_) { return null; }
}

// only allow plain recording file names (no path separators / traversal)
function safeName(name) {
  if (typeof name !== 'string' || !name) return null;
  const base = path.basename(name);
  if (base !== name) return null;
  if (!/^[\w.\- +()]+\.(wav|png)$/i.test(base)) return null;
  return base;
}

function within(dir, fp) {
  const rel = path.relative(dir, fp);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * deps: {
 *   webRoot, getConfig, getOutputDir, listRecordings,
 *   onShow(name) -> {}, onGain(num), onSetDefault(num) -> {}, saveExport(obj) -> {}
 * }
 */
function createWebServer(deps) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(u.pathname);

      // The UI is served same-origin, so no CORS headers are needed; their
      // absence also blocks other sites from reading these responses.

      // ---- API ----
      if (p === '/api/recordings' && req.method === 'GET') {
        return sendJson(res, 200, { recordings: await deps.listRecordings() });
      }

      if (p === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, deps.getConfig());
      }

      if (p === '/api/config' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
        return sendJson(res, 200, await deps.saveConfig(body));
      }

      if (p === '/api/devices' && req.method === 'GET') {
        return sendJson(res, 200, { devices: deps.getDevices() });
      }

      if (p === '/api/devices/refresh' && req.method === 'POST') {
        return sendJson(res, 200, { devices: await deps.refreshDevices() });
      }

      if (p === '/api/state' && req.method === 'GET') {
        return sendJson(res, 200, deps.getState());
      }

      if (p === '/api/peaks' && req.method === 'GET') {
        return sendJson(res, 200, deps.getPeaks());
      }

      if (p === '/api/start' && req.method === 'POST') {
        deps.onStart();
        return sendJson(res, 200, { ok: true });
      }

      if ((p === '/api/reset' || p === '/api/restart') && req.method === 'POST') {
        deps.onReset();
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/play' && req.method === 'POST') {
        deps.onPlay();
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/pause' && req.method === 'POST') {
        deps.onPause();
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/loop' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
        deps.onLoop(!!body.loop);
        return sendJson(res, 200, { ok: true });
      }

      if (p.startsWith('/api/audio/') && req.method === 'GET') {
        const name = safeName(p.slice('/api/audio/'.length));
        if (!name || !/\.wav$/i.test(name)) return send(res, 400, 'bad name');
        const dir = deps.getOutputDir();
        const fp = path.join(dir, name);
        if (!within(dir, fp)) return send(res, 400, 'bad path');
        try {
          const data = await fsp.readFile(fp);
          return send(res, 200, data, { 'Content-Type': 'audio/wav', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
        } catch (_) { return send(res, 404, 'not found'); }
      }

      if (p === '/api/show' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
        const name = safeName(body.file);
        if (!name) return sendJson(res, 400, { error: 'bad file' });
        return sendJson(res, 200, (await deps.onShow(name)) || { ok: true });
      }

      if (p === '/api/gain' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
        deps.onGain(Number(body.amplitudeScale));
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/smooth' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
        deps.onSmooth(Number(body.smoothing));
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/compress' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
        deps.onCompress(Number(body.compress));
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/set-default' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
        return sendJson(res, 200, (await deps.onSetDefault(body)) || { ok: true });
      }

      if (p === '/api/export' && req.method === 'POST') {
        const body = await jsonBody(req, 24 * 1024 * 1024); // PNG can be a few MB
        if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
        return sendJson(res, 200, await deps.saveExport(body));
      }

      // ---- static web UI ----
      let rel = p === '/' ? '/index.html' : p;
      rel = rel.replace(/\\/g, '/');
      const fp = path.join(deps.webRoot, rel);
      if (!within(deps.webRoot, fp)) return send(res, 400, 'bad path');
      try {
        const data = await fsp.readFile(fp);
        return send(res, 200, data, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
      } catch (_) { return send(res, 404, 'not found'); }
    } catch (err) {
      try { sendJson(res, 500, { error: String((err && err.message) || err) }); } catch (_) {}
    }
  });
  return server;
}

module.exports = { createWebServer };
