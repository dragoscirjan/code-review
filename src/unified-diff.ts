export type DiffLineKind = 'context' | 'addition' | 'deletion';

export interface UnifiedDiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface UnifiedDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: UnifiedDiffLine[];
  rawLines: string[];
}

export interface UnifiedDiffFile {
  oldPath?: string;
  newPath?: string;
  apiPath?: string;
  commentable: boolean;
  headerLines: string[];
  hunks: UnifiedDiffHunk[];
  rawLines: string[];
}

export interface UnifiedDiff {
  files: UnifiedDiffFile[];
}

export interface PreparedReviewDiff {
  text: string;
  originalBytes: number;
  truncated: boolean;
  totalFiles: number;
  parsed: UnifiedDiff;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function malformed(message: string): never {
  throw new Error(`Malformed unified diff: ${message}`);
}

function safeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) malformed(`${name} is outside the safe integer range`);
  return parsed;
}

function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) malformed('unterminated quoted path');
  const bytes: number[] = [];
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) malformed('invalid quoted path character');
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint), 'utf8'));
      if (codePoint > 0xffff) index += 1;
      continue;
    }
    const escape = value[++index];
    if (!escape) malformed('invalid quoted path escape');
    const mapped: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      '\\': 0x5c,
    };
    if (Object.hasOwn(mapped, escape)) {
      bytes.push(mapped[escape] as number);
      continue;
    }
    if (/[0-7]/.test(escape)) {
      const octal = `${escape}${value[index + 1] ?? ''}${value[index + 2] ?? ''}`;
      if (!/^[0-7]{3}$/.test(octal)) malformed('invalid octal path escape');
      bytes.push(Number.parseInt(octal, 8));
      index += 2;
      continue;
    }
    malformed('unsupported quoted path escape');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return malformed('quoted path is not valid UTF-8');
  }
}

function validatePath(value: string): string {
  if (!value || value.startsWith('/') || /[\0\r\n]/.test(value)) malformed('unsafe path');
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) malformed('unsafe path segment');
  return value;
}

function parseHeaderPath(line: string, prefix: '--- ' | '+++ ', sidePrefix: 'a/' | 'b/'): string | undefined {
  if (!line.startsWith(prefix)) malformed(`missing ${prefix.trim()} path header`);
  const encoded = line.slice(prefix.length);
  if (encoded === '/dev/null') return undefined;
  const decoded = decodeGitQuotedPath(encoded);
  if (!decoded.startsWith(sidePrefix)) malformed(`path does not use ${sidePrefix} prefix`);
  return validatePath(decoded.slice(2));
}

function parseMetadataPath(line: string, prefix: string): string {
  return validatePath(decodeGitQuotedPath(line.slice(prefix.length)));
}

function oneMetadataPath(headerLines: readonly string[], prefix: string): string | undefined {
  const metadata = headerLines.filter((line) => line.startsWith(prefix));
  if (metadata.length > 1) malformed('duplicate rename/copy metadata');
  return metadata[0] ? parseMetadataPath(metadata[0], prefix) : undefined;
}

function consumeExpectedDiffPath(value: string, expected: string): string {
  if (!value.startsWith('"')) {
    if (!value.startsWith(expected)) malformed('diff --git path identity mismatch');
    return value.slice(expected.length);
  }
  let end = 1;
  while (end < value.length) {
    if (value[end] === '\\') {
      end += 2;
      continue;
    }
    if (value[end] === '"') break;
    end += 1;
  }
  if (end >= value.length) malformed('unterminated diff --git quoted path');
  const encoded = value.slice(0, end + 1);
  if (decodeGitQuotedPath(encoded) !== expected) malformed('diff --git path identity mismatch');
  return value.slice(end + 1);
}

function validateDiffHeaderIdentity(line: string, oldPath: string, newPath: string): void {
  let remaining = line.slice('diff --git '.length);
  remaining = consumeExpectedDiffPath(remaining, `a/${oldPath}`);
  if (!remaining.startsWith(' ')) malformed('invalid diff --git path separator');
  remaining = consumeExpectedDiffPath(remaining.slice(1), `b/${newPath}`);
  if (remaining) malformed('unexpected content after diff --git paths');
}

function normalizeLines(raw: string): { text: string; lines: string[] } {
  if (/\r(?!\n)/.test(raw)) malformed('bare carriage return');
  const text = raw.replaceAll('\r\n', '\n');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return { text, lines };
}

