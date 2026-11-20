/** True for an absolute https URL, the only kind a teamrig request goes to, so its text never crosses a network in the clear. */
export function isHttpsUrl(text: string): boolean {
  return URL.canParse(text) && new URL(text).protocol === 'https:';
}
