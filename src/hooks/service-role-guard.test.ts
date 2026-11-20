import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_GATED_KEYS } from '../config/owner-gated.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { changedGatedKeys, serviceRoleGuardOutput, type ServiceRoleGuardEnv } from './service-role-guard.ts';

const CONFIG = 'C:/u/.teamrig/teams/shop/config.json';

const ROLES = { github: { holders: ['alpha'], commands: ['issue close'] } };

const TEXT = `${JSON.stringify({ sessions: ['lead', 'alpha'], serviceRoles: ROLES }, null, 2)}\n`;

/** Another team's config under the same kit home, with gated keys of its own. */
const OTHER = 'C:/u/.teamrig/teams/other/config.json';

const OTHER_TEXT = `${JSON.stringify({ sessions: ['boss'], ownerGates: ['budget'], pushGuard: { pushToProtected: 'ask' } }, null, 2)}\n`;

/** A path's spelling as the fake filesystem keys it: one slash, any case. */
function fileKey(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase();
}

/**
 * The real path of each spelling the fake filesystem knows: the kit home, the config, and what links to it. An 8.3
 * short name comes back unchanged, as Node's real path gives it on Windows, so the guard must know it by its name.
 */
const REAL: Readonly<Record<string, string>> = {
  [fileKey('C:/u/.teamrig')]: 'C:/u/.teamrig',
  [fileKey(CONFIG)]: CONFIG,
  [fileKey('C:/w/link.json')]: CONFIG,
  [fileKey('C:/u/.teamrig/teams/shop/CONFIG~1.JSO')]: 'C:/u/.teamrig/teams/shop/CONFIG~1.JSO',
  [fileKey('C:/u/.teamrig/teams/other/CONFIG~1.JSO')]: 'C:/u/.teamrig/teams/other/CONFIG~1.JSO',
  [fileKey('C:/u/TEAMRI~1/teams/shop/config.json')]: 'C:/u/TEAMRI~1/teams/shop/config.json',
  [fileKey('C:/u/TEAMRI~1/teams/SHOP~1/CONFIG~2.JSO')]: 'C:/u/TEAMRI~1/teams/SHOP~1/CONFIG~2.JSO',
};

interface GuardOptions {
  readonly configPath?: string | undefined;
  readonly text?: string | undefined;
  readonly platform?: NodeJS.Platform;
  /** Collects the path of each file the guard reads. */
  readonly reads?: string[];
}

