import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isRecord } from '../core/guards.ts';
import { SecretScanner } from '../core/secrets.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { KeepList } from './allow-rules.ts';
import type { SettingsFile } from './settings-scope.ts';
import { applyTrim, backupStamp, MANIFEST, ownerStateDir, planFile, planScope, rewritesOf, wideAllowOf, type FilePlan, type ReadPlan } from './trim.ts';

/** A value a rule can hold; no plan outside a file's own text may carry it. Joined, so no source line holds a URL the secret redactor catches. */
const HELD_VALUE = ['postgres://user:', 'hunter22', '@db.example.net'].join('');
const KEEP = new KeepList(['Bash(kubectl get *)', 'WebSearch']);
const SECRETS = new SecretScanner();
const USER: SettingsFile = { path: join('/home', 'me', '.claude', 'settings.json'), kind: 'user' };
const SHARED: SettingsFile = { path: join('/repo', '.claude', 'settings.json'), kind: 'shared' };
const LOCAL: SettingsFile = { path: join('/repo', '.claude', 'settings.local.json'), kind: 'local' };
const ALLOW = ['Bash(kubectl get:*)', 'Bash(node:*)', `Bash(psql ${HELD_VALUE})`, 'Read', 'WebSearch'];
const BACKUPS = join('/state', 'teamrig', 'permissions-backups', '20261023T122100Z');
const NOW = Date.parse('2026-10-23T12:21:00Z');

function settings(allow: unknown): string {
  return `${JSON.stringify({ model: 'opus', permissions: { allow, deny: ['Bash(rm *)'] }, env: { A: '1' } }, null, 2)}\n`;
}

function readPlan(plan: FilePlan): ReadPlan {
  assert.equal(plan.kind, 'read');
  return plan;
}

function json(text: string | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text ?? 'null');
  assert.ok(isRecord(parsed));
  return parsed;
}

/** Files whose writes land changed, as a disk or another writer could leave them. */
class TamperingFiles extends MemoryFiles {
  override async write(path: string, text: string): Promise<void> {
    await super.write(path, text.replace('WebSearch', 'WebFetch'));
  }
}

describe('planFile', () => {
  it('plans nothing for a missing file', () => {
    assert.deepEqual(planFile(LOCAL, undefined, KEEP, 'wide', SECRETS), { file: LOCAL, kind: 'absent' });
  });

  it('leaves a file it cannot read as an allow list, without quoting it', () => {
    const cases: readonly (readonly [string, string])[] = [
      [`{"permissions": {"allow": ["${HELD_VALUE}"`, 'not a JSON object'],
      ['[]', 'not a JSON object'],
      ['{"permissions": []}', 'permissions is not an object'],
      ['{"permissions": {"allow": "Bash"}}', 'permissions.allow is not a list of texts'],
      [`{"permissions": {"allow": ["${HELD_VALUE}", 1]}}`, 'permissions.allow is not a list of texts'],
    ];
    for (const [text, why] of cases) {
      const plan = planFile(LOCAL, text, KEEP, 'all', SECRETS);
      assert.deepEqual(plan, { file: LOCAL, kind: 'unreadable', why });
      assert.ok(!JSON.stringify(plan).includes('hunter22'));
    }
  });

  it('reads a file with no allow list as none, to rewrite nothing', () => {
    const plan = readPlan(planFile(LOCAL, '{"model": "opus"}', KEEP, 'all', SECRETS));
    assert.equal(plan.total, 0);
    assert.equal(plan.next, undefined);
  });

  it('removes the rules off the keep-list that approve a whole tool or program or hold a credential, and changes nothing else', () => {
    const plan = readPlan(planFile(LOCAL, `\uFEFF${settings(ALLOW)}`, KEEP, 'wide', SECRETS));
    assert.equal(plan.total, 5);
    const next = json(plan.next);
    assert.deepEqual(Object.keys(next), ['model', 'permissions', 'env']);
    assert.deepEqual(next['permissions'], { allow: ['Bash(kubectl get:*)', 'WebSearch'], deny: ['Bash(rm *)'] });
    assert.deepEqual(next['env'], { A: '1' });
    assert.ok(plan.next?.endsWith('}\n'));
  });

  it('removes every rule off the keep-list with all', () => {
    const plan = readPlan(planFile(USER, settings(ALLOW), KEEP, 'all', SECRETS));
    assert.deepEqual(plan.trim.after, ['Bash(kubectl get:*)', 'WebSearch']);
    assert.deepEqual(json(plan.next)['permissions'], { allow: ['Bash(kubectl get:*)', 'WebSearch'], deny: ['Bash(rm *)'] });
  });

  it('counts but never rewrites a shared file, or one with nothing to remove', () => {
    const shared = readPlan(planFile(SHARED, settings(ALLOW), KEEP, 'all', SECRETS));
    assert.deepEqual(shared.trim.removed, [['Bash credential', 1], ['Bash wide', 1], ['Read wide', 1]]);
    assert.equal(shared.next, undefined);
    assert.equal(readPlan(planFile(LOCAL, settings(['WebSearch', 'Bash(kubectl get)']), KEEP, 'all', SECRETS)).next, undefined);
  });
});

