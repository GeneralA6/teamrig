import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord, PermissionsAnswer, TrustedRoutesPlan } from '../../../plugin-api/index.ts';
import { DEFAULTS_ITEM, hostPermissions, secretDenyLines } from './permissions.ts';

const TAG = '[teamrig alpha] ';
const LINES = [`${TAG}one`, `${TAG}two`];
const OTHER_TEAM = '[teamrig beta] theirs';
const HAND = 'Source control: github.example/acme';
const PLATFORMS = ['linux', 'darwin', 'win32'] as const;
const GH_POSIX = 'Read(~/.config/gh/hosts.yml)';
const GH_WINDOWS = 'Read(~/AppData/Roaming/GitHub CLI/hosts.yml)';

function valueOf<T>(answer: PermissionsAnswer<T>): T {
  assert.ok(answer.ok, answer.ok ? '' : answer.problem);
  return answer.value;
}

function problemOf<T>(answer: PermissionsAnswer<T>): string {
  assert.equal(answer.ok, false);
  return answer.ok ? '' : answer.problem;
}

function withList(environment: readonly string[], others: JsonRecord = {}): JsonRecord {
  return { theme: 'dark', autoMode: { ...others, environment } };
}

const install = (settings: JsonRecord): PermissionsAnswer<TrustedRoutesPlan> => hostPermissions.installRoutes(settings, TAG, LINES);
const uninstall = (settings: JsonRecord): PermissionsAnswer<TrustedRoutesPlan> => hostPermissions.uninstallRoutes(settings, TAG);

describe('the Claude Code permissions port: settings names', () => {
  it('names the settings as a person finds them in Claude Code', () => {
    assert.equal(hostPermissions.allowSetting, 'permissions.allow');
    assert.equal(hostPermissions.denySetting, 'permissions.deny');
    assert.equal(hostPermissions.routesSetting, 'autoMode.environment');
  });
});

describe('the Claude Code permissions port: read', () => {
  it('reads the allow and deny lists, and no bypass when the default mode is another', () => {
    const reading = hostPermissions.read({ permissions: { allow: ['Bash(ls)'], deny: ['Read(~/.npmrc)'], defaultMode: 'acceptEdits' } });
    assert.deepEqual(reading, { allow: { ok: true, value: ['Bash(ls)'] }, deny: ['Read(~/.npmrc)'], bypass: undefined });
  });

  it('reads no rules from settings without a permissions object, or without the lists', () => {
    const none = { allow: { ok: true, value: [] }, deny: [], bypass: undefined };
    assert.deepEqual(hostPermissions.read({ theme: 'dark' }), none);
    assert.deepEqual(hostPermissions.read({ permissions: {} }), none);
  });

  it('words why an allow list cannot be rewritten', () => {
    assert.equal(problemOf(hostPermissions.read({ permissions: [] }).allow), 'permissions is not an object');
    assert.equal(problemOf(hostPermissions.read({ permissions: { allow: ['Bash(ls)', 3] } }).allow), 'permissions.allow is not a list of texts');
  });

  it('keeps the deny lines that are texts and skips the rest', () => {
    assert.deepEqual(hostPermissions.read({ permissions: { deny: ['Read(~/.npmrc)', 3, null] } }).deny, ['Read(~/.npmrc)']);
    assert.deepEqual(hostPermissions.read({ permissions: { deny: 'Read(~/.npmrc)' } }).deny, []);
  });

  it('names the bypass setting when every tool call runs without asking', () => {
    assert.equal(hostPermissions.read({ permissions: { defaultMode: 'bypassPermissions' } }).bypass, 'permissions.defaultMode is bypassPermissions');
  });
});

describe('the Claude Code permissions port: writeAllow', () => {
  it('puts the allow list in place, every other setting as it was', () => {
    const settings = { theme: 'dark', permissions: { allow: ['Bash(ls)', 'Bash(rm *)'], deny: ['Read(~/.npmrc)'] } };
    assert.deepEqual(valueOf(hostPermissions.writeAllow(settings, ['Bash(ls)'])), {
      theme: 'dark',
      permissions: { allow: ['Bash(ls)'], deny: ['Read(~/.npmrc)'] },
    });
  });

  it('starts a permissions object in settings without one, and refuses one of another shape', () => {
    assert.deepEqual(valueOf(hostPermissions.writeAllow({}, ['Bash(ls)'])), { permissions: { allow: ['Bash(ls)'] } });
    assert.equal(problemOf(hostPermissions.writeAllow({ permissions: 'all' }, [])), 'permissions is not an object');
  });
});

