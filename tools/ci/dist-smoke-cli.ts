import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_USAGE } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { isRecord, stringField } from '../lib/guards.ts';
import { launcherModeFinding, smokeDist, type Runner } from './dist-smoke.ts';

const PLUGIN_ROOT = resolve('plugins', 'teamrig');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Runs the committed dist as an installed plugin, in team `smoke` with an empty kit home. */
async function main(): Promise<number> {
  const plugin = readJson(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  const version = isRecord(plugin) ? stringField(plugin, 'version') : undefined;
  if (version === undefined) {
    console.log('dist-smoke: plugin.json has no version');
    return EXIT_USAGE;
  }
  const home = mkdtempSync(join(tmpdir(), 'teamrig-smoke-'));
  try {
    const env = { ...process.env, TEAMRIG_HOME: home, TEAMRIG_TEAM: 'smoke' };
    const run: Runner = (request) => {
      const result = spawnSync(request.file, request.args, {
        input: request.input,
        encoding: 'utf8',
        env,
        cwd: home,
        timeout: 15_000,
        windowsVerbatimArguments: request.verbatim ?? false,
      });
      // A file that cannot start (missing, or not executable) has no output, only an error.
      return { status: result.status, stdout: result.stdout, stderr: result.error === undefined ? result.stderr : result.error.message };
    };
    const findings = smokeDist(
      {
        platform: process.platform,
        pluginRoot: PLUGIN_ROOT,
        manifest: readJson(join(PLUGIN_ROOT, 'hooks', 'hooks.json')),
        version,
        nodePath: process.execPath,
        comspec: process.env['ComSpec'] ?? 'cmd.exe',
      },
      run,
    );
    const mode = await launcherModeFinding(createGit(process.cwd()));
    if (mode !== undefined) {
      findings.push(mode);
    }
    if (findings.length === 0) {
      console.log(`dist-smoke: the launcher and every hook run from the dist on ${process.platform}`);
      return EXIT_CLEAN;
    }
    console.log(`dist-smoke: ${findings.length} problem(s) on ${process.platform}:`);
    findings.forEach((finding) => console.log(`  ${finding}`));
    return EXIT_FINDINGS;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`dist-smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_USAGE;
  },
);
