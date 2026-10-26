import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { FileBytes } from '../core/file-bytes.ts';
import { pathKey } from '../core/paths.ts';
import { claudeMemoryDir } from '../doctor/context-files.ts';
import { MANIFEST } from '../permissions/trim.ts';
import { MemoryFiles, MemoryPathProbe } from '../testing/memory-files.ts';
import { textFileBytes } from '../testing/text-file-bytes.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { BACKUP_FORMAT, manifestText, parseManifest, readManifest, type BackupManifest } from './backup-manifest.ts';
import { findSetupPlaces, sourceOfStored, teamSkillsOf, WALK_DEPTH, type SetupLocations } from './backup-places.ts';
import { backupSetup, listBackups, sha256Of, storedPath, type SetupPorts } from './backup.ts';

const CLAUDE = join('/', 'u', '.claude');
const PROJECT = join('/', 'work', 'app');
const AT: SetupLocations = { claudeDir: CLAUDE, project: PROJECT, teamSkills: undefined };
/** A team whose `paths.skills` moves its skills into its own home. */
const TEAM_HOME = join('/', 'kit', 'teams', 'app');
const TEAM_SKILLS = join(TEAM_HOME, 'skills');
const TEAM_AT: SetupLocations = { ...AT, teamSkills: TEAM_SKILLS };
const MEMORY = claudeMemoryDir(CLAUDE, PROJECT);
const ROOT = join('/', 'state', 'teamrig', 'setup-backups');
const NOW = Date.parse('2030-01-08T10:00:00Z');

/** A user and project setup, with files beside it that are not setup. */
function seeded(extra: Readonly<Record<string, string>> = {}): MemoryFiles {
  return new MemoryFiles({
    [join(CLAUDE, 'CLAUDE.md')]: 'user rules',
    [join(CLAUDE, 'settings.json')]: '{}',
    [join(CLAUDE, 'skills', 'deploy', 'SKILL.md')]: 'deploy',
    [join(CLAUDE, 'skills', 'deploy', 'node_modules', 'x', 'index.js')]: 'a package',
    [join(CLAUDE, 'skills-parked', 'old', 'SKILL.md')]: 'parked',
    [join(CLAUDE, 'history.jsonl')]: 'not setup',
    [join(CLAUDE, 'projects', 'other', 'memory', 'MEMORY.md')]: 'another project',
    [join(PROJECT, 'CLAUDE.md')]: 'project rules',
    [join(PROJECT, '.claude', 'settings.local.json')]: '{}',
    [join(PROJECT, 'api', 'CLAUDE.md')]: 'api rules',
    [join(PROJECT, 'src', 'index.ts')]: 'code',
    [join('/', 'work', 'CLAUDE.md')]: 'parent rules',
    [join(MEMORY, 'MEMORY.md')]: '- index',
    [join(MEMORY, 'notes', 'a.md')]: 'a fact',
    ...extra,
  });
}

function portsOf(files: MemoryFiles, bytes: FileBytes = textFileBytes(files)): SetupPorts {
  return { files, probe: new MemoryPathProbe(files), bytes };
}

const STORED = [
  'files/user/CLAUDE.md',
  'files/user/settings.json',
  'files/user/skills/deploy/SKILL.md',
  'files/user/skills-parked/old/SKILL.md',
  'files/project/CLAUDE.md',
  'files/project/.claude/settings.local.json',
  'files/project/api/CLAUDE.md',
  'files/parents/1/CLAUDE.md',
  'files/memory/MEMORY.md',
  'files/memory/notes/a.md',
];

