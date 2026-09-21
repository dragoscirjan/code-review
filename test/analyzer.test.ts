import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { runDeterministicAnalysis } from '../src/analyzer';
import { parseAnalyzerConfiguration, DEFAULT_ANALYZER_LIMITS } from '../src/analyzer-config';
import { MAX_ANALYZER_REPORT_BYTES, parseAnalyzerReport, validateAnalyzerReport } from '../src/analyzer-contract';
import { assessReview } from '../src/finding-validation';
import type { PullRequestContext, RepositoryTextResult } from '../src/github';
import { parseReviewResult } from '../src/review-contract';
import { parseUnifiedDiff } from '../src/unified-diff';

const pullRequest: PullRequestContext = {
  owner: 'owner',
  repository: 'repo',
  number: 24,
  title: 'Analyze changed text',
  body: '',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  author: 'author',
  url: 'https://github.com/owner/repo/pull/24',
};

function configuration(overrides: Partial<typeof DEFAULT_ANALYZER_LIMITS> = {}) {
  return parseAnalyzerConfiguration(
    JSON.stringify({
      version: 1,
      analyzers: [
        { id: 'conflict-markers', rules: ['unresolved-conflict-marker'] },
        { id: 'typescript-syntax', rules: ['syntax-error'] },
        { id: 'json-syntax', rules: ['syntax-error', 'duplicate-property'] },
      ],
      limits: { ...DEFAULT_ANALYZER_LIMITS, ...overrides },
    }),
    pullRequest.baseSha,
    'config-blob',
  );
}

function addedFile(path: string, lines: string[]): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ];
}

function reviewedDiff(files: Array<[string, string[]]>) {
  const text = files.flatMap(([path, lines]) => addedFile(path, lines)).join('\n');
  const parsed = parseUnifiedDiff(text);
  return { text, originalBytes: Buffer.byteLength(text), truncated: false, parsed };
}

function reviewedRawDiff(text: string) {
  return { text, originalBytes: Buffer.byteLength(text), truncated: false, parsed: parseUnifiedDiff(text) };
}

function insertionDiff(paths: string[]) {
  return reviewedRawDiff(
    paths
      .flatMap((path) => [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        '+const added = true;',
      ])
      .join('\n'),
  );
}

function clientFor(contents: Record<string, RepositoryTextResult>, fetched: string[] = []) {
  return {
    async getRepositoryTextAtRevision(
      _pullRequest: PullRequestContext,
      path: string,
      revision: string,
    ): Promise<RepositoryTextResult> {
      assert.equal(revision, pullRequest.headSha);
      fetched.push(path);
      return contents[path] ?? { status: 'not-found', bytes: 0, truncated: false };
    },
  };
}

function found(text: string): RepositoryTextResult {
  return {
    status: 'found',
    text,
    bytes: Buffer.byteLength(text),
    truncated: false,
    blobSha: `blob-${Buffer.byteLength(text)}`,
  };
}

test('runs fixed in-process checks and maps only exact RIGHT additions with tool provenance', async () => {
  const files: Array<[string, string[]]> = [
    ['src/broken.ts', ['const value = ;']],
    ['config/data.json', ['{', '  "name": 1,', '  "name": 2', '}']],
    ['src/conflict.py', ['<<<<<<< branch', 'value = 1', '=======', 'value = 2', '>>>>>>> main']],
  ];
  const diff = reviewedDiff(files);
  const analysis = await runDeterministicAnalysis({
    client: clientFor(Object.fromEntries(files.map(([path, lines]) => [path, found(lines.join('\n'))]))),
    pullRequest,
    diff,
    configuration: configuration(),
  });
  assert.equal(analysis.report.coverage, 'complete');
  assert.equal(analysis.report.runs.length, 3);
  assert.ok(analysis.findings.some((finding) => finding.origin.analyzer === 'typescript-syntax'));
  assert.ok(analysis.findings.some((finding) => finding.origin.ruleId === 'duplicate-property'));
  assert.equal(analysis.findings.filter((finding) => finding.origin.ruleId === 'unresolved-conflict-marker').length, 3);
  for (const finding of analysis.findings) {
    assert.equal(finding.location.side, 'RIGHT');
    assert.match(finding.origin.observationDigest, /^sha256:[A-Za-z0-9_-]{43}$/u);
    assert.ok(!finding.explanation.includes('branch'));
  }
  assert.doesNotThrow(() => validateAnalyzerReport(analysis.report));
});

