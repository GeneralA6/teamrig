import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { APP, CliHarness, KIT, POINTER, TEAM, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { CONFIG_VERSION } from '../config/types.ts';
import type { PointerGit, PointerInGit } from '../setup/pointer-ignore.ts';
import { EXIT } from './runtime.ts';

const SHOP = resolve('/', 'w', 'shop');
const SHOP_CONFIG = join(KIT, 'teams', 'shop', 'config.json');
const SHOP_POINTER = join(SHOP, '.teamrig.json');
const SHOP_EXCLUDE = join(SHOP, '.git', 'info', 'exclude');
const ADDED = `.teamrig.json to ${SHOP_EXCLUDE}: git ignores it in this clone only, as the team it names exists on this machine only`;
const FOLDERS = new FakePathProbe({ folders: [SHOP, APP] });
const CREATE = ['team', 'create', 'shop', '--sessions', 'api,web', '--project', SHOP];
const NEXT = 'Next: teamrig add --session lead --owner <id> --priority p<n> --title "<first task>" --description "<what and why>" for each session, then teamrig open <id> for each.';
const SETTINGS = join(USER_HOME, '.claude', 'settings.json');
const TITLE_SWITCH = `add "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1" to "env" in ${SETTINGS} and restart Claude Code, so it stops writing its own title over the circle (tabs of projects outside teamrig then keep the terminal's title)`;

/** What team create says of `team`'s tab status where Claude Code still writes the tab title, as the harness's empty env has it. */
function tabNote(team: string): string {
  return `NOTE each tab of team ${team} shows a colored circle before its title for what its session is doing once you ${TITLE_SWITCH}`;
}

/** Files where another process writes the shop pointer just before this run does. */
class PointerRace extends MemoryFiles {
  override async createExclusive(path: string, text: string): Promise<boolean> {
    if (path === SHOP_POINTER) {
      await super.createExclusive(path, '{"team": "other"}');
    }
    return super.createExclusive(path, text);
  }
}

/** Git that gives every pointer the same answer. */
function pointerGit(answer: PointerInGit): PointerGit {
  return { state: () => answer };
}

function create(kit: CliHarness, argv: readonly string[] = CREATE, env: Record<string, string> = {}, cwd?: string): Promise<CliResult> {
  return kit.run(argv, { probe: FOLDERS, env, ...(cwd === undefined ? {} : { cwd }) });
}

describe('teamrig team create', () => {
  it('writes the config and the pointer, and the new team works at once', async () => {
    const kit = new CliHarness(null, null);
    const result = await create(kit);
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [`CREATED ${SHOP_CONFIG}`, `CREATED ${SHOP_POINTER}`, tabNote('shop'), 'Team shop: lead lead, sessions api, web.', NEXT],
      stderr: [],
    });
    assert.deepEqual(JSON.parse((await kit.files.read(SHOP_CONFIG)) ?? ''), {
      configVersion: CONFIG_VERSION,
      team: { id: 'shop' },
      sessions: ['lead', 'api', 'web'],
      roles: { lead: 'lead' },
      tabStatus: { enabled: true },
    });
    assert.deepEqual(JSON.parse((await kit.files.read(SHOP_POINTER)) ?? ''), { team: 'shop' });
    const who = await kit.run(['who'], { cwd: join(SHOP, 'src') });
    assert.deepEqual(who.stdout, ['lead shop-lead (lead)', 'api shop-api', 'web shop-web']);
  });

  it('writes nothing and succeeds when run again with the same team', async () => {
    const kit = new CliHarness(null, null);
    await create(kit);
    const again = await create(kit, ['team', 'create', 'shop', '--sessions', 'web, lead ,api', '--project', SHOP]);
    assert.deepEqual(again.stdout, [
      `UNCHANGED ${SHOP_CONFIG}: team shop already has these sessions`,
      `UNCHANGED ${SHOP_POINTER}: the project is already tied to team shop`,
      tabNote('shop'),
      'Team shop: lead lead, sessions web, api.',
      NEXT,
    ]);
    assert.equal(again.code, EXIT.ok);
  });

  it('prints what it would write on a dry run, and writes nothing', async () => {
    const kit = new CliHarness(null, null);
    const result = await create(kit, [...CREATE, '--dry-run', '--lead', 'boss']);
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, [
      'DRY RUN nothing is written',
      `WOULD CREATE ${SHOP_CONFIG}:`,
      '{',
      `  "configVersion": ${CONFIG_VERSION},`,
      '  "team": {',
      '    "id": "shop"',
      '  },',
      '  "sessions": [',
      '    "boss",',
      '    "api",',
      '    "web"',
      '  ],',
      '  "roles": {',
      '    "lead": "boss"',
      '  },',
      '  "tabStatus": {',
      '    "enabled": true',
      '  }',
      '}',
      `WOULD CREATE ${SHOP_POINTER}:`,
      '{',
      '  "team": "shop"',
      '}',
      tabNote('shop'),
    ]);
    assert.equal(await kit.files.read(SHOP_CONFIG), undefined);
    assert.equal(await kit.files.read(SHOP_POINTER), undefined);
  });

  it('keeps the new pointer out of git in this clone, and says so', async () => {
    const kit = new CliHarness(null, null);
    const result = await kit.run(CREATE, { probe: FOLDERS, pointerGit: pointerGit({ kind: 'open', exclude: SHOP_EXCLUDE }) });
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout.slice(0, 3), [`CREATED ${SHOP_CONFIG}`, `CREATED ${SHOP_POINTER}`, `ADDED ${ADDED}`]);
    assert.equal(await kit.files.read(SHOP_EXCLUDE), '.teamrig.json\n');
  });

  it('says on a dry run what it would add to the exclude file, and adds nothing', async () => {
    const kit = new CliHarness(null, null);
    const result = await kit.run([...CREATE, '--dry-run'], { probe: FOLDERS, pointerGit: pointerGit({ kind: 'open', exclude: SHOP_EXCLUDE }) });
    assert.deepEqual(result.stdout.slice(-2), [`WOULD ADD ${ADDED}`, tabNote('shop')]);
    assert.equal(await kit.files.read(SHOP_EXCLUDE), undefined);
  });

  it("keeps an earlier run's pointer out of git on a repeat, and leaves a committed or ignored one as it is", async () => {
    const kit = new CliHarness(null, null);
    await create(kit);
    const open = await kit.run(CREATE, { probe: FOLDERS, pointerGit: pointerGit({ kind: 'open', exclude: SHOP_EXCLUDE }) });
    assert.deepEqual(open.stdout.slice(1, 3), [`UNCHANGED ${SHOP_POINTER}: the project is already tied to team shop`, `ADDED ${ADDED}`]);
    assert.equal(await kit.files.read(SHOP_EXCLUDE), '.teamrig.json\n');
    const ignored = await kit.run(CREATE, { probe: FOLDERS, pointerGit: pointerGit({ kind: 'ignored' }) });
    assert.equal(ignored.stdout[2], `UNCHANGED ${SHOP_POINTER} in git: git already ignores it`);
    const tracked = await kit.run(CREATE, { probe: FOLDERS, pointerGit: pointerGit({ kind: 'tracked' }) });
    assert.equal(
      tracked.stdout[2],
      `UNCHANGED ${SHOP_POINTER} in git: it is committed, so every clone gets it; to keep it on this machine only, run git rm --cached .teamrig.json and commit`,
    );
    assert.equal(await kit.files.read(SHOP_EXCLUDE), '.teamrig.json\n', 'a kept pointer adds no second line');
  });

  it('says tab status is on where Claude Code leaves the tab title to hooks, and names what a kept config lacks', async () => {
    const kit = new CliHarness(null, null);
    const titleOff = { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' };
    const created = await create(kit, CREATE, titleOff);
    assert.equal(
      created.stdout[2],
      'TAB STATUS on: each tab of team shop shows a colored circle before its title for what its session is doing: green ready, yellow working, orange waiting on you',
    );
    await kit.files.write(SHOP_CONFIG, JSON.stringify({ configVersion: CONFIG_VERSION, team: { id: 'shop' }, sessions: ['lead', 'api', 'web'], roles: { lead: 'lead' } }));
    const kept = await create(kit, CREATE, titleOff);
    assert.equal(
      kept.stdout[2],
      `NOTE each tab of team shop shows a colored circle before its title for what its session is doing once you set "tabStatus": { "enabled": true } in ${SHOP_CONFIG}`,
    );
    assert.equal(JSON.parse((await kit.files.read(SHOP_CONFIG)) ?? '')['tabStatus'], undefined, 'a repeat leaves a kept config as it is');
  });

  it('takes the folder Claude Code started in, else the current folder', async () => {
    const fromEnv = new CliHarness(null, null);
    await create(fromEnv, ['team', 'create', 'shop', '--sessions', 'api'], { CLAUDE_PROJECT_DIR: SHOP }, APP);
    assert.notEqual(await fromEnv.files.read(SHOP_POINTER), undefined);
    const fromCwd = new CliHarness(null, null);
    await create(fromCwd, ['team', 'create', 'shop', '--sessions', 'api'], { CLAUDE_PROJECT_DIR: ' ' }, SHOP);
    assert.notEqual(await fromCwd.files.read(SHOP_POINTER), undefined);
  });

  it('refuses another team of the same id, or a project tied to another team', async () => {
    const kit = new CliHarness(TEAM);
    const sameId = await create(kit, ['team', 'create', 'app', '--sessions', 'api', '--project', SHOP]);
    assert.deepEqual(sameId.stdout, [
      `REFUSED team app already exists at ${join(KIT, 'teams', 'app', 'config.json')} with sessions lead, alpha, bravo (lead lead, no parent); choose another team name, or change that config by hand`,
    ]);
    const tied = await create(kit, ['team', 'create', 'shop', '--sessions', 'api', '--project', APP]);
    assert.deepEqual(tied.stdout, [`REFUSED ${APP} is already tied to team app by ${POINTER}; give another --project, or remove that pointer first`]);
    assert.deepEqual([sameId.code, tied.code], [EXIT.refused, EXIT.refused]);
    assert.equal(await kit.files.read(SHOP_POINTER), undefined);
    assert.equal(await kit.files.read(SHOP_CONFIG), undefined);
  });

  it('hangs a sub-team under a parent in the same project, its sessions reached through $TEAMRIG_TEAM', async () => {
    const kit = new CliHarness(TEAM);
    const web = join(KIT, 'teams', 'web', 'config.json');
    const result = await create(kit, ['team', 'create', 'web', '--sessions', 'front,back', '--parent', 'app', '--project', APP]);
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [
        `CREATED ${web}`,
        `UNCHANGED ${POINTER}: the project stays tied to team app, in the same tree as web; open web's sessions with teamrig open web/<id>`,
        tabNote('web'),
        'Team web, under team app: lead lead, sessions front, back.',
        "Next: app's lead runs teamrig add --team web --priority p<n> --title \"<first task>\" --description \"<what and why>\", then teamrig open web/lead: web's lead hands its sessions their parts and opens them.",
      ],
      stderr: [],
    });
    assert.deepEqual(JSON.parse((await kit.files.read(web)) ?? '')['team'], { id: 'web', parent: 'app' });
    assert.equal(await kit.files.read(POINTER), '{"team": "app"}');
    const who = await kit.run(['who'], { env: { TEAMRIG_TEAM: 'web' } });
    assert.deepEqual(who.stdout, ['lead web-lead (lead)', 'front web-front', 'back web-back']);
  });

  it('refuses a parent with no config, and a sub-team in a project tied to another tree', async () => {
    const kit = new CliHarness(TEAM);
    const orphan = await create(kit, ['team', 'create', 'web', '--sessions', 'front', '--parent', 'nope', '--project', SHOP]);
    assert.deepEqual(orphan.stdout, ['REFUSED parent team nope has no config; create it first with teamrig team create nope --sessions <id,id>']);
    await create(kit);
    const other = await create(kit, ['team', 'create', 'web', '--sessions', 'front', '--parent', 'app', '--project', SHOP]);
    assert.deepEqual(other.stdout, [`REFUSED ${SHOP} is already tied to team shop by ${SHOP_POINTER}; give another --project, or remove that pointer first`]);
    assert.equal(await kit.files.read(join(KIT, 'teams', 'web', 'config.json')), undefined);
  });

  it('refuses a project folder that is not there', async () => {
    const result = await create(new CliHarness(null, null), ['team', 'create', 'shop', '--sessions', 'api', '--project', 'nowhere'], {}, SHOP);
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, [`REFUSED the project folder ${join(SHOP, 'nowhere')} does not exist`]]);
  });

  it('refuses a file that appears between the check and the write', async () => {
    const files = new PointerRace();
    const result = await new CliHarness(null, null).run(CREATE, { probe: FOLDERS, files });
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, [`REFUSED ${SHOP_POINTER} appeared while the team was being set up; run the command again`]]);
    assert.equal(await files.read(SHOP_POINTER), '{"team": "other"}');
  });

  it('reads a bad command line as a usage error', async () => {
    const cases: [readonly string[], string][] = [
      [['team', 'create', 'Shop!', '--sessions', 'api'], 'team "Shop!" is not an id'],
      [['team', 'create', 'shop'], '--sessions is required'],
      [['team', 'create', 'shop', '--sessions', 'api,api'], '--sessions lists "api" twice'],
      [['team', 'create', '--sessions', 'api'], 'team create needs <team>'],
      [['team'], 'team create'],
    ];
    for (const [argv, message] of cases) {
      const result = await create(new CliHarness(null, null), argv);
      assert.equal(result.code, EXIT.usage, argv.join(' '));
      assert.ok(result.stderr[0]?.startsWith(message), result.stderr[0]);
    }
  });
});