describe('wideAllowOf', () => {
  it('adds up what a wide plan removes over the files that hold any, shared ones too', async () => {
    const files = new MemoryFiles({ [USER.path]: settings(['Read', 'Edit(src/x.ts)']), [SHARED.path]: settings(ALLOW), [LOCAL.path]: '[]' });
    const plans = await planScope(files, [USER, SHARED, LOCAL, { path: join('/none', 'settings.json'), kind: 'local' }], KEEP, 'wide', SECRETS);
    assert.deepEqual(wideAllowOf(plans), { files: 2, counts: [['Read wide', 2], ['Bash credential', 1], ['Bash wide', 1]] });
    assert.deepEqual(wideAllowOf([]), { files: 0, counts: [] });
  });
});

describe('applyTrim', () => {
  it('backs up each file it rewrites with a manifest, rewrites it and reads it back; a shared file stays', async () => {
    const original = settings(ALLOW);
    const files = new MemoryFiles({ [USER.path]: original, [LOCAL.path]: original, [SHARED.path]: original });
    const plans = await planScope(files, [USER, SHARED, LOCAL], KEEP, 'all', SECRETS);
    const written = await applyTrim(files, plans, BACKUPS, NOW);
    assert.deepEqual(
      written.map(({ plan, backup, result }) => [plan.file.path, backup, result]),
      [
        [USER.path, join(BACKUPS, '01-settings.json'), 'wrote'],
        [LOCAL.path, join(BACKUPS, '02-settings.local.json'), 'wrote'],
      ],
    );
    assert.equal(files.get(join(BACKUPS, '01-settings.json')), original);
    assert.equal(files.get(join(BACKUPS, '02-settings.local.json')), original);
    assert.equal(files.get(SHARED.path), original);
    assert.deepEqual(json(files.get(LOCAL.path))['permissions'], { allow: ['Bash(kubectl get:*)', 'WebSearch'], deny: ['Bash(rm *)'] });
    const sha256 = createHash('sha256').update(original, 'utf8').digest('hex');
    assert.deepEqual(json(files.get(join(BACKUPS, MANIFEST))), {
      createdAt: '2026-10-23T12:21:00.000Z',
      files: [
        { path: USER.path, backup: '01-settings.json', sha256, rules: 5 },
        { path: LOCAL.path, backup: '02-settings.local.json', sha256, rules: 5 },
      ],
    });
  });

  it('leaves a file that changed since it was read', async () => {
    const files = new MemoryFiles({ [LOCAL.path]: settings(ALLOW) });
    const plans = await planScope(files, [LOCAL], KEEP, 'all', SECRETS);
    await files.write(LOCAL.path, settings(['Read', 'Bash(git push *)']));
    const [write] = await applyTrim(files, plans, BACKUPS, NOW);
    assert.equal(write?.result, 'changed-since-read');
    assert.equal(files.get(LOCAL.path), settings(['Read', 'Bash(git push *)']));
  });

  it('reports a write whose read-back allow list differs', async () => {
    const files = new TamperingFiles({ [LOCAL.path]: settings(ALLOW) });
    const [write] = await applyTrim(files, await planScope(files, [LOCAL], KEEP, 'all', SECRETS), BACKUPS, NOW);
    assert.equal(write?.result, 'not-verified');
  });

  it('writes no settings file when a backup name is already taken', async () => {
    const files = new MemoryFiles({ [USER.path]: settings(ALLOW), [LOCAL.path]: settings(ALLOW), [join(BACKUPS, '02-settings.local.json')]: 'older' });
    const plans = await planScope(files, [USER, LOCAL], KEEP, 'all', SECRETS);
    await assert.rejects(applyTrim(files, plans, BACKUPS, NOW), /02-settings\.local\.json already exists; nothing written/);
    assert.equal(files.get(USER.path), settings(ALLOW));
    assert.equal(files.get(LOCAL.path), settings(ALLOW));
    assert.equal(files.get(join(BACKUPS, MANIFEST)), undefined);
    assert.equal(rewritesOf(plans).length, 2);
  });
});

describe('ownerStateDir and backupStamp', () => {
  it("picks the person's own state folder: LOCALAPPDATA on Windows, else XDG_STATE_HOME, else ~/.local/state", () => {
    const home = join('/home', 'me');
    assert.equal(ownerStateDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', XDG_STATE_HOME: '/x' }, home, 'win32'), 'C:\\Users\\me\\AppData\\Local');
    assert.equal(ownerStateDir({ LOCALAPPDATA: ' ', XDG_STATE_HOME: '/x' }, home, 'win32'), '/x');
    assert.equal(ownerStateDir({ LOCALAPPDATA: 'C:\\Local', XDG_STATE_HOME: '/x' }, home, 'linux'), '/x');
    assert.equal(ownerStateDir({}, home, 'darwin'), join(home, '.local', 'state'));
  });

  it('names a backup folder by the UTC second', () => {
    assert.equal(backupStamp(Date.parse('2026-10-23T12:21:07.123Z')), '20261023T122107Z');
  });
});
