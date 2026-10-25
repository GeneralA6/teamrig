import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { pathKey } from './paths.ts';
import { pointerTeam, resolveTeam, TEAM_POINTER } from './team.ts';

const WORK = resolve('/work');
const APP = join(WORK, 'app');
const DEEP = join(APP, 'src', 'core');
const OTHER = resolve('/elsewhere', 'project');

function pointer(dir: string): string {
  return join(dir, TEAM_POINTER);
}

/** Counts reads, and fails one path the way a folder named like the pointer fails. */
class WatchedFiles extends MemoryFiles {
  readonly reads: string[] = [];
  unreadable: string | undefined;

  override async read(path: string): Promise<string | undefined> {
    this.reads.push(path);
    if (path === this.unreadable) {
      throw Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' });
    }
    return super.read(path);
  }
}

describe('resolveTeam', () => {
  it('takes $TEAMRIG_TEAM before any pointer, trimmed', async () => {
    const files = new MemoryFiles({ [pointer(APP)]: '{"team":"app"}' });
    assert.deepEqual(await resolveTeam(files, { TEAMRIG_TEAM: ' ops ' }, [APP]), { kind: 'team', team: 'ops', from: '$TEAMRIG_TEAM' });
  });

  it('ignores a blank $TEAMRIG_TEAM', async () => {
    const files = new MemoryFiles({ [pointer(APP)]: '{"team":"app"}' });
    assert.deepEqual(await resolveTeam(files, { TEAMRIG_TEAM: '  ' }, [APP]), { kind: 'team', team: 'app', from: pointer(APP) });
  });

  it('reports a $TEAMRIG_TEAM that is not an id', async () => {
    const found = await resolveTeam(new MemoryFiles(), { TEAMRIG_TEAM: 'Ops Team' }, [APP]);
    assert.equal(found.kind, 'broken');
    assert.match(found.kind === 'broken' ? `${found.from} ${found.problem}` : '', /^\$TEAMRIG_TEAM "Ops Team" is not a team id/);
  });

  it("pointerTeam reads the folder's pointer, never $TEAMRIG_TEAM, for a command asked about a project", async () => {
    const files = new MemoryFiles({ [pointer(APP)]: '{"team":"app"}' });
    assert.deepEqual(await pointerTeam(files, [DEEP]), { kind: 'team', team: 'app', from: pointer(APP) });
    assert.deepEqual(await pointerTeam(files, [OTHER]), { kind: 'none' });
  });

  it('finds the nearest pointer walking up from the folder', async () => {
    const files = new MemoryFiles({ [pointer(WORK)]: '{"team":"work"}', [pointer(APP)]: '{"team":"app","note":"kept for later"}' });
    assert.deepEqual(await resolveTeam(files, {}, [DEEP]), { kind: 'team', team: 'app', from: pointer(APP) });
    assert.deepEqual(await resolveTeam(files, {}, [join(WORK, 'site')]), { kind: 'team', team: 'work', from: pointer(WORK) });
  });

  it('tries the next folder when nothing above the first names a team', async () => {
    const files = new MemoryFiles({ [pointer(APP)]: '{"team":"app"}' });
    assert.deepEqual(await resolveTeam(files, {}, [OTHER, DEEP]), { kind: 'team', team: 'app', from: pointer(APP) });
  });

  it('finds no team outside every team project', async () => {
    assert.deepEqual(await resolveTeam(new MemoryFiles(), {}, [DEEP, OTHER]), { kind: 'none' });
    assert.deepEqual(await resolveTeam(new MemoryFiles(), {}, []), { kind: 'none' });
  });

  it('reads each folder once, up to the root, across all starts', async () => {
    const files = new WatchedFiles();
    await resolveTeam(files, {}, [DEEP, APP, join(WORK, 'site')]);
    assert.equal(new Set(files.reads).size, files.reads.length);
    assert.ok(files.reads.includes(pointer(resolve('/'))));
  });

  it('never reads one folder twice in two spellings the platform treats as the same', async () => {
    const files = new WatchedFiles();
    await resolveTeam(files, {}, [APP, APP.toUpperCase(), `${APP}${sep}`]);
    assert.equal(new Set(files.reads.map((read) => pathKey(read))).size, files.reads.length);
  });

  it('reports a pointer it cannot use, with the path to fix', async () => {
    const cases: ReadonlyArray<readonly [string, RegExp]> = [
      ['team: app', /is not JSON/],
      ['["app"]', /has no "team" text/],
      ['{"team":7}', /has no "team" text/],
      ['{"team":"../app"}', /"\.\.\/app" is not a team id/],
    ];
    for (const [text, problem] of cases) {
      const found = await resolveTeam(new MemoryFiles({ [pointer(APP)]: text }), {}, [DEEP]);
      assert.equal(found.kind, 'broken', text);
      assert.equal(found.kind === 'broken' ? found.from : undefined, pointer(APP));
      assert.match(found.kind === 'broken' ? found.problem : '', problem, text);
    }
  });

  it('reports a pointer path that cannot be read instead of throwing', async () => {
    const files = new WatchedFiles();
    files.unreadable = pointer(APP);
    const found = await resolveTeam(files, {}, [DEEP]);
    assert.deepEqual(found, { kind: 'broken', from: pointer(APP), problem: 'cannot be read (EISDIR: illegal operation on a directory, read)' });
  });
});
