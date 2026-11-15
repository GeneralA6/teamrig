import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { HookAsks } from '../config/types.ts';
import { changedGatedKeys, OWNER_GATED_KEYS, serviceRoleGuardOutput, type ServiceRoleGuardEnv } from './service-role-guard.ts';

const CONFIG = 'C:/u/.teamrig/teams/shop/config.json';

const ROLES = { github: { holders: ['alpha'], commands: ['issue close'] } };

const TEXT = `${JSON.stringify({ sessions: ['lead', 'alpha'], serviceRoles: ROLES }, null, 2)}\n`;

function env(options: { readonly asks?: HookAsks; readonly configPath?: string | undefined; readonly text?: string | undefined } = {}): ServiceRoleGuardEnv {
  const text = 'text' in options ? options.text : TEXT;
  return {
    cwd: 'C:/w',
    home: 'C:/u',
    hookAsks: options.asks ?? 'ask',
    platform: 'win32',
    configPath: 'configPath' in options ? options.configPath : CONFIG,
    readConfig: () => Promise.resolve(text),
  };
}

function call(tool: string, input: JsonRecord, cwd = 'C:/w'): JsonRecord {
  return { tool_name: tool, tool_input: input, cwd };
}

/** The decision and reason a guard output gives, or undefined for no output. */
function decisionOf(output: string): { readonly decision: string; readonly reason: string } | undefined {
  if (output === '') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(output);
  assert.ok(isRecord(parsed));
  const hook = recordField(parsed, 'hookSpecificOutput');
  assert.ok(hook !== undefined);
  return { decision: stringField(hook, 'permissionDecision') ?? '', reason: stringField(hook, 'permissionDecisionReason') ?? '' };
}

async function decide(payload: JsonRecord, guardEnv: ServiceRoleGuardEnv = env()): Promise<string | undefined> {
  return decisionOf(await serviceRoleGuardOutput(payload, guardEnv))?.decision;
}

describe('service-role guard: roles grant and revoke', () => {
  it('asks the owner for a grant or revoke through any client, whatever --yes says', async () => {
    const lines = [
      'teamrig roles grant github --holder alpha --commands "issue close" --yes',
      'teamrig roles revoke github --yes',
      'cd C:/w && teamrig roles grant github --holder team',
      'node C:/u/.claude/plugins/cache/teamrig/teamrig/0.1.0/dist/cli/main.js roles grant github --holder alpha',
      '$T roles grant github --holder alpha',
      'teamrig roles "$WHAT" github',
    ];
    for (const command of lines) {
      assert.equal(await decide(call('Bash', { command })), 'ask', command);
    }
    assert.equal(await decide(call('PowerShell', { command: "teamrig roles grant github --holder alpha --commands 'issue close' --yes" })), 'ask');
    const output = decisionOf(await serviceRoleGuardOutput(call('Bash', { command: lines[0] ?? '' }), env()));
    assert.match(output?.reason ?? '', /a permission only the owner gives/);
  });

  it('refuses it with the note to wait for the owner when asks are off', async () => {
    const output = decisionOf(await serviceRoleGuardOutput(call('Bash', { command: 'teamrig roles grant github --holder alpha --yes' }), env({ asks: 'refuse' })));
    assert.equal(output?.decision, 'deny');
    assert.match(output?.reason ?? '', /approval:owner/);
  });

  it('leaves roles list, other teamrig commands and other programs alone', async () => {
    for (const command of ['teamrig roles list', 'teamrig list --session alpha', 'echo roles grant', 'git grep "roles grant"']) {
      assert.equal(await decide(call('Bash', { command })), undefined, command);
    }
  });
});

describe('service-role guard: the team config', () => {
  it('refuses an Edit, MultiEdit or Write that changes serviceRoles, by any spelling of the path', async () => {
    const added = { old_string: '"alpha"\n      ]', new_string: '"alpha",\n        "bravo"\n      ]' };
    assert.equal(await decide(call('Edit', { file_path: CONFIG, ...added })), 'deny');
    assert.equal(await decide(call('Edit', { file_path: 'c:\\U\\.teamrig\\teams\\shop\\CONFIG.json', ...added })), 'deny');
    assert.equal(await decide(call('MultiEdit', { file_path: CONFIG, edits: [{ old_string: '"lead"', new_string: '"boss"' }, added] })), 'deny');
    assert.equal(await decide(call('Write', { file_path: CONFIG, content: JSON.stringify({ sessions: ['lead', 'alpha'] }) })), 'deny');
    const created = env({ text: undefined });
    assert.equal(await decide(call('Write', { file_path: CONFIG, content: JSON.stringify({ serviceRoles: ROLES }) }), created), 'deny');
  });

  it("passes an edit of the config's other keys, and a file that is not the config", async () => {
    assert.equal(await decide(call('Edit', { file_path: CONFIG, old_string: '"lead",', new_string: '"lead", "bravo",' })), undefined);
    assert.equal(await decide(call('Write', { file_path: CONFIG, content: JSON.stringify({ serviceRoles: ROLES, sessions: ['lead'] }) })), undefined);
    assert.equal(await decide(call('Edit', { file_path: 'C:/u/.teamrig/teams/other/config.json', old_string: 'a', new_string: 'b' })), undefined);
    assert.equal(await decide(call('Edit', { file_path: CONFIG, old_string: '"lead"', new_string: '"boss"' }), env({ configPath: undefined })), undefined);
  });

  it('refuses a config edit it cannot read as a change: text not found, an Edit of no file, a notebook edit', async () => {
    assert.equal(await decide(call('Edit', { file_path: CONFIG, old_string: 'not there', new_string: 'x' })), 'deny');
    assert.equal(await decide(call('Edit', { file_path: CONFIG, old_string: 'a', new_string: 'b' }), env({ text: undefined })), 'deny');
    assert.equal(await decide(call('NotebookEdit', { notebook_path: CONFIG, new_source: '{}' })), 'deny');
    assert.equal(await decide(call('MultiEdit', { file_path: CONFIG, edits: 'all of it' })), 'deny');
  });

  it("refuses a shell line naming the team config, whatever it does, and passes other config files", async () => {
    const refused = [
      'cat C:/u/.teamrig/teams/shop/config.json',
      "sed -i 's/x/y/' ~/.teamrig/teams/*/config.json",
      'jq . "$TEAMRIG_HOME/teams/$T/config.json"',
      'cp x.json config.json',
    ];
    for (const command of refused) {
      assert.equal(await decide(call('Bash', { command }, 'C:/u/.teamrig/teams/shop')), 'deny', command);
    }
    assert.equal(await decide(call('PowerShell', { command: 'Get-Content $HOME\\.teamrig\\teams\\shop\\config.json' })), 'deny');
    for (const command of ['cat tsconfig.json', 'cat src/testing/config.json', 'node -e "require(\'./config.json5\')"']) {
      assert.equal(await decide(call('Bash', { command })), undefined, command);
    }
  });
});

