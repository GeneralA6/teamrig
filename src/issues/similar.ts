import { SECRET_BODY } from '../github/map.ts';
import { ACTIVE_STATUSES, ISSUE_REF_PREFIX } from '../register/model.ts';
import type { Task } from '../register/fold.ts';

/**
 * Duplicate candidates for an issue, found without the issue host and without a model: TF-IDF over the words of the
 * issues the register mirrors, cosine between the new issue and each of them. The watcher judges only the few
 * that score at or above the threshold, so a duplicate check costs no tokens for an issue with none.
 */

/** A title word counts this many times over a body word: a title says what the issue is about. */
export const TITLE_WEIGHT = 2;

/** How much of a body is read: its start says what the issue is; the rest is logs and steps that make every bug alike. */
export const BODY_CHARS = 1000;

/** How many candidates are kept, best first. */
export const SIMILAR_TOP = 3;

/** One issue as the scorer reads it. Title and body are outside input: only counted, never followed. */
export interface SimilarDoc {
  /** The issue's ref: `gh:<owner>/<name>#<number>`. */
  readonly ref: string;
  readonly title: string;
  readonly body: string;
}

/** An issue that may be a duplicate, with its cosine score, from 0 to 1. */
export interface SimilarMatch {
  readonly ref: string;
  readonly title: string;
  readonly score: number;
}

/** Words too common to tell two issues apart. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a about after all also an and any are as at be been before but by can could did do does doing done for from had has have ' +
    'how i if in into is it its just me more my no not now of on once only or other our out over same should so some such ' +
    'than that the their them then there these they this those through to too under until up us was we were what when where ' +
    'which while who why will with would you your'
  ).split(' '),
);

/** A run of letters, digits and `_`, which may hold `.`, `/` and `-` inside it: a word, a path, a version, a flag name. */
const CHUNK = /[\p{L}\p{N}_](?:[\p{L}\p{N}_./-]*[\p{L}\p{N}_])?/gu;

/** A chunk that names a file or a version (`src/core/version.ts`, `0.351.0`): it is kept whole, beside its parts. */
const PATH_LIKE = /[./]/;

/** A word worth counting: not a stop word, and not a lone letter (a lone digit stays: numbers are kept). */
function counts(word: string): boolean {
  return word !== '' && !STOP_WORDS.has(word) && !(word.length === 1 && /\p{L}/u.test(word));
}

/**
 * The words of a text, lowercased: each word once per time it appears, stop words out. A path or a version counts
 * whole and by its parts, so `src/core/version.ts` matches itself and a mention of `version`; a hyphened word
 * (`exec-policy`) counts by its parts.
 */
export function tokens(text: string): string[] {
  const words: string[] = [];
  for (const chunk of text.toLowerCase().match(CHUNK) ?? []) {
    if (PATH_LIKE.test(chunk)) {
      words.push(chunk);
    }
    const parts = /[./-]/.test(chunk) ? chunk.split(/[./-]+/) : [chunk];
    words.push(...parts.filter(counts));
  }
  return words;
}

/** Each word of the issue with how often it counts: the title's TITLE_WEIGHT times, the start of the body once. */
function termCounts(doc: SimilarDoc): Map<string, number> {
  const counted = new Map<string, number>();
  const add = (word: string, weight: number): void => {
    counted.set(word, (counted.get(word) ?? 0) + weight);
  };
  for (const word of tokens(doc.title)) {
    add(word, TITLE_WEIGHT);
  }
  for (const word of tokens(doc.body.slice(0, BODY_CHARS))) {
    add(word, 1);
  }
  return counted;
}

/** The TF-IDF vector of term counts, with the smoothed idf `ln((1 + n) / (1 + df)) + 1`, and its length. */
function weighted(counted: ReadonlyMap<string, number>, idf: ReadonlyMap<string, number>): { readonly weights: Map<string, number>; readonly norm: number } {
  const weights = new Map<string, number>();
  let sum = 0;
  for (const [word, count] of counted) {
    const weight = count * (idf.get(word) ?? 0);
    weights.set(word, weight);
    sum += weight * weight;
  }
  return { weights, norm: Math.sqrt(sum) };
}

/**
 * The issues of `corpus` most like `target`, best first: those scoring at least `threshold`, at most `top` of them,
 * the target's own ref left out. The idf is read over the corpus and the target together, so a word every issue
 * has weighs little. An equal score goes by ref, so the same register gives the same list.
 */
export function similarIssues(target: SimilarDoc, corpus: readonly SimilarDoc[], threshold: number, top: number = SIMILAR_TOP): readonly SimilarMatch[] {
  const others = corpus.filter((doc) => doc.ref !== target.ref);
  const counted = [target, ...others].map(termCounts);
  const documentFrequency = new Map<string, number>();
  for (const terms of counted) {
    for (const word of terms.keys()) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [word, df] of documentFrequency) {
    idf.set(word, Math.log((1 + counted.length) / (1 + df)) + 1);
  }
  const [targetTerms = new Map<string, number>(), ...otherTerms] = counted;
  const wanted = weighted(targetTerms, idf);
  if (wanted.norm === 0) {
    return [];
  }
  const matches: SimilarMatch[] = [];
  others.forEach((doc, index) => {
    const candidate = weighted(otherTerms[index] ?? new Map<string, number>(), idf);
    if (candidate.norm === 0) {
      return;
    }
    let dot = 0;
    for (const [word, weight] of wanted.weights) {
      dot += weight * (candidate.weights.get(word) ?? 0);
    }
    const score = dot / (wanted.norm * candidate.norm);
    if (score >= threshold) {
      matches.push({ ref: doc.ref, title: doc.title, score });
    }
  });
  return matches.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).slice(0, top);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The issues the register mirrors, as the scorer reads them: each task an issue made (its ref starts with
 * ISSUE_REF_PREFIX) still active, or done or dropped within `closedDays` of `now`, the window a sync reads closed
 * issues in. A body the import left out as a likely secret counts as none, so those issues do not match each other.
 */
export function mirroredIssues(tasks: Iterable<Task>, now: Date, closedDays: number): readonly SimilarDoc[] {
  const since = now.getTime() - closedDays * DAY_MS;
  const docs: SimilarDoc[] = [];
  for (const task of tasks) {
    if (task.ref === null || !task.ref.startsWith(ISSUE_REF_PREFIX)) {
      continue;
    }
    if (ACTIVE_STATUSES.includes(task.status) || Date.parse(task.statusAt) >= since) {
      docs.push({ ref: task.ref, title: task.title, body: task.description === null || task.description === SECRET_BODY ? '' : task.description });
    }
  }
  return docs;
}
