import type { GlobAutomaton, Move, StateSet } from './glob-automaton.ts';
import type { CharRole } from './glob.ts';

/** A secret glob as `fitsSecret` walks it: `tried` when a path it accepts counts, a `!glob` never. */
export interface WalkedGlob {
  readonly keep: boolean;
  readonly automaton: GlobAutomaton;
  readonly tried: boolean;
}

/** A part of the word's text read by a wildcard of the glob. */
const TEXT_IN_WILDCARD = 1;
/** A part of the word's wildcard read by text of the glob. */
const WILDCARD_IN_TEXT = 2;
/** Both: the word and the glob only meet where each one's wildcard covers the other's text, a coincidence. */
const CROSSED = TEXT_IN_WILDCARD | WILDCARD_IN_TEXT;

/**
 * True when some path fits `word` and is a secret: a tried glob accepts it on a reading that does not cross both ways,
 * and the last glob that accepts it is no `!glob`. A word meets a glob by coincidence when its text needs a wildcard
 * of the glob and its wildcard needs text of the glob: `*.ts` fits `.env.*` only as `.env.ts`, where the `*` stands
 * for `.env` and the glob's `*` for `ts`, and `grep x *.ts` reads no secret. A word whose text the glob spells
 * (`.env.l*`, `deploy/id_*`) or whose wildcard the glob's wildcard covers (`b*.pem`, `b[./]pem`) crosses one way at
 * most, and counts. A tried glob that accepts the path is the last one to or before it, so that glob decides.
 *
 * Walks the word's pairs with every tried glob, and every glob, side by side, a character at a time over `chars`, so
 * it finds such a path whenever one exists; it drops a walk with no pair left. Each side's sets of states are numbered
 * once and their steps kept, so a step of a long word is a lookup. Past `maxStates` states, true: the safe side.
 */
export function fitsSecret(word: GlobAutomaton, globs: readonly WalkedGlob[], chars: readonly string[], maxStates: number): boolean {
  const pairs = new PairSteps(word, globs);
  const decision = new DecisionSteps(globs);
  const key = (pairsId: number, decisionId: number): string => `${String(pairsId)},${String(decisionId)}`;
  const seen = new Set([key(pairs.start, decision.start)]);
  const pending: [number, number][] = [[pairs.start, decision.start]];
  for (let walk = pending.pop(); walk !== undefined; walk = pending.pop()) {
    const [pairsId, decisionId] = walk;
    if (decision.secret(decisionId) && pairs.accepts(pairsId)) {
      return true;
    }
    for (const char of chars) {
      const nextPairs = pairs.step(pairsId, char);
      if (pairs.empty(nextPairs)) {
        continue;
      }
      const nextDecision = decision.step(decisionId, char);
      const known = key(nextPairs, nextDecision);
      if (!seen.has(known)) {
        if (seen.size >= maxStates) {
          return true;
        }
        seen.add(known);
        pending.push([nextPairs, nextDecision]);
      }
    }
  }
  return false;
}

/** Values numbered by a key, the same key the same number. */
class Numbered<T> {
  readonly values: T[] = [];
  private readonly ids = new Map<string, number>();

  id(key: string, value: () => T): number {
    const known = this.ids.get(key);
    if (known !== undefined) {
      return known;
    }
    this.values.push(value());
    this.ids.set(key, this.values.length - 1);
    return this.values.length - 1;
  }
}

/** A step function kept per numbered value and character. */
class KeptSteps {
  private readonly steps = new Map<string, number>();

  step(id: number, char: string, make: () => number): number {
    const key = `${String(id)} ${char}`;
    const known = this.steps.get(key);
    if (known !== undefined) {
      return known;
    }
    const made = make();
    this.steps.set(key, made);
    return made;
  }
}

/** One automaton's sets of states, numbered, with their steps and whether each accepts. */
class SubsetSteps {
  readonly start: number;
  private readonly sets = new Numbered<StateSet>();
  private readonly kept = new KeptSteps();
  private readonly accepting = new Map<number, boolean>();
  private readonly automaton: GlobAutomaton;

  constructor(automaton: GlobAutomaton) {
    this.automaton = automaton;
    this.start = this.number(automaton.start);
  }

  step(id: number, char: string): number {
    return this.kept.step(id, char, () => this.number(this.automaton.step(this.sets.values[id] ?? [], char)));
  }

  accepts(id: number): boolean {
    const known = this.accepting.get(id);
    if (known !== undefined) {
      return known;
    }
    const accepts = this.automaton.accepts(this.sets.values[id] ?? []);
    this.accepting.set(id, accepts);
    return accepts;
  }

  private number(states: StateSet): number {
    return this.sets.id(states.join(','), () => states);
  }
}

/** Every glob's set of states at once, numbered, and whether the last glob that accepts there is no `!glob`. */
class DecisionSteps {
  readonly start: number;
  private readonly globs: readonly SubsetSteps[];
  private readonly keeps: readonly boolean[];
  private readonly vectors = new Numbered<readonly number[]>();
  private readonly kept = new KeptSteps();
  private readonly secrets = new Map<number, boolean>();

