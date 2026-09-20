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

/** Renders untrusted model text inside a raw HTML code block where Markdown constructs stay inert. */
export function renderModelTextLiteral(value: string): string {
  return `<pre><code>${encodeHtmlText(value)}</code></pre>`;
}

export function encodedModelTextBytes(value: string): number {
  return Buffer.byteLength(encodeHtmlText(value), 'utf8');
}
