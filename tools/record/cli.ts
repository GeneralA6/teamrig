import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT_CLEAN } from '../lib/exit.ts';
import { readTextIfPresent } from '../lib/files.ts';
import { stringField, type JsonRecord } from '../lib/guards.ts';
import { runMain } from '../lib/run-main.ts';
import { eventsOf, recordedInputs, recorderPlugin } from './plugin.ts';
import { assemble } from './recording.ts';
import { projectSlug } from '../../src/testing/folder-names.ts';
import { Scrubber } from './scrub.ts';
import { SEALED_ENV, turnsOf } from './turns.ts';

/** The hooks manifest whose events the recording must cover. */
const HOOKS_MANIFEST = resolve('plugins', 'teamrig', 'hooks', 'hooks.json');
/** Where the recorded fixtures live, from the repository's root. */
const DEFAULT_OUT = join('src', 'testing', 'recorded', 'claude-code');
/** The cheapest model that follows the tools turn's steps. */
const DEFAULT_MODEL = 'haiku';
/** Milliseconds one turn may take before it is killed. */
const TURN_TIMEOUT_MS = 600_000;
/** The fixture folders a new recording replaces whole, so no file of an older one stays. */
const REPLACED = ['hooks', 'transcripts'];

interface Options {
  readonly out: string;
  readonly model: string;
  /** The program that runs Claude Code, and the arguments that go before each turn's own. */
  readonly claude: string;
  readonly claudeArgs: readonly string[];
  /** Leave the throwaway folder and the session's transcripts in place, to read what Claude Code really wrote. */
  readonly keep: boolean;
}

function options(): Options {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: DEFAULT_OUT },
      model: { type: 'string', default: DEFAULT_MODEL },
      claude: { type: 'string', default: 'claude' },
      'claude-arg': { type: 'string', multiple: true, default: [] },
      keep: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return { out: resolve(values.out), model: values.model, claude: values.claude, claudeArgs: values['claude-arg'], keep: values.keep };
}

/** Runs Claude Code with `args` in `cwd`, its stdin closed, and returns what it printed; a run that fails is an error. */
function claude(options: Options, name: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(options.claude, [...options.claudeArgs, ...args], {
    cwd,
    env: { ...process.env, ...SEALED_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: TURN_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    throw new Error(`${name}: ${options.claude} did not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${name}: ${options.claude} ended with exit ${result.status ?? 'none'}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** Each distinct value the inputs give under `key`, in order of first appearance. */
function pathsOf(inputs: readonly JsonRecord[], key: string): string[] {
  return [...new Set(inputs.flatMap((input) => stringField(input, key) ?? []))];
}

/**
 * Records one Claude Code session on this machine and writes its fixture: a throwaway plugin records every hook
 * input of three sealed turns in an empty folder, then the inputs and the transcripts they name are scrubbed and
 * written under `--out`.
 */
async function main(): Promise<number> {
  const opts = options();
  const events = eventsOf(JSON.parse(readFileSync(HOOKS_MANIFEST, 'utf8')));
  // The native realpath spells out Windows' short 8.3 names, as Claude Code does in the paths it sends.
  const temp = realpathSync.native(tmpdir());
  const base = mkdtempSync(join(temp, 'teamrig-record-'));
  const pluginDir = join(base, 'plugin');
  const cwd = join(base, 'cwd');
  const outFile = join(base, 'out.jsonl');
  mkdirSync(cwd);
  writeFiles(pluginDir, recorderPlugin(events, outFile));
  let transcripts: string[] = [];
  try {
    const version = claude(opts, 'version', ['--version'], cwd);
    for (const turn of turnsOf({ sessionId: randomUUID(), pluginDir, model: opts.model, platform: process.platform })) {
      claude(opts, `the ${turn.name} turn`, turn.args, cwd);
    }
    const inputs = recordedInputs(readFileSync(outFile, 'utf8'));
    transcripts = pathsOf(inputs, 'transcript_path');
    const [session] = transcripts;
    if (session === undefined || transcripts.length > 1) {
      throw new Error(`the hook inputs name ${transcripts.length} session transcripts, not one`);
    }
    const files = assemble(
      {
        version,
        platform: process.platform,
        model: opts.model,
        events,
        inputs,
        session: { path: session, text: readFileSync(session, 'utf8') },
        helpers: pathsOf(inputs, 'agent_transcript_path').map((path) => ({ path, text: readTextIfPresent(path) })),
      },
      new Scrubber({ cwd, temp, home: homedir(), user: userInfo().username, host: hostname() }),
    );
    for (const folder of REPLACED) {
      rmSync(join(opts.out, folder), { recursive: true, force: true });
    }
    writeFiles(opts.out, files);
    console.log(`record: ${inputs.length} hook input(s) of ${version.trim()} written to ${opts.out}`);
    return EXIT_CLEAN;
  } finally {
    if (opts.keep) {
      console.log(`record: kept ${base}`);
    } else {
      rmSync(base, { recursive: true, force: true });
      // Claude Code keeps a session's transcripts in a folder named after the session folder; nothing else is removed.
      for (const folder of new Set(transcripts.map((path) => dirname(path)))) {
        if (basename(folder) === projectSlug(cwd)) {
          rmSync(folder, { recursive: true, force: true });
        }
      }
    }
  }
}

process.exitCode = await runMain('record', main, (line) => console.error(line));
