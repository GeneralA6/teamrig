import type { CharRole, GlobNode } from './glob.ts';

/** A move between two states: free, free when the next character is no `.` (a lookahead), or on one character. */
type Edge =
  | { readonly kind: 'free'; readonly to: number }
  | { readonly kind: 'notDot'; readonly to: number }
  | { readonly kind: 'char'; readonly fits: RegExp; readonly role: CharRole; readonly to: number };

/** The states an automaton may be in, sorted. */
export type StateSet = readonly number[];

/** A move on one character: the state it reaches, and the part of the glob that read the character. */
export interface Move {
  readonly to: number;
  readonly role: CharRole;
}

/**
 * A glob's pieces (`globNodes`) as a nondeterministic automaton, one step per character, so the secret guard can walk
 * a word and every secret glob side by side and find whether any path fits both (`SecretPaths.mayName`). It accepts
 * the same paths as `globRegExp` of the same pieces: each character move tests the piece's own expression.
 */
export class GlobAutomaton {
  /** The state a walk starts in. */
  readonly first = 0;
  readonly start: StateSet = [this.first];
  private readonly edges: Edge[][] = [[]];
  private readonly fits = new Map<string, RegExp>();
  private readonly flags: string;
  private readonly accept: number;

  constructor(nodes: readonly GlobNode[], ignoreCase: boolean) {
    this.flags = ignoreCase ? 'i' : '';
    this.accept = this.build(nodes, this.first);
  }

  /** How many states the automaton has, numbered from 0. */
  get size(): number {
    return this.edges.length;
  }

  /** The states after reading `char` from `states`. */
  step(states: StateSet, char: string): StateSet {
    const next = new Set<number>();
    for (const state of states) {
      for (const move of this.moves(state, char)) {
        next.add(move.to);
      }
    }
    return [...next].sort((a, b) => a - b);
  }

  /** The moves on `char` from `state`, past the free moves before it. */
  moves(state: number, char: string): readonly Move[] {
    const moves: Move[] = [];
    for (const from of this.closure([state], char)) {
      for (const edge of this.edges[from] ?? []) {
        if (edge.kind === 'char' && edge.fits.test(char)) {
          moves.push({ to: edge.to, role: edge.role });
        }
      }
    }
    return moves;
  }

  /** True when the path read so far, ending here, is one the glob matches. */
  accepts(states: StateSet): boolean {
    return this.closure(states, undefined).has(this.accept);
  }

  /** `accepts` for a walk in the one state `state`. */
  acceptsAt(state: number): boolean {
    return this.accepts([state]);
  }

  /** Every expression a character move tests, so `characterClasses` can tell which characters this automaton tells apart. */
  expressions(): readonly RegExp[] {
    return [...this.fits.values()];
  }

  /** `states` and every state a free move reaches from them, before reading `next` (undefined at the path's end). */
  private closure(states: StateSet, next: string | undefined): Set<number> {
    const reached = new Set(states);
    const pending = [...states];
    for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
      for (const edge of this.edges[state] ?? []) {
        const free = edge.kind === 'free' || (edge.kind === 'notDot' && next !== '.');
        if (free && !reached.has(edge.to)) {
          reached.add(edge.to);
          pending.push(edge.to);
        }
      }
    }
    return reached;
  }

  /** Adds the moves for `nodes` from state `from`, and returns the state they end in. */
  private build(nodes: readonly GlobNode[], from: number): number {
    let at = from;
    for (const node of nodes) {
      switch (node.kind) {
        case 'char': {
          const to = this.state();
          this.link(at, { kind: 'char', fits: this.expression(node.source), role: node.role, to });
          at = to;
          break;
        }
        case 'notDot': {
          const to = this.state();
          this.link(at, { kind: 'notDot', to });
          at = to;
          break;
        }
        case 'repeat': {
          // A fresh state to loop on, so the moves that follow the repeat never join the loop's body.
          const loop = this.state();
          this.link(at, { kind: 'free', to: loop });
          this.link(this.build(node.body, loop), { kind: 'free', to: loop });
          at = loop;
          break;
        }
        case 'optional': {
          const skip = this.state();
          this.link(at, { kind: 'free', to: skip });
          this.link(this.build(node.body, at), { kind: 'free', to: skip });
          at = skip;
          break;
        }
      }
    }
    return at;
  }

  private state(): number {
    this.edges.push([]);
    return this.edges.length - 1;
  }

  private link(from: number, edge: Edge): void {
    this.edges[from]?.push(edge);
  }

  private expression(source: string): RegExp {
    const known = this.fits.get(source);
    if (known !== undefined) {
      return known;
    }
    const made = new RegExp(`^(?:${source})$`, this.flags);
    this.fits.set(source, made);
    return made;
  }
}

/**
 * One character of each kind the globs `texts` tell apart, so a walk that tries only these misses no path. A set or a
 * range only changes its answer at a character it names or the one after it, in either case when case is ignored;
 * `\u0000` stands for every character none of them names. Characters are UTF-16 units, as the automaton reads them.
 */
export function telltaleCharacters(texts: readonly string[]): string[] {
  const chars = new Set<string>(['\u0000', '/', '0', '.']);
  const after = (char: string): string => String.fromCharCode(char.charCodeAt(0) + 1);
  for (const text of texts) {
    for (let index = 0; index < text.length; index += 1) {
      const char = text.charAt(index);
      for (const one of [char, char.toLowerCase(), char.toUpperCase()]) {
        if (one.length === 1) {
          chars.add(one);
          chars.add(after(one));
          chars.add(after(one).toLowerCase());
          chars.add(after(one).toUpperCase());
        }
      }
    }
  }
  return [...chars];
}

/**
 * The first of `chars` of each class the `automata` tell apart: characters every move test answers alike, and that are
 * alike a `.` or not (the lookahead), take the same moves everywhere, so a walk needs to try one of them only. It
 * keeps a long glob's walk from trying hundreds of characters at each step.
 */
export function characterClasses(chars: readonly string[], automata: readonly GlobAutomaton[]): string[] {
  const tests = [...new Set(automata.flatMap((automaton) => automaton.expressions()))];
  const classes = new Map<string, string>();
  for (const char of chars) {
    const signature = `${char === '.' ? 'd' : 'o'}${tests.map((test) => (test.test(char) ? '1' : '0')).join('')}`;
    if (!classes.has(signature)) {
      classes.set(signature, char);
    }
  }
  return [...classes.values()];
}