describe('findSetupPlaces', () => {
  it('finds the user, project, parent and memory files and nothing beside them', async () => {
    const files = seeded();
    const places = await findSetupPlaces(portsOf(files), AT);
    assert.deepEqual(places.files.map((file) => file.stored), STORED);
    assert.deepEqual(places.files.map((file) => file.kind), ['user', 'user', 'user', 'user', 'project', 'project', 'project', 'parents', 'memory', 'memory']);
    assert.deepEqual(places.skipped, [{ path: join(CLAUDE, 'skills', 'deploy', 'node_modules'), why: 'installed packages' }]);
    assert.ok(places.absent.includes(join(CLAUDE, 'settings.local.json')));
    assert.ok(places.absent.includes(join(PROJECT, '.claude', 'skills')));
  });

  it('keeps a file two kinds name once, for the first, when the project is the home folder', async () => {
    const home = join('/', 'u');
    const files = new MemoryFiles({ [join(CLAUDE, 'settings.json')]: '{}', [join(CLAUDE, 'skills', 'a', 'SKILL.md')]: 'a' });
    const places = await findSetupPlaces(portsOf(files), { claudeDir: CLAUDE, project: home, teamSkills: undefined });
    assert.deepEqual(places.files, [
      { kind: 'user', source: join(CLAUDE, 'settings.json'), stored: 'files/user/settings.json' },
      { kind: 'user', source: join(CLAUDE, 'skills', 'a', 'SKILL.md'), stored: 'files/user/skills/a/SKILL.md' },
    ]);
  });

  it("keeps the team's own skills folder and the parked skills beside it, and nothing else of the team's home", async () => {
    const files = seeded({
      [join(TEAM_SKILLS, 'review', 'SKILL.md')]: 'review',
      [join(TEAM_HOME, 'skills-parked', 'old-team', 'SKILL.md')]: 'parked',
      [join(TEAM_HOME, 'config.json')]: '{}',
      [join(TEAM_HOME, 'register', 'tasks.jsonl')]: 'not setup',
    });
    const places = await findSetupPlaces(portsOf(files), TEAM_AT);
    assert.deepEqual(
      places.files.filter((file) => file.kind === 'team-skills').map((file) => [file.source, file.stored]),
      [
        [join(TEAM_SKILLS, 'review', 'SKILL.md'), 'files/team-skills/skills/review/SKILL.md'],
        [join(TEAM_HOME, 'skills-parked', 'old-team', 'SKILL.md'), 'files/team-skills/skills-parked/old-team/SKILL.md'],
      ],
    );
    assert.deepEqual(places.files.filter((file) => file.kind !== 'team-skills').map((file) => file.stored), STORED);
  });

  it(`walks ${WALK_DEPTH} folders deep below a named folder and records the deeper one as skipped`, async () => {
    const levels = Array.from({ length: WALK_DEPTH + 1 }, (_, index) => `l${index + 1}`);
    const files = new MemoryFiles({
      [join(CLAUDE, 'skills', ...levels.slice(0, WALK_DEPTH), 'kept.md')]: 'kept',
      [join(CLAUDE, 'skills', ...levels, 'deep.md')]: 'deep',
    });
    const places = await findSetupPlaces(portsOf(files), AT);
    assert.deepEqual(places.files.map((file) => file.stored), [`files/user/skills/${levels.slice(0, WALK_DEPTH).join('/')}/kept.md`]);
    assert.deepEqual(places.skipped, [{ path: join(CLAUDE, 'skills', ...levels), why: `deeper than ${WALK_DEPTH} folders` }]);
  });
});

describe('teamSkillsOf', () => {
  it("names the team's skills folder only when it is not Claude Code's own", () => {
    assert.equal(teamSkillsOf(undefined, CLAUDE), undefined);
    assert.equal(teamSkillsOf(join(CLAUDE, 'skills'), CLAUDE), undefined);
    assert.equal(teamSkillsOf(TEAM_SKILLS, CLAUDE), TEAM_SKILLS);
  });
});

describe('sourceOfStored', () => {
  it('maps each stored path back to its file', async () => {
    const places = await findSetupPlaces(portsOf(seeded({ [join(TEAM_SKILLS, 'review', 'SKILL.md')]: 'review' })), TEAM_AT);
    assert.ok(places.files.some((file) => file.kind === 'team-skills'));
    for (const file of places.files) {
      assert.equal(pathKey(sourceOfStored(TEAM_AT, file.stored) ?? ''), pathKey(file.source), file.stored);
    }
  });

  it('refuses a path no backup makes, so a restore never writes outside the setup', () => {
    for (const stored of ['files/user/../../etc/passwd', 'files/user', 'files/user//x', 'files/user/a\\..\\..\\b', 'files/other/x', 'copies/user/x', 'files/parents/0/CLAUDE.md', 'files/parents/9/CLAUDE.md', 'files/parents/x/CLAUDE.md', 'files/parents/1', 'files/team-skills/skills/a/SKILL.md']) {
      assert.equal(sourceOfStored(AT, stored), undefined, stored);
    }
  });

  it("refuses a team-skills path outside the team's two skills folders", () => {
    for (const stored of ['files/team-skills/config.json', 'files/team-skills/register/tasks.jsonl', 'files/team-skills', 'files/team-skills/skills/../config.json', 'files/team-skills/..']) {
      assert.equal(sourceOfStored(TEAM_AT, stored), undefined, stored);
    }
  });
});