function env(options: GuardOptions = {}): ServiceRoleGuardEnv {
  const text = 'text' in options ? options.text : TEXT;
  return {
    cwd: 'C:/w',
    home: 'C:/u',
    platform: options.platform ?? 'win32',
    configPath: 'configPath' in options ? options.configPath : CONFIG,
    readConfig: (path) => {
      options.reads?.push(path);
      return Promise.resolve(/[\\/]teams[\\/]other[\\/]/i.test(path) ? OTHER_TEXT : text);
    },
    canonical: (path) => Promise.resolve(REAL[fileKey(path)]),
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
  it('refuses a grant or revoke through any client, whatever --yes says', async () => {
    const lines = [
      'teamrig roles grant github --holder alpha --commands "issue close" --yes',
      'teamrig roles revoke github --yes',
      'cd C:/w && teamrig roles grant github --holder team',
      'node C:/u/.claude/plugins/cache/teamrig/teamrig/0.1.0/dist/cli/main.js roles grant github --holder alpha',
      '$T roles grant github --holder alpha',
      'teamrig roles "$WHAT" github',
      'node C:/u/.claude/plugins/cache/teamrig/teamrig/0.1.0/dist/cli/guard-main.js roles grant github --holder alpha --yes',
      'npx teamrig roles grant github --holder alpha --yes',
      'npx tsx src/cli/main.ts roles grant github --holder alpha --yes',
      'pnpm dlx teamrig@latest roles revoke github --yes',
      'yarn teamrig roles grant github --holder alpha',
      'bunx teamrig roles grant github --holder alpha',
      'npx "$P" roles grant github --holder alpha',
      'pnpm dlx $P roles revoke github --yes',
      // What a package runner or a version manager starts, a shell it starts included (T3069).
      'npx -c "teamrig roles grant github --holder alpha"',
      'npx bash -c "teamrig roles revoke github --yes"',
      'pnpm exec sh -c "teamrig roles grant github --holder alpha"',
      'corepack pnpm exec teamrig roles revoke github',
      'volta run teamrig roles grant github --holder alpha',
      // Any program's words that start a grant, as they may start the CLI under another name; echo's too (T3069).
      'node C:/tmp/x.js roles grant github --holder alpha',
      './x roles revoke github',
      'npx git+https://x/teamrig.git roles grant github --holder alpha',
      'echo roles grant',
    ];
    for (const command of lines) {
      assert.equal(await decide(call('Bash', { command })), 'deny', command);
    }
    assert.equal(await decide(call('PowerShell', { command: "teamrig roles grant github --holder alpha --commands 'issue close' --yes" })), 'deny');
    const output = decisionOf(await serviceRoleGuardOutput(call('Bash', { command: lines[0] ?? '' }), env()));
    assert.match(output?.reason ?? '', /a permission only the owner gives/);
    assert.match(output?.reason ?? '', /a grant first shows what its commands reach, pull requests and outside authors included/, 'T2984');
  });

  it('refuses it with the route: the owner runs it from their own terminal, never at a prompt in a session (T3356)', async () => {
    const output = decisionOf(await serviceRoleGuardOutput(call('Bash', { command: 'teamrig roles grant github --holder alpha --yes' }), env()));
    assert.equal(output?.decision, 'deny');
    assert.match(output?.reason ?? '', /The owner runs it from their own terminal.*a session puts the change to its lead\./);
    assert.match(output?.reason ?? '', /approval:owner/);
    assert.doesNotMatch(output?.reason ?? '', /Owner: allow|or prompt/);
  });

  it('leaves roles list, other teamrig commands and other programs alone', async () => {
    for (const command of ['teamrig roles list', 'teamrig list --session alpha', 'git grep "roles grant"', 'echo "roles grant"']) {
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

  it("passes an edit of the config's other keys, and a file that is no team config", async () => {
    assert.equal(await decide(call('Edit', { file_path: CONFIG, old_string: '"lead",', new_string: '"lead", "bravo",' })), undefined);
    assert.equal(await decide(call('Write', { file_path: CONFIG, content: JSON.stringify({ serviceRoles: ROLES, sessions: ['lead'] }) })), undefined);
    for (const file_path of [
      'C:/u/.teamrig/config.json',
      'C:/u/.teamrig/teams/other/notes/config.json',
      'C:/u/.teamrig/teams/shop/plans/config.json',
      'C:/w/config.json',
      'C:/w/x.json',
    ]) {
      assert.equal(await decide(call('Edit', { file_path, old_string: 'a', new_string: 'b' })), undefined, file_path);
    }
    assert.equal(await decide(call('Edit', { file_path: CONFIG, old_string: '"lead"', new_string: '"boss"' }), env({ configPath: undefined })), undefined);
    assert.equal(await decide(call('Edit', { file_path: '/c/u/.teamrig/teams/other/notes.json', old_string: 'a', new_string: 'b' })), undefined);
  });

  it("guards every team's config under the kit home, each against its own text (T3083)", async () => {
    assert.equal(await decide(call('Edit', { file_path: OTHER, old_string: '"budget"', new_string: '' })), 'deny');
    assert.equal(await decide(call('Edit', { file_path: 'c:\\U\\.TEAMRIG\\teams\\other\\config.json', old_string: '"budget"', new_string: '' })), 'deny');
    const loosened = OTHER_TEXT.replace('"ask"', '"allow"');
    assert.equal(await decide(call('Write', { file_path: OTHER, content: loosened })), 'deny');
    assert.equal(await decide(call('Edit', { file_path: OTHER, old_string: '"boss"', new_string: '"boss", "bravo"' })), undefined);
  });

  it('knows a team config in any spelling of its path: a Git Bash drive, a long path, no team config of its own', async () => {
    const dropGate = { old_string: '"budget"', new_string: '' };
    assert.equal(await decide(call('Edit', { file_path: '/c/u/.teamrig/teams/other/config.json', ...dropGate })), 'deny');
    assert.equal(await decide(call('Edit', { file_path: '\\\\?\\C:\\u\\.teamrig\\teams\\other\\config.json', ...dropGate })), 'deny');
    assert.equal(await decide(call('Edit', { file_path: OTHER, ...dropGate }), env({ configPath: undefined })), 'deny');
    const ownRoles = { old_string: '"issue close"', new_string: '"issue close", "pr merge"' };
    assert.equal(await decide(call('Edit', { file_path: '/c/u/.teamrig/teams/shop/config.json', ...ownRoles })), 'deny');
  });

  it("guards every team's config under the kit home, reading that team's file (T2984)", async () => {
    const reads: string[] = [];
    const added = { old_string: '"alpha"\n      ]', new_string: '"alpha",\n        "bravo"\n      ]' };
    assert.equal(await decide(call('Edit', { file_path: 'C:/u/.teamrig/teams/web/config.json', ...added }), env({ reads })), 'deny');
    assert.deepEqual(reads, ['C:\\u\\.teamrig\\teams\\web\\config.json']);
    assert.equal(await decide(call('Edit', { file_path: 'C:/u/.teamrig/teams/web/config.json', old_string: '"lead"', new_string: '"boss"' })), undefined);
  });

  it('knows a team config by its 8.3 short name, which its real path gives back unchanged', async () => {
    const added = { old_string: '"alpha"\n      ]', new_string: '"alpha",\n        "bravo"\n      ]' };
    for (const file_path of ['C:/u/.teamrig/teams/shop/CONFIG~1.JSO', 'C:/u/TEAMRI~1/teams/SHOP~1/CONFIG~2.JSO', '/c/u/.teamrig/teams/shop/config~1.jso']) {
      assert.equal(await decide(call('Edit', { file_path, ...added })), 'deny', file_path);
    }
    const dropGate = { old_string: '"budget"', new_string: '' };
    assert.equal(await decide(call('Edit', { file_path: 'C:/u/.teamrig/teams/other/CONFIG~1.JSO', ...dropGate })), 'deny');
    assert.equal(await decide(call('Edit', { file_path: 'C:/u/.teamrig/teams/other/CONFIG~1.JSO', ...dropGate }), env({ configPath: undefined })), 'deny');
    const reads: string[] = [];
    await decide(call('Edit', { file_path: 'C:/u/.teamrig/teams/shop/CONFIG~1.JSO', ...added }), env({ reads }));
    assert.deepEqual(reads, ['C:\\u\\.teamrig\\teams\\shop\\CONFIG~1.JSO']);
    assert.equal(await decide(call('Edit', { file_path: 'C:/u/.teamrig/teams/shop/CONFIG~1.JSO', old_string: '"lead"', new_string: '"boss"' })), undefined);
  });

  it('holds every other spelling of a team config to the file: links, short names, trailing dots, and refuses device, share and stream forms (T2984)', async () => {
    const added = { old_string: '"alpha"\n      ]', new_string: '"alpha",\n        "bravo"\n      ]' };
    for (const file_path of [
      'C:/w/link.json',
      'C:/u/.teamrig/teams/shop/CONFIG~1.JSO',
      'C:/u/TEAMRI~1/teams/shop/config.json',
      'C:/u/.teamrig/teams/shop/config.json. ',
      'C:/u/.teamrig/teams./shop/config.json',
    ]) {
      assert.equal(await decide(call('Edit', { file_path, ...added })), 'deny', file_path);
    }
    for (const [file_path, form] of [
      ['C:\\u\\.teamrig\\teams\\shop\\config.json::$DATA', 'an alternate data stream'],
      ['C:/u/.teamrig/teams/shop/config.json:roles', 'an alternate data stream'],
      ['\\\\?\\C:\\u\\.teamrig\\teams\\shop\\config.json', 'a device path'],
      ['//./C:/u/.teamrig/teams/shop/CONFIG~1.JSO', 'a device path'],
      ['\\\\localhost\\c$\\u\\.teamrig\\teams\\shop\\config.json', 'a network share path'],
    ]) {
      const output = decisionOf(await serviceRoleGuardOutput(call('Write', { file_path, content: '{}' }), env()));
      assert.equal(output?.decision, 'deny', file_path);
      assert.match(output?.reason ?? '', new RegExp(`names a config\\.json through ${form}`), file_path);
    }
    assert.equal(await decide(call('Write', { file_path: '\\\\localhost\\c$\\w\\notes.md', content: 'x' })), undefined);
    assert.equal(await decide(call('Write', { file_path: 'C:config.json', content: 'x' })), undefined);
  });

  it('reads POSIX paths as written: a colon or leading slashes are plain characters there', async () => {
    const posixEnv = env({ platform: 'linux', configPath: '/srv/kit/teams/shop/config.json' });
    assert.equal(await decide(call('Write', { file_path: '/srv/notes/config.json:x', content: '{}' }, '/srv'), posixEnv), undefined);
    assert.equal(await decide(call('Write', { file_path: '/srv/kit/teams/web/config.json', content: '{}' }, '/srv'), posixEnv), 'deny');
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
      'cp x.json ~/.teamrig/teams/shop/CONFIG~1.JSO',
      'cp x.json ~/.teamrig/teams/shop/config.json.',
      'cp x.json "C:/u/.teamrig/teams/shop/config.json::$DATA"',
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
    prompts: { routeAllow: { enabled: false } },
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
      ['pluginDirs', changed((c) => ({ ...c, pluginDirs: ['/opt/mallory/hooks'] }))],
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