describe('the Claude Code permissions port: denyLines', () => {
  it('is secretDenyLines, each line once', () => {
    for (const platform of PLATFORMS) {
      const lines = hostPermissions.denyLines(platform);
      assert.deepEqual(lines, secretDenyLines(platform));
      assert.equal(new Set(lines).size, lines.length, platform);
    }
  });

  it("names gh's hosts file where gh keeps it on the platform, and only there (T2038)", () => {
    const gh = (platform: NodeJS.Platform): string[] => hostPermissions.denyLines(platform).filter((line) => line.includes('hosts.yml'));
    assert.deepEqual(gh('win32'), [GH_WINDOWS]);
    assert.deepEqual(gh('linux'), [GH_POSIX]);
    assert.deepEqual(gh('darwin'), [GH_POSIX]);
  });

  it("guards Claude Code's own login on every platform (T2038)", () => {
    for (const platform of PLATFORMS) {
      assert.ok(hostPermissions.denyLines(platform).includes('Read(~/.claude/.credentials.json)'), platform);
    }
  });

  it('holds no legacy prefix rule, which misses a call whose argument goes on past the colon', () => {
    const lines = hostPermissions.denyLines('linux');
    assert.deepEqual(lines.filter((line) => line.endsWith(':*)')), []);
    assert.ok(lines.includes('PowerShell(Get-ChildItem env*)'));
  });
});

describe('the Claude Code permissions port: installRoutes', () => {
  it("starts a machine with no list from Claude Code's built-in entries", () => {
    assert.deepEqual(valueOf(install({ theme: 'dark' })), {
      settings: { theme: 'dark', autoMode: { environment: [DEFAULTS_ITEM, ...LINES] } },
      removed: [],
      added: [DEFAULTS_ITEM, ...LINES],
    });
  });

  it('keeps the other autoMode keys when there is no list yet', () => {
    assert.deepEqual(valueOf(install({ autoMode: { soft_deny: ['x'] } })).settings, { autoMode: { soft_deny: ['x'], environment: [DEFAULTS_ITEM, ...LINES] } });
  });

  it("appends to a list with none of the team's lines, without adding $defaults to it", () => {
    assert.deepEqual(valueOf(install(withList([HAND, OTHER_TEAM], { hard_deny: ['y'] }))), {
      settings: withList([HAND, OTHER_TEAM, ...LINES], { hard_deny: ['y'] }),
      removed: [],
      added: LINES,
    });
  });

  it("replaces the team's lines at the first one's place, leaving hand lines and other teams' lines alone", () => {
    assert.deepEqual(valueOf(install(withList([DEFAULTS_ITEM, `${TAG}old`, HAND, `${TAG}two`, OTHER_TEAM]))), {
      settings: withList([DEFAULTS_ITEM, ...LINES, HAND, OTHER_TEAM]),
      removed: [`${TAG}old`],
      added: [`${TAG}one`],
    });
  });

  it('changes nothing when the lines are already in, in order', () => {
    assert.deepEqual(valueOf(install(withList([HAND, ...LINES, OTHER_TEAM]))), { settings: undefined, removed: [], added: [] });
  });

  it('refuses an autoMode or a list it cannot read', () => {
    assert.match(problemOf(install({ autoMode: 'on' })), /^autoMode is not an object/);
    assert.match(problemOf(install({ autoMode: { environment: 'x' } })), /^autoMode\.environment is not a list of strings/);
    assert.match(problemOf(install({ autoMode: { environment: [HAND, 3] } })), /^autoMode\.environment is not a list of strings/);
  });
});

describe('the Claude Code permissions port: uninstallRoutes', () => {
  it("takes the team's lines out, leaving hand lines and other teams' lines", () => {
    assert.deepEqual(valueOf(uninstall(withList([DEFAULTS_ITEM, ...LINES, HAND, OTHER_TEAM]))), {
      settings: withList([DEFAULTS_ITEM, HAND, OTHER_TEAM]),
      removed: LINES,
      added: [],
    });
  });

  it('drops a list left as only $defaults, and an autoMode left empty', () => {
    assert.deepEqual(valueOf(uninstall(withList([DEFAULTS_ITEM, ...LINES]))).settings, { theme: 'dark' });
  });

  it('keeps the other autoMode keys when the list is dropped', () => {
    assert.deepEqual(valueOf(uninstall(withList([DEFAULTS_ITEM, ...LINES], { soft_deny: ['x'] }))).settings, { theme: 'dark', autoMode: { soft_deny: ['x'] } });
  });

  it("keeps an empty list, which turns Claude Code's built-in entries off, as the person had it", () => {
    assert.deepEqual(valueOf(uninstall(withList(LINES))).settings, withList([]));
  });

  it("changes nothing without the team's lines or without a list", () => {
    const none = { settings: undefined, removed: [], added: [] };
    assert.deepEqual(valueOf(uninstall(withList([HAND, OTHER_TEAM]))), none);
    assert.deepEqual(valueOf(uninstall({ autoMode: { soft_deny: ['x'] } })), none);
    assert.deepEqual(valueOf(uninstall({})), none);
  });

  it('refuses an autoMode or a list it cannot read', () => {
    assert.match(problemOf(uninstall({ autoMode: [] })), /^autoMode is not an object/);
    assert.match(problemOf(uninstall({ autoMode: { environment: {} } })), /^autoMode\.environment is not a list of strings/);
  });
});
