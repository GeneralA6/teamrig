/** WCAG colour contrast, so picture tests can prove their text reads on the backgrounds it sits on. */

/** A `#rrggbb` colour's channels, from 0 to 255. */
interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

function rgbOf(hex: string): Rgb {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new RangeError(`not a #rrggbb colour: ${hex}`);
  const at = (start: number): number => Number.parseInt(hex.slice(start, start + 2), 16);
  return { red: at(1), green: at(3), blue: at(5) };
}

/** The WCAG relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const { red, green, blue } = rgbOf(hex);
  const linear = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** The WCAG contrast ratio of two colours, from 1 (the same) to 21 (black on white), whichever way round. */
export function contrast(a: string, b: string): number {
  const [first, second] = [luminance(a), luminance(b)];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** The `#rrggbb` colour a browser shows for `top` laid at `opacity` (0 to 1) over `bottom`, such as a translucent fill on the page. */
export function mix(top: string, bottom: string, opacity: number): string {
  if (!(opacity >= 0 && opacity <= 1)) throw new RangeError(`not an opacity from 0 to 1: ${opacity}`);
  const [over, under] = [rgbOf(top), rgbOf(bottom)];
  const channel = (a: number, b: number): string =>
    Math.round(a * opacity + b * (1 - opacity))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(over.red, under.red)}${channel(over.green, under.green)}${channel(over.blue, under.blue)}`;
}
