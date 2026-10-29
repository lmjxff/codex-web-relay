import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';

const exec = promisify(execFile);
type Status = 'ok' | 'warn' | 'error';
type Message = [string, string];
export interface Check { id: string; status: Status; message: Message }
interface Probes {
  command: (command: string, env: NodeJS.ProcessEnv) => boolean;
  git: (cwd: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
  pty: () => boolean;
  port: (port: number, host: string) => Promise<boolean>;
  tunnelBinary: () => boolean;
  certificate: () => boolean;
}

// Resolve executables without running CODEX_CMD, which can contain arbitrary shell code.
export function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const token = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s'";&|<>]+))(?=\s|$)/);
  const name = token?.[1] || token?.[2] || token?.[3];
  if (!name) return false;
  const windows = process.platform === 'win32';
  const envValue = (key: string) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] || '';
  const extensions = windows ? ['', ...(envValue('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  const directories = name.includes('/') || name.includes('\\') ? [''] : envValue('PATH').split(path.delimiter).filter(Boolean);
  return directories.some(directory => extensions.some(extension => {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), name + extension);
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch { return false; }
  }));
}

const probes: Probes = {
  command: commandExists,
  async git(cwd, env) {
    try {
      const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
        env, timeout: 3000, maxBuffer: 4096, windowsHide: true,
      });
      return stdout.trim() === 'true';
    } catch { return false; }
  },
  pty() { try { require('node-pty'); return true; } catch { return false; } },
  port(port, host) {
    return new Promise(resolve => {
      const socket = net.createServer();
      socket.once('error', () => resolve(false));
      socket.listen({ port, host, exclusive: true }, () => socket.close(() => resolve(true)));
    });
  },
  tunnelBinary() { try { return fs.existsSync(require('cloudflared').bin); } catch { return false; } },
  certificate() { return fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem')); },
};

