'use strict';
const express  = require('express');
const _archiverMod = require('archiver');
const archiver = typeof _archiverMod === 'function' ? _archiverMod : _archiverMod.default || _archiverMod.create;
const { spawn, spawnSync } = require('child_process');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const ASSETS   = require('./assets-data');

// ─── Platform ──────────────────────────────────────────────────────────────────
const IS_WIN = process.platform === 'win32';
const PORT   = parseInt(process.env.PORT) || 3456;

// ─── Tool paths ────────────────────────────────────────────────────────────────
const TOOLS_DIR = IS_WIN
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'DiskerIA')
  : path.join(__dirname, 'bin');

const YTDLP   = path.join(TOOLS_DIR, IS_WIN ? 'yt-dlp.exe'   : 'yt-dlp');
const FFMPEG  = path.join(TOOLS_DIR, IS_WIN ? 'ffmpeg.exe'  : 'ffmpeg');
const DENO    = path.join(TOOLS_DIR, IS_WIN ? 'deno.exe'    : 'deno');
const COOKIES = path.join(TOOLS_DIR, 'cookies.txt');

// ─── Credentials ───────────────────────────────────────────────────────────────
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'c56aa2a8e834483099301cb5e93bf145';
const GROQ_KEY  = process.env.GROQ_API_KEY      || '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';

// ─── Config ────────────────────────────────────────────────────────────────────
// Desktop: persisted in AppData JSON. Web: in-memory object (resets on restart).
const APP_DIR = IS_WIN ? path.join(os.homedir(), 'AppData', 'Roaming', 'DiskerIA') : null;
const CONFIG  = APP_DIR ? path.join(APP_DIR, 'config.json') : null;
let   webCfg  = {};

function loadConfig() {
  if (!CONFIG) return webCfg;
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
function saveConfig(data) {
  if (!CONFIG) { webCfg = { ...webCfg, ...data }; return; }
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ ...loadConfig(), ...data }, null, 2));
}
function getOutDir() {
  return loadConfig().outDir || path.join(os.homedir(), 'Desktop', 'DiskerIA');
}

// ─── Download sessions (web) ────────────────────────────────────────────────────
const dlSessions = new Map();

function createSession() {
  const id  = crypto.randomBytes(8).toString('hex');
  const dir = path.join(os.tmpdir(), `diskeria-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  dlSessions.set(id, { dir, outDir: dir, files: [], created: Date.now() });
  return id;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of dlSessions) {
    if (now - s.created > 3600000) {
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
      dlSessions.delete(id);
    }
  }
}, 300000);

// ─── Spotify PKCE ──────────────────────────────────────────────────────────────
const SCOPES = 'playlist-read-private playlist-read-collaborative';
let pkceVerifier = null;

function getRedirectUri(req) {
  if (process.env.REDIRECT_URI) return process.env.REDIRECT_URI;
  if (IS_WIN) return `http://127.0.0.1:${PORT}/callback`;
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}/callback`;
}

async function getValidAccessToken() {
  const cfg = loadConfig();
  if (cfg.accessToken && cfg.tokenExpiry && Date.now() < cfg.tokenExpiry - 60000)
    return cfg.accessToken;
  if (cfg.refreshToken) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: cfg.refreshToken,
        client_id:     CLIENT_ID,
      }),
    });
    const json = await res.json();
    if (json.access_token) {
      saveConfig({
        accessToken:  json.access_token,
        refreshToken: json.refresh_token || cfg.refreshToken,
        tokenExpiry:  Date.now() + json.expires_in * 1000,
      });
      return json.access_token;
    }
  }
  throw new Error('NEEDS_LOGIN');
}

// ─── Spotify tracks ────────────────────────────────────────────────────────────
function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80) || 'playlist';
}

async function getSpotifyTracks(url) {
  const m = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (!m) throw new Error('URL de Spotify inválida.');
  const token = await getValidAccessToken();

  const metaRes = await fetch(
    `https://api.spotify.com/v1/playlists/${m[1]}?fields=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const playlistName = metaRes.ok ? (await metaRes.json()).name || 'playlist' : 'playlist';

  const tracks = [];
  let next = `https://api.spotify.com/v1/playlists/${m[1]}/items?limit=100`;
  while (next) {
    const r    = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.text();
    if (!r.ok) throw new Error(`Spotify error ${r.status}`);
    const page = JSON.parse(body);
    for (const item of page.items || []) {
      const t = item.track || item.item;
      if (!t?.name) continue;
      tracks.push({
        title:       t.name,
        artist:      (t.artists || []).map(a => a.name).join(', '),
        searchQuery: `${(t.artists || []).map(a => a.name).join(' ')} ${t.name}`,
      });
    }
    next = page.next || null;
  }
  if (!tracks.length) throw new Error('Playlist vacía o no accesible');
  return { tracks, playlistName };
}

