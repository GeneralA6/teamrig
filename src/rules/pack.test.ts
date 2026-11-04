import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_LIMITS, RULE_CONFLICT_LIMITS } from '../config/limits.ts';
import { HOOK_ASKS, PUSH_TO_PROTECTED, type ConflictWinner, type HookAsks, type PushToProtected } from '../config/types.ts';
import { FOLLOWUP_STATUSES, TASK_STATUSES } from '../register/model.ts';
import { testConfig } from '../testing/config.ts';
import { RULES_CLOCK } from '../testing/zone.ts';
import { CORE_RULE_KEYS, type CoreRuleKey } from './keys.ts';
import {
  CONTEXT_MAX_CHARS,
  CORE_PACK_MAX_CHARS,
  coreRuleTexts,
  KEPT_RULES_MAX_CHARS,
  LEAD_RULES_MAX_CHARS,
  LIST_MAX_CHARS,
  renderCorePack,
  renderKeptRules,
  renderLeadRules,
  renderSessionContext,
  TEAM_RULES_MAX_CHARS,
  teamRulesPart,
  type KeptRule,
  type TeamRules,
} from './pack.ts';

const COMMAND = 'teamrig';
/** A delivery repository that `teamrig deploy` deploys. */
const DEPLOYED_REPO = { mainCheckout: 'C:/src/app', deploy: { targets: ['api'], command: ['node', 'deploy.js'] } };
const longest = (letter: string, length: number) => letter.repeat(length);
const filled = (limit: { readonly maxItems: number; readonly maxLength: number }, letter: string) =>
  Array.from({ length: limit.maxItems }, () => longest(letter, limit.maxLength));

/**
 * How the push and message rules are worded: the budget spec tries every combination, as which is longest changes
 * with the wording.
 */
interface Wording {
  readonly pushToProtected: PushToProtected;
  readonly hookAsks: HookAsks;
  readonly wakeEnabled: boolean;
}

