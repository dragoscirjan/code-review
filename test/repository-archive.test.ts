import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { create, Header } from 'tar';
import { test } from 'vitest';
import { DEFAULT_ARCHIVE_LIMITS, extractRepositoryArchive } from '../src/repository-archive';

interface RawEntry {
  path: string;
  type: 'File' | 'Directory' | 'Link' | 'SymbolicLink' | 'FIFO';
  content?: string;
  linkpath?: string;
}

async function rawArchiveFixture(entries: readonly RawEntry[], gzip = false) {
  const temporary = await mkdtemp(join(tmpdir(), 'code-review-raw-archive-test-'));
  const archive = join(temporary, gzip ? 'repository.tar.gz' : 'repository.tar');
  const destination = join(temporary, 'output');
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8');
    const header = new Header({
      path: entry.path,
      type: entry.type,
      size: entry.type === 'File' ? content.length : 0,
      mode: entry.type === 'Directory' ? 0o755 : 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
      linkpath: entry.linkpath,
    });
    const block = Buffer.alloc(512);
    assert.equal(header.encode(block), false);
    blocks.push(block);
    if (content.length > 0) {
      blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1_024));
  const tar = Buffer.concat(blocks);
  await writeFile(archive, gzip ? gzipSync(tar) : tar);
  return { temporary, archive, destination };
}

async function archiveFixture(setup: (root: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), 'code-review-archive-test-'));
  const parent = join(temporary, 'input');
  const root = join(parent, 'repository-root');
  const archive = join(temporary, 'repository.tar.gz');
  const destination = join(temporary, 'output');
  await mkdir(root, { recursive: true });
  await setup(root);
  await create({ cwd: parent, gzip: true, file: archive, portable: true }, ['repository-root']);
  return { temporary, archive, destination };
}

test('preflights and extracts a one-root regular-file archive', async () => {
  const fixture = await archiveFixture(async (root) => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = 1;\n');
  });
  try {
    const result = await extractRepositoryArchive(fixture.archive, fixture.destination, {
      maximumMembers: 20,
      maximumDirectories: 10,
      maximumFiles: 10,
      maximumFileBytes: 1_000,
      maximumExpandedBytes: 2_000,
      maximumPathBytes: 200,
      maximumPathSegments: 10,
    });
    assert.deepEqual(result, { files: 1, bytes: 24 });
    assert.equal(await readFile(join(fixture.destination, 'src', 'value.ts'), 'utf8'), 'export const value = 1;\n');
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test(
  'rejects symlink members before extraction and removes the destination',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = await archiveFixture(async (root) => {
      await writeFile(join(root, 'target'), 'target');
      await symlink('target', join(root, 'link'));
    });
    try {
      await assert.rejects(extractRepositoryArchive(fixture.archive, fixture.destination), /non-regular entry/);
      await assert.rejects(access(fixture.destination));
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  },
);

test.each([
  ['parent traversal', 'root/../escape'],
  ['absolute path', '/root/escape'],
  ['drive path', 'C:/root/escape'],
  ['backslash path', 'root\\escape'],
] as const)('rejects unsafe archive path: %s', async (_name, unsafePath) => {
  const fixture = await rawArchiveFixture([
    { path: 'root/', type: 'Directory' },
    { path: unsafePath, type: 'File', content: 'unsafe' },
  ]);
  try {
    await assert.rejects(extractRepositoryArchive(fixture.archive, fixture.destination), /unsafe path/);
    await assert.rejects(access(fixture.destination));
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test.each([
  ['hardlink', { path: 'root/link', type: 'Link' as const, linkpath: 'root/target' }],
  ['special file', { path: 'root/pipe', type: 'FIFO' as const }],
])('rejects %s members before extraction', async (_name, invalidEntry) => {
  const fixture = await rawArchiveFixture([{ path: 'root/', type: 'Directory' }, invalidEntry]);
  try {
    await assert.rejects(extractRepositoryArchive(fixture.archive, fixture.destination), /non-regular entry/);
    await assert.rejects(access(fixture.destination));
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test.each([
  [
    'duplicate destinations',
    [
      { path: 'root/', type: 'Directory' as const },
      { path: 'root/value', type: 'File' as const, content: 'one' },
      { path: 'root/value', type: 'File' as const, content: 'two' },
    ],
    /duplicate paths/,
  ],
  [
    'multiple roots',
    [
      { path: 'one/', type: 'Directory' as const },
      { path: 'two/', type: 'Directory' as const },
    ],
    /one root directory/,
  ],
  [
    'file and directory conflicts',
    [
      { path: 'root/', type: 'Directory' as const },
      { path: 'root/value/child', type: 'File' as const, content: 'child' },
      { path: 'root/value', type: 'File' as const, content: 'parent-file' },
    ],
    /file\/directory conflict/,
  ],
] as const)('rejects %s', async (_name, entries, expected) => {
  const fixture = await rawArchiveFixture(entries);
  try {
    await assert.rejects(extractRepositoryArchive(fixture.archive, fixture.destination), expected);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('bounds total members and directories, including compressed header amplification', async () => {
  const entries: RawEntry[] = [{ path: 'root/', type: 'Directory' }];
  for (let index = 0; index < 200; index += 1) entries.push({ path: `root/d${index}/`, type: 'Directory' });
  const fixture = await rawArchiveFixture(entries, true);
  try {
    await assert.rejects(
      extractRepositoryArchive(fixture.archive, fixture.destination, {
        ...DEFAULT_ARCHIVE_LIMITS,
        maximumMembers: 20,
        maximumDirectories: 10,
      }),
      /count exceeds|decompression ratio/,
    );
    await assert.rejects(access(fixture.destination));
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('aborts on the first invalid header even when substantial members follow', async () => {
  const entries: RawEntry[] = [
    { path: 'root/', type: 'Directory' },
    { path: 'root/link', type: 'SymbolicLink', linkpath: 'target' },
  ];
  for (let index = 0; index < 2_000; index += 1) entries.push({ path: `root/d${index}/`, type: 'Directory' });
  const fixture = await rawArchiveFixture(entries);
  try {
    await assert.rejects(extractRepositoryArchive(fixture.archive, fixture.destination), /non-regular entry/);
    await assert.rejects(access(fixture.destination));
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('rejects declared file and aggregate limits before extraction', async () => {
  const fixture = await archiveFixture(async (root) => {
    await writeFile(join(root, 'large.txt'), 'x'.repeat(100));
  });
  try {
    await assert.rejects(
      extractRepositoryArchive(fixture.archive, fixture.destination, {
        maximumMembers: 10,
        maximumDirectories: 5,
        maximumFiles: 1,
        maximumFileBytes: 50,
        maximumExpandedBytes: 50,
        maximumPathBytes: 100,
        maximumPathSegments: 10,
      }),
      /exceeds the limit/,
    );
    await assert.rejects(access(fixture.destination));
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});
