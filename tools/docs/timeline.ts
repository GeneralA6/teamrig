/**
 * One CSS animation clock for a drawn picture. Every moving part gets a class (`a0`, `a1`, ...) whose keyframes sit on
 * the same loop, so the parts stay in step without any script. Each class's own style (outside its animation) is the
 * part's state at the clock's `rest` moment, so with motion turned off (`animation:none`) the picture is a still of
 * that moment. The motions: `show` (fade in and out), `slide` (typing steps), `pop` (grow in), `draw` (a line drawn
 * from its start), `steps` (eased moves between held transforms, such as a camera) and `sweep` (a steady move right).
 */

export interface Clock {
  /** The loop's length, in seconds. */
  readonly loop: number;
  /** When a part shown "to the end" hides again, so the loop restarts from an empty picture. */
  readonly end: number;
  /** The moment the still picture shows. */
  readonly rest: number;
}

/** `rise` fades a part in while it moves up a few pixels; `fade` only fades it. */
export type Motion = 'rise' | 'fade';

export interface ShowOptions {
  /** When the part hides again; the clock's end unless given. */
  readonly to?: number;
  readonly motion?: Motion;
}

export interface PopOptions {
  /** When the part fades out; the clock's end unless given. */
  readonly to?: number;
  /** How far past full size the part grows before it settles; 1.15 unless given. */
  readonly overshoot?: number;
}

export interface DrawOptions {
  /** When the line fades out; the clock's end unless given. */
  readonly to?: number;
  /** How long the line takes to draw, in seconds; 0.35 unless given. */
  readonly duration?: number;
}

/** Text typed one character per step: a part slides right one step per character, then snaps back. */
export interface TypingSegment {
  /** When the first character appears, in seconds. */
  readonly from: number;
  /** How long the whole text takes to type. */
  readonly duration: number;
  /** The number of characters, one step each. */
  readonly chars: number;
  /** When the text is sent and the part snaps back. */
  readonly reset: number;
}

/** One move of a stepped part: at `at` it eases to `value` (a CSS transform) over `duration` seconds and holds it. */
export interface TransformStop {
  readonly at: number;
  readonly duration: number;
  readonly value: string;
}

/** A shown part fades in over this many seconds, and out over as many. */
export const FADE = 0.3;
/** A slid part holds its far position until this many seconds before it snaps back. */
const SNAP = 0.02;
/** How far a rising part moves up as it fades in, in pixels. */
const RISE = 5;
/** A popped part reaches its overshoot this many seconds after it starts, and settles at full size by POP_SETTLE. */
const POP_PEAK = 0.22;
const POP_SETTLE = 0.4;
/** The easing of a stepped part's moves: a quick start and a soft landing. */
const EASE = 'animation-timing-function:cubic-bezier(.45,0,.25,1)';

export class Timeline {
  private readonly clock: Clock;
  private readonly rules: string[] = [];
  private count = 0;

  constructor(clock: Clock) {
    if (!(clock.rest > 0 && clock.rest < clock.end && clock.end < clock.loop)) {
      throw new RangeError(`a clock needs 0 < rest < end < loop, not rest ${clock.rest}, end ${clock.end}, loop ${clock.loop}`);
    }
    this.clock = clock;
  }

  private pct(seconds: number): string {
    return `${((Math.min(Math.max(seconds, 0), this.clock.loop) / this.clock.loop) * 100).toFixed(3)}%`;
  }

  private nextName(): string {
    const name = `a${this.count}`;
    this.count += 1;
    return name;
  }

  /** 1 when the still moment falls in [from, to), else 0. */
  private stillOpacity(from: number, to: number): number {
    return from <= this.clock.rest && this.clock.rest < to ? 1 : 0;
  }

