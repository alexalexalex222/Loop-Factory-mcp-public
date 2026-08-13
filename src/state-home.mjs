import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function userStateHome(platform, env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Loop Factory');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Loop Factory');
  }
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'loop-factory');
}

/** Resolve state without creating, moving, or deleting anything. */
export function resolveStateHome(packageRoot, {
  home,
  env = process.env,
  platform = process.platform
} = {}) {
  if (home) return { homeDir: String(home), source: 'explicit' };
  if (env.SUPER_LOOP_HOME) return { homeDir: String(env.SUPER_LOOP_HOME), source: 'environment' };

  const legacy = join(packageRoot, '.super-loop');
  if (existsSync(legacy)) return { homeDir: legacy, source: 'legacy-package-state' };
  if (existsSync(join(packageRoot, '.git'))) return { homeDir: legacy, source: 'source-checkout' };
  return { homeDir: userStateHome(platform, env), source: 'user-state' };
}
