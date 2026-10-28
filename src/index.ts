#!/usr/bin/env node
import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import http, { IncomingMessage } from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync, spawn } from 'child_process';
import { Duplex } from 'stream';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import * as Diff2Html from 'diff2html';
import QRCode from 'qrcode';
import { AuthRateLimiter, createAuthToken, escapeHtml, getClientIp as resolveClientIp, isLocalhostRequest, verifyToken } from './security';
import { readGitDiff, readGitStatus } from './git';
import { attachPtyLifecycle, terminalSize, sharedTerminalSize, ptyExitMessage, PtyExit } from './terminal-lifecycle';
import { preparePtyRuntime } from './pty-setup';
import { TerminalScreen } from './terminal-screen';
import {
  startCloudflareTunnel,
  stopActiveTunnel,
  runCloudflaredLogin,
  ActiveTunnel,
} from './tunnel';

// Switch Windows console to UTF-8 so Chinese & symbols render cleanly
if (os.platform() === 'win32') {
  try {
    execFileSync('chcp', ['65001'], { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const TARGET_CWD = path.resolve(process.env.CODEX_CWD || process.cwd());
const CODEX_CMD = process.env.CODEX_CMD || 'codex';
const AUTO_START_CODEX = process.env.AUTO_START_CODEX !== 'false';
const ENABLE_TUNNEL = process.env.ENABLE_TUNNEL === 'true';
const AUTO_OPEN_QR = process.env.AUTO_OPEN_QR !== 'false';
const CF_HOSTNAME = (process.env.CF_HOSTNAME || '').trim();
const CF_TUNNEL_NAME = process.env.CF_TUNNEL_NAME || 'codex-relay';
const CF_TUNNEL_TOKEN = process.env.CF_TUNNEL_TOKEN || '';
const CF_OVERWRITE_DNS = process.env.CF_OVERWRITE_DNS === 'true';
const CF_MANAGE_DNS = process.env.CF_MANAGE_DNS !== 'false';

let AUTH_TOKEN = (process.env.RELAY_AUTH_TOKEN || process.env.RELAY_PIN || '').trim();
let activeTunnel: ActiveTunnel | null = null;

const authLimiter = new AuthRateLimiter();

function getClientIp(req: IncomingMessage | Request): string {
  return resolveClientIp(req, ENABLE_TUNNEL);
}

function isIpBlocked(ip: string): boolean {
  return authLimiter.isBlocked(ip);
}

function recordAuthFailure(ip: string): void {
  authLimiter.fail(ip);
}

function clearAuthFailures(ip: string): void {
  authLimiter.clear(ip);
}

function verifyAuthToken(candidate: unknown): boolean {
  return verifyToken(AUTH_TOKEN, candidate);
}

function extractTokenFromRequest(req: IncomingMessage | Request): string {
  const headerToken = req.headers['x-relay-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  try {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const queryToken = parsedUrl.searchParams.get('token');
    if (queryToken) return queryToken.trim();
  } catch {
    // ignore URL parse error
  }
  return '';
}

async function ensureAuthTokenConfigured(): Promise<string> {
  if (AUTH_TOKEN) return AUTH_TOKEN;
  const pinIndex = process.argv.indexOf('--pin');
  if (pinIndex !== -1 && process.argv[pinIndex + 1]) {
    AUTH_TOKEN = process.argv[pinIndex + 1].trim();
  }
  if (!AUTH_TOKEN) AUTH_TOKEN = createAuthToken();
  if (/[\r\n]/.test(AUTH_TOKEN) || AUTH_TOKEN.length > 256) {
    throw new Error('Access token must be a single line of at most 256 characters.');
  }
  const envPath = path.join(process.cwd(), '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const tokenLine = /^\s*(?:export\s+)?RELAY_AUTH_TOKEN\s*=.*$/gm;
  const setting = `RELAY_AUTH_TOKEN=${JSON.stringify(AUTH_TOKEN)}`;
  if (tokenLine.test(content)) {
    content = content.replace(tokenLine, () => setting);
  } else {
    content += `${content && !content.endsWith('\n') ? '\n' : ''}${setting}\n`;
  }
  fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 });
  console.log('[Security] Access credential saved to local .env; open the local /qr page to pair a trusted device.');
  return AUTH_TOKEN;
}

const app = express();
app.use((_req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  next();
});
app.use(express.json());
app.use(['/api', '/qr'], (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/vendor/xterm.js', (_req, res) => res.sendFile(require.resolve('@xterm/xterm')));
app.get('/vendor/addon-fit.js', (_req, res) => res.sendFile(require.resolve('@xterm/addon-fit')));
app.get('/vendor/xterm.css', (_req, res) => res.sendFile(path.resolve(path.dirname(require.resolve('@xterm/xterm')), '../css/xterm.css')));
app.get('/vendor/diff2html.css', (_req, res) => res.sendFile(require.resolve('diff2html/bundles/css/diff2html.min.css')));
app.use(express.static(path.join(__dirname, '..', 'public')));

interface WsClientMessage {
  type: 'input' | 'resize' | 'action' | 'restart' | 'ping' | 'sync';
  data?: string;
  cols?: number;
  rows?: number;
  action?: 'approve' | 'reject' | 'enter' | 'esc' | 'ctrl_c' | 'start_codex' | 'up' | 'down' | 'tab';
  id?: string;
}

let ptyProcess: pty.IPty | null = null;
let terminalStarted = false;
let lastTerminalExit: PtyExit | null = null;
let terminalDimensions = terminalSize();
let terminalScreen = new TerminalScreen(terminalDimensions.cols, terminalDimensions.rows);
const clients = new Set<WebSocket>();
const clientSizes = new Map<WebSocket, { cols: number; rows: number }>();
const acceptedInputs = new Map<string, number>();
const acceptedActions = new Map<string, { action: WsClientMessage['action']; at: number }>();

function screenError(): void {
  console.error('[Terminal] Unable to update the shared screen. Check the host and restart the session.');
}

function appendOutput(screen: TerminalScreen, data: string): void {
  void screen.write(data, () => {
    if (screen === terminalScreen) broadcast({ type: 'output', data });
  }).catch(screenError);
}

function updateSharedSize(): void {
  const size = sharedTerminalSize(clientSizes.values(), terminalDimensions);
  if (size.cols === terminalDimensions.cols && size.rows === terminalDimensions.rows) return;
  terminalDimensions = size;
  const screen = terminalScreen;
  const proc = ptyProcess;
  void screen.resize(size.cols, size.rows, snapshot => {
    if (screen !== terminalScreen) return;
    // Send the same parsed screen/geometry before requesting the application's
    // repaint. A phone and desktop must interpret cursor movement on one grid.
    broadcast({ type: 'history', ...snapshot });
    if (proc && ptyProcess === proc) {
      try { proc.resize(size.cols, size.rows); }
      catch { console.warn('[Terminal] Resize was not accepted. Check whether the session has ended.'); }
    }
  }).catch(screenError);
}

function broadcast(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function resolveDefaultShell(): { shell: string; args: string[] } {
  if (os.platform() === 'win32') {
    return {
      shell: 'powershell.exe',
      args: ['-NoLogo'],
    };
  }
  return {
    shell: process.env.SHELL || '/bin/bash',
    args: ['-l'],
  };
}

function spawnCodexPty(cols = 80, rows = 24): pty.IPty {
  if (ptyProcess) {
    const previous = ptyProcess;
    // Retire BEFORE kill: Windows can report an exit synchronously while its
    // pipes are closing, before a replacement has been assigned.
    ptyProcess = null;
    try {
      previous.kill();
    } catch {
      // ignore cleanup error
    }
  }

  const { shell, args } = resolveDefaultShell();
  preparePtyRuntime();
  const terminalEnv: Record<string, string> = { ...(process.env as Record<string, string>), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete terminalEnv.RELAY_AUTH_TOKEN;
  delete terminalEnv.RELAY_PIN;
  delete terminalEnv.CF_TUNNEL_TOKEN;
  terminalDimensions = sharedTerminalSize(clientSizes.values(), terminalSize(cols, rows));
  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    ...terminalDimensions,
    cwd: TARGET_CWD,
    env: terminalEnv,
  });

  ptyProcess = proc;
  terminalStarted = true;
  lastTerminalExit = null;
  acceptedInputs.clear();
  acceptedActions.clear();
  const previousScreen = terminalScreen;
  const screen = new TerminalScreen(terminalDimensions.cols, terminalDimensions.rows);
  terminalScreen = screen;
  void previousScreen.dispose().catch(screenError);
  broadcast({ type: 'session-reset', ...terminalDimensions });

  const banner = `\r\n\x1b[1;36m[codex-relay]\x1b[0m Attached to workspace: \x1b[33m${TARGET_CWD}\x1b[0m\r\n`;
  appendOutput(screen, banner);

  attachPtyLifecycle(proc, () => ptyProcess, (data: string) => {
    appendOutput(screen, data);
  }, event => {
    ptyProcess = null;
    lastTerminalExit = event;
    const color = event.kind === 'error' ? '31' : event.kind === 'unknown' ? '33' : '90';
    const msg = `\r\n\x1b[${color}m[codex-relay] ${ptyExitMessage(event)}\x1b[0m\r\n`;
    appendOutput(screen, msg);
    broadcast({ type: 'status', running: false, ...event });
  });

  if (AUTO_START_CODEX) {
    setTimeout(() => {
      if (ptyProcess === proc) {
        const lineEnding = os.platform() === 'win32' ? '\r\n' : '\n';
        try { proc.write(`${CODEX_CMD}${lineEnding}`); }
        catch { console.error('[Terminal] Unable to write the startup command. Check the terminal and restart the session.'); }
      }
    }, 350);
  }

  broadcast({
    type: 'status',
    running: true,
    pid: proc.pid,
    cwd: TARGET_CWD,
    cmd: CODEX_CMD,
  });

  return proc;
}

function sendTerminalAction(action: WsClientMessage['action']): void {
  if (!action || !['approve', 'reject', 'enter', 'esc', 'ctrl_c', 'start_codex', 'up', 'down', 'tab'].includes(action)) {
    throw new Error('Unknown action');
  }
  if (!ptyProcess && action === 'start_codex') {
    spawnCodexPty();
    // A new shell already schedules CODEX_CMD when automatic startup is enabled.
    if (AUTO_START_CODEX) return;
  }
  if (!ptyProcess) throw new Error('Terminal stopped. Restart the session first.');

  const eol = os.platform() === 'win32' ? '\r' : '\n';
  switch (action) {
    case 'up':
      ptyProcess.write('\x1b[A');
      break;
    case 'down':
      ptyProcess.write('\x1b[B');
      break;
    case 'tab':
      ptyProcess.write('\t');
      break;
    case 'approve':
      ptyProcess.write(`y${eol}`);
      break;
    case 'reject':
      ptyProcess.write(`n${eol}`);
      break;
    case 'enter':
      ptyProcess.write('\r');
      break;
    case 'esc':
      ptyProcess.write('\x1b');
      break;
    case 'ctrl_c':
      ptyProcess.write('\x03');
      break;
    case 'start_codex':
      ptyProcess.write(`${CODEX_CMD}${eol}`);
      break;
  }
}

async function buildQrPayload() {
  const lanIp = getLocalLanIp();
  const publicBaseUrl = activeTunnel?.isReady() ? activeTunnel.url : null;
  const publicMagicUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/?token=${encodeURIComponent(AUTH_TOKEN)}` : null;
  const lanEnabled = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
  const lanBaseUrl = lanEnabled ? `http://${lanIp}:${PORT}` : null;
  const lanMagicUrl = lanBaseUrl ? `${lanBaseUrl}/?token=${encodeURIComponent(AUTH_TOKEN)}` : null;

  const [publicQrSvg, lanQrSvg] = await Promise.all([
    publicMagicUrl ? QRCode.toString(publicMagicUrl, {
      type: 'svg',
      margin: 2,
      width: 260,
      color: { dark: '#0d1117', light: '#ffffff' },
    }) : '',
    lanMagicUrl ? QRCode.toString(lanMagicUrl, {
      type: 'svg',
      margin: 2,
      width: 260,
      color: { dark: '#0d1117', light: '#ffffff' },
    }) : '',
  ]);

  return {
    pin: AUTH_TOKEN,
    publicBaseUrl,
    publicMagicUrl,
    publicQrSvg,
    lanBaseUrl,
    lanMagicUrl,
    lanQrSvg,
  };
}

// Localhost-only or authenticated standalone HD QR Code page
app.get('/qr', async (req: Request, res: Response, next: NextFunction) => {
  try {
  const token = extractTokenFromRequest(req);
  if (!isLocalhostRequest(req) && !verifyAuthToken(token)) {
    res.redirect('/');
    return;
  }
  const qr = await buildQrPayload();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Codex Relay — 手机扫码连接</title>
  <style>
    body { margin:0; background:#0d1117; color:#f0f6fc; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; box-sizing:border-box; }
    .container { max-width:760px; width:100%; background:#161b22; border:1px solid #30363d; border-radius:18px; padding:28px; box-shadow:0 20px 50px rgba(0,0,0,0.6); }
    h1 { margin:0 0 8px; font-size:1.4rem; text-align:center; }
    .sub { color:#8b949e; font-size:0.9rem; text-align:center; margin-bottom:22px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:20px; }
    .card { background:#0d1117; border:1px solid #30363d; border-radius:14px; padding:20px; text-align:center; }
    .badge { display:inline-block; padding:4px 12px; border-radius:999px; font-size:0.78rem; font-weight:700; margin-bottom:12px; }
    .badge.pub { background:rgba(63,185,80,0.18); color:#3fb950; border:1px solid rgba(63,185,80,0.4); }
    .badge.lan { background:rgba(88,166,255,0.18); color:#58a6ff; border:1px solid rgba(88,166,255,0.4); }
    .qr-box { background:#fff; padding:12px; border-radius:12px; display:inline-block; margin-bottom:12px; }
    .qr-box svg { display:block; width:220px; height:220px; }
    .url { font-family:monospace; font-size:0.78rem; color:#58a6ff; word-break:break-all; margin:8px 0; }
    .tip { font-size:0.76rem; color:#8b949e; line-height:1.45; }
    .footer { margin-top:22px; text-align:center; display:flex; flex-direction:column; gap:10px; align-items:center; }
    .pin-box { background:#21262d; border:1px solid #30363d; padding:8px 18px; border-radius:10px; font-size:0.95rem; }
    .pin-box strong { color:#3fb950; font-family:monospace; font-size:0.9rem; overflow-wrap:anywhere; }
    .btn { display:inline-block; background:#58a6ff; color:#090d12; font-weight:700; text-decoration:none; padding:10px 22px; border-radius:10px; font-size:0.92rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📱 手机扫码远程控制 Codex CLI</h1>
    <p class="sub">直接用手机相机、浏览器或微信扫一扫下方高清二维码，免输密码一键登录</p>
    <div class="grid">
      ${qr.publicMagicUrl ? `<div class="card">
        <span class="badge pub">🌍 外网 4G/5G 远程连接 (Cloudflare)</span>
        <div class="qr-box">${qr.publicQrSvg}</div>
        <div class="url">${escapeHtml(qr.publicMagicUrl)}</div>
        <div class="tip">仅向可信设备展示；二维码包含访问凭据。</div>
      </div>` : `<div class="card"><h2>公网入口不可用</h2><p class="tip">未启用隧道、隧道尚未就绪或已经退出。不会生成公网访问码。</p></div>`}
      ${qr.lanMagicUrl ? `<div class="card">
        <span class="badge lan">📶 同一 Wi-Fi 局域网连接</span>
        <div class="qr-box">${qr.lanQrSvg}</div>
        <div class="url">${escapeHtml(qr.lanMagicUrl)}</div>
        <div class="tip">仅在可信的同一 Wi-Fi 下使用。HTTP 不提供传输加密。</div>
      </div>` : `<div class="card"><h2>当前仅允许本机访问</h2><p class="tip">需要手机局域网访问时，在本地 .env 设置 HOST=0.0.0.0 并重启。</p></div>`}
    </div>
    <div class="footer">
      <div class="pin-box">当前访问凭据（请勿公开）: <strong>${escapeHtml(qr.pin)}</strong></div>
      <a class="btn" href="/?token=${encodeURIComponent(qr.pin)}">进入电脑端 Web 控制台 →</a>
    </div>
  </div>
</body>
</html>`);
  } catch (error) { next(error); }
});

// Public Auth Verification Endpoint (Protected by Brute-Force Limiter)
app.post('/api/auth/verify', (req: Request, res: Response) => {
  const clientIp = getClientIp(req);
  if (isIpBlocked(clientIp)) {
    res.status(429).json({
      ok: false,
      error: 'Too many failed attempts. Please try again in 5 minutes.',
    });
    return;
  }

  const candidate = req.body?.token || extractTokenFromRequest(req);
  if (!verifyAuthToken(candidate)) {
    recordAuthFailure(clientIp);
    console.warn(`[Security] Rejected invalid login attempt from IP: ${clientIp}`);
    res.status(401).json({
      ok: false,
      error: '访问密码 / Token 错误，请重新输入',
    });
    return;
  }

  clearAuthFailures(clientIp);
  res.json({
    ok: true,
    cwd: TARGET_CWD,
    tunnelUrl: activeTunnel?.isReady() ? activeTunnel.url : null,
    hostname: CF_HOSTNAME,
  });
});

// Express Middleware: Protect all /api/* routes below
function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  const clientIp = getClientIp(req);
  if (isIpBlocked(clientIp)) {
    res.status(429).json({ ok: false, error: 'IP temporarily blocked due to failed auth attempts' });
    return;
  }

  const token = extractTokenFromRequest(req);
  if (!verifyAuthToken(token)) {
    recordAuthFailure(clientIp);
    res.status(401).json({ ok: false, error: 'Unauthorized: Valid PIN/Token required' });
    return;
  }

  clearAuthFailures(clientIp);
  next();
}

app.use('/api', requireApiAuth);

app.get('/api/qr', async (_req: Request, res: Response) => {
  try {
    const payload = await buildQrPayload();
    res.json({ ok: true, ...payload });
  } catch {
    res.status(500).json({ ok: false, error: 'Failed to generate QR code' });
  }
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    running: Boolean(ptyProcess),
    pid: ptyProcess?.pid ?? null,
    cwd: TARGET_CWD,
    codexCmd: CODEX_CMD,
    clients: clients.size,
    tunnelUrl: activeTunnel?.isReady() ? activeTunnel.url : null,
    tunnelMode: activeTunnel?.isReady() ? activeTunnel.mode : null,
  });
});

app.post('/api/action', (req: Request, res: Response) => {
  const action = req.body?.action as WsClientMessage['action'];
  if (!action || !['approve', 'reject', 'enter', 'esc', 'ctrl_c', 'start_codex', 'up', 'down', 'tab'].includes(action)) {
    res.status(400).json({ ok: false, error: 'Unknown action' });
    return;
  }
  try {
    sendTerminalAction(action);
    res.json({ ok: true, action });
  } catch {
    res.status(409).json({ ok: false, error: 'Terminal unavailable. Restart the session first.' });
  }
});

app.get('/api/git/status', async (_req: Request, res: Response) => {
  try {
    const status = await readGitStatus(TARGET_CWD);
    res.json({ ok: true, cwd: TARGET_CWD, repoRoot: status.root,
      branch: status.branch, files: status.files, timestamp: new Date().toISOString() });
  } catch {
    res.status(500).json({ ok: false, error: 'Unable to read Git status. Check the workspace and Git installation.' });
  }
});

app.get('/api/git/diff', async (req: Request, res: Response) => {
  try {
    const targetFile = typeof req.query.file === 'string' ? req.query.file : '';
    const diff = await readGitDiff(TARGET_CWD, targetFile);
    const html = diff.rawDiff.trim() ? Diff2Html.html(diff.rawDiff, {
      drawFileList: true, matching: 'lines', outputFormat: 'line-by-line',
    }) : '';
    res.json({ ok: true, cwd: TARGET_CWD, file: targetFile || null,
      ...diff, html, timestamp: new Date().toISOString() });
  } catch {
    res.status(500).json({ ok: false, error: 'Unable to generate the Git preview. Check the workspace and selected path.' });
  }
});

export const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
const liveClients = new WeakSet<WebSocket>();
function checkClientLiveness(): void {
  for (const client of wss.clients) {
    if (!liveClients.has(client)) { client.terminate(); continue; }
    liveClients.delete(client);
    if (client.readyState === WebSocket.OPEN) client.ping();
  }
}
const clientHeartbeat = setInterval(checkClientLiveness, 30000);
clientHeartbeat.unref();
wss.on('close', () => clearInterval(clientHeartbeat));

// Connection Isolation: Strictly authenticate every WebSocket upgrade request
server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
  const clientIp = getClientIp(request);

  try {
    const parsedUrl = new URL(request.url || '/', 'http://localhost');
    if (parsedUrl.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (isIpBlocked(clientIp)) {
      console.warn(`[Security] Blocked WebSocket upgrade from rate-limited IP: ${clientIp}`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = extractTokenFromRequest(request);
    if (!verifyAuthToken(token)) {
      recordAuthFailure(clientIp);
      console.warn(`[Security] Rejected unauthorized WebSocket connection from IP: ${clientIp}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    clearAuthFailures(clientIp);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch {
    socket.destroy();
  }
});

function sendSessionState(ws: WebSocket): void {
  ws.send(JSON.stringify({
    type: 'status', running: Boolean(ptyProcess), ...(lastTerminalExit || {}),
    pid: ptyProcess?.pid ?? null, cwd: TARGET_CWD, cmd: CODEX_CMD,
    tunnelUrl: activeTunnel?.isReady() ? activeTunnel.url : null,
  }));
  const screen = terminalScreen;
  void screen.snapshot(snapshot => {
    if (screen === terminalScreen && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'history', ...snapshot }));
  }).catch(screenError);
}

wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
  const clientIp = getClientIp(request);
  clients.add(ws);
  liveClients.add(ws);
  ws.on('pong', () => liveClients.add(ws));
  console.log(`[WebSocket] Authenticated client connected (${clientIp}), active=${clients.size}`);

  if (!ptyProcess && !terminalStarted) {
    try { spawnCodexPty(); }
    catch {
      clients.delete(ws);
      ws.close(1011, 'Terminal unavailable. Check the host.');
      return;
    }
  }

  sendSessionState(ws);

  ws.on('message', (raw: Buffer | string) => {
    let messageId: string | undefined;
    let messageType: WsClientMessage['type'] | undefined;
    try {
      const msg = JSON.parse(raw.toString()) as WsClientMessage;
      messageType = msg.type;
      messageId = typeof msg.id === 'string' && msg.id.length <= 128 ? msg.id : undefined;
      switch (msg.type) {
        case 'sync':
          sendSessionState(ws);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', id: messageId, ts: Date.now() }));
          break;
        case 'input':
          if (typeof msg.data === 'string' && msg.data.length <= 16 * 1024) {
            if (messageId) {
              const now = Date.now();
              for (const [id, acceptedAt] of acceptedInputs) if (acceptedAt < now - 5 * 60 * 1000) acceptedInputs.delete(id);
              if (acceptedInputs.has(messageId)) {
                ws.send(JSON.stringify({ type: 'input-ack', id: messageId }));
                break;
              }
            }
            if (!ptyProcess) throw new Error('Terminal unavailable');
            ptyProcess.write(msg.data);
            if (messageId) {
              acceptedInputs.set(messageId, Date.now());
              if (acceptedInputs.size > 1000) acceptedInputs.delete(acceptedInputs.keys().next().value!);
              ws.send(JSON.stringify({ type: 'input-ack', id: messageId }));
            }
          } else {
            throw new Error('Invalid terminal input');
          }
          break;
        case 'resize':
          if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
            clientSizes.set(ws, terminalSize(msg.cols, msg.rows));
            updateSharedSize();
          }
          break;
        case 'action':
          if (messageId) {
            const now = Date.now();
            for (const [id, record] of acceptedActions) if (record.at < now - 5 * 60 * 1000) acceptedActions.delete(id);
            const previous = acceptedActions.get(messageId);
            if (previous) {
              if (previous.action !== msg.action) throw new Error('Action ID reused for a different key');
              ws.send(JSON.stringify({ type: 'action-ack', id: messageId, action: msg.action }));
              break;
            }
          }
          sendTerminalAction(msg.action);
          if (messageId) {
            acceptedActions.set(messageId, { action: msg.action, at: Date.now() });
            if (acceptedActions.size > 1000) acceptedActions.delete(acceptedActions.keys().next().value!);
            ws.send(JSON.stringify({ type: 'action-ack', id: messageId, action: msg.action }));
          }
          break;
        case 'restart':
          spawnCodexPty(msg.cols || 80, msg.rows || 24);
          break;
      }
    } catch {
      if (messageId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: messageType === 'action' ? 'action-error' : 'input-error', id: messageId, error: 'Input was not accepted by the terminal.' }));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    clientSizes.delete(ws);
    updateSharedSize();
  });
  ws.on('error', () => {
    clients.delete(ws);
    clientSizes.delete(ws);
    updateSharedSize();
  });
});

app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ ok: false, error: 'Unable to process this request.' });
});

function getLocalLanIp(): string {
  const interfaces = os.networkInterfaces();
  const candidates: { name: string; address: string; score: number }[] = [];

  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    if (
      lowerName.includes('mihomo') ||
      lowerName.includes('clash') ||
      lowerName.includes('vethernet') ||
      lowerName.includes('wsl') ||
      lowerName.includes('docker') ||
      lowerName.includes('vmware') ||
      lowerName.includes('virtual') ||
      lowerName.includes('tun') ||
      lowerName.includes('tap')
    ) {
      continue;
    }

    for (const iface of interfaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.mac === '00:00:00:00:00:00') continue;
      if (iface.address.startsWith('198.18.') || iface.address.startsWith('169.254.')) continue;

      let score = 10;
      if (lowerName.includes('wlan') || lowerName.includes('wi-fi') || lowerName.includes('wifi')) {
        score += 50;
      }
      if (iface.address.startsWith('192.168.')) {
        score += 30;
      } else if (iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
        score += 10;
      }

      candidates.push({ name, address: iface.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || '127.0.0.1';
}

function openUrlInBrowser(url: string): void {
  try {
    if (os.platform() === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    } else if (os.platform() === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // ignore browser launch errors
  }
}

// Strict Lifecycle Binding: Destroy Cloudflare Tunnel & PTY immediately on exit
let isShuttingDown = false;
function gracefulShutdown(reason: string, exitCode = 0): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Lifecycle] 正在关闭 Codex Relay (${reason})，销毁公网隧道与终端进程...`);

  stopActiveTunnel();

  if (ptyProcess) {
    const previous = ptyProcess;
    ptyProcess = null;
    try {
      previous.kill();
    } catch {
      // ignore
    }
  }

  for (const ws of clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch {
      // ignore
    }
  }

  server.close(() => {
    process.exit(exitCode);
  });

  setTimeout(() => {
    process.exit(exitCode);
  }, 800).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
server.on('error', () => {
  console.error('[Startup] Listener failed. Check HOST, PORT and whether the port is already in use.');
  gracefulShutdown('listener error', 1);
});
process.on('exit', () => {
  stopActiveTunnel();
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
      // ignore
    }
  }
});

async function bootstrap(): Promise<void> {
  if (process.argv.includes('--cf-login')) {
    await runCloudflaredLogin();
    process.exit(0);
  }

  await ensureAuthTokenConfigured();
  if (/[\r\n]/.test(AUTH_TOKEN) || AUTH_TOKEN.length > 256) throw new Error('Invalid access credential configuration.');
  if (ENABLE_TUNNEL && AUTH_TOKEN.length < 24) {
    throw new Error('Public tunnels require an access credential of at least 24 characters. Remove the short RELAY_AUTH_TOKEN setting and restart to generate a random one.');
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be between 1 and 65535.');
  spawnCodexPty();

  server.listen(PORT, HOST, async () => {
    const localQrPageUrl = `http://localhost:${PORT}/qr`;

    console.log('====================================================');
    console.log('  Codex Relay — Mobile Codex CLI Bridge');
    console.log(`  Workspace   : ${TARGET_CWD}`);
    console.log(`  Command     : ${CODEX_CMD}`);
    console.log(`  Local URL   : http://localhost:${PORT}/`);
    console.log(`  Bind address: ${HOST} (public tunnel: ${ENABLE_TUNNEL ? 'enabled' : 'disabled'})`);
    console.log(`  高清扫码页面 : ${localQrPageUrl}`);
    console.log('====================================================');

    if (ENABLE_TUNNEL) {
      try {
        activeTunnel = await startCloudflareTunnel({
          port: PORT,
          hostname: CF_HOSTNAME,
          tunnelName: CF_TUNNEL_NAME,
          tunnelToken: CF_TUNNEL_TOKEN,
          overwriteDns: CF_OVERWRITE_DNS,
          manageDns: CF_MANAGE_DNS,
          localQrPageUrl,
        });
        const tunnel = activeTunnel;
        tunnel.process.once('exit', () => {
          if (activeTunnel === tunnel) {
            activeTunnel = null;
            broadcast({ type: 'status', tunnelUrl: null });
          }
        });
      } catch (err: any) {
        console.error(`[Cloudflare] Tunnel unavailable: ${err?.message || 'startup failed'}. Local access remains available.`);
      }
    }

    if (AUTO_OPEN_QR) {
      openUrlInBrowser(localQrPageUrl);
    }
  });
}

if (require.main === module) {
  bootstrap().catch(() => {
    console.error('[Startup] Unable to start Relay. Check the workspace, native PTY dependencies, PORT (1-65535) and access credential (24+ characters for public tunnels).');
    gracefulShutdown('startup failed', 1);
  });
}
