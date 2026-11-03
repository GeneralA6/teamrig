import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { APP, CliHarness, SKILLS_DIR, TEAM, TEAM_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import { SUB_TEAMS, teamConfigOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';
import { UNOWNED_FORGET_AFTER_MS } from './unowned-notices.ts';

const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
/** The team's CLAUDE.md budget [contextFiles.maxClaudeMdChars], at its lowest allowed value. */
const BUDGET = 1_000;
const HEADING = /^UNOWNED 1 warning\(s\) no session owns, so they go to the lead \(lead\): /;

describe('the warnings no session owns go to the lead (T951)', () => {
  it('prints a project CLAUDE.md over its budget as unowned in check and in the lead\'s start, not in another session\'s start', async () => {
    const kit = new CliHarness({ ...TEAM, contextFiles: { maxClaudeMdChars: BUDGET } });
    await kit.holdSecretDeny();
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET));
    const within = await kit.run(['check'], AS_ALPHA);
    assert.equal(within.code, EXIT.ok, within.stderr.join('\n'));
    assert.equal(
      within.stdout.some((line) => line.startsWith('UNOWNED')),
      false,
      within.stdout.join('\n'),
    );
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET + 1));
    const runs: ReadonlyArray<readonly [readonly string[], RunOptions]> = [
      [['check'], AS_ALPHA],
      [['check', '--all'], AS_ALPHA],
      [['start'], AS_LEAD],
    ];
    for (const [argv, options] of runs) {
      const result = await kit.run([...argv], options);
      assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
      const at = result.stdout.findIndex((line) => HEADING.test(line));
      assert.notEqual(at, -1, `${argv.join(' ')}:\n${result.stdout.join('\n')}`);
      assert.match(
        result.stdout[at + 1] ?? '',
        /^ *from the context check \[contextFiles\.maxClaudeMdChars\]: WARN context-size CLAUDE\.md files \(.*CLAUDE\.md 1,001\): 1,001 characters .*\[contextFiles\.maxClaudeMdChars\]/,
      );
    }
    const alpha = await kit.run(['start'], AS_ALPHA);
    assert.equal(alpha.code, EXIT.ok, alpha.stderr.join('\n'));
    assert.equal(
      alpha.stdout.some((line) => line.startsWith('UNOWNED')),
      false,
      alpha.stdout.join('\n'),
    );
  });

  it("moves a skill's flags out of SKILLS into the lead's UNOWNED when its owner is no session on the team", async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(join(SKILLS_DIR, 'orphan', 'SKILL.md'), '---\nname: orphan\ndescription: A skill with an owner who left.\n---\nOwner: ghost\nLast verified: 2030-01-01\n');
    const lead = await kit.run(['start', '--all'], AS_LEAD);
    assert.equal(lead.code, EXIT.ok, lead.stderr.join('\n'));
    assert.equal(lead.stdout.includes(`SKILLS 0 flag(s) in ${SKILLS_DIR}`), true, lead.stdout.join('\n'));
    assert.equal(lead.stdout.includes(`from the skill check of ${SKILLS_DIR}: SKILL OWNER (owner ghost is not a session on the team) ghost orphan`), true, lead.stdout.join('\n'));
  });

  it("posts the lead one inbox line per warning from any session's start, once while it stands", async () => {
    const kit = new CliHarness({ ...TEAM, contextFiles: { maxClaudeMdChars: BUDGET } });
    await kit.holdSecretDeny();
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET + 1));
    const first = await kit.run(['start'], AS_ALPHA);
    assert.equal(first.code, EXIT.ok, first.stderr.join('\n'));
    assert.equal(first.stderr.includes('NOTE lead has 1 new inbox line(s) on warnings no session owns'), true, first.stderr.join('\n'));
    assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    const lines = await leadNotices(kit);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(
      lines[0] ?? '',
      /^- \S+ \S+ teamrig: the context check \[contextFiles\.maxClaudeMdChars\] raised a warning no session owns, so it is yours as lead: WARN context-size .*; fix it, hand it on \(teamrig add --owner <session>\) or settle the check/,
    );

    await kit.files.write(join(APP, 'CLAUDE.md'), 'x');
    assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET + 1));
    assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    assert.equal((await leadNotices(kit)).length, 1, 'a start that did not see the warning keeps it told');

    await kit.files.write(join(APP, 'CLAUDE.md'), 'x');
    kit.clock.advance(UNOWNED_FORGET_AFTER_MS);
    assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET + 1));
    assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    assert.equal((await leadNotices(kit)).length, 2, 'a warning no start saw for a day is told again when it returns');
  });

  it('posts at most five lines per start, and the rest at the next', async () => {
    const kit = new CliHarness(TEAM);
    await kit.holdSecretDeny();
    for (const name of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7']) {
      await kit.files.write(join(SKILLS_DIR, name, 'SKILL.md'), `---\nname: ${name}\ndescription: A skill with an owner who left.\n---\nOwner: ghost\nLast verified: 2030-01-01\n`);
    }
    assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    assert.equal((await leadNotices(kit)).length, 5);
    assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    assert.equal((await leadNotices(kit)).length, 7);
  });

  it('warns and goes on when another start holds the lock, so the next start tells the lead', async () => {
    const kit = new CliHarness({ ...TEAM, contextFiles: { maxClaudeMdChars: BUDGET } });
    await kit.holdSecretDeny();
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET + 1));
    await holdFileLock(kit, join(TEAM_HOME, 'state', 'unowned-notices.lock'));
    const held = await kit.run(['start'], AS_ALPHA);
    assert.equal(held.code, EXIT.ok, held.stderr.join('\n'));
    assert.match(held.stderr.join('\n'), /^WARN lead was not told of the warnings no session owns: .*unowned-notices\.lock is held by another process/m);
    assert.equal((await leadNotices(kit)).length, 0);
    await kit.files.remove(join(TEAM_HOME, 'state', 'unowned-notices.lock'));
    assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    assert.equal((await leadNotices(kit)).length, 1);
  });

  it("warns when the lead's line is refused, tells nothing, and tries again at the next start", async () => {
    const kit = new CliHarness({ ...TEAM, register: { secretPatterns: ['hush-[0-9]+'] } });
    await kit.holdSecretDeny();
    await kit.files.write(join(SKILLS_DIR, 'orphan', 'SKILL.md'), '---\nname: orphan\ndescription: A skill whose owner line holds a secret.\n---\nOwner: hush-1234\nLast verified: 2030-01-01\n');
    const refused = /^WARN lead was not told of a warning no session owns \(skill OWNER orphan\): the line looks like it holds a secret/m;
    const first = await kit.run(['start'], AS_ALPHA);
    assert.equal(first.code, EXIT.ok, first.stderr.join('\n'));
    assert.match(first.stderr.join('\n'), refused);
    assert.equal(first.stderr.some((line) => line.startsWith('NOTE ')), false, first.stderr.join('\n'));
    assert.equal((await leadNotices(kit)).length, 0);
    assert.match((await kit.run(['start'], AS_ALPHA)).stderr.join('\n'), refused);
  });
});