// ─── Downloader ────────────────────────────────────────────────────────────────
function downloadSong(searchQuery, outDir, onProgress) {
  return new Promise((resolve, reject) => {
    const before = new Set(fs.readdirSync(outDir));
    const args   = [
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '--ffmpeg-location', FFMPEG,
      '--no-playlist', '--restrict-filenames',
      '--extractor-args', 'youtube:player_client=tv_embedded,web',
      '--js-runtimes', `node:${process.execPath}`,
      '--socket-timeout', '30',
      '--retries', '2',
      ...(fs.existsSync(COOKIES) ? ['--cookies', COOKIES] : []),
      '-o', path.join(outDir, '%(title)s.%(ext)s'),
      `ytsearch1:${searchQuery}`,
    ];
    if (!fs.existsSync(YTDLP)) {
      const msg = `yt-dlp no encontrado en: ${YTDLP}`;
      console.error(`[yt-dlp] ${msg}`);
      return reject(new Error(msg));
    }
    const proc = spawn(YTDLP, args);
    let output = '';
    proc.stdout.on('data', d => { output += d; if (onProgress) onProgress(); });
    proc.stderr.on('data', d => { output += d; if (onProgress) onProgress(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      console.error(`[yt-dlp] TIMEOUT for "${searchQuery}"`);
      reject(new Error('Timeout: la descarga tardó demasiado'));
    }, 3 * 60 * 1000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[yt-dlp] FAILED (${code}) for "${searchQuery}":\n${output.slice(-1000)}`);
        return reject(new Error(output.slice(-400)));
      }
      const newFile = fs.readdirSync(outDir).find(f => !before.has(f)) || null;
      resolve(newFile);
    });
    proc.on('error', err => {
      clearTimeout(timer);
      console.error(`[yt-dlp] spawn error for "${searchQuery}": ${err.message}`);
      reject(err);
    });
  });
}

// ─── Desktop: openAppWindow ────────────────────────────────────────────────────
function openAppWindow(port) {
  if (!IS_WIN) return;
  const url  = `http://localhost:${port}`;
  const pf   = process.env['ProgramFiles']      || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf,   'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf,   'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  const browser = candidates.find(b => fs.existsSync(b));
  if (browser) {
    spawn(browser, [`--app=${url}`, '--window-size=980,720'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', `start ${url}`], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ─── Desktop: heartbeat ────────────────────────────────────────────────────────
const HB_TIMEOUT = 30000;
let hbTimer = null;

// ─── HTML ──────────────────────────────────────────────────────────────────────
const HTML = /* html */`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DiskerIA</title>
<link rel="icon" href="/favicon.ico">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#00f5ff">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#03030c;
  --s0:rgba(255,255,255,0.03);
  --s1:rgba(255,255,255,0.06);
  --border:rgba(0,245,255,0.12);
  --border-hi:rgba(0,245,255,0.45);
  --cyan:#00f5ff;
  --pink:#ff006e;
  --purple:#7b2fff;
  --green:#00ff88;
  --red:#ff3355;
  --text:#b8c8e8;
  --bright:#e8f0ff;
  --muted:#3a4a6a;
}
body{
  background:var(--bg);
  color:var(--text);
  font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
  min-height:100vh;
  position:relative;
}
body::before{
  content:'';
  position:fixed;inset:0;
  background-image:
    radial-gradient(ellipse 100% 50% at 50% 0%,rgba(0,245,255,0.07) 0%,transparent 65%),
    linear-gradient(rgba(0,245,255,0.022) 1px,transparent 1px),
    linear-gradient(90deg,rgba(0,245,255,0.022) 1px,transparent 1px);
  background-size:auto,50px 50px,50px 50px;
  pointer-events:none;
  z-index:0;
}
.app{max-width:820px;margin:0 auto;padding:48px 20px 80px;position:relative;z-index:1}

/* Header */
.header{display:flex;align-items:center;gap:16px;margin-bottom:6px}
.logo-wrap{
  filter:drop-shadow(0 0 10px rgba(0,245,255,.55)) drop-shadow(0 0 22px rgba(0,245,255,.25));
  flex-shrink:0
}
.app-logo{width:46px;height:46px}
h1{
  font-size:2rem;font-weight:800;letter-spacing:-1px;
  background:linear-gradient(135deg,var(--cyan) 0%,var(--pink) 50%,var(--purple) 100%);
  background-size:200% 200%;
  animation:hshift 6s ease infinite;
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text
}
@keyframes hshift{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.subtitle{color:var(--muted);font-size:.85rem;margin-bottom:36px;letter-spacing:.3px}

/* Glass */
.glass{
  background:rgba(4,4,18,.78);
  backdrop-filter:blur(24px);
  -webkit-backdrop-filter:blur(24px);
  border:1px solid var(--border);
  border-radius:18px;
  box-shadow:0 4px 32px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.04)
}

/* Tabs */
.tabs{display:flex;gap:6px;margin-bottom:12px}
.tab{
  padding:9px 22px;border:1px solid var(--border);border-radius:100px;
  background:none;color:var(--muted);cursor:pointer;font-size:.85rem;font-weight:500;
  transition:all .2s
}
.tab:hover{border-color:rgba(0,245,255,.3);color:var(--text)}
.tab.active{
  background:rgba(0,245,255,.1);border-color:var(--cyan);color:var(--cyan);
  box-shadow:0 0 14px rgba(0,245,255,.2)
}

/* Panel */
.panel{padding:24px;margin-bottom:12px}

/* Inputs */
input[type=text],input[type=url],textarea{
  width:100%;background:rgba(0,0,0,.35);border:1px solid var(--border);
  border-radius:11px;padding:11px 14px;color:var(--bright);font-size:.9rem;
  outline:none;transition:border-color .2s,box-shadow .2s;font-family:inherit
}
input:focus,textarea:focus{
  border-color:rgba(0,245,255,.5);
  box-shadow:0 0 0 3px rgba(0,245,255,.08),0 0 16px rgba(0,245,255,.08)
}
.input-row{display:flex;gap:10px}
.input-row input{flex:1}

/* Buttons */
.btn{
  padding:10px 22px;border:none;border-radius:11px;cursor:pointer;
  font-size:.87rem;font-weight:600;transition:all .2s;white-space:nowrap;
  display:inline-flex;align-items:center;gap:6px
}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{
  background:linear-gradient(135deg,var(--pink),var(--purple));color:#fff;
  box-shadow:0 0 20px rgba(255,0,110,.35)
}
.btn-primary:not(:disabled):hover{
  box-shadow:0 0 28px rgba(255,0,110,.55),0 0 48px rgba(123,47,255,.3);
  transform:translateY(-1px)
}
.btn-ghost{background:var(--s0);border:1px solid var(--border);color:var(--text)}
.btn-ghost:not(:disabled):hover{border-color:rgba(0,245,255,.35);color:var(--bright)}
.btn-cyan{
  background:rgba(0,245,255,.1);border:1px solid rgba(0,245,255,.35);color:var(--cyan)
}
.btn-cyan:not(:disabled):hover{
  background:rgba(0,245,255,.18);box-shadow:0 0 16px rgba(0,245,255,.25)
}
.btn-danger{background:none;border:1px solid var(--muted);color:var(--muted)}
.btn-danger:hover{border-color:var(--red);color:var(--red)}
.btn-spotify{background:#1db954;color:#fff}
.btn-spotify:hover{opacity:.88}
.btn-disconnect{
  background:none;border:1px solid var(--muted);color:var(--muted);
  font-size:.78rem;padding:4px 12px;border-radius:8px;cursor:pointer
}
.btn-disconnect:hover{border-color:var(--red);color:var(--red)}

/* Spotify */
.connect-box{text-align:center;padding:8px 0}
.connect-box p{font-size:.85rem;color:var(--muted);margin-bottom:16px;line-height:1.5}
.connected-row{
  display:flex;align-items:center;gap:10px;
  background:rgba(0,255,136,.06);border:1px solid rgba(0,255,136,.2);
  border-radius:11px;padding:10px 14px;margin-bottom:14px
}
.connected-row span{flex:1;font-size:.88rem;color:var(--green)}

/* Divider */
.divider{display:flex;align-items:center;gap:10px;margin:16px 0;color:var(--muted);font-size:.78rem}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}

/* AI */
textarea.ai-input{resize:vertical;min-height:120px}
.ai-row{display:flex;gap:10px;align-items:center;margin-top:10px}
.ai-badge{font-size:.75rem;color:var(--muted)}
.ai-badge a{color:var(--purple);text-decoration:none}

/* Song list */
.song-list-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.song-count{
  font-size:.85rem;font-weight:700;color:var(--cyan);
  text-shadow:0 0 10px rgba(0,245,255,.5);letter-spacing:.5px
}
.song-list{display:flex;flex-direction:column;gap:4px;margin-bottom:16px}
.song-item{
  background:var(--s0);border:1px solid rgba(255,255,255,.04);
  border-left:3px solid var(--border);
  border-radius:11px;padding:10px 12px;
  display:flex;align-items:center;gap:10px;
  transition:border-color .2s,background .2s,box-shadow .2s
}
.song-item:hover{background:var(--s1);border-left-color:rgba(0,245,255,.35)}
.song-item.is-downloading{border-left-color:var(--cyan);box-shadow:-2px 0 12px rgba(0,245,255,.2)}
.song-item.is-done{border-left-color:var(--green)}
.song-item.is-error{border-left-color:var(--red)}
.song-num{color:var(--muted);font-size:.72rem;width:22px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums}
.song-info{flex:1;min-width:0}
.song-title{font-size:.87rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bright)}
.song-artist{font-size:.76rem;color:var(--muted)}
.song-dl-btn{
  color:var(--cyan);font-size:.85rem;text-decoration:none;
  width:26px;height:26px;display:none;align-items:center;justify-content:center;
  border-radius:7px;border:1px solid rgba(0,245,255,.3);
  transition:all .2s;flex-shrink:0
}
.song-dl-btn:hover{background:rgba(0,245,255,.15);box-shadow:0 0 10px rgba(0,245,255,.3)}
.song-status{font-size:.95rem;flex-shrink:0;width:22px;text-align:center}
.song-delete-btn{
  opacity:0;flex-shrink:0;width:24px;height:24px;
  background:rgba(255,51,85,.1);border:1px solid rgba(255,51,85,.22);
  color:var(--red);border-radius:6px;font-size:1rem;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:opacity .15s,background .15s;padding:0;line-height:1
}
.song-item:hover .song-delete-btn{opacity:1}
.song-delete-btn:hover{background:rgba(255,51,85,.3)}

/* Folder (desktop only) */
.folder-section{padding-top:14px;border-top:1px solid var(--border);margin-bottom:4px}
.folder-row{
  display:flex;align-items:center;gap:8px;
  background:rgba(0,0,0,.28);border:1px solid var(--border);
  border-radius:10px;padding:8px 12px;margin-bottom:6px
}
.folder-row .lbl{font-size:.75rem;color:var(--muted);flex-shrink:0}
.folder-base{flex:1;font-size:.77rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.folder-input{background:none;border:none;outline:none;color:var(--bright);font-size:.82rem;flex:1;font-family:inherit}

/* Actions */
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px}

/* Progress */
.progress-wrap{margin-top:16px}
.progress-label{font-size:.8rem;color:var(--cyan);margin-bottom:8px;font-family:monospace;letter-spacing:.3px}
.progress-track{height:4px;background:rgba(0,245,255,.08);border-radius:2px;overflow:hidden}
.progress-fill{
  height:100%;width:0%;
  background:linear-gradient(90deg,var(--cyan),var(--purple));
  border-radius:2px;transition:width .35s;
  box-shadow:0 0 10px rgba(0,245,255,.45)
}

/* Toast */
.toast{
  position:fixed;bottom:24px;right:24px;
  background:rgba(4,4,18,.92);backdrop-filter:blur(16px);
  border:1px solid var(--border);border-radius:12px;
  padding:12px 18px;font-size:.87rem;opacity:0;transition:opacity .3s;
  pointer-events:none;z-index:100;max-width:280px
}
.toast.show{opacity:1}
.toast.success{border-color:rgba(0,255,136,.5);color:var(--green)}
.toast.error{border-color:rgba(255,51,85,.5);color:var(--red)}
</style>
</head>
<body>
<div class="app">

  <div class="header">
    <div class="logo-wrap">
      <svg class="app-logo" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="lg" cx="35%" cy="35%" r="70%">
            <stop offset="0%" stop-color="#ff7828"/>
            <stop offset="100%" stop-color="#d2005a"/>
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="49" fill="url(#lg)"/>
        <circle cx="50" cy="50" r="15" fill="white"/>
        <circle cx="50" cy="50" r="6.5" fill="#d2005a"/>
        <line x1="29" y1="19" x2="51" y2="46" stroke="white" stroke-width="5.5" stroke-linecap="round"/>
        <circle cx="28" cy="18" r="4.5" fill="white"/>
      </svg>
    </div>
    <div>
      <h1>DiskerIA</h1>
    </div>
  </div>
  <p class="subtitle">Descargá tu música favorita en MP3</p>

  <div class="tabs">
    <button class="tab active" data-tab="spotify">🎵 Spotify</button>
    <button class="tab" data-tab="ia">🤖 Buscar con IA</button>
  </div>

  <!-- Spotify panel -->
  <div id="tab-spotify" class="panel glass">
    <div id="spotify-disconnected" style="display:none">
      <div class="connect-box">
        <p>Conectá tu cuenta de Spotify para importar playlists</p>
        <button class="btn btn-spotify" id="spotify-login-btn">🎵 Conectar con Spotify</button>
      </div>
    </div>
    <div id="spotify-connected" style="display:none">
      <div class="connected-row">
        <span>● Spotify conectado</span>
        <button class="btn-disconnect" id="spotify-logout-btn">Desconectar</button>
      </div>
      <div class="input-row">
        <input type="url" id="spotify-url" placeholder="https://open.spotify.com/playlist/...">
        <button class="btn btn-ghost" id="load-btn">Buscar</button>
      </div>
    </div>
  </div>

  <!-- IA panel -->
  <div id="tab-ia" class="panel glass" style="display:none">
    <textarea class="ai-input" id="ai-text"
      placeholder="Pegá cualquier lista de canciones acá:&#10;&#10;Bohemian Rhapsody - Queen&#10;1. Hotel California - Eagles&#10;Stairway to Heaven by Led Zeppelin&#10;..."></textarea>
    <div class="ai-row">
      <button class="btn btn-primary" id="ai-parse-btn">🤖 Detectar canciones</button>
      <span class="ai-badge">Powered by <a href="https://console.groq.com/keys" target="_blank">Groq</a></span>
    </div>
  </div>

  <!-- Song list -->
  <div id="song-list-wrap" class="glass" style="display:none">
    <div style="padding:24px">
      <div class="song-list-header">
        <span id="song-count" class="song-count"></span>
      </div>
      <div class="song-list" id="song-list"></div>

      <!-- Desktop: folder config -->
      <div class="folder-section desktop-only">
        <div class="folder-row">
          <span class="lbl">📁</span>
          <span class="folder-base" id="folder-base">...</span>
          <button class="btn btn-ghost" id="pick-folder-btn" style="padding:4px 10px;font-size:.78rem">Cambiar</button>
        </div>
        <div class="folder-row">
          <span class="lbl">└─</span>
          <input type="text" class="folder-input" id="folder-name" placeholder="subcarpeta (opcional)">
        </div>
      </div>

      <!-- Web: folder name only -->
      <div class="folder-row web-only" style="margin-top:4px">
        <span class="lbl">📁</span>
        <input type="text" class="folder-input" id="folder-name-web" placeholder="nombre de carpeta (opcional)">
      </div>

      <div class="actions">
        <button class="btn btn-primary" id="download-btn">⬇ Descargar todo</button>
        <button class="btn btn-danger" id="clear-btn">✕ Limpiar lista</button>
        <a id="zip-btn" class="btn btn-cyan" style="display:none" target="_blank">📦 Descargar ZIP</a>
      </div>

      <div id="progress-wrap" style="display:none">
        <div style="margin-top:16px">
          <div class="progress-label" id="progress-label">Iniciando...</div>
          <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
        </div>
      </div>
    </div>
  </div>

</div>
<div class="toast" id="toast"></div>

<script>
const IS_DESKTOP = ${IS_WIN};
let songs = [];
let downloading = false;
let downloadAbort = null;
let currentSessionId = null;

// ── Platform setup ────────────────────────────────────────────────────────────
document.querySelectorAll('.desktop-only').forEach(el => { el.style.display = IS_DESKTOP ? '' : 'none'; });
document.querySelectorAll('.web-only').forEach(el => { el.style.display = IS_DESKTOP ? 'none' : ''; });

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (type||'');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

function getFolderName() {
  return IS_DESKTOP
    ? document.getElementById('folder-name').value.trim()
    : document.getElementById('folder-name-web').value.trim();
}

function resetDownloadUI() {
  if (downloadAbort) { try { downloadAbort.abort(); } catch {} downloadAbort = null; }
  downloading = false;
  document.getElementById('download-btn').disabled = false;
  document.getElementById('progress-wrap').style.display = 'none';
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-label').textContent = 'Iniciando...';
  document.getElementById('zip-btn').style.display = 'none';
  currentSessionId = null;
}

// ── Song list ─────────────────────────────────────────────────────────────────
function loadSongs(newSongs, suggestedFolder, forceFolder) {
  resetDownloadUI();
  const wasEmpty = songs.length === 0;
  songs = [...songs, ...newSongs];
  if (suggestedFolder && (wasEmpty || forceFolder)) {
    if (IS_DESKTOP) {
      const fi = document.getElementById('folder-name');
      if (!fi.value.trim()) fi.value = suggestedFolder;
    } else {
      const fi = document.getElementById('folder-name-web');
      if (!fi.value.trim()) fi.value = suggestedFolder;
    }
  }
  renderSongs();
}

function renderSongs() {
  const wrap  = document.getElementById('song-list-wrap');
  const list  = document.getElementById('song-list');
  const count = document.getElementById('song-count');
  if (!songs.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  count.textContent = songs.length + ' canciones';
  list.innerHTML = songs.map((s, i) => \`
    <div class="song-item" id="song-\${i}">
      <span class="song-num">\${i+1}</span>
      <div class="song-info">
        <div class="song-title">\${escHtml(s.title)}</div>
        <div class="song-artist">\${escHtml(s.artist)}</div>
      </div>
      <a class="song-dl-btn" id="dl-\${i}" title="Descargar MP3" target="_blank">⬇</a>
      <span class="song-status" id="status-\${i}">⏳</span>
      <button class="song-delete-btn" data-idx="\${i}">×</button>
    </div>
  \`).join('');
}

document.getElementById('song-list').addEventListener('click', e => {
  const btn = e.target.closest('.song-delete-btn');
  if (!btn || downloading) return;
  songs.splice(parseInt(btn.dataset.idx, 10), 1);
  renderSongs();
});

// ── Desktop: out dir ──────────────────────────────────────────────────────────
if (IS_DESKTOP) {
  fetch('/api/out-dir').then(r => r.json()).then(d => {
    document.getElementById('folder-base').textContent = d.path || '';
  }).catch(() => {});

  document.getElementById('pick-folder-btn').addEventListener('click', async () => {
    const btn = document.getElementById('pick-folder-btn');
    btn.disabled = true; btn.textContent = '...';
    try {
      const res = await fetch('/api/pick-folder', { method: 'POST' });
      const data = await res.json();
      if (!data.cancelled) {
        document.getElementById('folder-base').textContent = data.path;
        toast('Carpeta guardada', 'success');
      }
    } finally { btn.disabled = false; btn.textContent = 'Cambiar'; }
  });
}

// ── Spotify ───────────────────────────────────────────────────────────────────
async function refreshSpotifyStatus() {
  try {
    const { connected } = await (await fetch('/auth/status')).json();
    document.getElementById('spotify-disconnected').style.display = connected ? 'none' : 'block';
    document.getElementById('spotify-connected').style.display    = connected ? 'block' : 'none';
  } catch {}
}
refreshSpotifyStatus();

document.getElementById('spotify-login-btn').addEventListener('click', () => { window.location.href = '/login'; });

document.getElementById('spotify-logout-btn').addEventListener('click', async () => {
  if (!confirm('¿Desconectar Spotify?')) return;
  await fetch('/auth/logout', { method: 'POST' });
  await refreshSpotifyStatus();
  toast('Spotify desconectado', '');
});

document.getElementById('load-btn').addEventListener('click', async () => {
  const url = document.getElementById('spotify-url').value.trim();
  if (!url) return;
  const btn = document.getElementById('load-btn');
  btn.disabled = true; btn.textContent = 'Cargando...';
  try {
    const res  = await fetch('/api/spotify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url}) });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'NEEDS_LOGIN') { window.location.href = '/login'; return; }
      throw new Error(data.error);
    }
    loadSongs(data.songs, data.playlistName, true);
    toast(songs.length + ' canciones cargadas', 'success');
  } catch(e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Buscar'; }
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.style.display = 'none');
  t.classList.add('active');
  document.getElementById('tab-' + t.dataset.tab).style.display = 'block';
}));

// ── AI parse ──────────────────────────────────────────────────────────────────
document.getElementById('ai-parse-btn').addEventListener('click', async () => {
  const text = document.getElementById('ai-text').value.trim();
  if (!text) return;
  const btn = document.getElementById('ai-parse-btn');
  btn.disabled = true; btn.textContent = '⏳ Procesando...';
  try {
    const res  = await fetch('/api/parse', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    loadSongs(data.songs, data.folderName, false);
    toast(songs.length + ' canciones detectadas', 'success');
  } catch(e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '🤖 Detectar canciones'; }
});

// ── Clear ─────────────────────────────────────────────────────────────────────
document.getElementById('clear-btn').addEventListener('click', () => {
  resetDownloadUI();
  songs = [];
  if (IS_DESKTOP) { document.getElementById('folder-name').value = ''; }
  else { document.getElementById('folder-name-web').value = ''; }
  renderSongs();
});

// ── Heartbeat (desktop only) ──────────────────────────────────────────────────
if (IS_DESKTOP) {
  new Worker(URL.createObjectURL(new Blob(
    ['setInterval(()=>postMessage(1),5000)'], {type:'text/javascript'}
  ))).onmessage = () => fetch('/api/heartbeat', {method:'POST'}).catch(()=>{});
}

// ── Download ──────────────────────────────────────────────────────────────────
document.getElementById('download-btn').addEventListener('click', async () => {
  if (!songs.length || downloading) return;
  downloading = true;
  downloadAbort = new AbortController();
  const btn          = document.getElementById('download-btn');
  const progressWrap = document.getElementById('progress-wrap');
  const progressFill = document.getElementById('progress-fill');
  const progressLabel= document.getElementById('progress-label');
  btn.disabled = true;
  progressWrap.style.display = 'block';
  songs.forEach((_,i) => {
    const s = document.getElementById('status-'+i);
    if (s) s.textContent = '⏳';
    const item = document.getElementById('song-'+i);
    if (item) item.className = 'song-item';
  });

  try {
    const folderName = getFolderName();
    const res = await fetch('/api/download', {
      method:'POST', signal:downloadAbort.signal,
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ songs, folderName }),
    });

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream:true });
      const events = buffer.split('\\n\\n');
      buffer = events.pop();
      for (const ev of events) {
        const line = ev.replace(/^data: /,'').trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'session') {
            currentSessionId = msg.sessionId;
          } else if (msg.type === 'start') {
            progressLabel.textContent = \`(\${msg.index+1}/\${msg.total}) \${msg.label}\`;
            progressFill.style.width = (msg.index / msg.total * 100) + '%';
            const item = document.getElementById('song-'+msg.index);
            if (item) item.className = 'song-item is-downloading';
            const st = document.getElementById('status-'+msg.index);
            if (st) st.textContent = '⬇️';
            item?.scrollIntoView({ behavior:'smooth', block:'nearest' });
          } else if (msg.type === 'done') {
            const item = document.getElementById('song-'+msg.index);
            if (item) item.className = 'song-item is-done';
            const st = document.getElementById('status-'+msg.index);
            if (st) st.textContent = '✅';
            if (!IS_DESKTOP && msg.filename && currentSessionId) {
              const dlBtn = document.getElementById('dl-'+msg.index);
              if (dlBtn) {
                dlBtn.href = \`/files/\${currentSessionId}/\${encodeURIComponent(msg.filename)}\`;
                dlBtn.style.display = 'inline-flex';
              }
            }
          } else if (msg.type === 'error') {
            const item = document.getElementById('song-'+msg.index);
            if (item) item.className = 'song-item is-error';
            const st = document.getElementById('status-'+msg.index);
            if (st) { st.textContent = '❌'; st.title = msg.error || ''; }
            console.error('[diskeria] error canción', msg.index, msg.error);
          } else if (msg.type === 'complete') {
            progressFill.style.width = '100%';
            toast('Descarga completa', 'success');
            if (!IS_DESKTOP && msg.sessionId) {
              progressLabel.textContent = '¡Listo! Descargando ZIP...';
              const zipUrl = '/zip/' + msg.sessionId;
              const zipBtn = document.getElementById('zip-btn');
              zipBtn.href = zipUrl;
              zipBtn.style.display = 'inline-flex';
              const a = document.createElement('a');
              a.href = zipUrl;
              a.download = 'diskeria-musica.zip';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            } else {
              progressLabel.textContent = '¡Listo! Revisá tu carpeta.';
            }
          }
        } catch {}
      }
    }
  } catch(e) {
    if (e.name !== 'AbortError') toast('Error en la descarga', 'error');
  } finally {
    downloading = false;
    downloadAbort = null;
    btn.disabled = false;
  }
});
</script>
</body>
</html>`;

// ─── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── Static assets ─────────────────────────────────────────────────────────────
app.get('/favicon.ico', (_, res) => {
  res.setHeader('Content-Type', 'image/x-icon');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(ASSETS.ico);
});
app.get('/logo.png', (_, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(ASSETS.png);
});
app.get('/manifest.json', (_, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: 'DiskerIA', short_name: 'DiskerIA', start_url: '/',
    display: 'standalone', background_color: '#03030c', theme_color: '#00f5ff',
    icons: [
      { src: '/logo.png',    sizes: '256x256', type: 'image/png'    },
      { src: '/favicon.ico', sizes: '48x48',   type: 'image/x-icon' },
    ],
  });
});

// ─── Heartbeat (desktop only) ──────────────────────────────────────────────────
app.post('/api/heartbeat', (_, res) => {
  if (IS_WIN) {
    if (hbTimer) clearTimeout(hbTimer);
    hbTimer = setTimeout(() => process.exit(0), HB_TIMEOUT);
  }
  res.status(204).end();
});

// ─── Main page ─────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.send(HTML));

// ─── Auth ──────────────────────────────────────────────────────────────────────
app.get('/auth/status', (_, res) => {
  const cfg = loadConfig();
  res.json({ connected: !!(cfg.refreshToken) });
});

app.post('/auth/logout', (_, res) => {
  saveConfig({ accessToken: null, refreshToken: null, tokenExpiry: null });
  res.json({ ok: true });
});

app.get('/login', (req, res) => {
  pkceVerifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(pkceVerifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code',
    redirect_uri: getRedirectUri(req), scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2 style="font-family:sans-serif;color:#ff3355">Error: ${error}</h2>`);
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: getRedirectUri(req),
      client_id: CLIENT_ID, code_verifier: pkceVerifier,
    }),
  });
  const json = await tokenRes.json();
  if (!json.access_token)
    return res.send(`<h2 style="font-family:sans-serif;color:#ff3355">Error: ${JSON.stringify(json)}</h2>`);
  saveConfig({
    accessToken:  json.access_token,
    refreshToken: json.refresh_token,
    tokenExpiry:  Date.now() + json.expires_in * 1000,
  });
  res.send('<script>window.location="/"</script>Conectado, redirigiendo...');
});

// ─── AI parse ──────────────────────────────────────────────────────────────────
app.post('/api/parse', async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Texto vacío' });

  const prompt = `Extract all songs from the text below and suggest a short folder name for the collection.
Return ONLY valid JSON, no markdown, no explanation:
{
  "folderName": "Fun evocative name (2-4 words) that captures the mood, era, or feel of the songs. Use letters, spaces and numbers only.",
  "songs": [{"title": "Song Name", "artist": "Artist Name"}, ...]
}
Use empty string for artist if unknown. Ignore lines that are not songs.

Text:
${text}`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.3 }),
  });
  const json = await r.json();
  if (!r.ok) return res.status(400).json({ error: json.error?.message || 'Groq error' });

  try {
    const raw    = json.choices[0].message.content.trim().replace(/^```json\n?|```$/g, '');
    const parsed = JSON.parse(raw);
    const list   = Array.isArray(parsed) ? parsed : (parsed.songs || []);
    const songs  = list.map(s => ({
      title: s.title || '', artist: s.artist || '',
      searchQuery: `${s.artist || ''} ${s.title || ''}`.trim(),
    })).filter(s => s.title);
    res.json({ songs, folderName: parsed.folderName || null });
  } catch {
    res.status(400).json({ error: 'La IA devolvió una respuesta inesperada, intentá de nuevo' });
  }
});

// ─── Spotify ───────────────────────────────────────────────────────────────────
app.post('/api/spotify', async (req, res) => {
  try {
    const { tracks, playlistName } = await getSpotifyTracks(req.body.url);
    res.json({ songs: tracks, playlistName });
  } catch (e) {
    if (e.message === 'NEEDS_LOGIN') return res.status(401).json({ error: 'NEEDS_LOGIN' });
    res.status(400).json({ error: e.message });
  }
});

// ─── Desktop: folder ──────────────────────────────────────────────────────────
app.get('/api/out-dir', (_, res) => res.json({ path: IS_WIN ? getOutDir() : null }));

app.post('/api/pick-folder', (req, res) => {
  if (!IS_WIN) return res.json({ cancelled: true });
  const current = getOutDir().replace(/'/g, "''");
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$o = New-Object System.Windows.Forms.Form; $o.TopMost = $true;',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
    `$d.Description = 'Selecciona donde guardar la musica';`,
    `$d.SelectedPath = '${current}';`,
    "if ($d.ShowDialog($o) -eq 'OK') { Write-Output $d.SelectedPath }",
  ].join(' ');
  const result  = spawnSync('powershell', ['-command', ps], { encoding: 'utf8', timeout: 60000 });
  const selected = result.stdout?.trim();
  if (!selected) return res.json({ cancelled: true });
  fs.mkdirSync(selected, { recursive: true });
  saveConfig({ outDir: selected });
  res.json({ path: selected });
});

// ─── Tools status ──────────────────────────────────────────────────────────────
app.get('/api/tools-status', (_, res) => {
  res.json({
    ytdlp:  { path: YTDLP,  exists: fs.existsSync(YTDLP)  },
    ffmpeg: { path: FFMPEG, exists: fs.existsSync(FFMPEG) },
    deno:   { path: DENO,   exists: fs.existsSync(DENO)   },
    platform: process.platform,
    cwd: process.cwd(),
    dirname: __dirname,
  });
});

// ─── Download ──────────────────────────────────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { songs, folderName } = req.body;

  let outDir, sessionId;
  if (IS_WIN) {
    const base = getOutDir();
    outDir = folderName ? path.join(base, sanitizeName(folderName)) : base;
    fs.mkdirSync(outDir, { recursive: true });
  } else {
    sessionId = createSession();
    const sess = dlSessions.get(sessionId);
    outDir = folderName ? path.join(sess.dir, sanitizeName(folderName)) : sess.dir;
    fs.mkdirSync(outDir, { recursive: true });
    sess.outDir = outDir;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 20000);
  if (sessionId) send({ type: 'session', sessionId });

  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    send({ type: 'start', index: i, total: songs.length, label: `${s.artist} – ${s.title}` });
    try {
      const filename = await downloadSong(s.searchQuery, outDir, () => {
        try { res.write(': progress\n\n'); } catch {}
      });
      if (sessionId && filename) {
        const sess = dlSessions.get(sessionId);
        if (sess) sess.files.push(filename);
      }
      console.log(`[OK] (${i+1}/${songs.length}) ${s.artist} – ${s.title}`);
      send({ type: 'done', index: i, filename: filename || null });
    } catch (e) {
      console.log(`[FAIL] (${i+1}/${songs.length}) ${s.artist} – ${s.title}`);
      send({ type: 'error', index: i, error: e.message });
    }
  }

  clearInterval(keepalive);
  send({ type: 'complete', sessionId: sessionId || null });
  res.end();
});

// ─── Web: serve files & zip ────────────────────────────────────────────────────
app.get('/files/:sessionId/:filename', (req, res) => {
  const sess = dlSessions.get(req.params.sessionId);
  if (!sess) return res.status(404).send('Not found');
  const filename = path.basename(req.params.filename);
  const filePath = path.join(sess.outDir || sess.dir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath);
});

app.get('/zip/:sessionId', (req, res) => {
  const sess = dlSessions.get(req.params.sessionId);
  if (!sess) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="diskeria-musica.zip"');
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { try { res.destroy(err); } catch {} });
  archive.pipe(res);
  archive.directory(sess.outDir || sess.dir, false);
  archive.finalize();
});

// ─── Start ─────────────────────────────────────────────────────────────────────
function setup() {
  if (IS_WIN && APP_DIR) fs.mkdirSync(APP_DIR, { recursive: true });
}

setup();
app.listen(PORT, () => {
  console.log(`DiskerIA running on http://localhost:${PORT}`);
  openAppWindow(PORT);
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    openAppWindow(PORT);
    setTimeout(() => process.exit(0), 2000);
  }
});