describe('config guard: every owner-gated key (T3083)', () => {
  const base = {
    sessions: ['lead', 'alpha'],
    serviceRoles: ROLES,
    roles: { lead: 'lead', securityReviewer: 'sec' },
    register: { ownerSource: 'owner', staleDays: 3 },
    prompts: { hookAsks: 'ask', routeAllow: { enabled: false } },
    readonlyShell: { allowPrefixes: ['git status'] },
    exec: { webhookEnv: 'HOOK_URL' },
    github: { owners: { octo: 'alpha' }, everyMinutes: 30 },
    delivery: { repos: { web: { merge: { command: ['gh', 'pr', 'merge'] } } }, checkTimeoutSeconds: 60 },
    pushGuard: { pushToProtected: 'ask' },
  };
  type Base = typeof base;
  const text = JSON.stringify(base, null, 2);
  const changed = (change: (config: Base) => Record<string, unknown>): string => JSON.stringify(change(structuredClone(base)), null, 2);

  it("refuses a session's Write that changes any of them, naming the key", async () => {
    const changes: readonly (readonly [string, string])[] = [
      ['roles', changed((c) => ({ ...c, roles: { ...c.roles, securityReviewer: 'alpha' } }))],
      ['register.ownerSource', changed((c) => ({ ...c, register: { ...c.register, ownerSource: 'alpha' } }))],
      ['prompts', changed((c) => ({ ...c, prompts: { ...c.prompts, hookAsks: 'off' } }))],
      ['readonlyShell', changed((c) => ({ ...c, readonlyShell: { allowPrefixes: ['git status', 'rm'] } }))],
      ['exec', changed((c) => ({ ...c, exec: { webhookEnv: 'OTHER' } }))],
      ['github.owners', changed((c) => ({ ...c, github: { ...c.github, owners: { octo: 'alpha', mallory: 'alpha' } } }))],
      ['delivery.repos', changed((c) => ({ ...c, delivery: { ...c.delivery, repos: { web: { merge: { command: ['sh', '-c', 'x'] } } } } }))],
      ['delivery.passEnv', changed((c) => ({ ...c, delivery: { ...c.delivery, passEnv: ['GH_TOKEN'] } }))],
      ['pushGuard', changed((c) => ({ ...c, pushGuard: { pushToProtected: 'allow' } }))],
      ['alerts', changed((c) => ({ ...c, alerts: { webhookEnv: 'X' } }))],
    ];
    for (const [key, content] of changes) {
      const output = decisionOf(await serviceRoleGuardOutput(call('Write', { file_path: CONFIG, content }), env({ text })));
      assert.equal(output?.decision, 'deny', key);
      assert.ok(output?.reason.includes(`changes ${key} in the team config`), `${key}: ${output?.reason ?? ''}`);
    }
  });

  it('refuses an Edit of a gated key inside the text, and passes one of a key beside it', async () => {
    const owner = { old_string: '"ownerSource": "owner"', new_string: '"ownerSource": "alpha"' };
    assert.equal(await decide(call('Edit', { file_path: CONFIG, ...owner }), env({ text })), 'deny');
    const stale = { old_string: '"staleDays": 3', new_string: '"staleDays": 5' };
    assert.equal(await decide(call('Edit', { file_path: CONFIG, ...stale }), env({ text })), undefined);
  });

  it('passes a change of its other keys, beside unchanged gated ones', async () => {
    const other = changed((c) => ({
      ...c,
      sessions: ['lead', 'alpha', 'bravo'],
      register: { ...c.register, staleDays: 5 },
      github: { ...c.github, everyMinutes: 15 },
      delivery: { ...c.delivery, checkTimeoutSeconds: 90 },
    }));
    assert.equal(await decide(call('Write', { file_path: CONFIG, content: other }), env({ text })), undefined);
  });

  it('reads a key the config lacks as unset, so adding or removing one is a change', () => {
    assert.deepEqual(changedGatedKeys(JSON.stringify({ sessions: [] }), JSON.stringify({ sessions: [], alerts: { webhookEnv: 'X' } })), ['alerts']);
    assert.deepEqual(changedGatedKeys(text, JSON.stringify({ ...base, exec: undefined })), ['exec']);
    assert.deepEqual(changedGatedKeys(undefined, 'not json'), []);
    assert.ok(OWNER_GATED_KEYS.some((keyPath) => keyPath.join('.') === 'serviceRoles'));
  });
});
