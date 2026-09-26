// All Unicode format controls are rendered visibly so bidi and zero-width state cannot alter review presentation.
const INVISIBLE_FORMAT = /\p{Cf}/gu;

function encodeHtmlText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(
      INVISIBLE_FORMAT,
      (character) => `\\u{${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}}`,
    )
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;');
}

/** Display column cap for model-provided prose in code-literal blocks (GitHub gutter width). */
export const MODEL_TEXT_LINE_LIMIT = 80;

const HTML_ENTITY = /&[a-zA-Z]+;|&#\d+;/gu;

/**
 * Monospace display columns of one code point, wcwidth-style: CJK and emoji code points render
 * double-width, combining marks and variation selectors occupy no column of their own, and
 * regional-indicator pairs (flags) are approximated at one column each so a flag ≈ two columns.
 */
function codePointWidth(codePoint: number): number {
  if ((codePoint >= 0x0300 && codePoint <= 0x036f) || codePoint === 0xfe0e || codePoint === 0xfe0f) return 0;
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return 1;
  const wide =
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1ffff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd);
  return wide ? 2 : 1;
}

/** Display width of an encoded fragment: HTML entities occupy one column; Unicode-aware. */
function displayWidth(fragment: string): number {
  let width = 0;
  for (const character of fragment.replace(HTML_ENTITY, ' ')) {
    width += codePointWidth(character.codePointAt(0) as number);
  }
  return width;
}

/** Tokenizes an encoded line into display units: one HTML entity or one code point each. */
function encodedUnits(line: string): string[] {
  const entity = /&[a-zA-Z]+;|&#\d+;/y;
  const units: string[] = [];
  let index = 0;
  while (index < line.length) {
    entity.lastIndex = index;
    const match = entity.exec(line);
    if (match) {
      units.push(match[0]);
      index += match[0].length;
      continue;
    }
    // Code points, not UTF-16 units: a surrogate pair must never be split across lines.
    const character = String.fromCodePoint(line.codePointAt(index) as number);
    units.push(character);
    index += character.length;
  }
  return units;
}

/** Splits one already-encoded line at the display-column cap, preferring space boundaries. */
function wrapEncodedLine(line: string, limit: number): string[] {
  if (displayWidth(line) <= limit) return [line];
  const lines: string[] = [];
  let current = '';
  let lastSpace = -1;
  for (const unit of encodedUnits(line)) {
    if (current !== '' && displayWidth(current + unit) > limit) {
      if (lastSpace > 0) {
        lines.push(current.slice(0, lastSpace));
        current = `${current.slice(lastSpace).replace(/^ +/u, '')}${unit}`;
      } else {
        lines.push(current);
        current = unit;
      }
      lastSpace = current.lastIndexOf(' ');
      continue;
    }
    current += unit;
    if (unit === ' ') lastSpace = current.length - 1;
  }
  if (current !== '') lines.push(current);
  return lines;
}

/**
 * Wraps encoded model prose to the display-column cap so long lines never force a horizontal
 * scrollbar in GitHub's comment gutter. Applied to literal prose blocks only; suggestion fenced
 * blocks must stay byte-exact (GitHub applies the replacement verbatim) and are never wrapped.
 */
function wrapEncodedLines(encoded: string, limit: number = MODEL_TEXT_LINE_LIMIT): string {
  return encoded
    .split('\n')
    .map((line) => wrapEncodedLine(line, limit).join('\n'))
    .join('\n');
}

/** Renders untrusted model text inside a raw HTML code block where Markdown constructs stay inert. */
export function renderModelTextLiteral(value: string): string {
  return `<pre><code>${wrapEncodedLines(encodeHtmlText(value))}</code></pre>`;
}

/** Renders untrusted model text as inert inline code on one line (for headings and index lines). */
export function renderModelTextInline(value: string): string {
  return `<code>${encodeHtmlText(value)}</code>`;
}

export function encodedModelTextBytes(value: string): number {
  return Buffer.byteLength(encodeHtmlText(value), 'utf8');
}