  constructor(globs: readonly WalkedGlob[]) {
    this.globs = globs.map(({ automaton }) => new SubsetSteps(automaton));
    this.keeps = globs.map(({ keep }) => keep);
    this.start = this.number(this.globs.map((glob) => glob.start));
  }

  step(id: number, char: string): number {
    return this.kept.step(id, char, () => this.number((this.vectors.values[id] ?? []).map((states, index) => this.globs[index]?.step(states, char) ?? states)));
  }

  secret(id: number): boolean {
    const known = this.secrets.get(id);
    if (known !== undefined) {
      return known;
    }
    let secret = false;
    (this.vectors.values[id] ?? []).forEach((states, index) => {
      if (this.globs[index]?.accepts(states) === true) {
        secret = this.keeps[index] !== true;
      }
    });
    this.secrets.set(id, secret);
    return secret;
  }

  private number(vector: readonly number[]): number {
    return this.vectors.id(vector.join(','), () => vector);
  }
}

/** Where the word and the tried glob `glob` (its index) stand on a path read so far, and which crossings it has made. */
interface Pair {
  readonly word: number;
  readonly glob: number;
  readonly at: number;
  readonly crossed: number;
}

/** The crossing a character makes, read by the word's part `word` and the glob's part `glob`. */
function crossing(word: CharRole, glob: CharRole): number {
  if (word === 'literal' && (glob === 'one' || glob === 'star')) {
    return TEXT_IN_WILDCARD;
  }
  return (word === 'star' || word === 'folders') && glob === 'literal' ? WILDCARD_IN_TEXT : 0;
}

/** The sets of pairs of the word with the tried globs, numbered, with their steps and whether any pair accepts. */
class PairSteps {
  readonly start: number;
  private readonly word: GlobAutomaton;
  private readonly globs: readonly GlobAutomaton[];
  private readonly sets = new Numbered<readonly Pair[]>();
  private readonly kept = new KeptSteps();
  private readonly accepting = new Map<number, boolean>();
  /** The moves kept per automaton (the word first, then each glob), state and character: many pairs share a state. */
  private readonly moves: Map<string, readonly Move[]>[][];
  /** The most states a glob has, so a pair's key can number its glob state. */
  private readonly globSize: number;

  constructor(word: GlobAutomaton, globs: readonly WalkedGlob[]) {
    this.word = word;
    this.globs = globs.map(({ automaton }) => automaton);
    this.moves = [word, ...this.globs].map(() => []);
    this.globSize = Math.max(1, ...this.globs.map(({ size }) => size));
    this.start = this.number(globs.flatMap((glob, index) => (glob.tried ? [{ word: word.first, glob: index, at: glob.automaton.first, crossed: 0 }] : [])));
  }

  /** A number for `pair`, the same for the same pair only, whose last two bits are its crossings. */
  private key(pair: Pair): number {
    return ((pair.word * this.globs.length + pair.glob) * this.globSize + pair.at) * 4 + pair.crossed;
  }

  empty(id: number): boolean {
    return (this.sets.values[id] ?? []).length === 0;
  }

  step(id: number, char: string): number {
    return this.kept.step(id, char, () => this.number(this.stepped(this.sets.values[id] ?? [], char)));
  }

  accepts(id: number): boolean {
    const known = this.accepting.get(id);
    if (known !== undefined) {
      return known;
    }
    const accepts = (this.sets.values[id] ?? []).some((pair) => this.word.acceptsAt(pair.word) && this.globs[pair.glob]?.acceptsAt(pair.at) === true);
    this.accepting.set(id, accepts);
    return accepts;
  }

  /** The pairs after reading `char`, without those that crossed both ways or that a pair with no crossing stands for. */
  private stepped(pairs: readonly Pair[], char: string): Pair[] {
    const next = new Map<number, Pair>();
    for (const pair of pairs) {
      for (const wordMove of this.movesOf(0, pair.word, char)) {
        for (const globMove of this.movesOf(pair.glob + 1, pair.at, char)) {
          const crossed = pair.crossed | crossing(wordMove.role, globMove.role);
          if (crossed !== CROSSED) {
            const made: Pair = { word: wordMove.to, glob: pair.glob, at: globMove.to, crossed };
            next.set(this.key(made), made);
          }
        }
      }
    }
    return [...next].filter(([key, pair]) => pair.crossed === 0 || !next.has(key - pair.crossed)).map(([, pair]) => pair);
  }

  /** The moves of automaton `automaton` (0 the word, then the globs) from `state` on `char`, kept. */
  private movesOf(automaton: number, state: number, char: string): readonly Move[] {
    const states = this.moves[automaton] ?? [];
    const kept = (states[state] ??= new Map());
    const known = kept.get(char);
    if (known !== undefined) {
      return known;
    }
    const moves = (automaton === 0 ? this.word : this.globs[automaton - 1])?.moves(state, char) ?? [];
    kept.set(char, moves);
    return moves;
  }

  private number(pairs: readonly Pair[]): number {
    const keys = pairs.map((pair) => this.key(pair)).sort((a, b) => a - b);
    return this.sets.id(keys.join(','), () => pairs);
  }
}