test('package scripts, shebangs, imports, and top-level code remain inert and no repository command is executed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-analyzer-test-'));
  const canary = join(directory, 'executed');
  const packageText = JSON.stringify({
    scripts: {
      preinstall: `touch ${canary}`,
      install: `touch ${canary}`,
      postinstall: `touch ${canary}`,
      prepare: `touch ${canary}`,
      test: `touch ${canary}`,
    },
  });
  const source = `#!/usr/bin/env node\nimport 'evil-plugin';\nrequire('node:fs').writeFileSync(${JSON.stringify(canary)}, 'bad');`;
  const files: Array<[string, string[]]> = [
    ['package.json', packageText.split('\n')],
    ['--plugin=evil.ts', source.split('\n')],
  ];
  const fetched: string[] = [];
  try {
    const analysis = await runDeterministicAnalysis({
      client: clientFor(
        {
          'package.json': found(packageText),
          '--plugin=evil.ts': found(source),
        },
        fetched,
      ),
      pullRequest,
      diff: reviewedDiff(files),
      configuration: configuration(),
    });
    assert.deepEqual(fetched.sort(), ['--plugin=evil.ts', 'package.json']);
    assert.equal(analysis.summary.runCount, 3);
    await assert.rejects(access(canary));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('binary/NUL, symlink-like unavailable, oversized, and timed-out inputs produce visible partial coverage', async () => {
  const files: Array<[string, string[]]> = [
    ['nul.ts', ['const x = "\0";']],
    ['link.ts', ['const linked = true;']],
    ['large.ts', ['x'.repeat(128)]],
  ];
  let clock = 0;
  const analysis = await runDeterministicAnalysis({
    client: clientFor({
      'nul.ts': found('const x = "\0";'),
      'link.ts': { status: 'unavailable', bytes: 0, truncated: false, reason: 'not-a-regular-file' },
      'large.ts': { status: 'found', text: 'x'.repeat(64), bytes: 128, truncated: true, blobSha: 'large' },
    }),
    pullRequest,
    diff: reviewedDiff(files),
    configuration: configuration({ maximumFileBytes: 64, timeoutSeconds: 1 }),
    now: () => (clock += 100),
  });
  assert.equal(analysis.report.coverage, 'partial');
  assert.ok(analysis.summary.skippedFiles > 0);
  assert.equal(analysis.summary.contextTruncated, true);
});

test('fetch TimeoutError and valid Git-quoted backslash paths are skipped as partial coverage', async () => {
  const timeoutPath = 'timeout.ts';
  const quotedPath = String.raw`evil\name.ts`;
  const encodedPath = String.raw`evil\\name.ts`;
  const quotedDiff = reviewedRawDiff(
    [
      `diff --git "a/${encodedPath}" "b/${encodedPath}"`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ "b/${encodedPath}"`,
      '@@ -0,0 +1 @@',
      '+const value = ;',
    ].join('\n'),
  );
  assert.equal(quotedDiff.parsed.files[0]?.newPath, quotedPath);
  let backslashFetched = false;
  const backslashAnalysis = await runDeterministicAnalysis({
    client: {
      async getRepositoryTextAtRevision() {
        backslashFetched = true;
        throw new Error('path contract should be preflighted');
      },
    },
    pullRequest,
    diff: quotedDiff,
    configuration: configuration(),
  });
  assert.equal(backslashFetched, false);
  assert.equal(backslashAnalysis.report.coverage, 'partial');
  assert.equal(backslashAnalysis.summary.skippedFiles, 1);

  const timeout = new Error('request timed out');
  timeout.name = 'TimeoutError';
  const timeoutAnalysis = await runDeterministicAnalysis({
    client: {
      async getRepositoryTextAtRevision() {
        throw timeout;
      },
    },
    pullRequest,
    diff: reviewedDiff([[timeoutPath, ['const value = ;']]]),
    configuration: configuration(),
  });
  assert.equal(timeoutAnalysis.report.coverage, 'partial');
  assert.equal(timeoutAnalysis.summary.skippedFiles, 1);
  assert.equal(timeoutAnalysis.findings.length, 0);
});

test('deadline expiry after fetch and parser work cannot produce findings or complete coverage', async () => {
  let clockReads = 0;
  const analysis = await runDeterministicAnalysis({
    client: clientFor({ 'late.ts': found('const value = ;') }),
    pullRequest,
    diff: reviewedDiff([['late.ts', ['const value = ;']]]),
    configuration: configuration({ timeoutSeconds: 1 }),
    now: () => {
      clockReads += 1;
      return clockReads >= 5 ? 2_000 : 0;
    },
  });
  assert.equal(analysis.report.coverage, 'partial');
  assert.equal(analysis.findings.length, 0);
});

test('valid JSON beyond the nesting limit is skipped instead of published as invalid syntax', async () => {
  const nested = `${'['.repeat(33)}0${']'.repeat(33)}`;
  assert.doesNotThrow(() => JSON.parse(nested));
  const analysis = await runDeterministicAnalysis({
    client: clientFor({ 'deep.json': found(nested) }),
    pullRequest,
    diff: reviewedDiff([['deep.json', [nested]]]),
    configuration: configuration(),
  });
  const jsonRun = analysis.report.runs.find((run) => run.analyzer === 'json-syntax');
  assert.equal(analysis.report.coverage, 'partial');
  assert.equal(jsonRun?.status, 'partial');
  assert.equal(jsonRun?.skippedFiles, 1);
  assert.equal(
    analysis.findings.some((finding) => finding.origin.ruleId === 'syntax-error'),
    false,
  );

  const invalid = '{"value":';
  const invalidAnalysis = await runDeterministicAnalysis({
    client: clientFor({ 'invalid.json': found(invalid) }),
    pullRequest,
    diff: reviewedDiff([['invalid.json', [invalid]]]),
    configuration: configuration(),
  });
  assert.equal(
    invalidAnalysis.findings.some((finding) => finding.origin.ruleId === 'syntax-error'),
    true,
  );
});

test('TypeScript syntactic provenance retains high-numbered JSX tag and fragment diagnostics', async () => {
  for (const [path, source] of [
    ['tag.tsx', 'const view = <div></span>;'],
    ['fragment.tsx', 'const view = <><div></>;'],
  ] as const) {
    const analysis = await runDeterministicAnalysis({
      client: clientFor({ [path]: found(source) }),
      pullRequest,
      diff: reviewedDiff([[path, [source]]]),
      configuration: configuration(),
    });
    assert.ok(
      analysis.report.runs
        .find((run) => run.analyzer === 'typescript-syntax')
        ?.observations.some((observation) => observation.ruleId === 'syntax-error'),
      `${path} should produce a syntactic observation`,
    );
  }
});

test('observation limits are global, deterministic, and excess results make coverage partial', async () => {
  const lines = ['<<<<<<< a', '=======', '>>>>>>> b'];
  const analysis = await runDeterministicAnalysis({
    client: clientFor({ 'conflict.ts': found(lines.join('\n')) }),
    pullRequest,
    diff: reviewedDiff([['conflict.ts', lines]]),
    configuration: configuration({ maximumObservations: 1 }),
  });
  assert.equal(analysis.findings.length, 1);
  assert.equal(analysis.report.coverage, 'partial');
});

test('path, out-of-scope, and report-byte contract bounds truncate deterministically without throwing', async () => {
  const overlongPath = `${'p'.repeat(1_025)}.ts`;
  let overlongFetched = false;
  const longPathAnalysis = await runDeterministicAnalysis({
    client: {
      async getRepositoryTextAtRevision() {
        overlongFetched = true;
        return found('const value = ;');
      },
    },
    pullRequest,
    diff: reviewedDiff([[overlongPath, ['const value = ;']]]),
    configuration: configuration(),
  });
  assert.equal(overlongFetched, false);
  assert.equal(longPathAnalysis.report.coverage, 'partial');
  assert.equal(longPathAnalysis.summary.skippedFiles, 1);

  const outOfScopePaths = ['first.ts', 'second.ts', 'third.ts'];
  const outOfScopeText = ['const added = true;', ...Array.from({ length: 60 }, () => '<<<<<<< branch')].join('\n');
  const outOfScopeAnalysis = await runDeterministicAnalysis({
    client: clientFor(Object.fromEntries(outOfScopePaths.map((path) => [path, found(outOfScopeText)]))),
    pullRequest,
    diff: insertionDiff(outOfScopePaths),
    configuration: configuration(),
  });
  const conflictRun = outOfScopeAnalysis.report.runs.find((run) => run.analyzer === 'conflict-markers');
  assert.equal(conflictRun?.outOfScopeObservations, 100);
  assert.equal(conflictRun?.status, 'partial');

  const reportFiles: Array<[string, string[]]> = Array.from({ length: 32 }, (_, index) => {
    const path = `src/${String(index).padStart(2, '0')}-${'p'.repeat(980)}.ts`;
    const evidence = `const value = "${'x'.repeat(850)}`;
    return [path, [evidence]];
  });
  const reportAnalysis = await runDeterministicAnalysis({
    client: clientFor(Object.fromEntries(reportFiles.map(([path, lines]) => [path, found(lines.join('\n'))]))),
    pullRequest,
    diff: reviewedDiff(reportFiles),
    configuration: configuration({ maximumFiles: 32, maximumObservations: 50 }),
  });
  assert.equal(reportAnalysis.report.coverage, 'partial');
  assert.ok(Buffer.byteLength(JSON.stringify(reportAnalysis.report), 'utf8') <= MAX_ANALYZER_REPORT_BYTES);
  const retainedObservations = reportAnalysis.report.runs.reduce((total, run) => total + run.observations.length, 0);
  assert.ok(retainedObservations > 0);
  assert.ok(retainedObservations < 32);
  assert.doesNotThrow(() => validateAnalyzerReport(reportAnalysis.report));
});

test('near-limit conflict input stops diagnostic collection at the bounded observation sentinel', async () => {
  const lines = Array.from({ length: 7_000 }, () => '=======');
  const analysis = await runDeterministicAnalysis({
    client: clientFor({ 'many.ts': found(lines.join('\n')) }),
    pullRequest,
    diff: reviewedDiff([['many.ts', lines]]),
    configuration: configuration({ maximumObservations: 1 }),
  });
  assert.equal(analysis.report.coverage, 'partial');
  assert.equal(
    analysis.report.runs.reduce((total, run) => total + run.observations.length, 0),
    1,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(analysis.report), 'utf8') <= MAX_ANALYZER_REPORT_BYTES);
});

