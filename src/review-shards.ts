import type { PreparedReviewDiff, UnifiedDiffFile, UnifiedDiffHunk } from './unified-diff';
import { selectReviewedDiff } from './unified-diff';

/** Bump when shard splitting, clustering, or provenance semantics change. */
export const SHARDING_VERSION = 1 as const;

/** Maximum diff bytes a single shard prompt may carry. */
export const MAX_SHARD_DIFF_BYTES = 24_000;
/** Maximum number of commentable files grouped into one clustered shard. */
export const MAX_SHARD_FILES = 4;
/** Hard ceiling on shard count produced for one review. */
export const MAX_SHARD_COUNT = 12;

export interface DiffShard {
  /** Zero-based execution order of this shard. */
  index: number;
  /** Repository paths this shard is authoritative for. */
  paths: string[];
  /** Bounded diff text containing complete file sections covering only hunks assigned to this shard. */
  text: string;
}

export interface SplitDiffShardsResult {
  shards: DiffShard[];
  /**
   * Bounded fallback diff covering commentable files that no shard covers (for example dropped by
   * diff truncation, or whose only hunks exceed the shard cap). Null when everything is covered.
   */
  leftoverShard: DiffShard | null;
}

/** Returns every repository path identity under which a diff file may be addressed. */
function filePaths(file: UnifiedDiffFile): string[] {
  return [
    ...new Set([file.oldPath, file.newPath, file.apiPath].filter((path): path is string => typeof path === 'string')),
  ];
}

function sectionText(file: UnifiedDiffFile): string {
  return file.rawLines.join('\n');
}

function sectionBytes(file: UnifiedDiffFile): number {
  return Buffer.byteLength(sectionText(file), 'utf8');
}

function hunkBytes(hunk: UnifiedDiffHunk): number {
  return Buffer.byteLength(hunk.rawLines.join('\n'), 'utf8');
}

function hunkHasChanges(hunk: UnifiedDiffHunk): boolean {
  return hunk.lines.some((line) => line.kind === 'addition' || line.kind === 'deletion');
}

/**
 * Splits a prepared review diff into bounded whole-file shards. Each shard contains complete
 * parseable diff sections so findings keep exact file/line provenance against the authoritative
 * parsed diff. Oversized files split at hunk boundaries; a single hunk larger than the cap is
 * never cut mid-hunk, because partial hunks would break exact changed-line evidence mapping.
 */
export function splitDiffShards(
  diff: PreparedReviewDiff,
  maximumShardDiffBytes: number = MAX_SHARD_DIFF_BYTES,
  maximumShardFiles: number = MAX_SHARD_FILES,
  maximumShardCount: number = MAX_SHARD_COUNT,
): SplitDiffShardsResult {
  const parsed = diff.completeParsed ?? diff.parsed;
  const commentable = parsed.files.filter((file) => file.commentable && file.hunks.some(hunkHasChanges));
  const fitting = commentable.filter((file) => sectionBytes(file) <= maximumShardDiffBytes);
  const oversized = commentable.filter((file) => sectionBytes(file) > maximumShardDiffBytes);

  const shards: DiffShard[] = [];
  for (const file of oversized) {
    for (const text of splitOversizedFile(file, maximumShardDiffBytes)) {
      shards.push({ index: shards.length, paths: filePaths(file), text });
    }
  }
  const grouped = clusterSmallFiles(fitting, maximumShardDiffBytes, maximumShardFiles);
  for (const group of grouped) {
    shards.push({
      index: shards.length,
      paths: group.flatMap(filePaths),
      text: group.map(sectionText).join('\n'),
    });
  }
  const bounded = shards.slice(0, maximumShardCount);
  const leftover = buildLeftoverShard(diff, commentable, bounded);
  return { shards: bounded.map((shard, index) => ({ ...shard, index })), leftoverShard: leftover };
}

/** Splits one oversized commentable file into hunk-group sections, each within the byte cap. */
function splitOversizedFile(file: UnifiedDiffFile, maximumShardDiffBytes: number): string[] {
  const parts: string[] = [];
  let currentHunks: UnifiedDiffHunk[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (currentHunks.length === 0) return;
    parts.push([...file.headerLines, ...currentHunks.flatMap((hunk) => hunk.rawLines)].join('\n'));
    currentHunks = [];
    currentBytes = 0;
  };
  for (const hunk of file.hunks) {
    if (!hunkHasChanges(hunk)) continue;
    const bytes = hunkBytes(hunk) + (currentHunks.length === 0 ? 0 : 1);
    if (bytes > maximumShardDiffBytes) continue;
    if (currentBytes + bytes > maximumShardDiffBytes) flush();
    currentHunks.push(hunk);
    currentBytes += bytes;
  }
  flush();
  return parts;
}

/** Greedy packing of small whole-file sections into clusters bounded by file count and bytes. */
function clusterSmallFiles(
  files: readonly UnifiedDiffFile[],
  maximumShardDiffBytes: number,
  maximumShardFiles: number,
): UnifiedDiffFile[][] {
  const groups: UnifiedDiffFile[][] = [];
  let current: UnifiedDiffFile[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    groups.push(current);
    current = [];
    currentBytes = 0;
  };
  for (const file of files) {
    const bytes = sectionBytes(file) + (current.length === 0 ? 0 : 1);
    if (current.length >= maximumShardFiles || currentBytes + bytes > maximumShardDiffBytes) flush();
    current.push(file);
    currentBytes += bytes;
  }
  flush();
  return groups;
}

/**
 * Builds one leftover shard covering commentable files that no shard covers: files dropped from
 * the model-visible diff by truncation, commentable metadata-only files excluded from shards, and
 * hunks of oversized files that exceeded the per-shard cap. Reuses {@link selectReviewedDiff} so
 * the leftover text stays bounded and parses to its own exact hunks. Null when fully covered.
 */
function buildLeftoverShard(
  diff: PreparedReviewDiff,
  commentable: readonly UnifiedDiffFile[],
  shards: readonly DiffShard[],
): DiffShard | null {
  const covered = new Set(shards.flatMap((shard) => shard.paths));
  const uncoveredPaths = commentable.flatMap(filePaths).filter((path) => !covered.has(path));
  if (uncoveredPaths.length === 0) return null;
  const paths = new Set(uncoveredPaths);
  // The leftover is built only from files of the already-bounded model-visible diff, so its byte
  // ceiling is that diff itself, not the smaller per-shard cap that these files just exceeded.
  const leftoverBudget = Buffer.byteLength(diff.text, 'utf8') + 1;
  const leftoverDiff = selectReviewedDiff(
    diff.completeParsed ?? diff.parsed,
    paths,
    leftoverBudget,
    diff.originalBytes,
  );
  if (!leftoverDiff.text) return null;
  return { index: shards.length, paths: uncoveredPaths, text: leftoverDiff.text };
}
