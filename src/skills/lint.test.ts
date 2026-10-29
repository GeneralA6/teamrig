import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import type { SkillScript } from './grants.ts';
import { areaOf, descriptionOf, formatSkillFlag, frontmatterValue, lintSkills, type SkillFile } from './lint.ts';

const NOW = new Date('2030-03-01T12:00:00Z');
const team = testConfig({ sessions: ['lead', 'alpha', 'alpha-ops', 'bravo'] });
/** No other team of the tree reads the skills folder. */
const NONE: ReadonlySet<string> = new Set();

interface SkillParts {
  readonly front?: string;
  readonly owner?: string | null;
  readonly verified?: string | null;
  readonly grants?: string;
  readonly scripts?: readonly SkillScript[];
}

function skill(name: string, parts: SkillParts = {}): SkillFile {
  const front = parts.front ?? `name: ${name}\ndescription: Use when the nightly job fails.`;
  const owner = parts.owner === undefined ? 'alpha' : parts.owner;
  const verified = parts.verified === undefined ? '2030-02-20' : parts.verified;
  const grants = parts.grants === undefined ? [] : [`Grants: ${parts.grants}`];
  const body = ['# Steps', owner === null ? '' : `Owner: ${owner}`, verified === null ? '' : `Last verified: ${verified}`, ...grants];
  return { name, text: `---\r\n${front.replaceAll('\n', '\r\n')}\r\n---\r\n${body.join('\r\n')}\r\n`, scripts: parts.scripts ?? [] };
}

function lint(...skills: SkillFile[]): string[] {
  return lintSkills(skills, NOW, team, NONE).map(formatSkillFlag);
}