  /**
   * A class that shows its part from `from` until `to` (fading in and out) and hides it the rest of the loop.
   * Its still state is shown when `rest` falls in [from, to). Throws when the window is too short to fade in and
   * out, or does not sit inside the loop, since its keyframes would then not ascend.
   */
  show(from: number, { to = this.clock.end, motion = 'rise' }: ShowOptions = {}): string {
    if (!(from > 0 && from + 2 * FADE < to && to < this.clock.loop)) {
      throw new RangeError(`a part shown from ${from}s to ${to}s needs more than ${2 * FADE}s inside the ${this.clock.loop}s loop`);
    }
    const name = this.nextName();
    const off = motion === 'rise' ? `opacity:0;transform:translateY(${RISE}px)` : 'opacity:0';
    const on = motion === 'rise' ? 'opacity:1;transform:translateY(0)' : 'opacity:1';
    this.rules.push(
      `@keyframes ${name}{0%,${this.pct(from)}{${off}}${this.pct(from + FADE)},${this.pct(to - FADE)}{${on}}${this.pct(to)},100%{${off}}}`,
      `.${name}{opacity:${this.stillOpacity(from, to)};animation:${name} ${this.clock.loop}s linear infinite}`,
    );
    return name;
  }

  /**
   * A class that slides its part right by `width` pixels per character, in steps, during each segment, holds it
   * there and snaps it back at the segment's reset. Its still state is unmoved. Throws on segments that overlap,
   * leave the loop or type no character.
   */
  slide(segments: readonly TypingSegment[], width: number): string {
    let after = 0;
    for (const segment of segments) {
      const fits = Number.isInteger(segment.chars) && segment.chars > 0 && segment.from > after && segment.from + segment.duration < segment.reset - SNAP && segment.reset < this.clock.loop;
      if (!fits) throw new RangeError(`a typing segment from ${segment.from}s (${segment.chars} characters, reset ${segment.reset}s) does not fit after ${after}s`);
      after = segment.reset;
    }
    const name = this.nextName();
    const frames = ['0%{transform:translateX(0)}'];
    for (const segment of segments) {
      const far = `translateX(${(segment.chars * width).toFixed(1)}px)`;
      frames.push(
        `${this.pct(segment.from)}{transform:translateX(0);animation-timing-function:steps(${segment.chars},end)}`,
        `${this.pct(segment.from + segment.duration)},${this.pct(segment.reset - SNAP)}{transform:${far}}`,
        `${this.pct(segment.reset)}{transform:translateX(0)}`,
      );
    }
    frames.push('100%{transform:translateX(0)}');
    this.rules.push(`@keyframes ${name}{${frames.join('')}}`, `.${name}{animation:${name} ${this.clock.loop}s linear infinite}`);
    return name;
  }

  /**
   * A class that pops its part in at `from` (growing from small past `overshoot`, then settling at full size,
   * scaled about its own centre) and fades it out at `to`. Its still state is shown when `rest` falls in
   * [from, to). Throws when the window is too short to pop in and fade out, or does not sit inside the loop.
   */
  pop(from: number, { to = this.clock.end, overshoot = 1.15 }: PopOptions = {}): string {
    if (!(from > 0 && from + POP_SETTLE < to - FADE && to < this.clock.loop)) {
      throw new RangeError(`a part popped in at ${from}s and out at ${to}s needs more than ${POP_SETTLE + FADE}s inside the ${this.clock.loop}s loop`);
    }
    const name = this.nextName();
    this.rules.push(
      `@keyframes ${name}{0%,${this.pct(from)}{opacity:0;transform:scale(.2)}${this.pct(from + POP_PEAK)}{opacity:1;transform:scale(${overshoot})}` +
        `${this.pct(from + POP_SETTLE)},${this.pct(to - FADE)}{opacity:1;transform:scale(1)}${this.pct(to)},100%{opacity:0;transform:scale(1)}}`,
      `.${name}{transform-box:fill-box;transform-origin:center;opacity:${this.stillOpacity(from, to)};animation:${name} ${this.clock.loop}s linear infinite}`,
    );
    return name;
  }

