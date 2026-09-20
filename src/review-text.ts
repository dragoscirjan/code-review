function encodeHtmlText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
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