describe('lintSkills', () => {
  it('passes a skill that follows the rules', () => {
    assert.deepEqual(lint(skill('alpha-nightly')), []);
  });

  it('flags a missing or unknown owner', () => {
    assert.deepEqual(lint(skill('alpha-a', { owner: null }), skill('alpha-b', { owner: 'zulu' })), [
      'SKILL OWNER (no "Owner: <session>" line) - alpha-a',
      'SKILL OWNER (owner zulu is not a session on the team) zulu alpha-b',
    ]);
  });

  it("leaves a skill another tree team's session owns to that team's check: no flag here, no count in an area", () => {
    // T1473: the root team's check flagged a child team session's skill, which the child team's own check lints too.
    const elsewhere = new Set(['pixel', 'alpha']);
    const pixel = Array.from({ length: 9 }, (_, index) => skill(`pixel-s${index}`, { owner: 'pixel', verified: null }));
    const flags = lintSkills([...pixel, skill('alpha-a', { verified: null }), skill('alpha-b', { owner: 'zulu' })], NOW, team, elsewhere).map(formatSkillFlag);
    assert.deepEqual(flags, [
      'SKILL UNVERIFIED (no "Last verified: YYYY-MM-DD") alpha alpha-a',
      'SKILL OWNER (owner zulu is not a session on the team) zulu alpha-b',
    ]);
  });

  it('reads an owner line that ends like a sentence, and keeps a dot inside a name', () => {
    assert.deepEqual(lint(skill('alpha-a', { owner: 'alpha.' }), skill('alpha-b', { owner: 'alpha;' })), []);
    assert.deepEqual(lint(skill('alpha-c', { owner: 'al.pha' })), ['SKILL OWNER (owner al.pha is not a session on the team) al.pha alpha-c']);
  });

  it('flags a skill never verified or verified too long ago', () => {
    assert.deepEqual(lint(skill('alpha-a', { verified: null }), skill('alpha-b', { verified: '2030-01-29' }), skill('alpha-c', { verified: '2030-01-30' })), [
      'SKILL UNVERIFIED (no "Last verified: YYYY-MM-DD") alpha alpha-a',
      'SKILL UNVERIFIED (last verified 2030-01-29, 31 d ago > 30) alpha alpha-b',
    ]);
  });

  it('flags a note after the verified date, the line parallel runs both rewrite, and allows the sentence end', () => {
    const logged = skill('alpha-a', { verified: '2030-02-20 (T12: the build passed; T13: wrap long lines first)' });
    const sentence = { name: 'alpha-b', scripts: [], text: '---\ndescription: ok\n---\nOwner: alpha. Last verified: 2030-02-20.\n' };
    const bold = { name: 'alpha-c', scripts: [], text: '---\ndescription: ok\n---\nOwner: alpha\n**Last verified: 2030-02-20**\n' };
    assert.deepEqual(lint(logged, sentence, bold), [
      'SKILL VERIFIED-NOTE (text after the "Last verified:" date: keep the date alone, a lesson on its own line) alpha alpha-a',
    ]);
    const stale = lintSkills([skill('alpha-d', { verified: '2030-01-01 by bravo' })], NOW, team, NONE).map((flag) => flag.kind);
    assert.deepEqual(stale, ['UNVERIFIED', 'VERIFIED-NOTE']);
  });

  it('flags forbidden frontmatter keys but not the same words in the body', () => {
    const front = 'name: alpha-a\ndescription: Use when needed.\nallowed-tools: Bash';
    assert.deepEqual(lint(skill('alpha-a', { front }), { name: 'alpha-b', scripts: [], text: '---\ndescription: ok\n---\nallowed-tools: none\nOwner: alpha\nLast verified: 2030-02-20\n' }), [
      'SKILL FORBIDDEN-KEY (allowed-tools is not allowed in a team skill: remove it) alpha alpha-a',
    ]);
  });

  it('flags a missing or wordy description', () => {
    const wordy = `description: ${Array.from({ length: 31 }, (_, index) => `w${index}`).join(' ')}`;
    assert.deepEqual(lint(skill('alpha-a', { front: 'name: alpha-a' }), skill('alpha-b', { front: wordy }), { name: 'alpha-c', scripts: [], text: 'no frontmatter\nOwner: alpha\nLast verified: 2030-02-20' }), [
      'SKILL DESCRIPTION (no description) alpha alpha-a',
      'SKILL DESCRIPTION (31 words > 30) alpha alpha-b',
      'SKILL DESCRIPTION (no description) alpha alpha-c',
    ]);
  });

  it('flags a Signature line that is not a valid regex, and passes a valid one', () => {
    const signed = (name: string, source: string): SkillFile => ({ name, scripts: [], text: `${skill(name).text}Signature: \`${source}\`\r\n` });
    assert.deepEqual(lint(signed('alpha-a', 'teamrig (inbox read'), signed('alpha-b', 'teamrig inbox read')), [
      'SKILL SIGNATURE ("Signature: `teamrig (inbox read`" is not a valid regex, so the scorecard misses its uses) alpha alpha-a',
    ]);
  });

  it('flags each privileged call kind a script makes that no Grants line names, and passes a granted one', () => {
    // T746: a node script ran kubectl exec with a key from the pod env; auto mode judged only `node <script>`.
    const flow: SkillScript = {
      name: 'flow-list.js',
      text: `execFileSync('kubectl', ['exec', '-n', 'apps', 'deploy/worker', '--', 'sh', '-c', \`wget --header "x-service-key: $SERVICE_KEY" '\${url}'\`]);`,
    };
    const tail = 'which auto mode does not see: with the owner\'s grant add';
    assert.deepEqual(lint(skill('alpha-a', { scripts: [flow] }), skill('alpha-b', { scripts: [flow], grants: 'pod-exec, secret-read auth-header' })), [
      `SKILL GRANT (pod-exec in flow-list.js, ${tail} "Grants: pod-exec", else drop the call) alpha alpha-a`,
      `SKILL GRANT (secret-read in flow-list.js, ${tail} "Grants: secret-read", else drop the call) alpha alpha-a`,
      `SKILL GRANT (auth-header in flow-list.js, ${tail} "Grants: auth-header", else drop the call) alpha alpha-a`,
    ]);
  });

  it('flags a Grants word that names no kind', () => {
    assert.deepEqual(lint(skill('alpha-a', { grants: 'pod-exec kubectl' })), [
      'SKILL GRANT ("Grants: kubectl" names no grant kind: use pod-exec, secret-read, auth-header) alpha alpha-a',
    ]);
  });

  it('counts skills per area, keeping hyphenated session names whole', () => {
    const alpha = Array.from({ length: 9 }, (_, index) => skill(`alpha-s${index}`));
    const ops = Array.from({ length: 8 }, (_, index) => skill(`alpha-ops-s${index}`, { owner: 'alpha-ops' }));
    const shared = Array.from({ length: 9 }, (_, index) => skill(`team-s${index}`));
    assert.deepEqual(lint(...alpha, ...ops, ...shared), [
      'SKILL AREA-OVER-LIMIT (9 skills > 8: merge before adding) alpha alpha',
      'SKILL AREA-OVER-LIMIT (9 skills > 8: merge before adding) - team',
    ]);
  });

  it('takes its limits from the config', () => {
    const strict = testConfig({ skills: { maxDescriptionWords: 5, forbidFrontmatter: ['model'] } });
    const front = 'description: one two three four five six\nmodel: haiku';
    const flags = lintSkills([skill('alpha-a', { front })], NOW, strict, NONE).map((flag) => flag.kind);
    assert.deepEqual(flags, ['FORBIDDEN-KEY', 'DESCRIPTION']);
  });
});

describe('descriptionOf', () => {
  it('reads inline, quoted and block descriptions', () => {
    assert.equal(descriptionOf('description: plain text'), 'plain text');
    assert.equal(descriptionOf('description: "quoted: text"'), 'quoted: text');
    assert.equal(descriptionOf('description: >\n  folded\n  lines\nname: x'), 'folded lines');
    assert.equal(descriptionOf('description: |-\n'), null);
    assert.equal(descriptionOf('name: x'), null);
  });
});

describe('frontmatterValue', () => {
  it("reads the named key's value, never one whose name only starts with it", () => {
    const front = 'names: many\nname: code-reader\ntools: Read, Grep\ndescription: >\n  reads';
    assert.deepEqual(['name', 'tools', 'description', 'model'].map((key) => frontmatterValue(front, key)), ['code-reader', 'Read, Grep', 'reads', null]);
  });
});

describe('areaOf', () => {
  it('prefers the longest matching area and falls back to the first word', () => {
    assert.equal(areaOf('alpha-ops-deploy', ['alpha', 'alpha-ops', 'team']), 'alpha-ops');
    assert.equal(areaOf('alpha-deploy', ['alpha', 'alpha-ops']), 'alpha');
    assert.equal(areaOf('misc-notes', ['alpha']), 'misc');
  });
});
