/**
 * The version of the public interface this teamrig serves (docs/design/public-interface.md, Versions and notice). A
 * major changes or removes what a reader holds; a minor only adds documents and fields, so a reader of 1.0 reads every
 * 1.x answer by leaving out what it does not know.
 */
export const INTERFACE_MAJOR = 1;
export const INTERFACE_MINOR = 1;

/** The served version as every answer carries it: `major.minor`. */
export const INTERFACE_VERSION = `${INTERFACE_MAJOR}.${INTERFACE_MINOR}`;

export interface InterfaceVersion {
  readonly major: number;
  readonly minor: number;
}

/** `major.minor` in digits, with no sign, space or leading zero, so one version has one spelling. */
const VERSION_TEXT = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/u;

/** The version `text` names as `major.minor`, or undefined when it names none. */
export function parseInterfaceVersion(text: string): InterfaceVersion | undefined {
  const match = VERSION_TEXT.exec(text);
  const major = match?.[1];
  const minor = match?.[2];
  return major === undefined || minor === undefined ? undefined : { major: Number(major), minor: Number(minor) };
}

/** Whether a reader that speaks `asked` can read this teamrig's answers, or the one line saying why not. */
export type RangeCheck = { readonly served: true } | { readonly served: false; readonly reason: string };

/**
 * Checks the version a reader speaks against the served one. A reader that names none takes the served version. A
 * reader of another major is refused, since its fields may mean something else; so is one of a newer minor, since it
 * would wait for documents and fields this teamrig never sends. An older minor of the same major is served.
 */
export function checkInterfaceRange(asked: InterfaceVersion | undefined): RangeCheck {
  if (asked === undefined) {
    return { served: true };
  }
  const text = `${asked.major}.${asked.minor}`;
  if (asked.major > INTERFACE_MAJOR) {
    return { served: false, reason: `interface ${text} is newer than the ${INTERFACE_VERSION} this teamrig serves; update teamrig` };
  }
  if (asked.major < INTERFACE_MAJOR) {
    return { served: false, reason: `interface ${text} is no longer served; this teamrig serves ${INTERFACE_VERSION}, so update the reader` };
  }
  if (asked.minor > INTERFACE_MINOR) {
    return { served: false, reason: `interface ${text} is newer than the ${INTERFACE_VERSION} this teamrig serves; update teamrig` };
  }
  return { served: true };
}
