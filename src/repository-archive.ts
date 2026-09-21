import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { extract, Parser, type ReadEntry } from 'tar';

export interface ArchiveLimits {
  maximumMembers: number;
  maximumDirectories: number;
  maximumFiles: number;
  maximumFileBytes: number;
  maximumExpandedBytes: number;
  maximumPathBytes: number;
  maximumPathSegments: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maximumMembers: 60_000,
  maximumDirectories: 10_000,
  maximumFiles: 50_000,
  maximumFileBytes: 5 * 1024 * 1024,
  maximumExpandedBytes: 512 * 1024 * 1024,
  maximumPathBytes: 1_024,
  maximumPathSegments: 64,
};

function safeArchivePath(path: string, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): string[] {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[A-Za-z]:/u.test(path)) {
    throw new Error('Base-revision archive contains an unsafe path');
  }
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  if (Buffer.byteLength(normalized, 'utf8') > limits.maximumPathBytes) {
    throw new Error('Base-revision archive path exceeds the limit');
  }
  const segments = normalized.split('/');
  if (
    segments.length < 1 ||
    segments.length > limits.maximumPathSegments + 1 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Base-revision archive contains an unsafe path');
  }
  return segments;
}

function acceptedType(entry: { type?: string }): 'file' | 'directory' {
  if (entry.type === 'File' || entry.type === 'OldFile' || entry.type === 'ContiguousFile') return 'file';
  if (entry.type === 'Directory' || entry.type === 'GNUDumpDir') return 'directory';
  throw new Error('Base-revision archive contains a non-regular entry');
}

interface PreflightResult {
  files: number;
  bytes: number;
}

async function preflightArchive(archivePath: string, limits: ArchiveLimits): Promise<PreflightResult> {
  const roots = new Set<string>();
  const explicitDestinations = new Set<string>();
  const requiredDirectories = new Set<string>();
  const fileDestinations = new Set<string>();
  let rootDirectorySeen = false;
  let members = 0;
  let files = 0;
  let bytes = 0;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(archivePath);
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error) {
        stream.destroy();
        rejectPromise(error instanceof Error ? error : new Error('Base-revision archive preflight failed'));
      } else {
        resolvePromise();
      }
    };
    const abort = (error: unknown): void => {
      if (settled) return;
      const failure = error instanceof Error ? error : new Error('Base-revision archive preflight failed');
      stream.destroy();
      try {
        parser.abort(failure);
      } catch {
        // The parser also reports the same fatal error through its error event.
      }
      finish(failure);
    };
    const onEntry = (entry: ReadEntry): void => {
      try {
        members += 1;
        if (members > limits.maximumMembers) throw new Error('Base-revision archive member count exceeds the limit');
        const segments = safeArchivePath(entry.path, limits);
        const root = segments[0] as string;
        roots.add(root);
        if (roots.size > 1) throw new Error('Base-revision archive must contain exactly one root directory');
        const type = acceptedType(entry);
        const destinationPath = segments.slice(1).join('/');
        if (segments.length === 1) {
          if (type !== 'directory') throw new Error('Base-revision archive root must be a directory');
          rootDirectorySeen = true;
        }
        if (explicitDestinations.has(destinationPath)) {
          throw new Error('Base-revision archive contains duplicate paths');
        }
        explicitDestinations.add(destinationPath);

        if (destinationPath) {
          const destinationSegments = destinationPath.split('/');
          for (let index = 1; index < destinationSegments.length; index += 1) {
            const ancestor = destinationSegments.slice(0, index).join('/');
            if (fileDestinations.has(ancestor)) {
              throw new Error('Base-revision archive contains a file/directory conflict');
            }
            requiredDirectories.add(ancestor);
          }
          if (type === 'file') {
            if (requiredDirectories.has(destinationPath)) {
              throw new Error('Base-revision archive contains a file/directory conflict');
            }
            fileDestinations.add(destinationPath);
          } else {
            if (fileDestinations.has(destinationPath)) {
              throw new Error('Base-revision archive contains a file/directory conflict');
            }
            requiredDirectories.add(destinationPath);
          }
        }

        if (requiredDirectories.size + (rootDirectorySeen ? 1 : 0) > limits.maximumDirectories) {
          throw new Error('Base-revision archive directory count exceeds the limit');
        }
        if (type !== 'directory') {
          const size = Number(entry.size);
          if (!Number.isSafeInteger(size) || size < 0 || size > limits.maximumFileBytes) {
            throw new Error('Base-revision archive file exceeds the limit');
          }
          files += 1;
          bytes += size;
          if (files > limits.maximumFiles || bytes > limits.maximumExpandedBytes) {
            throw new Error('Base-revision archive expanded size exceeds the limit');
          }
        }
        entry.resume();
      } catch (error) {
        abort(error);
      }
    };
    const parser = new Parser({
      strict: true,
      maxMetaEntrySize: limits.maximumPathBytes * 4,
      maxDecompressionRatio: 100,
      onReadEntry: onEntry,
    });
    parser.on('error', abort);
    parser.on('end', () => finish());
    stream.on('error', abort);
    stream.pipe(parser);
  });

  if (roots.size !== 1 || !rootDirectorySeen) {
    throw new Error('Base-revision archive must contain exactly one root directory');
  }
  return { files, bytes };
}

/** Preflights every member before extracting a single byte, then verifies the extracted regular-file tree. */
export async function extractRepositoryArchive(
  archivePath: string,
  destination: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<{ files: number; bytes: number }> {
  try {
    const declared = await preflightArchive(archivePath, limits);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await extract({
      file: archivePath,
      cwd: destination,
      strip: 1,
      strict: true,
      preservePaths: false,
      maxMetaEntrySize: limits.maximumPathBytes * 4,
      maxDecompressionRatio: 100,
      filter(path) {
        safeArchivePath(path, limits);
        return true;
      },
    });

    const root = resolve(destination);
    const pending = [root];
    let directories = 0;
    let files = 0;
    let bytes = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) break;
      for (const name of await readdir(directory)) {
        const path = resolve(directory, name);
        const fromRoot = relative(root, path);
        if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
          throw new Error('Base-revision archive escaped the extraction root');
        }
        const details = await lstat(path);
        if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) {
          throw new Error('Base-revision extraction contains a non-regular entry');
        }
        if (details.isDirectory()) {
          directories += 1;
          if (directories > limits.maximumDirectories) {
            throw new Error('Base-revision extraction directory count exceeds the limit');
          }
          pending.push(path);
          continue;
        }
        files += 1;
        bytes += details.size;
        if (
          details.size > limits.maximumFileBytes ||
          files > limits.maximumFiles ||
          bytes > limits.maximumExpandedBytes
        ) {
          throw new Error('Base-revision extraction exceeds the limit');
        }
      }
    }
    if (files !== declared.files || bytes !== declared.bytes) {
      throw new Error('Base-revision extraction does not match archive metadata');
    }
    return { files, bytes };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
