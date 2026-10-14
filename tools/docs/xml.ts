/**
 * A strict, small XML reader for the drawn pictures' tests: it reads elements, attributes, text, comments and the
 * five predefined and numeric character references, and throws on anything that is not well-formed (an unclosed or
 * mismatched tag, a bare `&` or `<`, an unquoted or repeated attribute, a second root, text outside the root).
 * It does not read DTDs, CDATA sections or processing instructions; a picture has none.
 */

export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
}

/** An element, or a run of text with its character references resolved. */
export type XmlNode = XmlElement | string;

/** An element and the elements around it, from the root down to the element itself. */
export interface XmlPlace {
  readonly element: XmlElement;
  readonly path: readonly XmlElement[];
}

export class XmlError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = 'XmlError';
  }
}

const NAME = /[A-Za-z_:][\w.:-]*/y;
const SPACE = /\s*/y;
const REFERENCE = /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([\da-fA-F]+));/y;
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

class Reader {
  private at = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  document(): XmlElement {
    this.skipComments();
    const root = this.element();
    this.skipComments();
    if (this.at < this.source.length) this.fail('content after the root element');
    return root;
  }

  private fail(message: string): never {
    throw new XmlError(message, this.at);
  }

  private match(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.at;
    const found = pattern.exec(this.source);
    if (found !== null) this.at = pattern.lastIndex;
    return found;
  }

  private skipSpace(): void {
    this.match(SPACE);
  }

  private take(text: string): boolean {
    if (!this.source.startsWith(text, this.at)) return false;
    this.at += text.length;
    return true;
  }

  private expect(text: string, what: string): void {
    if (!this.take(text)) this.fail(`expected ${what}`);
  }

  private name(what: string): string {
    return this.match(NAME)?.[0] ?? this.fail(`expected ${what}`);
  }

  /** Whitespace and comments, which may stand before and after the root element. */
  private skipComments(): void {
    this.skipSpace();
    while (this.source.startsWith('<!--', this.at)) {
      this.comment();
      this.skipSpace();
    }
  }

  private comment(): void {
    const end = this.source.indexOf('-->', this.at + 4);
    if (end === -1) this.fail('a comment that never ends');
    this.at = end + 3;
  }

  /** Text up to the next `<` or `stop`, with its character references resolved. */
  private text(stop: string): string {
    let out = '';
    while (this.at < this.source.length) {
      const char = this.source.charAt(this.at);
      if (char === '<' || char === stop) break;
      if (char === '&') out += this.reference();
      else {
        out += char;
        this.at += 1;
      }
    }
    return out;
  }

  /** One character reference (`&amp;`, `&#60;` or `&#x3c;`), as the character it stands for. */
  private reference(): string {
    const found = this.match(REFERENCE) ?? this.fail('a bare & or an unknown character reference');
    const [whole, named = '', decimal, hex] = found;
    const code = decimal === undefined ? (hex === undefined ? undefined : Number.parseInt(hex, 16)) : Number.parseInt(decimal, 10);
    if (code === undefined) return NAMED[named] ?? this.fail(`no entity ${whole}`);
    return code <= 0x10ffff ? String.fromCodePoint(code) : this.fail(`no character ${whole}`);
  }

  private attributes(): Map<string, string> {
    const attributes = new Map<string, string>();
    for (;;) {
      const before = this.at;
      this.skipSpace();
      if (this.source.startsWith('>', this.at) || this.source.startsWith('/>', this.at)) return attributes;
      if (this.at >= this.source.length) this.fail('a tag that never ends');
      if (this.at === before) this.fail('expected a space before an attribute');
      const name = this.name('an attribute name, > or />');
      if (attributes.has(name)) this.fail(`attribute ${name} given twice`);
      this.skipSpace();
      this.expect('=', `= after attribute ${name}`);
      this.skipSpace();
      const quote = this.source.charAt(this.at);
      if (quote !== '"' && quote !== "'") this.fail(`attribute ${name} is not quoted`);
      this.at += 1;
      const value = this.text(quote);
      if (!this.take(quote)) this.fail(`attribute ${name} holds a < or never ends`);
      attributes.set(name, value);
    }
  }

  private element(): XmlElement {
    this.expect('<', 'an element');
    const name = this.name('an element name');
    const attributes = this.attributes();
    if (this.take('/>')) return { name, attributes, children: [] };
    this.expect('>', '>');
    const children: XmlNode[] = [];
    for (;;) {
      const text = this.text('');
      if (text !== '') children.push(text);
      if (this.at >= this.source.length) this.fail(`<${name}> is never closed`);
      if (this.source.startsWith('<!--', this.at)) this.comment();
      else if (this.take('</')) {
        const end = this.name('an end tag name');
        if (end !== name) this.fail(`</${end}> closes <${name}>`);
        this.skipSpace();
        this.expect('>', `> after </${end}`);
        return { name, attributes, children };
      } else children.push(this.element());
    }
  }
}

/** The document's root element; throws an XmlError naming the first thing that is not well-formed. */
export function parseXml(source: string): XmlElement {
  return new Reader(source).document();
}

/** Every element under `root`, `root` included, in document order, each with its path from the root. */
export function placesIn(root: XmlElement): XmlPlace[] {
  const places: XmlPlace[] = [];
  const visit = (element: XmlElement, above: readonly XmlElement[]): void => {
    const path = [...above, element];
    places.push({ element, path });
    for (const child of element.children) if (typeof child !== 'string') visit(child, path);
  };
  visit(root, []);
  return places;
}

/** All the text inside a node, as a reader would see it. */
export function textOf(node: XmlNode): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('');
}