describe('backupSetup', () => {
  it('copies each setup file into the stamped folder and writes the manifest last', async () => {
    const files = seeded();
    const result = await backupSetup(portsOf(files), AT, ROOT, NOW);
    assert.equal(result.stamp, '20300108T100000Z');
    assert.equal(result.dir, join(ROOT, '20300108T100000Z'));
    assert.equal(files.get(storedPath(result.dir, 'files/user/skills/deploy/SKILL.md')), 'deploy');
    assert.equal(files.get(storedPath(result.dir, 'files/parents/1/CLAUDE.md')), 'parent rules');
    assert.deepEqual([...result.counts], [['user', 4], ['project', 3], ['parents', 1], ['memory', 2], ['team-skills', 0]]);
    const read = await readManifest(files, result.dir);
    assert.equal(read.kind, 'read');
    const manifest = read.kind === 'read' ? read.manifest : undefined;
    assert.deepEqual(manifest, result.manifest);
    assert.equal(manifest?.createdAt, '2030-01-08T10:00:00.000Z');
    assert.deepEqual(manifest?.files.map((entry) => entry.stored), STORED);
    const deploy = manifest?.files.find((entry) => entry.stored === 'files/user/skills/deploy/SKILL.md');
    assert.deepEqual(deploy, { source: join(CLAUDE, 'skills', 'deploy', 'SKILL.md'), stored: 'files/user/skills/deploy/SKILL.md', bytes: 6, sha256: sha256Of(new TextEncoder().encode('deploy')) });
  });

  it('refuses a second backup in the same second and writes nothing more', async () => {
    const files = seeded();
    await backupSetup(portsOf(files), AT, ROOT, NOW);
    const before = await files.list(join(ROOT, '20300108T100000Z'));
    await assert.rejects(backupSetup(portsOf(files), AT, ROOT, NOW), /setup backup 20300108T100000Z already exists/);
    assert.deepEqual(await files.list(join(ROOT, '20300108T100000Z')), before);
  });

  it('counts a file gone between the walk and its copy as absent', async () => {
    const files = seeded();
    const gone = join(PROJECT, 'CLAUDE.md');
    const text = textFileBytes(files);
    const vanishing: FileBytes = { ...text, read: async (path) => (pathKey(path) === pathKey(gone) ? undefined : text.read(path)) };
    const result = await backupSetup(portsOf(files, vanishing), AT, ROOT, NOW);
    assert.equal(result.manifest.files.some((entry) => entry.source === gone), false);
    assert.ok(result.manifest.absent.includes(gone));
    assert.equal(result.counts.get('project'), 2);
  });
});

describe('parseManifest', () => {
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: '2030-01-08T10:00:00.000Z',
    claudeDir: CLAUDE,
    project: PROJECT,
    teamSkills: TEAM_SKILLS,
    files: [
      { source: join(CLAUDE, 'CLAUDE.md'), stored: 'files/user/CLAUDE.md', bytes: 3, sha256: 'a'.repeat(64) },
      { source: join(TEAM_SKILLS, 'review', 'SKILL.md'), stored: 'files/team-skills/skills/review/SKILL.md', bytes: 6, sha256: 'b'.repeat(64) },
    ],
    absent: [join(CLAUDE, 'rules')],
    skipped: [{ path: join(CLAUDE, 'skills', 'node_modules'), why: 'installed packages' }],
  };
  const [entry, teamEntry] = manifest.files;

  it('reads back the manifest it writes', () => {
    assert.deepEqual(parseManifest(manifestText(manifest)), manifest);
  });

  it('writes the fields of its format', () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      2: ['absent[]', 'claudeDir', 'createdAt', 'files[].bytes', 'files[].sha256', 'files[].source', 'files[].stored', 'format', 'project', 'skipped[].path', 'skipped[].why', 'teamSkills'],
    };
    assert.deepEqual(fieldPaths(JSON.parse(manifestText(manifest))), written[BACKUP_FORMAT]);
  });

  it('reads a format 1 manifest, made before the team skills folder, as one without it', () => {
    const files = manifest.files.slice(0, 1);
    const older = { format: 1, createdAt: manifest.createdAt, claudeDir: CLAUDE, project: PROJECT, files, absent: manifest.absent, skipped: manifest.skipped };
    assert.deepEqual(parseManifest(JSON.stringify(older)), { ...manifest, teamSkills: undefined, files });
  });

  it('refuses an edited or foreign manifest', () => {
    assert.ok(entry !== undefined && teamEntry !== undefined);
    const edited: readonly unknown[] = [
      { ...manifest, format: BACKUP_FORMAT + 1 },
      { ...manifest, format: 1 },
      { ...manifest, teamSkills: 'relative' },
      { ...manifest, teamSkills: 7 },
      { ...manifest, teamSkills: undefined },
      { ...manifest, files: [{ ...teamEntry, stored: 'files/team-skills/config.json', source: join(TEAM_HOME, 'config.json') }] },
      { ...manifest, project: 'relative' },
      { ...manifest, files: [{ ...entry, source: join('/', 'etc', 'passwd') }] },
      { ...manifest, files: [{ ...entry, stored: 'files/user/../../etc/passwd' }] },
      { ...manifest, files: [{ ...entry, sha256: 'not a hash' }] },
      { ...manifest, files: [{ ...entry, bytes: -1 }] },
      { ...manifest, skipped: [{ path: 'x' }] },
      { ...manifest, absent: 'x' },
    ];
    for (const value of edited) {
      assert.equal(parseManifest(JSON.stringify(value)), undefined, JSON.stringify(value));
    }
    assert.equal(parseManifest('{ not json'), undefined);
  });
});

describe('listBackups', () => {
  it('lists the stamped folders oldest first with their manifests, past other folders', async () => {
    const files = seeded({ [join(ROOT, 'notes', 'x.md')]: 'not a backup', [join(ROOT, '20290101T000000Z', MANIFEST)]: '{ broken' });
    const ports = portsOf(files);
    await backupSetup(ports, AT, ROOT, NOW);
    const listed = await listBackups(ports, ROOT);
    assert.deepEqual(listed.map((backup) => [backup.stamp, backup.read.kind]), [['20290101T000000Z', 'unreadable'], ['20300108T100000Z', 'read']]);
    assert.deepEqual(await listBackups(ports, join('/', 'nowhere')), []);
  });
});