export async function diagnose(options: {
  cwd?: string; env?: NodeJS.ProcessEnv; nodeVersion?: string; probes?: Partial<Probes>;
} = {}): Promise<Check[]> {
  const cwd = options.cwd || process.cwd();
  const checks: Check[] = [];
  const add = (id: string, status: Status, en: string, zh: string) => checks.push({ id, status, message: [en, zh] });
  const probe = { ...probes, ...options.probes };
  let fileEnv: NodeJS.ProcessEnv = {};
  try {
    const filename = path.join(cwd, '.env');
    if (fs.existsSync(filename)) fileEnv = dotenv.parse(fs.readFileSync(filename));
    add('config', 'ok', 'Local configuration read; values are hidden.', '本地配置已读取，配置值已隐藏。');
  } catch {
    add('config', 'error', 'Cannot read .env. Check file permissions.', '无法读取 .env，请检查文件权限。');
  }
  const env = { ...fileEnv, ...(options.env || process.env) };
  const version = options.nodeVersion || process.versions.node;
  add('node', Number(version.split('.')[0]) >= 22 ? 'ok' : 'error',
    'Node.js 22+ is required (22 and 24 are tested).', '需要 Node.js 22+（已验证 22 和 24）。');
  const hasGit = probe.command('git', env);
  add('git', hasGit ? 'ok' : 'error', hasGit ? 'Git executable found.' : 'Install Git and add it to PATH.',
    hasGit ? '已找到 Git。' : '请安装 Git 并加入 PATH。');
  const command = env.CODEX_CMD || 'codex';
  const hasCodex = probe.command(command, env);
  add('codex', hasCodex ? 'ok' : env.AUTO_START_CODEX === 'false' ? 'warn' : 'error',
    hasCodex ? 'CODEX_CMD executable found; authentication and execution were not tested.' : 'CODEX_CMD executable not found. Check PATH or CODEX_CMD.',
    hasCodex ? '已找到 CODEX_CMD 程序；未验证登录或执行。' : '未找到 CODEX_CMD 程序，请检查 PATH 或 CODEX_CMD。');
  const workspace = path.resolve(cwd, env.CODEX_CWD || '.');
  let validWorkspace = false;
  try { fs.accessSync(workspace, fs.constants.R_OK); validWorkspace = fs.statSync(workspace).isDirectory(); } catch {}
  add('workspace', validWorkspace ? 'ok' : 'error',
    validWorkspace ? 'Workspace is a readable directory.' : 'CODEX_CWD must point to a readable directory.',
    validWorkspace ? '工作目录存在且可读取。' : 'CODEX_CWD 必须指向可读取的目录。');
  if (validWorkspace && hasGit) {
    const gitWorkspace = await probe.git(workspace, env);
    add('git-workspace', gitWorkspace ? 'ok' : 'warn',
      gitWorkspace ? 'Git workspace detected.' : 'Git cannot read this worktree. Check the repository and Git ownership; terminal use can still work.',
      gitWorkspace ? '已识别 Git 工作区。' : 'Git 无法读取此工作区，请检查仓库和所有权；终端仍可使用。');
  }
  const pty = probe.pty();
  add('pty', pty ? 'ok' : 'error',
    pty ? 'Native node-pty module loads; spawning a terminal was not tested.' : 'Native node-pty cannot load. Run npm rebuild node-pty; check native build tools if it fails.',
    pty ? '原生 node-pty 模块可加载；未测试创建终端。' : '原生 node-pty 无法加载，请运行 npm rebuild node-pty；失败时检查原生编译工具。');
  const port = Number(env.PORT || 3210);
  const host = env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    add('port', 'error', 'PORT must be an integer from 1 to 65535.', 'PORT 必须是 1 到 65535 的整数。');
  } else if (!net.isIP(host) && host !== 'localhost') {
    add('port', 'warn', 'HOST is a name; bind check skipped to avoid DNS requests. Prefer a local IP address.', 'HOST 为主机名，为避免 DNS 请求已跳过绑定检查；建议使用本机 IP。');
  } else {
    const available = await probe.port(port, host);
    add('port', available ? 'ok' : 'error',
      available ? 'Configured address and port can be bound (temporary probe closed).' : 'Cannot bind HOST/PORT. Relay may already be running; check the address or choose a free port.',
      available ? '配置的地址和端口可绑定（临时探测已关闭）。' : '无法绑定 HOST/PORT，Relay 可能已在运行；请检查地址或选择空闲端口。');
  }
  const tunnel = env.ENABLE_TUNNEL === 'true';
  const token = (env.RELAY_AUTH_TOKEN || env.RELAY_PIN || '').trim();
  const invalidToken = /[\r\n]/.test(token) || token.length > 256 || (tunnel && !!token && token.length < 24);
  add('credential', invalidToken ? 'error' : token ? 'ok' : 'warn',
    invalidToken ? 'Access credential must be a single line, at most 256 characters and at least 24 for public tunnels.' : token ? 'Access credential has a valid shape; value hidden.' : 'No access credential configured. Normal startup will generate and save one; doctor does not.',
    invalidToken ? '访问凭据必须为单行、最多 256 字符；公网隧道至少需要 24 字符。' : token ? '访问凭据格式有效，值已隐藏。' : '未配置访问凭据，正常启动时会生成并保存；诊断不会生成。');
  if (!tunnel) {
    add('tunnel', 'ok', 'Tunnel disabled; Cloudflare is optional.', '隧道未启用，无需 Cloudflare。');
  } else {
    const hostname = (env.CF_HOSTNAME || '').trim();
    const tunnelToken = (env.CF_TUNNEL_TOKEN || '').trim();
    const validHostname = !hostname || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname);
    const credentials = !hostname || !!tunnelToken || probe.certificate();
    const configured = validHostname && (!tunnelToken || !!hostname) && credentials;
    add('tunnel', configured ? 'ok' : 'error',
      configured ? 'Tunnel configuration shape is valid; account, DNS and connectivity were not checked.' : 'Check CF_HOSTNAME (hostname only). Token mode needs a hostname; custom-domain certificate mode needs local Cloudflare login.',
      configured ? '隧道配置格式有效；未验证账号、DNS 或连通性。' : '请检查 CF_HOSTNAME（仅主机名）；Token 模式需要主机名，自定义域名证书模式需要本地 Cloudflare 登录。');
    const binary = probe.tunnelBinary();
    add('cloudflared', binary ? 'ok' : 'warn',
      binary ? 'Bundled cloudflared binary exists; not executed.' : 'Bundled cloudflared is absent. Normal tunnel startup downloads it; doctor does not.',
      binary ? '配套 cloudflared 程序存在，未执行。' : '尚无配套 cloudflared，正常启用隧道时会下载；诊断不会下载。');
  }
  return checks;
}

export async function runDoctor(args = process.argv.slice(2)): Promise<void> {
  const zh = args.includes('--lang=zh-CN');
  const checks = await diagnose();
  const errors = checks.filter(check => check.status === 'error').length;
  const warnings = checks.filter(check => check.status === 'warn').length;
  const runtime = { node: process.versions.node, platform: process.platform, arch: process.arch };
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok: errors === 0, errors, warnings, runtime,
      checks: checks.map(({ id, status, message }) => ({ id, status, message: message[zh ? 1 : 0] })) }, null, 2));
  } else {
    console.log('Codex Web Relay — Doctor');
    console.log(`Node ${runtime.node} / ${runtime.platform} ${runtime.arch}`);
    for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.id}: ${check.message[zh ? 1 : 0]}`);
    console.log(zh ? `完成：${errors} 个错误，${warnings} 个提示。` : `Done: ${errors} error(s), ${warnings} warning(s).`);
  }
  process.exitCode = errors ? 1 : 0;
}
