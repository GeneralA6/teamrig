import { INTERFACE_VERSION } from './version.ts';

/** The documents version 1 serves, in the order the help names them: the five of 1.0, then each a minor added. */
export const DOCUMENTS = ['tasks', 'inbox', 'sessions', 'meetings', 'config', 'plan', 'goals'] as const;
export type DocumentName = (typeof DOCUMENTS)[number];

export function isDocumentName(text: string): text is DocumentName {
  return DOCUMENTS.some((name) => name === text);
}

/**
 * What every answer starts with, whatever its document: the interface version it is written in, which document it
 * is, the revision of what it was built from, and the plain lines saying what could only partly be served.
 */
export interface EnvelopeHead {
  readonly interface: string;
  readonly document: DocumentName;
  /** Opaque: a reader only hands it back (`--unless`) and compares it for equality. */
  readonly revision: string;
  readonly problems: readonly string[];
}

/** A document's answer: the head, then the document's own fields. */
export type Answer<Body extends object> = EnvelopeHead & Body;

/**
 * The answer to a reader whose copy is still current: nothing the document reads has changed since the revision it
 * handed in, so no field is sent again.
 */
export interface UnchangedAnswer {
  readonly interface: string;
  readonly document: DocumentName;
  readonly revision: string;
  readonly unchanged: true;
}

/**
 * A document's answer. The head's four fields are written last, so a body that names one of them by mistake cannot
 * replace what a reader takes its bearings from.
 */
export function answerOf<Body extends object>(document: DocumentName, revision: string, problems: readonly string[], body: Body): Answer<Body> {
  return { ...body, interface: INTERFACE_VERSION, document, revision, problems };
}

export function unchangedAnswer(document: DocumentName, revision: string): UnchangedAnswer {
  return { interface: INTERFACE_VERSION, document, revision, unchanged: true };
}
