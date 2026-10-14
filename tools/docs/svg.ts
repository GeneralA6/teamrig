/**
 * What the drawn pictures share: XML escaping, the system font stacks GitHub itself uses, and the outer `<svg>`
 * frame with its text alternative (role, aria-label and title) and its stylesheet.
 */

export function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** GitHub's monospace stack. */
export const MONO_FONTS = `ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;
/** GitHub's sans-serif stack, so a picture's words look like the page around it. */
export const SANS_FONTS = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;

export interface SvgPicture {
  readonly width: number;
  readonly height: number;
  /** The text alternative, for screen readers and as the tooltip; plain text, escaped here. */
  readonly label: string;
  /** CSS rules, one per line. */
  readonly style: readonly string[];
  /** The drawing: SVG elements, already escaped. */
  readonly body: readonly string[];
}

/** The picture as an SVG file: one element per line, ending in a newline. */
export function renderSvg(picture: SvgPicture): string {
  const label = escapeXml(picture.label);
  const { width, height } = picture;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">`,
    `<title>${label}</title>`,
    `<style>\n${picture.style.join('\n')}\n</style>`,
    ...picture.body,
    '</svg>',
    '',
  ].join('\n');
}
