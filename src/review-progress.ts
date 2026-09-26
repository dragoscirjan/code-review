import { performance } from 'node:perf_hooks';

/**
 * Versioned, bounded run-log channel for the review execution path. Lines carry fixed status
 * words, shard indices, counters, and elapsed time only — never secrets, prompts, diffs, model
 * output, or any other untrusted pull request content.
 */
export const REVIEW_PROGRESS_VERSION = 1 as const;

/** Hard ceiling on emitted progress lines so verbose runs cannot flood the Actions job log. */
export const MAX_PROGRESS_LOG_LINES = 200;

export type ReviewProgressPhase =
  | 'review-started'
  | 'context-planned'
  | 'single-pass-started'
  | 'single-pass-completed'
  | 'shard-queued'
  | 'shard-started'
  | 'shard-completed'
  | 'shard-skipped'
  | 'shard-partial'
  | 'merge-pass-started'
  | 'merge-pass-completed'
  | 'merge-pass-skipped'
  | 'publication-completed'
  | 'review-completed';

export interface ReviewProgressEvent {
  phase: ReviewProgressPhase;
  /** Zero-based index of the shard the event refers to. */
  shardIndex?: number;
  totalShards?: number;
  /** Number of validated findings attached to the event. */
  findings?: number;
  degraded?: boolean;
}

export interface ReviewProgressLogger {
  event: (event: ReviewProgressEvent) => void;
  /** Number of lines emitted so far; never exceeds {@link MAX_PROGRESS_LOG_LINES}. */
  emitted: () => number;
  /** Number of events dropped after the line cap was reached. */
  suppressed: () => number;
}

function assertLineContainsNoSecrets(line: string, secrets: readonly string[]): void {
  for (const secret of [...new Set(secrets)].filter(Boolean)) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (line.includes(secret) || (escaped !== secret && line.includes(escaped))) {
      throw new Error('Review progress line contains forbidden secret data');
    }
  }
}

export function createReviewProgressLogger(input: {
  secrets: readonly string[];
  /** Monotonic clock; overridable for tests. */
  now?: () => number;
  sink?: (line: string) => void;
}): ReviewProgressLogger {
  const now = input.now ?? performance.now.bind(performance);
  const sink = input.sink ?? ((line: string) => console.log(line));
  const startedAtMs = now();
  let emitted = 0;
  let suppressed = 0;
  return {
    event(event) {
      if (emitted >= MAX_PROGRESS_LOG_LINES) {
        suppressed += 1;
        return;
      }
      const elapsedSeconds = Math.max(0, (now() - startedAtMs) / 1_000);
      const parts = [
        `[review-progress v${REVIEW_PROGRESS_VERSION}]`,
        `+${elapsedSeconds.toFixed(1)}s`,
        `phase=${event.phase}`,
      ];
      if (event.shardIndex !== undefined) {
        parts.push(`shard=${event.shardIndex}/${event.totalShards ?? '?'}`);
      }
      if (event.findings !== undefined) parts.push(`findings=${event.findings}`);
      if (event.degraded === true) parts.push('degraded=true');
      const line = parts.join(' ');
      assertLineContainsNoSecrets(line, input.secrets);
      emitted += 1;
      sink(line);
    },
    emitted: () => emitted,
    suppressed: () => suppressed,
  };
}
