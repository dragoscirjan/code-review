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

/** Display width of an encoded fragment: HTML entities occupy exactly one column. */
function displayWidth(fragment: string): number {
  return fragment.replace(HTML_ENTITY, ' ').length;
}

/** Tokenizes an encoded line into display units: one HTML entity or one character each. */
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
    } else {
      units.push(line[index] as string);
      index += 1;
    }
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
