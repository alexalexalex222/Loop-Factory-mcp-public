import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extname, join, win32 } from 'node:path';

const COMMAND_SHIM_EXTENSIONS = new Set(['.cmd', '.bat']);
const CMD_META_PATTERN = /([()\][%!^"`<>&|;, *?])/g;
const PROCESS_TREE_RUNNER = fileURLToPath(new URL('./process-tree-runner.mjs', import.meta.url));
const TIMEOUT_TREE_KILLED = 'LOOP_FACTORY_TIMEOUT_TREE_KILLED';
const TIMEOUT_TREE_KILL_FAILED = 'LOOP_FACTORY_TIMEOUT_TREE_KILL_FAILED';
const OUTPUT_LIMIT_TREE_KILLED = 'LOOP_FACTORY_OUTPUT_LIMIT_TREE_KILLED';

function checkedToken(value, label) {
  const token = String(value);
  if (token.includes(String.fromCharCode(0)) || /[\r\n]/.test(token)) {
    throw new Error(`${label} contains command-line control characters`);
  }
  // cmd.exe expands %NAME% before caret escaping is applied. Refuse percent
  // tokens entirely so a route or path can never mutate after receipt capture.
  if (token.includes('%')) {
    throw new Error(`${label} contains unsupported Windows environment expansion syntax`);
  }
  return token;
}

function escapeCommand(value) {
  return checkedToken(value, 'command shim path').replace(CMD_META_PATTERN, '^$1');
}

function escapeArgument(value, index) {
  let token = checkedToken(value, `argument ${index}`);
  token = token.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  token = token.replace(/(?=(\\+?)?)\1$/, '$1$1');
  token = `"${token}"`;
  // A .cmd/.bat shim parses metacharacters once before forwarding %*, so fixed
  // controller-owned arguments need the second escape pass as well.
  return token.replace(CMD_META_PATTERN, '^$1').replace(CMD_META_PATTERN, '^$1');
}

function commandProcessor(env, platform) {
  const configured = String(env.ComSpec || env.COMSPEC || '').trim();
  if (configured) return configured;
  const inherited = platform === 'win32'
    ? String(process.env.ComSpec || process.env.COMSPEC || '').trim()
    : '';
  if (inherited) return inherited;
  const systemRoot = String(
    env.SystemRoot || env.SYSTEMROOT
      || (platform === 'win32' ? process.env.SystemRoot || process.env.SYSTEMROOT : '')
      || ''
  ).trim();
  return systemRoot ? join(systemRoot, 'System32', 'cmd.exe') : 'cmd.exe';
}

/**
 * Return the exact execFile target and argv for an already allowlisted binary.
 * The prompt is deliberately not accepted into the launch representation; callers
 * deliver it through stdin only.
 */
export function buildProcessLaunch({
  binPath,
  args = [],
  platform = process.platform,
  env = process.env,
  forceCommandShim = false
} = {}) {
  const file = String(binPath || '');
  if (!file) throw new Error('binPath is required');
  const extension = extname(file).toLowerCase();
  const isCommandShim = platform === 'win32' && COMMAND_SHIM_EXTENSIONS.has(extension);

  if (forceCommandShim && !isCommandShim) {
    throw new Error('Windows command-shim adapter accepts only .cmd or .bat files');
  }
  if (!isCommandShim) {
    return {
      file,
      args: args.map(String),
      shell: false,
      windowsVerbatimArguments: false,
      requiresTreeTermination: false,
      adapter: 'native-exec-file'
    };
  }

  const processor = commandProcessor(env, platform);
  if (win32.basename(processor).toLowerCase() !== 'cmd.exe') {
    throw new Error('ComSpec must resolve to cmd.exe');
  }
  const commandTokens = [
    escapeCommand(file),
    ...args.map((arg, index) => escapeArgument(arg, index))
  ].join(' ');
  // cmd /s /c removes one outer quote pair. The doubled leading/trailing quote
  // keeps the quoted shim path intact, including spaces and metacharacters.
  const command = `"${commandTokens}"`;
  return {
    file: processor,
    args: ['/d', '/s', '/v:off', '/c', command],
    shell: false,
    windowsVerbatimArguments: true,
    requiresTreeTermination: true,
    adapter: 'windows-command-shim'
  };
}

/**
 * Execute a launch plan synchronously. Windows command shims run inside a tiny
 * Node supervisor that owns the child PID and kills its complete process tree
 * before a timeout or output-limit failure is returned to Loop Factory.
 */
export function executeProcessSync(launch, {
  input = '',
  cwd,
  env = process.env,
  timeoutMs = 600000,
  maxBuffer = 64 * 1024 * 1024,
  encoding = 'utf8'
} = {}) {
  const common = {
    input,
    cwd: cwd || undefined,
    env,
    encoding,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  };
  if (!launch.requiresTreeTermination) {
    return execFileSync(launch.file, launch.args, {
      ...common,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer,
      windowsVerbatimArguments: launch.windowsVerbatimArguments
    });
  }

  const payload = Buffer.from(JSON.stringify({
    file: launch.file,
    args: launch.args,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    timeoutMs,
    maxBuffer
  })).toString('base64url');
  try {
    return execFileSync(process.execPath, [PROCESS_TREE_RUNNER, payload], {
      ...common,
      timeout: timeoutMs + 30_000,
      killSignal: 'SIGKILL',
      maxBuffer: maxBuffer + (1024 * 1024)
    });
  } catch (error) {
    const stderr = String(error?.stderr || '');
    error.loopFactoryTimeout = stderr.includes(TIMEOUT_TREE_KILLED);
    error.loopFactoryCleanupFailed = stderr.includes(TIMEOUT_TREE_KILL_FAILED);
    error.loopFactoryOutputLimit = stderr.includes(OUTPUT_LIMIT_TREE_KILLED);
    throw error;
  }
}
