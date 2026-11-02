import { CORE_RULE_KEYS, ruleLabel, type CoreRuleKey } from './keys.ts';

/**
 * Words that tie a line to a topic of a core rule. They are broad on purpose: a scan shows the model every line that
 * could conflict with a rule, and the model judges which do. A miss here hides a conflict for good, while an extra
 * line costs only reading, so a word is added whenever a real conflict gets past these (none of a 30-line audit of
 * local rules that overrode the core did).
 */
const RULE_TOPICS: Readonly<Record<CoreRuleKey, RegExp>> = {
  roles: /\b(lead|coordinator|delivery owner|fleet health|re-?prioriti\w*|reassign\w*|owns?)\b/i,
  'own-change': /\b(merg\w*|integrat\w*|roll(s|ed)? (it |them )?back|another session|own change|end to end)\b/i,
  messages: /\b(messag\w*|inbox\w*|pings?|acks?|SendMessage|reply|notify)\b/i,
  register: /\b(status|boards?|blockers?|deadlines?|register|task ?ids?|tasks?|work block|verifying|handoff|handover|findings)\b/i,
  'task-order': /\b(priority order|top task|loops?|cron\w*|wake-?ups?|self-made|ScheduleWakeup)\b/i,
  'owner-gates': /\b(owner|approv\w*|consent|gated|silence)\b/i,
  deploy: /\b(deploy\w*|ASAP|heavy|queu\w*|cut-?off|roll(s|ing)?)\b/i,
  'lean-calls': /\b(sub-?agents?|helpers?|cheaper|haiku|sonnet|opus|effort|weekly limit|budget|tokens?|batch)\b/i,
  investigate: /\b(investigat\w*|recommendation|options)\b/i,
  resources: /\b(limits?|stopgap|root cause|memory use|cpu)\b/i,
  data: /\b(delet\w*|drop\w*|dry[- ]run|secrets?|0\.0\.0\.0|127\.0\.0\.1|regenerat\w*|parity)\b/i,
  contracts: /\b(contracts?|page a human|alerts?)\b/i,
  skills: /\b(skills?|SKILL\.md|last verified|memory|MEMORY\.md|CLAUDE\.md|frontmatter)\b/i,
  commits: /\b(commit\w*|large-commit|--no-verify)\b/i,
  push: /\b(push\w*|force|protected|route around|guard)\b/i,
  worktrees: /\b(worktrees?|branch\w*|main|checkout|junction|rmdir|stale|dead code|comments?)\b/i,
};

/** A line that says which rule wins, or names teamrig itself, matters whatever its topic. */
export const LINE_TAGS = ['precedence', 'teamrig'] as const;
export type LineTag = (typeof LINE_TAGS)[number];

const TAG_WORDS: Readonly<Record<LineTag, RegExp>> = {
  precedence: /\b(overrid\w*|wins?|precedence|supersed\w*|instead of|takes? priority|regardless|yields? to|no longer|retired?|replaced by|rather than|outranks?)\b/i,
  teamrig: /\bteamrig\b/i,
};

/** A line shorter than this, trimmed, is a heading, a fence or a fragment, never a rule a scan shows. */
export const RULE_LINE_MIN_CHARS = 20;

/** The topics a line touches: the core rules its words name, in rule order, and its tags. */
export interface LineTopics {
  readonly rules: readonly CoreRuleKey[];
  readonly tags: readonly LineTag[];
}

/** The topics of a line, or undefined when it is too short or touches none, so it cannot conflict with a core rule. */
export function topicsOf(line: string): LineTopics | undefined {
  if (line.trim().length < RULE_LINE_MIN_CHARS) {
    return undefined;
  }
  const rules = CORE_RULE_KEYS.filter((key) => RULE_TOPICS[key].test(line));
  const tags = LINE_TAGS.filter((tag) => TAG_WORDS[tag].test(line));
  return rules.length === 0 && tags.length === 0 ? undefined : { rules, tags };
}

/** A line's topics as a scan prints them: its rules by number and key, then its tags, `2 own-change, 7 deploy; teamrig`. */
export function topicsLabel({ rules, tags }: LineTopics): string {
  return [rules.map(ruleLabel).join(', '), tags.join(', ')].filter((part) => part !== '').join('; ');
}
