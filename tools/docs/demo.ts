import { join, resolve } from 'node:path';
import { runCli } from '../../src/cli/run.ts';
import { EXIT } from '../../src/cli/runtime.ts';
import { formatConfig } from '../../src/config/load.ts';
import type { JsonRecord } from '../../src/core/guards.ts';
import { FakeClock } from '../../src/testing/fake-clock.ts';
import { MemoryFiles } from '../../src/testing/memory-files.ts';
import { quietWorld } from '../../src/testing/quiet-world.ts';
import { textFileBytes } from '../../src/testing/text-file-bytes.ts';

/**
 * Runs the real CLI for a fictional team, in memory and on a fixed clock, so the commands doc's picture shows what
 * the CLI really prints, the same on every machine, and nothing from the machine that drew them.
 */

export const DEMO_TEAM = 'bookshop';
export const DEMO_CONFIG: JsonRecord = { sessions: ['lead', 'api', 'web', 'data'], roles: { lead: 'lead' } };
export const DEMO_START = '2026-10-12T09:00:00Z';
/** The kit home the demo runs in; printed paths show it as the default home, `~/.teamrig`. */
export const DEMO_KIT = resolve('/', 'kit');
const PROJECT = resolve('/', 'work', DEMO_TEAM);
/** Each step moves the clock this far, so inbox lines carry distinct times. */
const STEP_MS = 3 * 60_000;

export interface DemoStep {
  readonly session: string;
  readonly argv: readonly string[];
}

export interface DemoRun {
  readonly session: string;
  /** The command as a user types it: `teamrig <argv>`, quoted where a shell needs it. */
  readonly command: string;
  readonly output: readonly string[];
}

export function commandLine(argv: readonly string[]): string {
  return ['teamrig', ...argv.map((arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`))].join(' ');
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The line with every path under `kit` shown under `~/.teamrig`, with forward slashes. */
export function displayPaths(line: string, kit: string = DEMO_KIT): string {
  const forms = [...new Set([kit, kit.replaceAll('\\', '/')])];
  const pattern = new RegExp(`(?:${forms.map(escapeRegExp).join('|')})(\\S*)`, 'g');
  return line.replace(pattern, (_path, rest: string) => `~/.teamrig${rest.replaceAll('\\', '/')}`);
}

/** A fixed, fictional Claude Code session id per team session, as Claude Code would pass it. */
const claudeSessionOf = (session: string): string => `00000000-0000-4000-8000-${session.padEnd(12, '0').slice(0, 12).replace(/[^0-9a-f]/g, '0')}`;

/** Runs the steps in order against one in-memory team; a step that does not exit 0 throws, naming it. */
export async function runDemo(steps: readonly DemoStep[], config: JsonRecord = DEMO_CONFIG): Promise<DemoRun[]> {
  const files = new MemoryFiles({
    [join(DEMO_KIT, 'teams', DEMO_TEAM, 'config.json')]: formatConfig(config),
    [join(PROJECT, '.teamrig.json')]: JSON.stringify({ team: DEMO_TEAM }),
  });
  const clock = new FakeClock(DEMO_START);
  const runs: DemoRun[] = [];
  for (const step of steps) {
    const out: string[] = [];
    const code = await runCli(step.argv, {
      env: { TEAMRIG_HOME: DEMO_KIT, TEAMRIG_SESSION: step.session, CLAUDE_CODE_SESSION_ID: claudeSessionOf(step.session) },
      userHome: resolve('/', 'home', 'demo'),
      cwd: PROJECT,
      pid: 1,
      files,
      fileBytes: textFileBytes(files),
      clock,
      timeZone: 'UTC',
      sleep: clock.sleep,
      ...quietWorld('main'),
      out: { stdout: (line) => out.push(line), stderr: (line) => out.push(line) },
    });
    const command = commandLine(step.argv);
    if (code !== EXIT.ok) throw new Error(`demo step "${command}" as ${step.session} exited ${code}: ${out.join(' | ')}`);
    runs.push({ session: step.session, command, output: out.map((line) => displayPaths(line)) });
    clock.advance(STEP_MS);
  }
  return runs;
}
