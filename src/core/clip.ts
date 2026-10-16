/** The start of `text`, cut to `max` characters with "..." when longer. */
export function clipEnd(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/** The end of `text`, cut to `max` characters with "..." when longer: a path's file name is its telling part. */
export function clipStart(text: string, max: number): string {
  return text.length <= max ? text : `...${text.slice(text.length - max + 3)}`;
}
