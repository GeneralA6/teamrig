import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { kitLines, kitTag } from '../automode/lines.ts';
import { formatConfig } from '../config/load.ts';
import { homeRelative } from '../core/paths.ts';
import { CliHarness, KIT, TEAM, TEAM_HOME, USER_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const SETTINGS = join(USER_HOME, '.claude', 'settings.json');
const BACKUP = join(KIT, 'backups', 'claude-settings.json');
const WHERE = `${SETTINGS} autoMode.environment`;
const TAG = kitTag('app');
/** The default team's lines: team `app`, lead `lead`, the shipped push guard. */
const LINES = kitLines({
  team: 'app',
  home: homeRelative(TEAM_HOME, USER_HOME),
  lead: 'lead',
  pushGuard: { protectedBranches: ['main', 'master'], pushToProtected: 'ask' },
});
const OWN = 'Trusted repo: github.com/me/app';
const OTHER_TEAM = '[teamrig shop] Protected branches: main.';

async function withSettings(text: string | undefined, config = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  if (text !== undefined) {
    await kit.files.write(SETTINGS, text);
  }
  return kit;
}

function settingsIn(kit: CliHarness): unknown {
  const text = kit.files.get(SETTINGS);
  return text === undefined ? undefined : JSON.parse(text);
}

function added(lines: readonly string[]): string[] {
  return lines.map((line) => `  ADD ${WHERE}: ${line}`);
}

function removed(lines: readonly string[]): string[] {
  return lines.map((line) => `  REMOVE ${WHERE}: ${line}`);
}

describe('teamrig automode install', () => {
  it('previews the lines after "$defaults" on a machine with no list, and writes nothing without --yes', async () => {
    const kit = await withSettings(undefined);
    const result = await kit.run(['automode', 'install']);
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['PREVIEW nothing written (add --yes to write)', ...added(['$defaults', ...LINES])]]);
    assert.equal(kit.files.get(SETTINGS), undefined);
  });

  it('with --yes writes the list, and a second run finds nothing to change', async () => {
    const kit = await withSettings(undefined);
    const result = await kit.run(['automode', 'install', '--yes']);
    assert.deepEqual(result.stdout, ['WROTE the changes below', ...added(['$defaults', ...LINES])]);
    assert.deepEqual(settingsIn(kit), { autoMode: { environment: ['$defaults', ...LINES] } });
    assert.deepEqual((await kit.run(['automode', 'install', '--yes'])).stdout, [`UNCHANGED ${SETTINGS}: team app's lines are already there`]);
  });

  it('replaces stale team lines where they were, keeping the old file and every other line and key', async () => {
    const original = formatConfig({ theme: 'dark', autoMode: { allow: ['x'], environment: [OWN, `${TAG}an old line`, OTHER_TEAM] } });
    const kit = await withSettings(original);
    const result = await kit.run(['automode', 'install', '--yes']);
    assert.deepEqual(result.stdout, [
      `WROTE the changes below; the old settings file is at ${BACKUP}`,
      ...removed([`${TAG}an old line`]),
      ...added(LINES),
    ]);
    assert.deepEqual(settingsIn(kit), { theme: 'dark', autoMode: { allow: ['x'], environment: [OWN, ...LINES, OTHER_TEAM] } });
    assert.equal(kit.files.get(BACKUP), original);
  });

  it("fills the lines from the team's config: its lead and push guard", async () => {
    const kit = await withSettings(undefined, { ...TEAM, roles: { lead: 'alpha' }, pushGuard: { protectedBranches: ['trunk'], pushToProtected: 'lead' } });
    const result = await kit.run(['automode', 'install']);
    assert.match(result.stdout[2] ?? '', /\[teamrig app\] Protected branches: trunk\. A normal push to one goes through only for the lead \(session alpha\)/);
  });

  it('names a team folder under the user home with ~/', async () => {
    const kitHome = join(USER_HOME, '.teamrig');
    const kit = new CliHarness(null);
    await kit.files.write(join(kitHome, 'teams', 'app', 'config.json'), formatConfig(TEAM));
    const result = await kit.run(['automode', 'install'], { env: { TEAMRIG_HOME: kitHome } });
    assert.match(result.stdout[3] ?? '', /they write only under ~\/\.teamrig\/teams\/app\/\.$/);
  });

  it('refuses a list that is not strings and writes nothing', async () => {
    const original = formatConfig({ autoMode: { environment: [OWN, 3] } });
    const kit = await withSettings(original);
    const result = await kit.run(['automode', 'install', '--yes']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /^REFUSED autoMode\.environment is not a list of strings/);
    assert.equal(kit.files.get(SETTINGS), original);
    assert.equal(kit.files.get(BACKUP), undefined);
  });

  it('refuses outside a team', async () => {
    const kit = new CliHarness(null, null);
    const result = await kit.run(['automode', 'install']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /^REFUSED no team here/);
  });
});

describe('teamrig automode uninstall', () => {
  it("takes out only the team's lines, and drops a list and an autoMode left with nothing of their own", async () => {
    const kit = await withSettings(formatConfig({ theme: 'dark', autoMode: { environment: ['$defaults', ...LINES] } }));
    const preview = await kit.run(['automode', 'uninstall']);
    assert.deepEqual(preview.stdout, ['PREVIEW nothing written (add --yes to write)', ...removed(LINES)]);
    const result = await kit.run(['automode', 'uninstall', '--yes']);
    assert.deepEqual(result.stdout, [`WROTE the changes below; the old settings file is at ${BACKUP}`, ...removed(LINES)]);
    assert.deepEqual(settingsIn(kit), { theme: 'dark' });
  });

  it("keeps the person's own lines and another team's", async () => {
    const kit = await withSettings(formatConfig({ autoMode: { environment: [OWN, ...LINES, OTHER_TEAM] } }));
    await kit.run(['automode', 'uninstall', '--yes']);
    assert.deepEqual(settingsIn(kit), { autoMode: { environment: [OWN, OTHER_TEAM] } });
  });

  it('changes nothing when the team has no lines there', async () => {
    const kit = await withSettings(formatConfig({ autoMode: { environment: [OWN] } }));
    const result = await kit.run(['automode', 'uninstall', '--yes']);
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, [`UNCHANGED ${SETTINGS}: team app has no lines there`]]);
    assert.equal(kit.files.get(BACKUP), undefined);
  });
});