test('forged report locations, evidence, digests, tool versions, and extra fields fail strict validation', async () => {
  const lines = ['<<<<<<< a', '=======', '>>>>>>> b'];
  const analysis = await runDeterministicAnalysis({
    client: clientFor({ 'conflict.ts': found(lines.join('\n')) }),
    pullRequest,
    diff: reviewedDiff([['conflict.ts', lines]]),
    configuration: configuration(),
  });
  type MutableReport = {
    command?: string;
    runs: Array<{
      analyzerVersion: string;
      observations: Array<{ path: string; evidence: string; message: string; digest: string }>;
    }>;
  };
  assert.throws(
    () => parseAnalyzerReport(JSON.stringify(analysis.report).replace('{"version":1,', '{"version":1,"version":1,')),
    /duplicate-property/,
  );
  assert.throws(() => parseAnalyzerReport('['.repeat(40) + '0' + ']'.repeat(40)), /nesting-too-deep/);
  for (const mutate of [
    (value: MutableReport) => value.runs.reverse(),
    (value: MutableReport) => value.runs[0]!.observations.reverse(),
    (value: MutableReport) => (value.runs[0]!.analyzerVersion = 'latest'),
    (value: MutableReport) => (value.runs[0]!.observations[0]!.path = '../secret'),
    (value: MutableReport) => (value.runs[0]!.observations[0]!.evidence = 'forged'),
    (value: MutableReport) => (value.runs[0]!.observations[0]!.message = '\ud800'),
    (value: MutableReport) => (value.runs[0]!.observations[0]!.digest = `sha256:${'A'.repeat(43)}`),
    (value: MutableReport) => (value.command = 'npm test'),
  ]) {
    const forged = structuredClone(analysis.report) as unknown as MutableReport;
    mutate(forged);
    assert.throws(() => validateAnalyzerReport(forged));
  }
});

