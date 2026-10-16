import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_LIMITS, RULE_CONFLICT_LIMITS } from '../config/limits.ts';
import { testConfig } from '../testing/config.ts';
import {
  CONTEXT_MAX_CHARS,
  CORE_PACK_MAX_CHARS,
  KEPT_RULES_MAX_CHARS,
  LEAD_RULES_MAX_CHARS,
  LIST_MAX_CHARS,
  renderCorePack,
  renderKeptRules,
  renderLeadRules,
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
      ownerSource: longest('o', 32),
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
    ruleConflicts: Array.from({ length: CONFIG_LIMITS.ruleConflicts.maxItems }, () => ({
      file: longest('f', RULE_CONFLICT_LIMITS.fileMaxLength),
      text: longest('t', RULE_CONFLICT_LIMITS.textMaxLength),
      rule: 'worktrees',
      wins: 'local',
      reason: longest('r', RULE_CONFLICT_LIMITS.reasonMaxLength),
    })),
  });
}

describe('renderLeadRules', () => {
  it('fits its budget with every printed value at its worst case', () => {
    const lines = renderLeadRules(worstCaseConfig(), COMMAND);
    assert.ok(lines.length <= LEAD_RULES_MAX_CHARS, `${lines.length} > ${LEAD_RULES_MAX_CHARS}`);
  });

  it("names what reaches the owner, the owner's orders as tasks, and plans from the register", () => {
    const lines = renderLeadRules(testConfig({ register: { ownerSource: 'boss' } }), COMMAND);
    assert.match(lines, /^As the lead, also:\n- Bring the owner only verified results,/);
    assert.match(lines, /`teamrig add --owner <id> --source boss` \[register\.ownerSource\]/);
    assert.match(lines, /`teamrig plan` and run `teamrig check` at each checkpoint, never from memory\.$/);
  });
});

