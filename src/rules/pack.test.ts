import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_LIMITS } from '../config/limits.ts';
import { testConfig } from '../testing/config.ts';
import {
  CONTEXT_MAX_CHARS,
  CORE_PACK_MAX_CHARS,
  LIST_MAX_CHARS,
  renderCorePack,
  renderSessionContext,
  TEAM_RULES_MAX_CHARS,
  type TeamRules,
} from './pack.ts';

const COMMAND = 'teamrig';
const longest = (letter: string, length: number) => letter.repeat(length);
const filled = (limit: { readonly maxItems: number; readonly maxLength: number }, letter: string) =>
  Array.from({ length: limit.maxItems }, () => longest(letter, limit.maxLength));

/** Every printed value at its longest: names, lists, numbers and the optional rules all on. */
function worstCaseConfig() {
  const lead = longest('l', 32);
  const coordinator = longest('c', 32);
  return testConfig({
    sessions: [lead, coordinator],
    roles: { lead, coordinatorOwner: coordinator },
    ownerGates: filled(CONFIG_LIMITS.ownerGates, 'g'),
    messages: { maxLines: CONFIG_LIMITS.maxLines.max },
    register: {
      requireNoteOn: Array.from({ length: CONFIG_LIMITS.requireNoteOn.maxItems }, () => 'in-progress'),
      requireEvidenceOnDone: true,
      requireSkillOnDone: true,
    },
    skills: {
      sharedPrefix: longest('s', 32),
      maxDescriptionWords: CONFIG_LIMITS.maxDescriptionWords.max,
      maxPerArea: CONFIG_LIMITS.maxPerArea.max,
      maxVerifiedAgeDays: CONFIG_LIMITS.maxVerifiedAgeDays.max,
      forbidFrontmatter: filled(CONFIG_LIMITS.forbidFrontmatter, 'k'),
    },
    pushGuard: { protectedBranches: filled(CONFIG_LIMITS.protectedBranches, 'b'), pushToProtected: 'allow' },
    commits: { maxLines: CONFIG_LIMITS.commitMaxLines.max, maxFiles: CONFIG_LIMITS.commitMaxFiles.max, largeCommitTrailer: 'T'.repeat(40), gate: 'refuse' },
    coordinator: { schedule: { heavyCutoffUtc: '22:30' } },
    // Both round to their longest two-decimal form (two digits before the point), and together stay within 100%.
    budget: { enabled: true, targetPct: 50.98765432109876, reservePct: 48.98765432109876 },
    alerts: { persistentFailureHours: CONFIG_LIMITS.persistentFailureHours.max },
  });
}

