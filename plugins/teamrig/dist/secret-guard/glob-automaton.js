/**
 * A glob's pieces (`globNodes`) as a nondeterministic automaton, one step per character, so the secret guard can walk
 * a word and every secret glob side by side and find whether any path fits both (`SecretPaths.mayName`). It accepts
 * the same paths as `globRegExp` of the same pieces: each character move tests the piece's own expression.
 */
export class GlobAutomaton {
    /** The state a walk starts in. */
    first = 0;
    start = [this.first];
    edges = [[]];
    fits = new Map();
    flags;
    accept;
    constructor(nodes, ignoreCase) {
        this.flags = ignoreCase ? 'i' : '';
        this.accept = this.build(nodes, this.first);
    }
    /** How many states the automaton has, numbered from 0. */
    get size() {
        return this.edges.length;
    }
    /** The states after reading `char` from `states`. */
    step(states, char) {
        const next = new Set();
        for (const state of states) {
            for (const move of this.moves(state, char)) {
                next.add(move.to);
            }
        }
        return [...next].sort((a, b) => a - b);
    }
    /** The moves on `char` from `state`, past the free moves before it. */
    moves(state, char) {
        const moves = [];
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
    accepts(states) {
        return this.closure(states, undefined).has(this.accept);
    }
    /** `accepts` for a walk in the one state `state`. */
    acceptsAt(state) {
        return this.accepts([state]);
    }
    /** Every expression a character move tests, so `characterClasses` can tell which characters this automaton tells apart. */
    expressions() {
        return [...this.fits.values()];
    }
    /** `states` and every state a free move reaches from them, before reading `next` (undefined at the path's end). */
    closure(states, next) {
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
    build(nodes, from) {
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
    state() {
        this.edges.push([]);
        return this.edges.length - 1;
    }
    link(from, edge) {
        this.edges[from]?.push(edge);
    }
    expression(source) {
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
export function telltaleCharacters(texts) {
    const chars = new Set(['\u0000', '/', '0', '.']);
    const after = (char) => String.fromCharCode(char.charCodeAt(0) + 1);
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
export function characterClasses(chars, automata) {
    const tests = [...new Set(automata.flatMap((automaton) => automaton.expressions()))];
    const classes = new Map();
    for (const char of chars) {
        const signature = `${char === '.' ? 'd' : 'o'}${tests.map((test) => (test.test(char) ? '1' : '0')).join('')}`;
        if (!classes.has(signature)) {
            classes.set(signature, char);
        }
    }
    return [...classes.values()];
}