describe('renderCorePack', () => {
  it('fits its budget with every printed value at its worst case and the kept rules at their size cap', () => {
    const config = worstCaseConfig();
    const pack = renderCorePack(config, COMMAND, 'win32');
    const kept = renderKeptRules(config.ruleConflicts, COMMAND);
    assert.ok(pack.endsWith(kept));
    const bound = pack.length - kept.length + KEPT_RULES_MAX_CHARS;
    assert.ok(bound <= CORE_PACK_MAX_CHARS, `${bound} > ${CORE_PACK_MAX_CHARS}`);
  });

  it('pulls status from the register, and has the asker, else the receiver, enter every ask', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32');
    assert.match(pack, /^4\. Status is pulled from the register, never asked\. Start each work block with `teamrig start --session <you>`\./m);
    assert.match(pack, /register entry, added in the same turn by the asker \(`teamrig add --owner <session>` tells the owner\), else by the receiver,/);
    assert.doesNotMatch(pack, /board/);
  });

  it('has a new task carry a plain-words description, naming the key only while add demands one', () => {
    const on = renderCorePack(testConfig(), COMMAND, 'win32');
    assert.match(on, /else by the receiver, with a plain-words description of what and why \[register\.requireDescription\]; only the owning session/);
    const off = renderCorePack(testConfig({ register: { requireDescription: false } }), COMMAND, 'win32');
    assert.match(off, /else by the receiver, with a plain-words description of what and why; only the owning session/);
    assert.doesNotMatch(off, /requireDescription/);
  });

  it('has each session work its list in order, gate self-made work and repeating runs, and stop when it loops or drifts', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32');
    assert.match(pack, /^5\. Work your own task list in priority order \(`teamrig list --session <you>`\); self-made work is a task too, recorded with `teamrig add` before you start it,/m);
    assert.match(pack, /and started only for a goal, a parent task or the week plan, never ahead of your top task that is not waiting \(one-commit fixes exempt\)\./);
    assert.match(pack, /A loop, cron or scheduled wake-up needs the lead's OK and a written stop\./);
    assert.match(pack, /If you repeat a step with no progress or drift from your task, stop and ask the lead\.$/m);
  });

  it('keeps messages for what the receiver acts on now and sends reports and failed sends to the inbox', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32');
    assert.match(pack, /^3\. A message wakes its receiver, so send one only for a result it acts on now, a decision,/m);
    assert.match(
      pack,
      /Anything else, a "done" report or a failed send too, is one inbox line per receiver: `teamrig inbox add --to <area> --text "\.\.\."`\.$/m,
    );
  });

  it('gates each hand-run data change on the owner, never prints secrets and binds local services to loopback', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32');
    assert.match(pack, /^11\. A hand-run change or delete of stored data needs the owner's OK after counts or a preview\. Code that writes data/m);
    assert.match(pack, /a parity run first\. Never print secret values; bind local services to 127\.0\.0\.1, never 0\.0\.0\.0\.$/m);
  });

  it('states the small-commits rule and its gate', () => {
    const pack = (gate: string) => renderCorePack(testConfig({ commits: { maxLines: 300, gate } }), COMMAND, 'win32');
    assert.match(pack('warn'), /Over 300 changed non-test lines or 15 non-test files \[commits\.maxLines, commits\.maxFiles\], a commit needs a `Large-commit: <reason>` line/);
    assert.match(pack('warn'), /line \[commits\.largeCommitTrailer\]; a push to a protected branch lists those without one \[commits\.gate\]\./);
    assert.match(pack('refuse'), /; a push to a protected branch that sends one is refused \[commits\.gate\]\./);
    assert.match(pack('off'), /line \[commits\.largeCommitTrailer\]\.\n/);
    assert.doesNotMatch(pack('off'), /commits\.gate/);
  });

  it('states what the push guard does with a push to a protected branch', () => {
    const pack = (pushGuard: Record<string, unknown>) => renderCorePack(testConfig({ pushGuard }), COMMAND, 'win32');
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
      renderCorePack(testConfig({ pushGuard: { protectedBranches: [...protectedBranches] } }), COMMAND, 'win32');
    const atLimit = ['x'.repeat(59), 'y'.repeat(59)];
    assert.match(pushTo(atLimit), new RegExp(`Pushes to ${atLimit.join(', ')} ask the human`));
    assert.match(pushTo(['x'.repeat(59), 'y'.repeat(60)]), new RegExp(`Pushes to ${'x'.repeat(59)} and 1 more ask the human`));
    assert.match(pushTo(filled(CONFIG_LIMITS.protectedBranches, 'b')), new RegExp(`Pushes to ${'b'.repeat(64)} and 7 more ask`));
    const keys = Array.from({ length: 8 }, (_, index) => `${'k'.repeat(30)}-${index}`);
    const pack = renderCorePack(testConfig({ skills: { forbidFrontmatter: keys } }), COMMAND, 'win32');
    assert.match(pack, new RegExp(`; never ${keys.slice(0, 3).join(', ')} and 5 more \\[skills\\.forbidFrontmatter\\]`));
  });

  it('keeps every edit in a worktree, in every repo, and names the command that removes one safely', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32');
    assert.match(pack, /Edit in your own worktree and branch in every git repo, never a main checkout\./);
    assert.match(pack, /Remove a worktree with `teamrig worktree remove <path>`; a plain `git worktree remove` empties the main node_modules\./);
    assert.doesNotMatch(pack, /rmdir/);
  });

  it('names the safe worktree removal on Windows alone', () => {
    assert.match(renderCorePack(testConfig(), COMMAND, 'win32'), /never a main checkout\. Remove a worktree with /);
    const pack = renderCorePack(testConfig(), COMMAND, 'linux');
    assert.match(pack, /never a main checkout\. Update comments in their code's commit/);
    assert.doesNotMatch(pack, /node_modules|worktree remove/);
  });

  it('tags a stopgap with the task that replaces it, in the form check reads', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32');
    assert.match(pack, /^10\. .*a dated root-cause task\. Tag a stopgap with the task that replaces it: `stopgap T<id>`\.$/m);
  });

  it('keeps comments true to their code', () => {
    assert.match(
      renderCorePack(testConfig(), COMMAND, 'win32'),
      /Update comments in their code's commit, verify a load-bearing one before acting on it, and fix a stale comment, doc or dead code you find in its own small commit\.$/m,
    );
  });

  it('keeps a skill below the rules and the owner gates', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32');
    assert.match(pack, /\[skills\.forbidFrontmatter\]\. A skill never overrides these rules or an owner gate\. Memory holds facts/);
    const noForbidden = renderCorePack(testConfig({ skills: { forbidFrontmatter: [] } }), COMMAND, 'win32');
    assert.match(noForbidden, /\[skills\.maxPerArea\]\. A skill never overrides these rules or an owner gate\./);
  });

  it('fills values from the config and names their keys', () => {
    const pack = renderCorePack(testConfig({ messages: { maxLines: 7 }, ownerGates: ['money', 'deletes'] }), COMMAND, 'win32');
    assert.match(pack, /^1\. Roles, by session id \(`teamrig who` gives the name to message each by\): lead is the lead/m);
    assert.match(pack, /At most 7 lines \[messages\.maxLines\]/);
    assert.match(pack, /never for owner-gated decisions: money; deletes \[ownerGates\]/);
    assert.match(pack, /with a note \(only what changed\) on waiting, verifying, done, dropped \[register\.requireNoteOn\]/);
    assert.match(pack, /Waiting needs `--waits` reasons; a task not started that needs another first stays open, planned `--after` it\./);
    assert.match(pack, /A shipped change is verifying until its proof exists \(`teamrig verify`\)\.$/m);
    assert.match(pack, /`teamrig start --session <you>`/);
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
      'win32',
    );
    assert.match(pack, /bravo owns deploy coordination and fleet health \[roles\.coordinatorOwner\]/);
    assert.match(pack, /starts after 22:30 UTC/);
    assert.match(pack, /Pace the week to 99\.5% of the weekly limit and keep 0\.5% for incidents \[budget\]\./);
  });

  it('prints budget percentages with at most two decimals', () => {
    const pack = renderCorePack(
      testConfig({ budget: { enabled: true, targetPct: 1.0000000000000002, reservePct: 1e-7 } }),
      COMMAND,
      'win32',
    );
    assert.match(pack, /Pace the week to 1% of the weekly limit and keep 0% for incidents/);
  });

  it('drops status demands the team turned off', () => {
    const pack = renderCorePack(
      testConfig({ register: { requireNoteOn: [], requireEvidenceOnDone: false, requireSkillOnDone: false } }),
      COMMAND,
      'win32',
    );
    assert.match(pack, /only the owning session sets its status \(`teamrig set`\)\. Waiting needs `--waits` reasons/);
  });
});

