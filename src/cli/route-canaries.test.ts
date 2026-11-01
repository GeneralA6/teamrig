import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { CLIENT_MANIFEST, clientFileHash, clientManifestText, clientRootOf } from '../exec/client-integrity.ts';
import { SANCTIONED_ROUTES } from '../permissions/sanctioned.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { quietWorld } from '../testing/quiet-world.ts';
import { EXIT } from './runtime.ts';

/**
 * The canaries (T679, design M1 place 5): each sanctioned route's canary line, fed to every PreToolUse guard on Bash and
 * to the PermissionRequest answer, as the canary session that owns T1, with asks off. None may ask or refuse: a guard
 * that would stop a route's own line is a route no session can take.
 */
const CANARY_TEAM: JsonRecord = { ...TEAM, sessions: ['lead', 'alpha', 'bravo', 'tr-canary'], prompts: { hookAsks: 'refuse' } };
const ENV = { TEAMRIG_SESSION: 'tr-canary' };
/** The Bash PreToolUse hooks of hooks.json, but the route allow, whose answer each canary's entry sets. */
const GUARDS = ['push-guard', 'package-guard', 'secret-guard', 'exec-guard', 'pass-record-guard', 'readonly-allow'] as const;
/** A repository whose `origin` is a remote, on a branch no rule protects. */
const GIT: RunOptions['git'] = {
  branch: () => 't1-canary',
  head: () => undefined,
  pushTarget: () => undefined,
  config: (_dir, key) => (key === 'remote.origin.url' ? { kind: 'set', value: 'u' } : { kind: 'unset' }),
};

function payload(event: string, command: string): string {
  return JSON.stringify({ hook_event_name: event, session_id: CLAUDE_SESSION, cwd: APP, tool_name: 'Bash', tool_input: { command } });
}

/** The hook's answer: its PreToolUse permission decision, or its PermissionRequest decision's behavior; else undefined. */
function answerOf(result: CliResult): unknown {
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  const output = isRecord(parsed) ? recordField(parsed, 'hookSpecificOutput') : undefined;
  return output?.['permissionDecision'] ?? recordField(output ?? {}, 'decision')?.['behavior'];
}

/** The plugin root the harness CLI runs from, and its launcher as its build wrote it. */
const PLUGIN = clientRootOf(quietWorld().self.script);
const LAUNCHER = 'bin/teamrig';
const BUILT = '#!/bin/sh\nexec node main.js\n';

/** A team whose canary session owns T1, run from a plugin install whose client matches its build (the exec guard). */
async function canaryKit(): Promise<CliHarness> {
  const kit = new CliHarness(CANARY_TEAM);
  await kit.files.write(join(PLUGIN, CLIENT_MANIFEST), clientManifestText(new Map([[LAUNCHER, clientFileHash(BUILT)]])));
  await kit.files.write(join(PLUGIN, LAUNCHER), BUILT);
  await kit.run(['add', '--title', 'Canary', '--description', 'what and why', '--priority', 'p1', '--session', 'tr-canary']);
  return kit;
}

describe('sanctioned route canaries', () => {
  for (const route of SANCTIONED_ROUTES) {
    it(`${route.id}: no Bash guard asks about or refuses its canary`, async () => {
      const kit = await canaryKit();
      for (const guard of GUARDS) {
        const result = await kit.run(['hook', guard], { stdin: payload('PreToolUse', route.canary), env: ENV, git: GIT });
        assert.equal(result.code, EXIT.ok, `${guard}: ${result.stderr.join('\n')}`);
        assert.ok(answerOf(result) === undefined || answerOf(result) === 'allow', `${guard}: ${result.stdout.join('\n')}`);
      }
    });

    it(`${route.id}: the route allow ${route.preToolUse ? 'runs' : 'leaves to the permission check'} its canary`, async () => {
      const kit = await canaryKit();
      const result = await kit.run(['hook', 'route-allow'], { stdin: payload('PreToolUse', route.canary), env: ENV, git: GIT });
      assert.equal(answerOf(result), route.preToolUse ? 'allow' : undefined);
    });

    it(`${route.id}: the permission prompt's answer runs its canary`, async () => {
      const kit = await canaryKit();
      const result = await kit.run(['hook', 'prompt-refuse'], { stdin: payload('PermissionRequest', route.canary), env: ENV, git: GIT });
      assert.equal(answerOf(result), 'allow', result.stdout.join('\n'));
    });
  }
});