describe("the skill and context checks read the skills of Claude Code's folder (T1185)", () => {
  it("reads $CLAUDE_CONFIG_DIR/skills, not ~/.claude/skills, when Claude Code's folder is moved", async () => {
    const kit = new CliHarness(TEAM);
    const moved = join('/', 'cfg');
    const skill = (name: string): string => `---\nname: ${name}\ndescription: A skill with an owner who left.\n---\nOwner: ghost\nLast verified: 2030-01-01\n`;
    await kit.files.write(join(SKILLS_DIR, 'at-home', 'SKILL.md'), skill('at-home'));
    await kit.files.write(join(moved, 'skills', 'in-moved', 'SKILL.md'), skill('in-moved'));
    const lead = await kit.run(['check', '--all'], { env: { TEAMRIG_SESSION: 'lead', CLAUDE_CONFIG_DIR: moved } });
    assert.equal(lead.code, EXIT.ok, lead.stderr.join('\n'));
    const out = lead.stdout.join('\n');
    assert.equal(lead.stdout.includes(`SKILLS 0 flag(s) in ${join(moved, 'skills')}`), true, out);
    assert.match(out, /SKILL OWNER \(owner ghost is not a session on the team\) ghost in-moved/);
    assert.equal(out.includes('at-home'), false, out);
  });
});

describe('the skill check of teams of one tree that read one skills folder (T1473)', () => {
  it("leaves a skill another team's session owns to that team's check, and flags one whose team reads another folder", async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('ops'), formatConfig({ ...SUB_TEAMS['ops'], paths: { skills: join('/', 'ops-skills') } }));
    const unverified = (name: string, owner: string): string => `---\nname: ${name}\ndescription: A skill never verified.\n---\nOwner: ${owner}\n`;
    await kit.files.write(join(SKILLS_DIR, 'front-deploy', 'SKILL.md'), unverified('front-deploy', 'front'));
    await kit.files.write(join(SKILLS_DIR, 'run-restart', 'SKILL.md'), unverified('run-restart', 'run'));
    const root = await kit.run(['check', '--all'], AS_LEAD);
    assert.equal(root.code, EXIT.ok, root.stderr.join('\n'));
    const rootOut = root.stdout.join('\n');
    assert.equal(rootOut.includes('front-deploy'), false, rootOut);
    assert.match(rootOut, /SKILL OWNER \(owner run is not a session on the team\) run run-restart/);
    const web = await kit.run(['check', '--all', '--session', 'lead'], { env: { TEAMRIG_TEAM: 'web' } });
    assert.equal(web.code, EXIT.ok, web.stderr.join('\n'));
    const webOut = web.stdout.join('\n');
    assert.match(webOut, /SKILL UNVERIFIED \(no "Last verified: YYYY-MM-DD"\) front front-deploy/);
    assert.equal(
      web.stdout.some((line) => line.includes('from the skill check') && line.includes('front-deploy')),
      false,
      webOut,
    );
  });
});

/** The lead's inbox lines on warnings no session owns. */
async function leadNotices(kit: CliHarness): Promise<string[]> {
  const text = (await kit.files.read(join(TEAM_HOME, 'state', 'inbox', 'lead.md'))) ?? '';
  return text.split('\n').filter((line) => line.includes('raised a warning no session owns'));
}
