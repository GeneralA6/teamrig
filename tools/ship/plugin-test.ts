import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A plugin's own tests (`claude plugin test <plugin dir>`) run as the repo's CI runs them: with an empty
 * home and config folder, so no account, settings or other plugins reach them. A local check in repos.json.
 * Usage: node plugin-test.ts <plugin dir>
 */

export interface PluginTestDeps {
  /** Makes a new empty folder and returns its path. */
  makeHome: () => string;
  makeDir: (path: string) => void;
  removeHome: (path: string) => void;
  /** Runs a command with its output shown and returns its exit code, null when it could not start. */
  spawn: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => number | null;
  env: NodeJS.ProcessEnv;
  err: (line: string) => void;
}

/** The environment with its home and Claude config folder moved to an empty `home`. */
export function isolatedEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return { ...base, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') };
}

export function runPluginTests(argv: readonly string[], deps: PluginTestDeps): number {
  const [pluginDir, ...rest] = argv;
  if (pluginDir === undefined || pluginDir.startsWith('--') || rest.length > 0) {
    deps.err('usage: plugin-test.ts <plugin dir>');
    return 1;
  }
  const home = deps.makeHome();
  try {
    const env = isolatedEnv(deps.env, home);
    deps.makeDir(env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude'));
    const status = deps.spawn('claude', ['plugin', 'test', pluginDir], env);
    if (status === null) deps.err('plugin-test: claude did not start: is Claude Code installed and on PATH?');
    return status ?? 1;
  } finally {
    deps.removeHome(home);
  }
}

export const realPluginTestDeps: PluginTestDeps = {
  makeHome: () => mkdtempSync(join(tmpdir(), 'plugin-test-home-')),
  makeDir: path => mkdirSync(path, { recursive: true }),
  removeHome: path => rmSync(path, { recursive: true, force: true }),
  spawn: (file, args, env) => spawnSync(file, args, { stdio: 'inherit', env, windowsHide: true }).status,
  env: process.env,
  err: line => console.error(line),
};

if (import.meta.main) process.exitCode = runPluginTests(process.argv.slice(2), realPluginTestDeps);