describe('renderCorePack', () => {
  it('fits its budget with every printed value at its worst case', () => {
    const pack = renderCorePack(worstCaseConfig(), COMMAND);
    assert.ok(pack.length <= CORE_PACK_MAX_CHARS, `${pack.length} > ${CORE_PACK_MAX_CHARS}`);
  });

  it('has each session work its list in order, record self-made work and stop when it loops or drifts', () => {
    const pack = renderCorePack(testConfig(), COMMAND);
    assert.match(pack, /^5\. Work your own task list in priority order \(`teamrig list --session <you>`\); self-made work is a task too, recorded with `teamrig add` before you start it\./m);
    assert.match(pack, /When you notice you are looping \(the same step again, no progress\) or drifting from your task, stop and ask the lead\.$/m);
  });

  it('keeps messages for what the receiver acts on now and sends reports and failed sends to the inbox', () => {
    const pack = renderCorePack(testConfig(), COMMAND);
    assert.match(pack, /^3\. A message wakes its receiver, so send one only for a result it acts on now, a decision,/m);
    assert.match(
      pack,
      /Anything else, a "done" report too, is one inbox line per receiver, and so is a failed send: `teamrig inbox add --to <area> --text "\.\.\."`\.$/m,
    );
  });

  it('gates each hand-run data change on the owner, never prints secrets and binds local services to loopback', () => {
    const pack = renderCorePack(testConfig(), COMMAND);
    assert.match(pack, /^11\. Each hand-run change, delete or drop of stored data needs the owner's OK, after counts or a preview\. Code that writes data/m);
    assert.match(pack, /a parity run first\. Never print secret values; bind local services to 127\.0\.0\.1, never 0\.0\.0\.0\.$/m);
  });

  it('states the small-commits rule and its gate', () => {
    const pack = (gate: string) => renderCorePack(testConfig({ commits: { maxLines: 300, gate } }), COMMAND);
    assert.match(pack('warn'), /Over 300 changed non-test lines or 15 non-test files \[commits\.maxLines, commits\.maxFiles\], a commit needs a `Large-commit: <reason>` line/);
    assert.match(pack('warn'), /line \[commits\.largeCommitTrailer\]; a push to a protected branch lists those without one \[commits\.gate\]\./);
    assert.match(pack('refuse'), /; a push to a protected branch that sends one is refused \[commits\.gate\]\./);
    assert.match(pack('off'), /line \[commits\.largeCommitTrailer\]\.\n/);
    assert.doesNotMatch(pack('off'), /commits\.gate/);
  });

  it('states what the push guard does with a push to a protected branch', () => {
    const pack = (pushGuard: Record<string, unknown>) => renderCorePack(testConfig({ pushGuard }), COMMAND);
    const keys = String.raw`\[pushGuard\]`;
    const routed = ' A refused or blocked route is reported to the lead, never routed around or handed to another session.';
    assert.match(pack({}), new RegExp(String.raw`^15\. Pushes to main, master ask the human; force-pushing or deleting them is refused ${keys}\.${routed}$`, 'm'));
    assert.match(
      pack({ protectedBranches: ['release'], pushToProtected: 'allow' }),
      new RegExp(String.raw`^15\. Pushes to release go through unasked; force-pushing or deleting them is refused ${keys}\.${routed}$`, 'm'),
    );
    assert.match(pack({ protectedBranches: [], pushToProtected: 'allow' }), new RegExp(String.raw`^15\. No branch is protected, so the push guard stops no push \[pushGuard\.protectedBranches\]\.${routed}$`, 'm'));
  });

  it(`prints a branch or frontmatter list in full up to ${LIST_MAX_CHARS} characters, past it its first items and how many more`, () => {
    const pushTo = (protectedBranches: readonly string[]) =>
      renderCorePack(testConfig({ pushGuard: { protectedBranches: [...protectedBranches] } }), COMMAND);
    const atLimit = ['x'.repeat(59), 'y'.repeat(59)];
    assert.match(pushTo(atLimit), new RegExp(`Pushes to ${atLimit.join(', ')} ask the human`));
    assert.match(pushTo(['x'.repeat(59), 'y'.repeat(60)]), new RegExp(`Pushes to ${'x'.repeat(59)} and 1 more ask the human`));
    assert.match(pushTo(filled(CONFIG_LIMITS.protectedBranches, 'b')), new RegExp(`Pushes to ${'b'.repeat(64)} and 7 more ask`));
    const keys = Array.from({ length: 8 }, (_, index) => `${'k'.repeat(30)}-${index}`);
    const pack = renderCorePack(testConfig({ skills: { forbidFrontmatter: keys } }), COMMAND);
    assert.match(pack, new RegExp(`; never ${keys.slice(0, 3).join(', ')} and 5 more \\[skills\\.forbidFrontmatter\\]`));
  });

  it('keeps every edit in a worktree, in every repo, and names the Git Bash form of the junction removal', () => {
    const pack = renderCorePack(testConfig(), COMMAND);
    assert.match(pack, /Edit in your own worktree and branch in every git repo, never a main checkout\./);
    assert.match(pack, /\(`cmd \/c rmdir`; Git Bash `cmd \/\/c`\)/);
  });

  it('fills values from the config and names their keys', () => {
    const pack = renderCorePack(testConfig({ messages: { maxLines: 7 }, ownerGates: ['money', 'deletes'] }), COMMAND);
    assert.match(pack, /^1\. Roles, by session id \(`teamrig who` gives the name to message each by\): lead is the lead/m);
    assert.match(pack, /At most 7 lines \[messages\.maxLines\]/);
    assert.match(pack, /never for owner-gated decisions: money; deletes \[ownerGates\]/);
    assert.match(pack, /with a note on waiting, verifying, done, dropped \[register\.requireNoteOn\]/);
    assert.match(pack, /Waiting needs `--waits` reasons; a task not started that needs another first stays open, planned `--after` it\./);
    assert.match(pack, /A shipped change is verifying until its proof exists\.$/m);
    assert.match(pack, /`teamrig inbox read --session <you>`/);
    assert.doesNotMatch(pack, /coordinatorOwner|heavyCutoffUtc|Pace the week|\[budget\]/);
  });

  it('adds the coordinator owner, heavy cutoff and budget pacing only when configured', () => {
    const pack = renderCorePack(
      testConfig({
        roles: { lead: 'lead', coordinatorOwner: 'bravo' },
        coordinator: { schedule: { heavyCutoffUtc: '22:30' } },
        budget: { enabled: true },
      }),
      COMMAND,
    );
    assert.match(pack, /bravo owns deploy coordination and fleet health \[roles\.coordinatorOwner\]/);
    assert.match(pack, /starts after 22:30 UTC/);
    assert.match(pack, /Pace the week to 99\.5% of the weekly limit and keep 0\.5% for incidents \[budget\]\./);
  });

  it('prints budget percentages with at most two decimals', () => {
    const pack = renderCorePack(
      testConfig({ budget: { enabled: true, targetPct: 1.0000000000000002, reservePct: 1e-7 } }),
      COMMAND,
    );
    assert.match(pack, /Pace the week to 1% of the weekly limit and keep 0% for incidents/);
  });

  it('drops status demands the team turned off', () => {
    const pack = renderCorePack(
      testConfig({ register: { requireNoteOn: [], requireEvidenceOnDone: false, requireSkillOnDone: false } }),
      COMMAND,
    );
    assert.match(pack, /only the owning session sets its status \(`teamrig set`\)\. Waiting needs `--waits` reasons/);
  });
});

describe('renderSessionContext', () => {
  const core = renderCorePack(testConfig(), COMMAND);
  const context = (team?: TeamRules) => renderSessionContext(core, team, COMMAND);

  it('is the core pack alone without team rules', () => {
    assert.equal(context(), core);
    assert.equal(context({ path: 'rules.md', text: ' \n' }), core);
  });

  it("shows a team's rules file at its size limit in full beside the worst-case core", () => {
    const text = 'x'.repeat(TEAM_RULES_MAX_CHARS);
    const full = renderSessionContext(renderCorePack(worstCaseConfig(), COMMAND), { path: 'rules.md', text }, COMMAND);
    assert.ok(full.endsWith(`# Your team's rules\n${text}`));
    assert.ok(full.length <= CONTEXT_MAX_CHARS);
  });

  it("appends the team's rules when they fit", () => {
    assert.equal(context({ path: 'rules.md', text: '- Ship on Fridays.\n' }), `${core}\n\n# Your team's rules\n- Ship on Fridays.`);
  });

  it('points to rules that are too long, and stays inside the context cap', () => {
    const text = 'x'.repeat(TEAM_RULES_MAX_CHARS + 1);
    assert.equal(
      context({ path: 'home/rules.md', text }),
      `${core}\n\nYour team's rules are in home/rules.md (${text.length} characters, more than the ${TEAM_RULES_MAX_CHARS} shown here): read them now.`,
    );
    const capped = context({ path: `/${'p'.repeat(CONTEXT_MAX_CHARS)}`, text });
    assert.ok(capped.length <= CONTEXT_MAX_CHARS);
    assert.match(capped, /run `teamrig doctor`/);
  });
});
