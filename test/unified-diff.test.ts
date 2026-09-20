import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseUnifiedDiff, prepareReviewedDiff } from '../src/unified-diff';

const modified = [
  'diff --git a/src/file.ts b/src/file.ts',
  'index 111..222 100644',
  '--- a/src/file.ts',
  '+++ b/src/file.ts',
  '@@ -1,3 +1,3 @@',
  ' unchanged',
  '-old value',
  '+new value',
  ' trailing',
].join('\n');

test('maps additions, deletions, and context on both sides', () => {
  const parsed = parseUnifiedDiff(modified);
  const lines = parsed.files[0]?.hunks[0]?.lines;
  assert.deepEqual(lines, [
    { kind: 'context', text: 'unchanged', oldLine: 1, newLine: 1 },
    { kind: 'deletion', text: 'old value', oldLine: 2 },
    { kind: 'addition', text: 'new value', newLine: 2 },
    { kind: 'context', text: 'trailing', oldLine: 3, newLine: 3 },
  ]);
});

test('supports create, delete, rename, CRLF, Unicode, and no-final-newline markers', () => {
  const raw = [
    'diff --git a/old name.ts b/new name.ts',
    'similarity index 80%',
    'rename from old name.ts',
    'rename to new name.ts',
    '--- a/old name.ts',
    '+++ b/new name.ts',
    '@@ -1 +1 @@',
    '-café',
    '\\ No newline at end of file',
    '+cafés',
    '\\ No newline at end of file',
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1 @@',
    '+created',
    'diff --git a/deleted.ts b/deleted.ts',
    'deleted file mode 100644',
    '--- a/deleted.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-removed',
  ].join('\r\n');
  const parsed = parseUnifiedDiff(raw);
  assert.deepEqual(
    parsed.files.map((file) => [file.oldPath, file.newPath, file.apiPath]),
    [
      ['old name.ts', 'new name.ts', 'new name.ts'],
      [undefined, 'new.ts', 'new.ts'],
      ['deleted.ts', undefined, 'deleted.ts'],
    ],
  );
  assert.equal(parsed.files[0]?.hunks[0]?.lines[0]?.text, 'café');
});

test('supports standard metadata-only pure renames and copies as anchorless files', () => {
  const parsed = parseUnifiedDiff(
    [
      'diff --git a/old name.ts b/new name.ts',
      'similarity index 100%',
      'rename from old name.ts',
      'rename to new name.ts',
      'diff --git a/shared.ts b/copy one.ts',
      'similarity index 100%',
      'copy from shared.ts',
      'copy to copy one.ts',
      'diff --git a/shared.ts b/copy two.ts',
      'similarity index 100%',
      'copy from shared.ts',
      'copy to copy two.ts',
    ].join('\n'),
  );
  assert.deepEqual(
    parsed.files.map((file) => [file.oldPath, file.newPath, file.apiPath, file.commentable, file.hunks.length]),
    [
      ['old name.ts', 'new name.ts', 'new name.ts', false, 0],
      ['shared.ts', 'copy one.ts', 'copy one.ts', false, 0],
      ['shared.ts', 'copy two.ts', 'copy two.ts', false, 0],
    ],
  );
});

test('keeps NFC and NFD path identities distinct without normalization', () => {
  const nfc = modified.replaceAll('src/file.ts', 'src/café.ts');
  const nfd = modified.replaceAll('src/file.ts', 'src/café.ts');
  const parsed = parseUnifiedDiff(`${nfc}\n${nfd}`);
  assert.deepEqual(
    parsed.files.map((file) => file.apiPath),
    ['src/café.ts', 'src/café.ts'],
  );
});

test('decodes Git C-quoted UTF-8 and escaped path bytes exactly', () => {
  const raw = [
    'diff --git "a/src/caf\\303\\251\\tfile.ts" "b/src/caf\\303\\251\\tfile.ts"',
    '--- "a/src/caf\\303\\251\\tfile.ts"',
    '+++ "b/src/caf\\303\\251\\tfile.ts"',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  assert.equal(parseUnifiedDiff(raw).files[0]?.apiPath, 'src/café\tfile.ts');
});

test('represents binary, mode-only, and submodule entries without commentable anchors', () => {
  const parsed = parseUnifiedDiff(
    [
      'diff --git a/image.png b/image.png',
      'Binary files a/image.png and b/image.png differ',
      'diff --git a/vendor b/vendor',
      'index 1111111..2222222 160000',
      '--- a/vendor',
      '+++ b/vendor',
      '@@ -1 +1 @@',
      '-Subproject commit 1111111',
      '+Subproject commit 2222222',
    ].join('\n'),
  );
  assert.equal(parsed.files[0]?.hunks.length, 0);
  assert.equal(parsed.files[0]?.apiPath, undefined);
  assert.equal(parsed.files[1]?.commentable, false);
});

for (const [name, raw] of [
  ['count mismatch', modified.replace('@@ -1,3 +1,3 @@', '@@ -1,4 +1,3 @@')],
  ['truncated hunk', modified.split('\n').slice(0, -1).join('\n')],
  ['combined diff', 'diff --cc src/file.ts\n@@@ -1,1 -1,1 +1,1 @@@'],
  ['unsafe path', modified.replaceAll('src/file.ts', '../file.ts')],
  ['bare carriage return', modified.replace('\n', '\r')],
  ['duplicate path', `${modified}\n${modified}`],
  [
    'mismatched metadata-only identity',
    ['diff --git a/wrong.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts'].join('\n'),
  ],
  ['unpaired copy metadata', ['diff --git a/old.ts b/new.ts', 'similarity index 100%', 'copy from old.ts'].join('\n')],
  ['overflowing hunk range', modified.replace('@@ -1,3 +1,3 @@', `@@ -${Number.MAX_SAFE_INTEGER},3 +1,3 @@`)],
  [
    'overlapping hunks',
    ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-a', '+b', '@@ -1 +1 @@', '-a', '+c'].join(
      '\n',
    ),
  ],
] as const) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseUnifiedDiff(raw), /Malformed unified diff/);
  });
}

test('packs complete hunks only and reparses the exact model-visible line map', () => {
  const second = modified.replaceAll('src/file.ts', 'src/other.ts').replace('new value', 'x'.repeat(500));
  const raw = `${modified}\n${second}`;
  const packed = prepareReviewedDiff(raw, Buffer.byteLength(modified, 'utf8') + 1);
  assert.equal(packed.truncated, true);
  assert.equal(packed.text, modified);
  assert.deepEqual(packed.parsed, parseUnifiedDiff(packed.text));
  assert.ok(Buffer.byteLength(packed.text, 'utf8') <= Buffer.byteLength(modified, 'utf8') + 1);
});

test('prioritizes later commentable hunks over leading binary, mode-only, and anchorless sections', () => {
  const leading = [
    'diff --git a/image.bin b/image.bin',
    `Binary files a/image.bin and b/image.bin differ ${'x'.repeat(1_000)}`,
    'diff --git a/mode.ts b/mode.ts',
    'old mode 100644',
    'new mode 100755',
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
  ].join('\n');
  const packed = prepareReviewedDiff(`${leading}\n${modified}`, Buffer.byteLength(modified, 'utf8') + 1);
  assert.equal(packed.text, modified);
  assert.equal(packed.parsed.files[0]?.commentable, true);
});

test('fails when no complete changed hunk fits the configured prompt budget', () => {
  assert.throws(() => prepareReviewedDiff(modified, 20), /No complete diff hunk fits/);
});
