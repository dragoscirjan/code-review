import type { PullRequestDiff, GitHubCompareResult } from './github';
import {
  anchorSignatureKey,
  fingerprintAnchor,
  type ReviewMode,
  type ReviewStateFinding,
  type ReviewStateV1,
} from './review-lifecycle';
import { selectReviewedDiff, type UnifiedDiff, type UnifiedDiffFile, type UnifiedDiffLine } from './unified-diff';

export interface IncrementalReviewPlan {
  mode: ReviewMode;
  reason: string;
  diff: PullRequestDiff & Required<Pick<PullRequestDiff, 'parsed' | 'completeParsed' | 'totalFiles'>>;
  prior: ReviewStateV1 | undefined;
  carried: ReviewStateFinding[];
  affected: ReviewStateFinding[];
  fromHeadSha: string | null;
}

interface RemappedFinding {
  state: ReviewStateFinding;
  file: UnifiedDiffFile;
  line: UnifiedDiffLine;
}

function changedLinesWithFingerprints(file: UnifiedDiffFile) {
  const ordinals = new Map<string, number>();
  return file.hunks.flatMap((hunk) =>
    hunk.lines.flatMap((line) => {
      if (line.kind !== 'addition' && line.kind !== 'deletion') return [];
      const signature = anchorSignatureKey(file, hunk, line);
      const ordinal = ordinals.get(signature) ?? 0;
      ordinals.set(signature, ordinal + 1);
      return [{ hunk, line, anchorFingerprint: fingerprintAnchor(file, hunk, line, ordinal).anchorFingerprint }];
    }),
  );
}

