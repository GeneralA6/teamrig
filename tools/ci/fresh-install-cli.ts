import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { runMain } from '../lib/run-main.ts';
import { freshInstall, installEnv, type InstallInput, type InstallRunner } from './fresh-install.ts';

/** The PATH, under whichever case this OS spells its name (Windows hands Node `Path`). */
function inheritedPath(): string {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? '' : (process.env[key] ?? '');
}

/**
 * A new developer's first run of the committed tree in this checkout, cloned over `file://` into an empty home
 * (fresh-install.ts). Prints each step's exit, then what failed.
 */
async function main(): Promise<number> {
  // The native realpath spells out Windows' short 8.3 names, which cmd.exe would otherwise have to take as written.
  const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'teamrig-install-'));
  try {
    const input: InstallInput = {
      platform: process.platform,
      source: pathToFileURL(resolve('.')).href,
      home,
      path: inheritedPath(),
      nodePath: process.execPath,
      comspec: process.env['ComSpec'] ?? 'cmd.exe',
    };
    const env = installEnv(input, process.env);
    const run: InstallRunner = (request, cwd) => {
      const result = spawnSync(request.file, request.args, {
        input: request.input,
        encoding: 'utf8',
        env,
        cwd,
        timeout: 120_000,
        windowsVerbatimArguments: request.verbatim ?? false,
      });
      // A file that cannot start (missing, or not executable) has no output, only an error.
      return { status: result.status, stdout: result.stdout, stderr: result.error === undefined ? result.stderr : result.error.message };
    };
    const report = freshInstall(input, run, (plugin) => JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')));
    report.log.forEach((line) => console.log(`  ${line}`));
    if (report.findings.length === 0) {
      console.log(`fresh-install: a new team runs from a fresh clone on ${process.platform}`);
      return EXIT_CLEAN;
    }
    console.log(`fresh-install: ${report.findings.length} problem(s) on ${process.platform}:`);
    report.findings.forEach((finding) => console.log(`  ${finding}`));
    return EXIT_FINDINGS;
  } finally {
    // A hook's child may still hold a file for a moment on Windows.
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
}

process.exitCode = await runMain('fresh-install', main, (line) => console.error(line));