function parseHunk(rawLines: string[], start: number): { hunk: UnifiedDiffHunk; next: number } {
  const match = HUNK_HEADER.exec(rawLines[start] ?? '');
  if (!match) malformed('invalid hunk header');
  const oldStart = safeInteger(match[1] as string, 'old hunk start');
  const oldCount = safeInteger(match[2] ?? '1', 'old hunk count');
  const newStart = safeInteger(match[3] as string, 'new hunk start');
  const newCount = safeInteger(match[4] ?? '1', 'new hunk count');
  if ((oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)) malformed('invalid zero hunk start');
  if (!Number.isSafeInteger(oldStart + oldCount) || !Number.isSafeInteger(newStart + newCount)) {
    malformed('hunk range is outside the safe integer range');
  }

  let oldLine = oldStart;
  let newLine = newStart;
  let oldConsumed = 0;
  let newConsumed = 0;
  let index = start + 1;
  const lines: UnifiedDiffLine[] = [];
  while (index < rawLines.length && !rawLines[index]?.startsWith('@@ ')) {
    const rawLine = rawLines[index] as string;
    if (rawLine === '\\ No newline at end of file') {
      if (lines.length === 0) malformed('orphan no-newline marker');
      index += 1;
      continue;
    }
    const marker = rawLine[0];
    const text = rawLine.slice(1);
    if (marker === ' ') {
      lines.push({ kind: 'context', text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      oldConsumed += 1;
      newConsumed += 1;
    } else if (marker === '-') {
      lines.push({ kind: 'deletion', text, oldLine });
      oldLine += 1;
      oldConsumed += 1;
    } else if (marker === '+') {
      lines.push({ kind: 'addition', text, newLine });
      newLine += 1;
      newConsumed += 1;
    } else {
      malformed('invalid hunk content line');
    }
    if (oldConsumed > oldCount || newConsumed > newCount) malformed('hunk contains more lines than declared');
    index += 1;
  }
  if (oldConsumed !== oldCount || newConsumed !== newCount) malformed('hunk line counts do not match header');
  return {
    hunk: {
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines,
      rawLines: rawLines.slice(start, index),
    },
    next: index,
  };
}

function parseFile(rawLines: string[]): UnifiedDiffFile {
  if (!rawLines[0]?.startsWith('diff --git ')) malformed('file section does not start with diff --git');
  if (rawLines.some((line) => line.startsWith('diff --cc ') || line.startsWith('diff --combined '))) {
    malformed('combined diffs are unsupported');
  }
  const firstHunk = rawLines.findIndex((line) => line.startsWith('@@'));
  const headerEnd = firstHunk < 0 ? rawLines.length : firstHunk;
  const headerLines = rawLines.slice(0, headerEnd);
  const oldHeaders = headerLines.filter((line) => line.startsWith('--- '));
  const newHeaders = headerLines.filter((line) => line.startsWith('+++ '));
  if (oldHeaders.length > 1 || newHeaders.length > 1) malformed('duplicate path headers');
  const oldHeader = oldHeaders[0];
  const newHeader = newHeaders[0];
  if ((oldHeader && !newHeader) || (!oldHeader && newHeader)) malformed('unpaired path headers');
  if (firstHunk >= 0 && (!oldHeader || !newHeader)) malformed('textual hunk lacks path headers');

  const headerOldPath = oldHeader ? parseHeaderPath(oldHeader, '--- ', 'a/') : undefined;
  const headerNewPath = newHeader ? parseHeaderPath(newHeader, '+++ ', 'b/') : undefined;
  if (oldHeader && !headerOldPath && !headerNewPath) malformed('both paths are /dev/null');

  const renameFrom = oneMetadataPath(headerLines, 'rename from ');
  const renameTo = oneMetadataPath(headerLines, 'rename to ');
  const copyFrom = oneMetadataPath(headerLines, 'copy from ');
  const copyTo = oneMetadataPath(headerLines, 'copy to ');
  if (Boolean(renameFrom) !== Boolean(renameTo) || Boolean(copyFrom) !== Boolean(copyTo)) {
    malformed('unpaired rename/copy metadata');
  }
  if ((renameFrom || renameTo) && (copyFrom || copyTo)) malformed('mixed rename and copy metadata');
  const metadataOldPath = renameFrom ?? copyFrom;
  const metadataNewPath = renameTo ?? copyTo;
  if (headerOldPath && metadataOldPath && headerOldPath !== metadataOldPath) {
    malformed('rename/copy metadata path mismatch');
  }
  if (headerNewPath && metadataNewPath && headerNewPath !== metadataNewPath) {
    malformed('rename/copy metadata path mismatch');
  }
  const oldPath = headerOldPath ?? metadataOldPath;
  const newPath = headerNewPath ?? metadataNewPath;
  const identityOldPath = oldPath ?? newPath;
  const identityNewPath = newPath ?? oldPath;
  if (identityOldPath && identityNewPath) {
    validateDiffHeaderIdentity(rawLines[0] as string, identityOldPath, identityNewPath);
  }

  const hunks: UnifiedDiffHunk[] = [];
  let index = firstHunk < 0 ? rawLines.length : firstHunk;
  let previousOldEnd = -1;
  let previousNewEnd = -1;
  while (index < rawLines.length) {
    const parsed = parseHunk(rawLines, index);
    if (parsed.hunk.oldStart < previousOldEnd || parsed.hunk.newStart < previousNewEnd) {
      malformed('overlapping or out-of-order hunks');
    }
    previousOldEnd = parsed.hunk.oldStart + parsed.hunk.oldCount;
    previousNewEnd = parsed.hunk.newStart + parsed.hunk.newCount;
    hunks.push(parsed.hunk);
    index = parsed.next;
  }

  const submodule = headerLines.some(
    (line) =>
      /^(?:old mode|new mode|new file mode|deleted file mode) 160000$/.test(line) ||
      /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/.test(line),
  );
  const hasChangedAnchor = hunks.some((hunk) =>
    hunk.lines.some((line) => line.kind === 'addition' || line.kind === 'deletion'),
  );
  return {
    oldPath,
    newPath,
    apiPath: newPath ?? oldPath,
    commentable: Boolean((oldPath || newPath) && !submodule && hasChangedAnchor),
    headerLines,
    hunks,
    rawLines,
  };
}

export function parseUnifiedDiff(raw: string): UnifiedDiff {
  const { lines } = normalizeLines(raw);
  if (lines.length === 0) return { files: [] };
  if (lines.some((line) => line.startsWith('diff --cc ') || line.startsWith('diff --combined '))) {
    malformed('combined diffs are unsupported');
  }
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('diff --git ')) starts.push(index);
  }
  if (starts.length === 0 || starts[0] !== 0) malformed('content exists outside a file section');

  const files = starts.map((start, position) => parseFile(lines.slice(start, starts[position + 1] ?? lines.length)));
  const identities = new Set<string>();
  const anchors = new Set<string>();
  for (const file of files) {
    if (!file.commentable) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const anchor =
          line.kind === 'addition'
            ? `${file.apiPath}\0RIGHT\0${line.newLine}`
            : line.kind === 'deletion'
              ? `${file.apiPath}\0LEFT\0${line.oldLine}`
              : undefined;
        if (!anchor) continue;
        if (anchors.has(anchor)) malformed('duplicate changed-line anchor');
        anchors.add(anchor);
      }
    }
    for (const [side, path] of [
      ['LEFT', file.oldPath],
      ['RIGHT', file.newPath],
    ] as const) {
      if (!path) continue;
      const key = `${side}\0${path}`;
      if (identities.has(key)) malformed('duplicate side-specific path');
      identities.add(key);
    }
  }
  return { files };
}