test('a stale snapshot during exact-head acquisition aborts analysis before any result can be used', async () => {
  const lines = ['<<<<<<< a'];
  let freshnessChecks = 0;
  await assert.rejects(
    runDeterministicAnalysis({
      client: clientFor({ 'conflict.ts': found(lines.join('\n')) }),
      pullRequest,
      diff: reviewedDiff([['conflict.ts', lines]]),
      configuration: configuration(),
      assertFresh: async () => {
        freshnessChecks += 1;
        if (freshnessChecks === 2) throw new Error('stale head');
      },
    }),
    /stale head/,
  );
  assert.equal(freshnessChecks, 2);
});

test('known secrets in mapped analyzer evidence abort before context or publication candidates are returned', async () => {
  const lines = ['<<<<<<< provider-secret'];
  await assert.rejects(
    runDeterministicAnalysis({
      client: clientFor({ 'conflict.ts': found(lines.join('\n')) }),
      pullRequest,
      diff: reviewedDiff([['conflict.ts', lines]]),
      configuration: configuration(),
      secrets: ['provider-secret'],
    }),
    /forbidden secret/,
  );
});

test('model and analyzer findings share exact evidence validation, anchor deduplication, and global caps', async () => {
  const lines = ['<<<<<<< a'];
  const diff = reviewedDiff([['conflict.ts', lines]]);
  const analysis = await runDeterministicAnalysis({
    client: clientFor({ 'conflict.ts': found(lines.join('\n')) }),
    pullRequest,
    diff,
    configuration: configuration(),
  });
  const model = parseReviewResult(
    JSON.stringify({
      version: 1,
      outcome: 'findings',
      findings: [
        {
          category: 'correctness',
          severity: 'critical',
          confidence: 1,
          location: { path: 'conflict.ts', side: 'RIGHT', line: 1 },
          evidence: lines[0],
          explanation: 'A conflict marker remains.',
          fix: 'Resolve it.',
        },
      ],
    }),
  );
  const assessment = assessReview(
    model,
    diff.parsed,
    { minimumConfidence: 0, maximumInlineComments: 10 },
    [],
    analysis.findings,
  );
  assert.equal(assessment.counts.received, 1 + analysis.findings.length);
  assert.equal(assessment.counts.duplicates, analysis.findings.length);
  assert.equal(assessment.counts.accepted, 1);
});