  /**
   * A class that draws a line from its start over `duration` seconds from `from`, and fades it out at `to`. The
   * line's `stroke-dasharray` must be `length`, the line's length or more. Its still state is shown when `rest`
   * falls in [from, to). Throws when the line is not drawn before it starts to fade, or the window leaves the loop.
   */
  draw(from: number, length: number, { to = this.clock.end, duration = 0.35 }: DrawOptions = {}): string {
    if (!(length > 0 && from > 0 && duration > 0 && from + duration < to - FADE && to < this.clock.loop)) {
      throw new RangeError(`a ${length}px line drawn from ${from}s for ${duration}s and gone at ${to}s does not fit the ${this.clock.loop}s loop`);
    }
    const name = this.nextName();
    this.rules.push(
      `@keyframes ${name}{0%,${this.pct(from)}{stroke-dashoffset:${length};opacity:1}${this.pct(from + duration)},${this.pct(to - FADE)}{stroke-dashoffset:0;opacity:1}` +
        `${this.pct(to)},100%{stroke-dashoffset:0;opacity:0}}`,
      `.${name}{opacity:${this.stillOpacity(from, to)};animation:${name} ${this.clock.loop}s linear infinite}`,
    );
    return name;
  }

  /**
   * A class that holds the `initial` transform, eases to each stop's value and holds it, and jumps back to
   * `initial` as the loop restarts. `extra` declarations (such as a transform-origin) open its rule. Its still
   * state is the last value reached by `rest`. Throws on no stops, or stops that overlap or leave the loop.
   */
  steps(initial: string, stops: readonly TransformStop[], extra = ''): string {
    const first = stops[0];
    if (first === undefined) throw new RangeError('a stepped part needs at least one stop');
    let after = 0;
    for (const stop of stops) {
      if (!(stop.at > after && stop.duration > 0 && stop.at + stop.duration < this.clock.loop)) {
        throw new RangeError(`a move at ${stop.at}s for ${stop.duration}s does not fit after ${after}s in the ${this.clock.loop}s loop`);
      }
      after = stop.at + stop.duration;
    }
    const name = this.nextName();
    const frames = [`0%,${this.pct(first.at)}{transform:${initial};${EASE}}`];
    let still = initial;
    stops.forEach((stop, i) => {
      const next = stops[i + 1];
      frames.push(`${this.pct(stop.at + stop.duration)},${next === undefined ? '100%' : this.pct(next.at)}{transform:${stop.value};${EASE}}`);
      if (stop.at + stop.duration <= this.clock.rest) still = stop.value;
    });
    this.rules.push(`@keyframes ${name}{${frames.join('')}}`, `.${name}{${extra}transform:${still};animation:${name} ${this.clock.loop}s linear infinite}`);
    return name;
  }

  /**
   * A class that moves its part right by `distance` pixels at a steady speed from `from` for `duration` seconds,
   * holds it there and snaps it back as the loop restarts. Its still state is moved when the sweep ends by `rest`.
   * Throws when the sweep does not sit inside the loop.
   */
  sweep(from: number, duration: number, distance: number): string {
    if (!(from > 0 && duration > 0 && from + duration < this.clock.loop)) {
      throw new RangeError(`a sweep from ${from}s for ${duration}s does not fit the ${this.clock.loop}s loop`);
    }
    const name = this.nextName();
    const far = `translateX(${distance}px)`;
    this.rules.push(
      `@keyframes ${name}{0%,${this.pct(from)}{transform:translateX(0)}${this.pct(from + duration)},100%{transform:${far}}}`,
      `.${name}{transform:${from + duration <= this.clock.rest ? far : 'translateX(0)'};animation:${name} ${this.clock.loop}s linear infinite}`,
    );
    return name;
  }

  /** Every class's keyframes and rule so far, one per line. */
  css(): string {
    return this.rules.join('\n');
  }
}
