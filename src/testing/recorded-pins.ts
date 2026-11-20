import { readdirSync, readFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptLineOf } from '../budget/line.ts';
import { isRecord } from '../core/guards.ts';
import { APP, CliHarness, KIT, TEAM, USER_HOME } from './cli-harness.ts';
import { FolderNames, withStrings } from './folder-names.ts';
import { MemoryTranscripts } from './memory-transcripts.ts';
import { hookMatches, pluginHooks } from './plugin-hooks.ts';
import { hookFile, loadRecording, type RecordedHost } from './recorded.ts';
import { shippedTranscripts } from './shipped-transcripts.ts';

/** The pinned file that holds what teamrig reads out of each recorded transcript. */
export const TRANSCRIPT_LINES_FILE = 'transcript-lines.json';

/** What one wired hook did with one recorded input. */
export interface PinnedRun {
  readonly event: string;
  /** The input's place among its event's inputs, from 0. */
  readonly index: number;
  /** The words teamrig's CLI was run with. */
  readonly hook: string;
  readonly code: number;
  /** Each printed line; one that is a JSON object or list is kept parsed. */
  readonly stdout: readonly unknown[];
  readonly stderr: readonly string[];
}

/** The folder that holds the committed pins of `host`'s recording. */
export function expectedFolder(host: RecordedHost): string {
  return fileURLToPath(new URL(`./recorded/${host}/expected/`, import.meta.url));
}

/** The text of every file under `folder`, by its `/`-separated path there: pins as they are on disk. */
export function pinsIn(folder: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  const read = (inside: string): void => {
    for (const entry of readdirSync(join(folder, inside), { withFileTypes: true })) {
      const path = inside === '' ? entry.name : `${inside}/${entry.name}`;
      if (entry.isDirectory()) {
        read(path);
      } else {
        files[path] = readFileSync(join(folder, path), 'utf8');
      }
    }
  };
  read('');
  return files;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** `line` parsed when it is a JSON object or list, which is how a hook answers its host; undefined for any other text. */
function structured(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) || Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What teamrig does today with the recorded session of `host`, as the pinned files by their path in the recording's
 * `expected/` folder: `hooks/<Event>.json` holds, for each of the event's inputs in firing order, what every hook the
 * plugin's hooks.json wires to it printed and exited with, and `transcript-lines.json` what the usage meter reads out
 * of each transcript line. Every step that moves host code behind a port must leave these files as they are.
 *
 * The session is replayed through one CLI harness, so a hook sees the state the hooks before it left, as in the
 * recorded session. The harness's folders stand in for the recording's, and every folder is named by its placeholder
 * again in what is pinned, so the files are the same on every machine.
 */
export async function recordedPins(host: RecordedHost): Promise<Readonly<Record<string, string>>> {
  const names = new FolderNames({ cwd: APP, temp: resolve('/', 'tmp'), home: USER_HOME }, { '{{kit}}': KIT });
  const named = (text: string): string => names.named(text);
  const recording = loadRecording(host, names);
  const hooks = pluginHooks();
  const kit = new CliHarness({ ...TEAM, tabStatus: { enabled: true } });
  const env = { CLAUDE_PROJECT_DIR: APP, TEAMRIG_SESSION: 'alpha' };
  // Whole from the first input on: the real ones grew during the session, and the recording keeps only their end
  // state. A hook that builds a transcript's path itself spells it the platform's way, so each is found under both.
  const transcripts = new MemoryTranscripts();
  for (const { path, text } of recording.transcripts) {
    await kit.files.write(path, text);
    for (const spelled of new Set([path, normalize(path)])) {
      transcripts.set(spelled, text);
    }
  }
  const runs: PinnedRun[] = [];
  for (const { event, index, input } of recording.inputs) {
    for (const hook of hooks.filter((wired) => hookMatches(wired, input))) {
      // The guard hooks run through `hook <name>` like every other, without the guard runner's worker thread: the
      // pin is what a hook decides, and the runner has its own specs.
      const result = await kit.run(hook.argv, { stdin: JSON.stringify(input), env, transcripts });
      runs.push({
        event,
        index,
        hook: hook.argv.join(' '),
        code: result.code,
        // Folders are named in a parsed line's values: in its raw text a path would take a following `\n` escape for a
        // segment of its own.
        stdout: result.stdout.map((line) => {
          const value = structured(line);
          return value === undefined ? named(line) : withStrings(value, named);
        }),
        stderr: result.stderr.map(named),
      });
    }
  }
  const reader = shippedTranscripts();
  const lines = recording.transcripts.map(({ file, text }) => {
    const raw = text.split('\n').filter((line) => line !== '');
    const read = raw.flatMap((line, index) => {
      const value = transcriptLineOf(reader, line);
      return value === undefined ? [] : [{ line: index + 1, value: withStrings(value, named) }];
    });
    return { file, lines: raw.length, read };
  });
  return {
    ...Object.fromEntries(Object.keys(recording.recorded).map((event) => [hookFile(event), pretty(runs.filter((run) => run.event === event))])),
    [TRANSCRIPT_LINES_FILE]: pretty(lines),
  };
}