function selectedSections(
  files: readonly UnifiedDiffFile[],
  selectedHunks: ReadonlyMap<number, readonly UnifiedDiffHunk[]>,
  selectedAnchorless: ReadonlySet<number>,
): string[][] {
  const sections: string[][] = [];
  files.forEach((file, fileIndex) => {
    const hunks = selectedHunks.get(fileIndex);
    if (hunks?.length) sections.push([...file.headerLines, ...hunks.flatMap((hunk) => hunk.rawLines)]);
    else if (selectedAnchorless.has(fileIndex)) sections.push(file.rawLines);
  });
  return sections;
}

function linesBytes(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join('\n'), 'utf8');
}

/** Parses the complete diff first, prioritizing commentable complete hunks before optional anchorless metadata. */
export function prepareReviewedDiff(raw: string, maximumBytes: number): PreparedReviewDiff {
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  const normalized = normalizeLines(raw).text.replace(/\n$/, '');
  const complete = parseUnifiedDiff(normalized);
  if (Buffer.byteLength(normalized, 'utf8') <= maximumBytes) {
    return { text: normalized, originalBytes, truncated: false, totalFiles: complete.files.length, parsed: complete };
  }

  const selectedHunks = new Map<number, UnifiedDiffHunk[]>();
  const selectedAnchorless = new Set<number>();
  let selectedByteCount = 0;
  let selectedSectionCount = 0;
  complete.files.forEach((file, fileIndex) => {
    if (!file.commentable) return;
    for (const hunk of file.hunks) {
      if (!hunk.lines.some((line) => line.kind === 'addition' || line.kind === 'deletion')) continue;
      const included = selectedHunks.get(fileIndex) ?? [];
      const addedBytes =
        included.length === 0
          ? (selectedSectionCount > 0 ? 1 : 0) + linesBytes([...file.headerLines, ...hunk.rawLines])
          : 1 + linesBytes(hunk.rawLines);
      if (selectedByteCount + addedBytes > maximumBytes) continue;
      selectedHunks.set(fileIndex, [...included, hunk]);
      selectedByteCount += addedBytes;
      if (included.length === 0) selectedSectionCount += 1;
    }
  });
  complete.files.forEach((file, fileIndex) => {
    if (file.commentable) return;
    const addedBytes = (selectedSectionCount > 0 ? 1 : 0) + linesBytes(file.rawLines);
    if (selectedByteCount + addedBytes > maximumBytes) return;
    selectedAnchorless.add(fileIndex);
    selectedByteCount += addedBytes;
    selectedSectionCount += 1;
  });

  const sections = selectedSections(complete.files, selectedHunks, selectedAnchorless);
  const text = sections.flat().join('\n');
  if (complete.files.some((file) => file.commentable) && selectedHunks.size === 0) {
    throw new Error('No complete diff hunk fits within max-diff-bytes');
  }
  return {
    text,
    originalBytes,
    truncated: true,
    totalFiles: complete.files.length,
    parsed: parseUnifiedDiff(text),
  };
}
