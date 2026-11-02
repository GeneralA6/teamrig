import type { PlaceKind } from './places.ts';
import type { Candidate } from './scan.ts';

/**
 * Where a person starts judging the override candidates when a setup holds too many to judge at once. A word list finds
 * a rule's topic, never whether a line contradicts it (the model judges that, line by line, in `rules scan`), so this
 * only orders: first the lines a session reads unasked, since they steer every session; then the lines that name the
 * kit, since they speak of its rules; then the lines that direct or say which rule wins. A directive word orders and
 * never filters: a plain imperative ("Use --force when a push is rejected") conflicts as well as a "never" does. How
 * many topics a line touches is left out: that count grows with a line's length, so it ranks long notes over rules.
 */

/**
 * How a place's lines reach a session: 2 unasked (a CLAUDE.md, a rules file, the team rules, settings' `autoMode`),
 * 1 at an event or when read (a hook's output, a memory file: its index loads at start, but the rule an index line
 * points to lives in the file), 0 only when its skill runs.
 */
export const LOAD_WEIGHT: Readonly<Record<PlaceKind, number>> = { 'claude-md': 2, rules: 2, 'team-rules': 2, settings: 2, hook: 1, memory: 1, skill: 0 };

/** Words that make a line tell a session what to do or not do, or what it may do. */
const DIRECTIVE_WORDS = /\b(never|always|must|may|do not|don't|only|no one|nobody|without (asking|approval)|skip|instead)\b/i;

/** Whether a session reads the candidate's line without being asked (LOAD_WEIGHT 2). */
export function loadsUnasked(candidate: Candidate): boolean {
  return LOAD_WEIGHT[candidate.place.kind] === 2;
}

/**
 * The candidate's rank, higher first: its place's LOAD_WEIGHT outranks naming the kit, which outranks directing; the
 * weights 4, 2 and 1 keep those three apart in one number.
 */
function rankOf(candidate: Candidate): number {
  const { tags } = candidate.topics;
  const directs = tags.includes('precedence') || DIRECTIVE_WORDS.test(candidate.text);
  return LOAD_WEIGHT[candidate.place.kind] * 4 + (tags.includes('teamrig') ? 2 : 0) + (directs ? 1 : 0);
}

/** Every candidate, in the order to judge them (see above); candidates of one rank keep the scan's order. */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  return candidates
    .map((candidate) => ({ candidate, rank: rankOf(candidate) }))
    .sort((a, b) => b.rank - a.rank)
    .map(({ candidate }) => candidate);
}