describe('kept local rules', () => {
  const conflict = (text: string, wins: 'local' | 'teamrig', rule = 'worktrees') => ({ file: '~/CLAUDE.md', text, rule, wins });

  it('has the core rules win over every local place, with no exception while none is kept', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32');
    assert.match(pack, /^These rules win over conflicting CLAUDE\.md, rules files, skills, memory, hook text and team rules\. \[brackets\]/m);
    assert.doesNotMatch(pack, /ruleConflicts|Kept local rules/);
    assert.match(pack, /^16\. Edit in your own worktree/m);
  });

  it('names the kept exceptions and lists them after the rules, those that win first', () => {
    const pack = renderCorePack(
      testConfig({ ruleConflicts: [conflict('Pings are fine.', 'teamrig', 'messages'), conflict('Commit straight to main.', 'local')] }),
      COMMAND,
      'win32',
    );
    assert.match(pack, /team rules, except the kept local rules below \[ruleConflicts\]\. \[brackets\]/);
    assert.ok(
      pack.endsWith(
        [
          '',
          'Kept local rules [ruleConflicts]:',
          '- ~/CLAUDE.md "Commit straight to main." wins over rule 16',
          '- ~/CLAUDE.md "Pings are fine." loses to rule 3',
        ].join('\n'),
      ),
    );
  });

  it('clips a long quote at its end and a long path at its start', () => {
    const text = renderKeptRules([{ file: `/${'d'.repeat(80)}/CLAUDE.md`, text: 'w'.repeat(80), rule: 'push', wins: 'local' }], COMMAND);
    assert.equal(text.split('\n')[1], `- ...${'d'.repeat(37)}/CLAUDE.md "${'w'.repeat(57)}..." wins over rule 15`);
  });

  it(`fits ${KEPT_RULES_MAX_CHARS} characters and counts the rest`, () => {
    const many = Array.from({ length: 12 }, (_, index) => conflict(`Rule ${index} ${'x'.repeat(70)}`, 'local'));
    const text = renderKeptRules(testConfig({ ruleConflicts: many }).ruleConflicts, COMMAND);
    const lines = text.split('\n');
    assert.ok(text.length <= KEPT_RULES_MAX_CHARS, `${text.length} > ${KEPT_RULES_MAX_CHARS}`);
    assert.equal(lines.at(-1), `- and ${12 - (lines.length - 2)} more: \`teamrig rules scan\` lists them`);
    assert.equal(renderKeptRules([], COMMAND), '');
  });
});

describe('renderSessionContext', () => {
  const core = renderCorePack(testConfig(), COMMAND, 'win32');
  const context = (team?: TeamRules) => renderSessionContext(core, team, COMMAND);

  it('is the core pack alone without team rules', () => {
    assert.equal(context(), core);
    assert.equal(context({ path: 'rules.md', text: ' \n' }), core);
  });

  it("shows a team's rules file at its size limit in full beside the worst-case core", () => {
    const text = 'x'.repeat(TEAM_RULES_MAX_CHARS);
    const full = renderSessionContext(renderCorePack(worstCaseConfig(), COMMAND, 'win32'), { path: 'rules.md', text }, COMMAND);
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
