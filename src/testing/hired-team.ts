import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { EXIT } from '../cli/runtime.ts';
import { CliHarness, TEAM_HOME, type CliResult } from './cli-harness.ts';

/** A test team where the lead hires `helper`, for the hire, retire, check and doctor tests through the CLI. */

export const HIRES = join(TEAM_HOME, 'state', 'hires.jsonl');
export const HELPER_HANDOVER = join(TEAM_HOME, 'handover', 'helper.md');
export const LEAD_TEAM: JsonRecord = { sessions: ['lead', 'alpha'], roles: { lead: 'lead' }, hiring: { policy: 'lead' } };

/** The result, after asserting the command succeeded (its output names why when it did not). */
export function ok(result: CliResult): CliResult {
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  return result;
}

/** A team with `helper` hired, owning the tasks given, and with its handover written when asked. */
export async function teamWithHelper(config: JsonRecord = LEAD_TEAM, tasks: readonly string[] = [], handover = true): Promise<CliHarness> {
  const kit = new CliHarness(config);
  ok(await kit.run(['hire', 'helper', '--scope', 'port the importer', '--reason', 'release week', '--yes', '--session', 'lead']));
  for (const title of tasks) {
    ok(await kit.run(['add', '--owner', 'helper', '--title', title, '--description', 'the job', '--priority', 'p2', '--session', 'lead']));
  }
  if (handover) {
    await kit.files.write(HELPER_HANDOVER, '# helper\nall done\n');
  }
  return kit;
}
