/**
 * Reads the small stylesheets the drawn pictures carry, so their tests can check the animation: which classes
 * animate, their keyframe stops, and a class's own (still) declarations. It reads only what the pictures write:
 * flat rules, `@keyframes` and `@media` blocks one level deep, no comments or strings holding braces.
 */

export interface Keyframes {
  /** The stops in written order, as percentages: `from` is 0 and `to` is 100. */
  readonly stops: readonly number[];
  /** The block's text between its outer braces. */
  readonly body: string;
}

/** A block whose rules hold one level of braces: `@keyframes x{0%{...}100%{...}}` or `@media (...){.a{...}}`. */
const NESTED = /@(keyframes|media)\s*([^{]*)\{((?:[^{}]*\{[^{}]*\})*)\}/g;
const RULE = /([^{}]+)\{([^{}]*)\}/g;

function stop(selector: string): number {
  const text = selector.trim();
  if (text === 'from') return 0;
  if (text === 'to') return 100;
  const found = /^(\d+(?:\.\d+)?)%$/.exec(text);
  if (found?.[1] === undefined) throw new Error(`not a keyframe stop: ${text}`);
  return Number(found[1]);
}

/** Every `@keyframes` block by name. */
export function keyframesIn(css: string): Map<string, Keyframes> {
  const blocks = new Map<string, Keyframes>();
  for (const [, kind, name = '', body = ''] of css.matchAll(NESTED)) {
    if (kind !== 'keyframes') continue;
    const stops = [...body.matchAll(RULE)].flatMap(([, selectors = '']) => selectors.split(',').map(stop));
    blocks.set(name.trim(), { stops, body });
  }
  return blocks;
}

/** The text of every `@media` block, by its condition, such as `(prefers-color-scheme:dark)`. */
export function mediaIn(css: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const [, kind, condition = '', body = ''] of css.matchAll(NESTED)) if (kind === 'media') blocks.set(condition.trim(), body);
  return blocks;
}

/** The declarations of every top-level rule (outside `@keyframes` and `@media`), by selector; repeats are joined. */
export function rulesIn(css: string): Map<string, string> {
  const rules = new Map<string, string>();
  for (const [, selector = '', declarations = ''] of css.replace(NESTED, '').matchAll(RULE)) {
    const key = selector.trim();
    const before = rules.get(key);
    rules.set(key, before === undefined ? declarations : `${before};${declarations}`);
  }
  return rules;
}

/** One property's value in a run of declarations, such as `opacity` in `opacity:0;animation:a0 17s`. */
export function valueOf(declarations: string, property: string): string | undefined {
  for (const declaration of declarations.split(';')) {
    const at = declaration.indexOf(':');
    if (at !== -1 && declaration.slice(0, at).trim() === property) return declaration.slice(at + 1).trim();
  }
  return undefined;
}

/** The animation each top-level rule runs, by selector: `.a0{animation:a0 17s linear infinite}` gives `.a0` → `a0`. */
export function animationsIn(css: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const [selector, declarations] of rulesIn(css)) {
    const name = valueOf(declarations, 'animation')?.split(/\s+/)[0];
    if (name !== undefined && name !== 'none') names.set(selector, name);
  }
  return names;
}

/** True when the stops only go up, each past the one before. */
export function ascending(stops: readonly number[]): boolean {
  return stops.every((value, i) => i === 0 || value > (stops[i - 1] ?? Number.NEGATIVE_INFINITY));
}
