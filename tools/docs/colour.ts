/** WCAG colour contrast, so picture tests can prove their text reads on the backgrounds it sits on. */

/** The WCAG relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new RangeError(`not a #rrggbb colour: ${hex}`);
  const channel = (at: number): number => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The WCAG contrast ratio of two colours, from 1 (the same) to 21 (black on white), whichever way round. */
export function contrast(a: string, b: string): number {
  const [first, second] = [luminance(a), luminance(b)];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