/** Every printed value at its longest: names, lists, numbers and the optional rules all on. */
function worstCaseConfig(wording: Wording = { pushToProtected: 'ask', hookAsks: 'refuse', wakeEnabled: true }) {
  const lead = longest('l', 32);
  const delivery = longest('c', 32);
  return testConfig({
    // Its mark and offset, `ACWST` and `UTC+8:45`, print widest of every zone's, in either season.
    timeZone: 'Australia/Eucla',
    sessions: [lead, delivery],
    roles: { lead, deliveryOwner: delivery },
    ownerGates: filled(CONFIG_LIMITS.ownerGates, 'g'),
    messages: { maxLines: CONFIG_LIMITS.maxLines.max },
    register: {
      requireNoteOn: [...TASK_STATUSES].sort((a, b) => b.length - a.length).slice(0, CONFIG_LIMITS.requireNoteOn.maxItems),
      requireEvidenceOnDone: true,
      requireSkillOnDone: true,
      requireFollowupsOn: FOLLOWUP_STATUSES.slice(0, CONFIG_LIMITS.requireFollowupsOn.maxItems),
      ownerSource: longest('o', 32),
    },
    skills: {
      sharedPrefix: longest('s', 32),
      maxDescriptionWords: CONFIG_LIMITS.maxDescriptionWords.max,
      maxPerArea: CONFIG_LIMITS.maxPerArea.max,
      maxVerifiedAgeDays: CONFIG_LIMITS.maxVerifiedAgeDays.max,
      forbidFrontmatter: filled(CONFIG_LIMITS.forbidFrontmatter, 'k'),
    },
    pushGuard: { protectedBranches: filled(CONFIG_LIMITS.protectedBranches, 'b'), pushToProtected: wording.pushToProtected },
    prompts: { hookAsks: wording.hookAsks },
    wake: { enabled: wording.wakeEnabled },
    commits: { maxLines: CONFIG_LIMITS.commitMaxLines.max, maxFiles: CONFIG_LIMITS.commitMaxFiles.max, largeCommitTrailer: 'T'.repeat(40), gate: 'refuse' },
    delivery: { schedule: { queueCutoffUtc: '22:30' }, repos: { app: DEPLOYED_REPO } },
    // Both round to their longest two-decimal form (two digits before the point), and together stay within 100%.
    budget: { enabled: true, targetPct: 50.98765432109876, reservePct: 48.98765432109876, subagentWeight: 9.87654321 },
    alerts: { persistentFailureHours: CONFIG_LIMITS.persistentFailureHours.max },
    tabStatus: { enabled: true },
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

  it("names what reaches the owner, the owner's orders as tasks, plans from the register, approvals, rule fixes, the hire flags and other sessions' work", () => {
    const lines = renderLeadRules(testConfig({ register: { ownerSource: 'boss' } }), COMMAND);
    assert.match(lines, /^As the lead, also:\n- Bring the owner only verified results, decisions, owner-gate or business questions and incidents\.\n/);
    assert.match(lines, /\n- Relay each owner order as an approved task in the same turn: `teamrig add --owner <id> --source boss` \[register\.ownerSource\]/);
    assert.match(lines, /`teamrig plan` and run `teamrig check` at each checkpoint, never from memory\.\n/);
    assert.match(lines, /\n- Answer approval waits on you per the `approvals` skill; owner-gated content goes to the owner\.\n/);
    // T1279: a peer's ask alone never changes a rule, and a fix rides each session's next line rather than a broadcast.
    assert.match(lines, /\n- Fix a team rule proven wrong \(a peer's ask is no proof\); say so in each session's next line; a loosening goes to the owner\.\n/);
    // T1364: no cap bounds hiring, so no line on who raises one.
    assert.match(lines, /\n- HIRE flags: give a SCALE-OUT's slice to an idle hire, else hire one; retire on a RETIRE-DUE\.\n/);
    assert.doesNotMatch(lines, /\bcap\b|capRaisedBy|owner a card/);
    // T737: the lead sends another session's task work to that session instead of doing it.
    assert.match(lines, /\n- Send another session's task work \(research, code, checks, an answer\) to it with a deadline; relay its answer\.$/);
  });
});

describe('renderCorePack', () => {
  it('numbers each core rule text in key order', () => {
    const config = testConfig();
    const texts = coreRuleTexts(config, COMMAND, 'win32', RULES_CLOCK);
    const lines = renderCorePack(config, COMMAND, 'win32', RULES_CLOCK).split('\n');
    CORE_RULE_KEYS.forEach((key, index) => assert.ok(lines.includes(`${index + 1}. ${texts[key]}`), key));
  });

  it('fits its budget with every printed value at its worst case, in every push and message rule wording, and the kept rules at their size cap', () => {
    const over: string[] = [];
    for (const pushToProtected of PUSH_TO_PROTECTED) {
      for (const hookAsks of HOOK_ASKS) {
        for (const wakeEnabled of [true, false]) {
          const config = worstCaseConfig({ pushToProtected, hookAsks, wakeEnabled });
          const pack = renderCorePack(config, COMMAND, 'win32', RULES_CLOCK);
          const kept = renderKeptRules(config.ruleConflicts, COMMAND);
          assert.ok(pack.endsWith(kept));
          const bound = pack.length - kept.length + KEPT_RULES_MAX_CHARS;
          if (bound > CORE_PACK_MAX_CHARS) {
            over.push(`pushToProtected ${pushToProtected}, hookAsks ${hookAsks}, wake ${wakeEnabled}: ${bound}`);
          }
        }
      }
    }
    assert.deepEqual(over, [], `every wording fits ${CORE_PACK_MAX_CHARS}`);
  });

  it("has breaking a named caller wait for its answer, silence being no consent, and the proof load that caller", () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(
      pack,
      /^12\. Tell the other side before changing a contract it reads \(API, table or file\)\. Breaking a caller you named waits for its answer or its leader's: silence is no consent, and the proof loads that caller\. The same external failure/m,
    );
  });

  it('pulls status from the register, and has the asker, else the receiver, enter every ask', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /^4\. Status is pulled from the register, never asked\. Start each work block with `teamrig start --session <you>`\./m);
    assert.match(pack, /register entry, added in the same turn by the asker \(`teamrig add --owner <session>` tells the owner\), else by the receiver,/);
    assert.doesNotMatch(pack, /board/);
  });

  it('has a new task carry a plain-words description, naming the register keys once while any demand is on', () => {
    const on = renderCorePack(testConfig({ register: { requireNoteOn: [], requireEvidenceOnDone: false, requireSkillOnDone: false, requireFollowupsOn: [] } }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(on, /else by the receiver, with a plain-words description of what and why; only the owning session sets its status \(`teamrig set`\) \[register\]\. /);
    const off = renderCorePack(
      testConfig({ register: { requireDescription: false, requireNoteOn: [], requireEvidenceOnDone: false, requireSkillOnDone: false, requireFollowupsOn: [] } }),
      COMMAND,
      'win32',
      RULES_CLOCK,
    );
    assert.match(off, /else by the receiver, with a plain-words description of what and why; only the owning session sets its status \(`teamrig set`\)\. /);
    assert.doesNotMatch(off, /\[register/);
  });

  it('lists each status demand the register enforces, under one [register] key', () => {
    const pack = renderCorePack(
      testConfig({ register: { requireDescription: false, requireNoteOn: ['waiting', 'done'], requireEvidenceOnDone: true, requireSkillOnDone: true, requireFollowupsOn: ['done'] } }),
      COMMAND,
      'win32',
      RULES_CLOCK,
    );
    assert.match(
      pack,
      /only the owning session sets its status \(`teamrig set`\), with a note \(only what changed\) on waiting, done, evidence and --skill <name>\|none on done, --followups <tasks it leaves>\|none on done \[register\]\. /,
    );
    assert.doesNotMatch(pack, /register\.require/);
  });

  it('has each session work its list in order, gate self-made work and repeating runs, and stop when it loops or drifts', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /^5\. Work your own task list in priority order \(`teamrig list --session <you>`\); self-made work is a task too, added with `teamrig add` before you start it,/m);
    assert.match(pack, /and started only for a goal, a parent task or the week plan, never ahead of your top task that is not waiting \(one-commit fixes exempt\)\./);
    assert.match(pack, /A loop, cron or scheduled wake-up needs the lead's OK and a written stop\./);
    assert.match(pack, /If you repeat a step with no progress or drift from your task, stop and ask your leader\.$/m);
  });

  it('wakes a peer with an inbox line for what it acts on now and keeps a message for a live back-and-forth, with wakes on', () => {
    const pack = renderCorePack(testConfig({ messages: { maxLines: 9 } }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(
      pack,
      /^3\. Wake a peer only for a result it acts on now, a decision, a blocker, a same-area conflict or an incident: `teamrig inbox add --to <id> --text "\.\.\." --wake now`;/m,
    );
    assert.match(pack, / SendMessage \(at most 9 lines \[messages\.maxLines\]\) only for live back-and-forth\. Say what happened, evidence \(numbers, ids, paths\),/);
    assert.match(pack, / No acks, thanks or progress pings; drop --wake for the rest, a "done" report too\. Write times/);
    assert.doesNotMatch(pack, /A message wakes its receiver/);
  });

  it('keeps messages for what the receiver acts on now and sends reports to the inbox, with wakes off (the failed-send hook covers a failed send)', () => {
    const pack = renderCorePack(testConfig({ wake: { enabled: false }, messages: { maxLines: 9 } }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /^3\. A message wakes its receiver, so send one only for a result it acts on now, a decision,/m);
    assert.match(pack, / At most 9 lines \[messages\.maxLines\]: what happened, evidence \(numbers, ids, paths\),/);
    assert.match(pack, /Anything else, a "done" report too, is one inbox line per receiver: `teamrig inbox add --to <area> --text "\.\.\."`\./);
    assert.doesNotMatch(pack, /--wake now/);
  });

  it("writes times on the team's clock, zone-marked, with the offset from UTC off it", () => {
    const onUtc = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(onUtc, /^3\. .* Write times on the team's clock, zone-marked \(`04:00 UTC`\) \[timeZone\]\.$/m);
    const inIsrael = renderCorePack(testConfig({ timeZone: 'Asia/Jerusalem' }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(inIsrael, /^3\. .* Write times on the team's clock, zone-marked \(`04:00 IST`, UTC\+2 now\); UTC only when UTC is the subject \[timeZone\]\.$/m);
    const summer = { ...RULES_CLOCK, now: new Date('2030-07-08T10:00:00.000Z') };
    const inSummer = renderCorePack(testConfig({ timeZone: 'America/New_York' }), COMMAND, 'win32', summer);
    assert.match(inSummer, /zone-marked \(`04:00 EDT`, UTC-4 now\);/, 'the mark and offset of the day the rules are read');
  });

  it("has only a change's own session merge, deploy, verify and fix it", () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(
      pack,
      /^2\. Own your change end to end: only the session that made it merges, deploys \(when it must run\), verifies and fixes or rolls it back; another session's change goes to its owner\.$/m,
    );
  });

  it('gates each hand-run data change on the owner, never prints secrets and binds local services to loopback', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /^11\. A hand-run change or delete of stored data needs the owner's OK after counts or a preview\. Code that writes data/m);
    assert.match(pack, /a parity run explaining each differing row; archive history and audit data before any TTL\. Never print secret values;/);
    assert.match(pack, /Never print secret values; bind local services to 127\.0\.0\.1, never 0\.0\.0\.0\.$/m);
  });

  it('states the small-commits rule and its gate', () => {
    const pack = (gate: string) => renderCorePack(testConfig({ commits: { maxLines: 300, gate } }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack('warn'), /Over 300 changed non-test lines or 15 non-test files, a commit needs a `Large-commit: <reason>` line/);
    assert.match(pack('warn'), /line; a push to a protected branch lists those without one \[commits\]\./);
    assert.match(pack('refuse'), /; a push to a protected branch that sends one is refused \[commits\]\./);
    assert.match(pack('off'), /line \[commits\]\.\n/);
    assert.doesNotMatch(pack('off'), /a push to a protected branch/);
  });

  it('states what the push guard does with a push to a protected branch', () => {
    const pack = (pushGuard: Record<string, unknown>) => renderCorePack(testConfig({ pushGuard }), COMMAND, 'win32', RULES_CLOCK);
    const keys = String.raw`\[pushGuard\]`;
    const routed = ' A route refused, blocked or prompting unexpectedly goes to the lead, never routed around or handed to another session.';
    assert.match(pack({}), new RegExp(String.raw`^15\. Pushes to main, master ask the human; force-pushing or deleting them is refused ${keys}\.${routed}$`, 'm'));
    assert.match(
      pack({ protectedBranches: ['release'], pushToProtected: 'allow' }),
      new RegExp(String.raw`^15\. Pushes to release go unasked; force-pushing or deleting them is refused ${keys}\.${routed}$`, 'm'),
    );
    assert.match(pack({ protectedBranches: [], pushToProtected: 'allow' }), new RegExp(String.raw`^15\. No branch is protected, so the push guard stops no push \[pushGuard\.protectedBranches\]\.${routed}$`, 'm'));
  });

  it("says a push to a protected branch needs the session's leader under pushToProtected lead, whatever hookAsks says (T684, T781)", () => {
    for (const hookAsks of ['ask', 'refuse']) {
      const pack = renderCorePack(testConfig({ pushGuard: { pushToProtected: 'lead' }, prompts: { hookAsks } }), COMMAND, 'win32', RULES_CLOCK);
      assert.match(pack, /^15\. Pushes to main, master ask your leader; force-pushing or deleting them is refused \[pushGuard\]\. /m, hookAsks);
    }
  });

  it('says changes go through teamrig merge under pushToProtected gated, whatever hookAsks says (T858)', () => {
    for (const hookAsks of ['ask', 'refuse']) {
      const pack = renderCorePack(testConfig({ pushGuard: { pushToProtected: 'gated' }, prompts: { hookAsks } }), COMMAND, 'win32', RULES_CLOCK);
      assert.match(pack, /^15\. Pushes to main, master use teamrig merge; force-pushing or deleting them is refused \[pushGuard\]\. /m, hookAsks);
    }
  });


  it('tells the session to record a refused route for the owner, not report it to the lead, when hook asks are off', () => {
    const pack = (pushGuard: Record<string, unknown>) => renderCorePack(testConfig({ pushGuard, prompts: { hookAsks: 'refuse' } }), COMMAND, 'win32', RULES_CLOCK);
    const waits = ' A refused or blocked route waits on approval:owner; take your next task, never route around it or hand it off.';
    assert.match(pack({}), new RegExp(String.raw`^15\. Every push to main, master is refused \[pushGuard, prompts\.hookAsks\]\.${waits}$`, 'm'));
    assert.match(pack({ pushToProtected: 'allow' }), new RegExp(String.raw`^15\. Pushes to main, master go unasked; force-pushing or deleting them is refused \[pushGuard\]\.${waits}$`, 'm'));
    assert.doesNotMatch(pack({}), /reported to the lead/);
  });

  it(`prints a branch list in full up to ${LIST_MAX_CHARS} characters, past it its first items and how many more`, () => {
    const pushTo = (protectedBranches: readonly string[]) =>
      renderCorePack(testConfig({ pushGuard: { protectedBranches: [...protectedBranches] } }), COMMAND, 'win32', RULES_CLOCK);
    const atLimit = ['x'.repeat(59), 'y'.repeat(59)];
    assert.match(pushTo(atLimit), new RegExp(`Pushes to ${atLimit.join(', ')} ask the human`));
    assert.match(pushTo(['x'.repeat(59), 'y'.repeat(60)]), new RegExp(`Pushes to ${'x'.repeat(59)} and 1 more ask the human`));
    assert.match(pushTo(filled(CONFIG_LIMITS.protectedBranches, 'b')), new RegExp(`Pushes to ${'b'.repeat(64)} and 7 more ask`));
  });

  it('keeps every edit in a worktree, in every repo, and names the command that removes one safely', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /Edit in your own worktree and branch in each repo, never a main checkout\./);
    // T1279: any removal but the command, `rm -rf` or `Remove-Item -Recurse` too, not `git worktree remove` alone.
    assert.match(pack, /Remove a worktree only with `teamrig worktree remove <path>`: any other removal may empty the main node_modules\./);
    assert.doesNotMatch(pack, /rmdir/);
  });

  it('names the safe worktree removal on Windows alone', () => {
    assert.match(renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK), /never a main checkout\. Remove a worktree only with /);
    const pack = renderCorePack(testConfig(), COMMAND, 'linux', RULES_CLOCK);
    assert.match(pack, /never a main checkout\. Comments say why/);
    assert.doesNotMatch(pack, /node_modules|worktree remove/);
  });

  it('has a comment say why plainly and name no path outside the repo (T1869)', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'linux', RULES_CLOCK);
    assert.match(pack, /^16\. .* Comments say why plainly, no path outside the repo, and change with their code or go; verify/m);
  });

  it('tags a stopgap with the task that replaces it, in the form check reads', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /^10\. .*a dated root-cause task\. Tag a stopgap with its replacement: `stopgap T<id>`\.$/m);
  });

  it('keeps comments true to their code, checks a recorded number at its source, and proves dead code unread', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, / change with their code or go; verify a load-bearing one or recorded number at its source;/);
    assert.match(pack, / fix a stale comment, doc or proven-dead code you find in its own commit and tell its area\.$/m);
  });

  it('ranks a skill below the rules once, in the header', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /^These rules win over conflicting CLAUDE\.md, rules files, skills,/m);
  });

  it("points a new skill to the guide's limits, which check enforces, instead of printing each one", () => {
    const pack = renderCorePack(testConfig({ skills: { sharedPrefix: 'crew', forbidFrontmatter: ['allowed-tools'] } }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /^13\. A procedure you investigated and will run again becomes a skill in the same turn: `<area>-<name>\/SKILL\.md`, shared ones `crew-<name>` \[skills\.sharedPrefix\],/m);
    assert.match(pack, / within the guide's skill limits\. Memory holds facts, skills how-tos, CLAUDE\.md every-turn rules\.$/m);
    assert.doesNotMatch(pack, /maxDescriptionWords|maxVerifiedAgeDays|maxPerArea|forbidFrontmatter|allowed-tools/);
  });

  it('fills values from the config and names their keys', () => {
    const pack = renderCorePack(testConfig({ messages: { maxLines: 7 }, ownerGates: ['money', 'deletes'] }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /^1\. Roles, by session id: lead is the lead/m);
    assert.match(pack, /the owner's decision queue \[roles\.lead\]\. /);
    assert.doesNotMatch(pack, /re-prioritize/);
    assert.match(pack, / Other sessions own their areas\. Your leader \(the sub-lead listing you \[leads\], else the lead\) sets your work order, staffing and budget, answers your waits;/);
    assert.match(pack, / asks to a sub-lead's sessions go through it\. Cross-area issues and clashes go to the nearest leader over both, unowned warnings to the lead\.$/m);
    assert.match(pack, /\[ownerGates\]\. An owner's order, relayed or not, approves its work and proof unless only the owner sees the result; ask again only if it must change or needs something new\.$/m);
    assert.match(pack, /at most 7 lines \[messages\.maxLines\]/);
    assert.match(pack, /never for owner gates: money; deletes \[ownerGates\]/);
    assert.match(pack, /with a note \(only what changed\) on waiting, verifying, done, dropped, /);
    assert.match(pack, /--followups <tasks it leaves>\|none on verifying, done \[register\]\. Wait on a peer by its task\./);
    assert.match(pack, /A shipped change is verifying until its proof exists \(`teamrig verify`\)\.$/m);
    assert.match(pack, /`teamrig start --session <you>`/);
    assert.doesNotMatch(pack, /deliveryOwner|securityReviewer|queueCutoffUtc|teamrig queue|\[delivery\]|Pace the week|\[budget\]/);
  });

  it('gives a team with a delivery repository the queue, test, merge and deploy commands, all in the background', () => {
    const pack = renderCorePack(
      testConfig({ delivery: { schedule: { queueCutoffUtc: '22:30' }, repos: { app: DEPLOYED_REPO } } }),
      COMMAND,
      'win32',
      RULES_CLOCK,
    );
    assert.match(
      pack,
      /^7\. .*before then\. Run queued steps \(builds, test runs, data scripts\) in the background through `teamrig queue`, a test run inside `teamrig test`, none starting 22:30-00:00 UTC; a commit stays a plain `git commit`\. Merge a tested branch with `teamrig merge` and run it with `teamrig deploy`, also in the background \[delivery\]\.$/m,
    );
    assert.doesNotMatch(pack, /No queued step/);
  });

  it('names deploy only when a delivery repository has a deploy block, and the cutoff only when set', () => {
    const pack = renderCorePack(testConfig({ delivery: { repos: { app: { mainCheckout: 'C:/src/app' } } } }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(
      pack,
      / a test run inside `teamrig test`; a commit stays a plain `git commit`\. Merge a tested branch with `teamrig merge`, also in the background \[delivery\]\.$/m,
    );
    assert.doesNotMatch(pack, /teamrig deploy|none starting/);
  });

  it('adds the delivery owner, security reviewer, queue cutoff and budget pacing only when configured', () => {
    const pack = renderCorePack(
      testConfig({
        roles: { lead: 'lead', deliveryOwner: 'bravo', securityReviewer: 'alpha' },
        delivery: { schedule: { queueCutoffUtc: '22:30' } },
        budget: { enabled: true },
      }),
      COMMAND,
      'win32',
      RULES_CLOCK,
    );
    assert.match(pack, /bravo owns the delivery flow and fleet health \[roles\.deliveryOwner\]\. alpha reviews privileged commands \(`teamrig exec`\) \[roles\.securityReviewer\]\. Other sessions own/);
    assert.match(pack, /No queued step \(builds, test runs, data scripts\) starts 22:30-00:00 UTC \[delivery\.schedule\.queueCutoffUtc\]\./);
    const cutoff = { delivery: { schedule: { queueCutoffUtc: '22:30' } } };
    const inIsrael = renderCorePack(testConfig(cutoff), COMMAND, 'win32', { ...RULES_CLOCK, machineZone: 'Asia/Jerusalem' });
    assert.match(inIsrael, /starts 00:30-02:00 IST \[/, "on the machine's clock, in winter");
    const summer = { ...RULES_CLOCK, now: new Date('2030-07-08T10:00:00.000Z') };
    assert.match(renderCorePack(testConfig({ ...cutoff, timeZone: 'Asia/Jerusalem' }), COMMAND, 'win32', summer), /starts 01:30-03:00 IDT \[/, "on the team's clock, in summer");
    assert.match(pack, /Pace the week to 99\.5% of the limit, 0\.5% kept for incidents \[budget\]\./);
  });

  it('has owner questions stand alone, and carry the decision marker line only while tab status shows it', () => {
    const on = renderCorePack(testConfig({ tabStatus: { enabled: true } }), COMMAND, 'win32', RULES_CLOCK);
    assert.ok(on.includes('stand alone, no bare ids; options, numbers, your pick, a `Decision needed:` line.'), on);
    const off = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.ok(off.includes('each question stands alone, no bare task ids, with options, numbers and a recommendation.'), off);
    assert.ok(!off.includes('Decision needed'), off);
  });

  it('asks the owner only on an owner gate or a business decision, however many good answers the rest has, and names staffing the leader\'s (T1194)', () => {
    const on = renderCorePack(testConfig({ tabStatus: { enabled: true } }), COMMAND, 'win32', RULES_CLOCK);
    assert.ok(on.includes(' Ask the owner only gates and business calls: '), on);
    const off = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.ok(off.includes(' Ask the owner only on owner gates and business decisions: '), off);
    for (const pack of [on, off]) {
      assert.ok(pack.includes('Your leader (the sub-lead listing you [leads], else the lead) sets your work order, staffing and budget,'), pack);
      assert.ok(!/right answer|correct answer/.test(pack), 'two good answers are no reason to ask the owner');
    }
  });

  it('prints budget percentages with at most two decimals', () => {
    const pack = renderCorePack(
      testConfig({ budget: { enabled: true, targetPct: 1.0000000000000002, reservePct: 1e-7 } }),
      COMMAND,
      'win32',
      RULES_CLOCK,
    );
    assert.match(pack, /Pace the week to 1% of the limit, 0% kept for incidents/);
  });

  it('keeps work in the session and prices a helper by budget.subagentWeight', () => {
    const weighted = renderCorePack(testConfig({ budget: { subagentWeight: 2.15 } }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(
      weighted,
      /^8\. Lean calls: batch related shell steps in one call \(each re-reads the context\)\. Work in your own session: a helper's tokens cost 2\.15x yours \[budget\.subagentWeight\], so start one only for parallel work or an independent review, never to save tokens or for a build or test you wait on; run helpers on your model and effort\. Task files go in `teamrig files T<id>`, other notes in `--notes`\.$/m,
    );
    const even = renderCorePack(testConfig({ budget: { subagentWeight: 1 } }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(even, /^8\. .* Work in your own session: start a helper only when it keeps far more tokens out of your context than it uses or truly runs in parallel,/m);
    assert.doesNotMatch(even, /subagentWeight|subagent that returns/);
  });

  it('drops status demands the team turned off, and the [register] key once add demands no description either', () => {
    const off = { requireNoteOn: [], requireEvidenceOnDone: false, requireSkillOnDone: false, requireFollowupsOn: [] };
    const pack = renderCorePack(testConfig({ register: off }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /only the owning session sets its status \(`teamrig set`\) \[register\]\. Wait on a peer by its task\./);
    const bare = renderCorePack(testConfig({ register: { ...off, requireDescription: false } }), COMMAND, 'win32', RULES_CLOCK);
    assert.match(bare, /only the owning session sets its status \(`teamrig set`\)\. Wait on a peer by its task\./);
  });

  it('prints a status the team listed twice once, and the skill and follow-up demands in one flag each', () => {
    const pack = renderCorePack(
      testConfig({
        register: { requireNoteOn: ['done', 'waiting', 'done'], requireEvidenceOnDone: false, requireSkillOnDone: true, requireFollowupsOn: ['dropped', 'done', 'dropped'] },
      }),
      COMMAND,
      'win32',
      RULES_CLOCK,
    );
    assert.match(pack, /with a note \(only what changed\) on done, waiting, --skill <name>\|none on done, /);
    assert.match(pack, /--followups <tasks it leaves>\|none on dropped, done \[register\]\./);
  });
});

describe('kept local rules', () => {
  const conflict = (text: string, wins: 'local' | 'teamrig', rule = 'worktrees') => ({ file: '~/CLAUDE.md', text, rule, wins });

  it('has the core rules win over every local place, with no exception while none is kept', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
    assert.match(pack, /^These rules win over conflicting CLAUDE\.md, rules files, skills, memory, hook text and team rules\. \[brackets\]/m);
    assert.doesNotMatch(pack, /ruleConflicts|Kept local rules/);
    assert.match(pack, /^16\. Edit in your own worktree/m);
  });

  it('names the kept exceptions and lists them after the rules, those that win first', () => {
    const pack = renderCorePack(
      testConfig({ ruleConflicts: [conflict('Pings are fine.', 'teamrig', 'messages'), conflict('Commit straight to main.', 'local')] }),
      COMMAND,
      'win32',
      RULES_CLOCK,
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

  const above = (team: string, text: string, wins: ConflictWinner, rule: CoreRuleKey): KeptRule => ({ file: '~/CLAUDE.md', text, rule, wins, team });

  it("lists the kept rules of the teams above, tagged with their team, before the team's own of the same verdict", () => {
    const pack = renderCorePack(testConfig({ ruleConflicts: [conflict('Commit straight to main.', 'local')] }), COMMAND, 'win32', RULES_CLOCK, [
      above('root', 'Pings are fine.', 'teamrig', 'messages'),
      above('mid', 'Push when green.', 'local', 'push'),
    ]);
    assert.ok(
      pack.endsWith(
        [
          'Kept local rules [ruleConflicts]:',
          '- (team mid) ~/CLAUDE.md "Push when green." wins over rule 15',
          '- ~/CLAUDE.md "Commit straight to main." wins over rule 16',
          '- (team root) ~/CLAUDE.md "Pings are fine." loses to rule 3',
        ].join('\n'),
      ),
      pack,
    );
  });

  it('shows a line a team above and the team both kept once, with the verdict of the team above', () => {
    const text = renderKeptRules([above('root', 'Commit straight to main.', 'teamrig', 'worktrees'), { file: '~/CLAUDE.md', text: 'Commit straight to main.', rule: 'worktrees', wins: 'local' }], COMMAND);
    assert.equal(text, ['Kept local rules [ruleConflicts]:', '- (team root) ~/CLAUDE.md "Commit straight to main." loses to rule 16'].join('\n'));
  });

  it('names the exception when only a team above kept a rule', () => {
    const pack = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK, [above('root', 'Commit straight to main.', 'local', 'worktrees')]);
    assert.match(pack, /team rules, except the kept local rules below \[ruleConflicts\]\. \[brackets\]/);
    assert.ok(pack.endsWith('\n- (team root) ~/CLAUDE.md "Commit straight to main." wins over rule 16'), pack);
  });
});

describe('renderSessionContext', () => {
  const core = renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK);
  const context = (...files: TeamRules[]) => renderSessionContext(core, files, COMMAND);
  const own = (text: string, path = 'rules.md'): TeamRules => ({ ancestor: undefined, path, text });
  const above = (team: string, text: string): TeamRules => ({ ancestor: team, path: `teams/${team}/rules.md`, text });
  const ROOT_TITLE = "Team app's rules (a team above yours; they win over a lower team's)";

  it('is the core pack alone without team rules', () => {
    assert.equal(context(), core);
    assert.equal(context(own(' \n')), core);
  });

  it("shows a team's rules file at its size limit in full beside the worst-case core", () => {
    const text = 'x'.repeat(TEAM_RULES_MAX_CHARS);
    const full = renderSessionContext(renderCorePack(worstCaseConfig(), COMMAND, 'win32', RULES_CLOCK), [own(text)], COMMAND);
    assert.ok(full.endsWith(`# Your team's rules\n${text}`));
    assert.ok(full.length <= CONTEXT_MAX_CHARS);
  });

  it("appends the team's rules when they fit", () => {
    assert.equal(context(own('- Ship on Fridays.\n')), `${core}\n\n# Your team's rules\n- Ship on Fridays.`);
  });

  it('points to rules that are too long, and stays inside the context cap', () => {
    const text = 'x'.repeat(TEAM_RULES_MAX_CHARS + 1);
    assert.equal(
      renderSessionContext('CORE', [own(text, 'home/rules.md')], COMMAND),
      `CORE\n\nYour team's rules are in home/rules.md (${text.length} characters; this start has room for ${TEAM_RULES_MAX_CHARS}): read them now.`,
    );
    const capped = context(own(text, `/${'p'.repeat(CONTEXT_MAX_CHARS)}`));
    assert.ok(capped.length <= CONTEXT_MAX_CHARS);
    assert.match(capped, /run `teamrig doctor`/);
  });

  it('names the room the context cap leaves when a long core, not the file, is the cause', () => {
    const long = 'c'.repeat(7_500);
    const before = `${long}\n\n# Your team's rules\n`;
    assert.equal(
      renderSessionContext(long, [own('x'.repeat(2_620))], COMMAND),
      `${long}\n\nYour team's rules are in rules.md (2620 characters; this start has room for ${CONTEXT_MAX_CHARS - before.length}): read them now.`,
    );
  });

  it('shows the teams above first, root first, each under its own heading', () => {
    assert.equal(
      context(above('app', '- Root rule.'), above('web', '- Web rule.'), own('- Own rule.')),
      [
        core,
        `# ${ROOT_TITLE}\n- Root rule.`,
        "# Team web's rules (a team above yours; they win over a lower team's)\n- Web rule.",
        "# Your team's rules\n- Own rule.",
      ].join('\n\n'),
    );
  });

  it('shares one size limit across the files, pointing to the one that no longer fits', () => {
    const root = 'r'.repeat(2_000);
    assert.equal(
      renderSessionContext('CORE', [above('app', root), own('o'.repeat(1_000))], COMMAND),
      `CORE\n\n# ${ROOT_TITLE}\n${root}\n\nYour team's rules are in rules.md (1000 characters; this start has room for ${TEAM_RULES_MAX_CHARS - 2_000}): read them now.`,
    );
  });

  it('still shows a short file below a long one that gets a pointer', () => {
    const root = 'r'.repeat(TEAM_RULES_MAX_CHARS + 250);
    assert.equal(
      renderSessionContext('CORE', [above('app', root), own('- Own rule.')], COMMAND),
      `CORE\n\n${ROOT_TITLE} are in teams/app/rules.md (${root.length} characters; this start has room for ${TEAM_RULES_MAX_CHARS}): read them now.\n\n# Your team's rules\n- Own rule.`,
    );
  });

  it('skips an empty file above', () => {
    assert.equal(context(above('app', '\n'), own('- Own rule.')), `${core}\n\n# Your team's rules\n- Own rule.`);
  });

  it('ends without a pointer when even the doctor line no longer fits', () => {
    const full = 'c'.repeat(CONTEXT_MAX_CHARS - 10);
    assert.equal(renderSessionContext(full, [own('x', `/${'p'.repeat(CONTEXT_MAX_CHARS)}`)], COMMAND), full);
  });
});

describe('teamRulesPart', () => {
  const own = (text: string): TeamRules => ({ ancestor: undefined, path: 'rules.md', text });
  const HEADING = "\n\n# Your team's rules\n";

  it('is only the text that follows a start of the given length, empty without team rules (T1376)', () => {
    assert.equal(teamRulesPart([own('- Own rule.')], 100, COMMAND), `${HEADING}- Own rule.`);
    assert.equal(teamRulesPart([], 100, COMMAND), '');
  });

  it('counts the room it names from the length of the start before it', () => {
    const used = CONTEXT_MAX_CHARS - 1_000;
    assert.equal(
      teamRulesPart([own('x'.repeat(2_000))], used, COMMAND),
      `\n\nYour team's rules are in rules.md (2000 characters; this start has room for ${1_000 - HEADING.length}): read them now.`,
    );
  });
});