/** Uniquely remaps a prior host-generated anchor anywhere in the authoritative current PR diff. */
export function remapPriorFinding(diff: UnifiedDiff, finding: ReviewStateFinding): RemappedFinding | undefined {
  const candidates: RemappedFinding[] = [];
  for (const file of diff.files) {
    if (file.apiPath !== finding.path) continue;
    for (const candidate of changedLinesWithFingerprints(file)) {
      if (candidate.anchorFingerprint !== finding.anchorFingerprint) continue;
      const side = candidate.line.kind === 'addition' ? 'RIGHT' : 'LEFT';
      const line = side === 'RIGHT' ? candidate.line.newLine : candidate.line.oldLine;
      if (line === undefined) continue;
      candidates.push({
        file,
        line: candidate.line,
        state: { ...finding, path: file.apiPath as string, side, line },
      });
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function findingAnchorIsCovered(diff: UnifiedDiff, finding: ReviewStateFinding): boolean {
  return remapPriorFinding(diff, finding) !== undefined;
}

function currentAnchorMatches(diff: UnifiedDiff, finding: ReviewStateFinding): ReviewStateFinding | undefined {
  return remapPriorFinding(diff, finding)?.state;
}

function safeFullPlan(
  diff: IncrementalReviewPlan['diff'],
  prior: ReviewStateV1 | undefined,
  reason: string,
  mode: ReviewMode = prior ? 'full' : 'migration',
  provablyUnaffectedPaths: ReadonlySet<string> = new Set(),
): IncrementalReviewPlan {
  const active = prior?.findings.filter((finding) => finding.state === 'new' || finding.state === 'unchanged') ?? [];
  const carried: ReviewStateFinding[] = [];
  const affected: ReviewStateFinding[] = [];
  for (const finding of active) {
    if (!diff.truncated) {
      affected.push(finding);
      continue;
    }
    const remapped = currentAnchorMatches(diff.completeParsed, finding);
    if (!remapped) {
      throw new Error('Truncated review cannot uniquely remap a prior finding');
    }
    if (provablyUnaffectedPaths.has(finding.path)) {
      if (findingAnchorIsCovered(diff.parsed, remapped)) {
        throw new Error('A carried prior finding is unexpectedly inside reviewed coverage');
      }
      carried.push(remapped);
      continue;
    }
    if (!findingAnchorIsCovered(diff.parsed, remapped)) {
      throw new Error('Truncated review omits an affected prior finding');
    }
    affected.push(remapped);
  }
  return {
    mode,
    reason,
    diff,
    prior,
    carried,
    affected,
    fromHeadSha: prior?.completedThroughHeadSha ?? null,
  };
}

/** Uses a verified strict-descendant comparison only to select current-PR files; it never authorizes findings. */
export function planIncrementalReview(input: {
  currentDiff: IncrementalReviewPlan['diff'];
  currentHeadSha: string;
  maximumDiffBytes: number;
  prior?: ReviewStateV1;
  compare?: GitHubCompareResult;
  fallbackReason?: string;
  reuseAllowed?: boolean;
}): IncrementalReviewPlan {
  const { currentDiff, prior } = input;
  if (!prior) {
    const reason = input.fallbackReason ?? 'no-valid-baseline';
    return safeFullPlan(currentDiff, undefined, reason, reason === 'legacy-summary' ? 'migration' : 'full');
  }
  if (input.reuseAllowed === false) {
    return safeFullPlan(currentDiff, prior, input.fallbackReason ?? 'review-input-mismatch');
  }
  if (!prior.coverageComplete || !prior.completedThroughHeadSha) {
    return safeFullPlan(currentDiff, prior, 'prior-coverage-incomplete');
  }
  const active = prior.findings.filter((finding) => finding.state === 'new' || finding.state === 'unchanged');
  if (prior.completedThroughHeadSha === input.currentHeadSha) {
    const carried = active.map((finding) => currentAnchorMatches(currentDiff.completeParsed, finding));
    if (carried.every((finding): finding is ReviewStateFinding => finding !== undefined)) {
      return {
        mode: 'no-change',
        reason: 'already-reviewed-head',
        diff: selectReviewedDiff(
          currentDiff.completeParsed,
          new Set(),
          input.maximumDiffBytes,
          currentDiff.originalBytes,
        ),
        prior,
        carried: carried.map((finding) => ({ ...finding, state: 'unchanged' })),
        affected: [],
        fromHeadSha: prior.completedThroughHeadSha,
      };
    }
    return safeFullPlan(currentDiff, prior, 'same-head-state-mismatch');
  }
  const compare = input.compare;
  if (
    !compare ||
    compare.status !== 'ahead' ||
    compare.baseSha !== prior.completedThroughHeadSha ||
    compare.headSha !== input.currentHeadSha
  ) {
    return safeFullPlan(currentDiff, prior, input.fallbackReason ?? 'compare-unavailable');
  }
  const touched = new Set<string>();
  for (const file of compare.diff.files) {
    if (file.oldPath) touched.add(file.oldPath);
    if (file.newPath) touched.add(file.newPath);
    if (file.apiPath) touched.add(file.apiPath);
  }
  const carried: ReviewStateFinding[] = [];
  const affected: ReviewStateFinding[] = [];
  for (const finding of active) {
    const remapped = currentAnchorMatches(currentDiff.completeParsed, finding);
    if (!touched.has(finding.path) && remapped) carried.push(remapped);
    else affected.push(remapped ?? finding);
  }
  const selectedPaths = new Set(touched);
  for (const finding of affected) selectedPaths.add(finding.path);
  let selected: IncrementalReviewPlan['diff'];
  try {
    selected = selectReviewedDiff(
      currentDiff.completeParsed,
      selectedPaths,
      input.maximumDiffBytes,
      currentDiff.originalBytes,
    );
  } catch {
    const unaffected = new Set(active.filter((finding) => !touched.has(finding.path)).map((finding) => finding.path));
    return safeFullPlan(currentDiff, prior, 'incremental-selection-truncated', 'full', unaffected);
  }
  if (selected.truncated) {
    const unaffected = new Set(active.filter((finding) => !touched.has(finding.path)).map((finding) => finding.path));
    return safeFullPlan(currentDiff, prior, 'incremental-selection-truncated', 'full', unaffected);
  }
  if (
    affected.some(
      (finding) =>
        !selected.parsed.files.some(
          (file) => file.apiPath === finding.path || file.oldPath === finding.path || file.newPath === finding.path,
        ),
    )
  ) {
    return safeFullPlan(currentDiff, prior, 'affected-finding-not-covered');
  }
  return {
    mode: selected.parsed.files.length === 0 && affected.length === 0 ? 'no-change' : 'incremental',
    reason: 'strict-descendant-compare',
    diff: selected,
    prior,
    carried,
    affected,
    fromHeadSha: prior.completedThroughHeadSha,
  };
}
