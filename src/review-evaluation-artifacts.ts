import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const MAX_EVALUATION_ARTIFACT_BYTES = 1_048_576;
export const EVALUATION_JSON_FILENAME = 'review-evaluation.json';
export const EVALUATION_MARKDOWN_FILENAME = 'review-evaluation.md';

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith(sep);
}

function assertNoSecrets(content: string, secrets: readonly string[]): void {
  for (const secret of [...new Set(secrets)].filter(Boolean)) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (content.includes(secret) || (escaped !== secret && content.includes(escaped))) {
      throw new Error('Evaluation artifact contains forbidden secret data');
    }
  }
}

/** Creates a private output directory directly below trusted runner temporary storage. */
export async function createEvaluationOutputDirectory(
  preferred?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const trustedRoot = resolve(environment.RUNNER_TEMP ?? tmpdir());
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(trustedRoot);
  if (!preferred) {
    const created = await mkdtemp(join(canonicalRoot, 'code-review-evaluation-'));
    await chmod(created, 0o700);
    return created;
  }
  const target = resolve(preferred);
  if (!inside(canonicalRoot, target) || dirname(target) !== canonicalRoot) {
    throw new Error('Evaluation output directory must be a direct child of trusted temporary storage');
  }
  await mkdir(target, { recursive: false, mode: 0o700 });
  return target;
}

export async function writeEvaluationArtifacts(input: {
  outputDirectory: string;
  json: string;
  markdown: string;
  secrets?: readonly string[];
}): Promise<{ jsonPath: string; markdownPath: string }> {
  const directory = resolve(input.outputDirectory);
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error('Evaluation output is not a regular directory');
  if ((await readdir(directory)).length !== 0) throw new Error('Evaluation output directory must be empty');
  for (const [label, content] of [
    ['JSON', input.json],
    ['Markdown', input.markdown],
  ] as const) {
    if (Buffer.byteLength(content, 'utf8') > MAX_EVALUATION_ARTIFACT_BYTES) {
      throw new Error(`${label} evaluation artifact exceeds the byte limit`);
    }
    assertNoSecrets(content, input.secrets ?? []);
  }
  const jsonPath = join(directory, EVALUATION_JSON_FILENAME);
  const markdownPath = join(directory, EVALUATION_MARKDOWN_FILENAME);
  const temporaryJsonPath = join(directory, '.review-evaluation.json.tmp');
  const temporaryMarkdownPath = join(directory, '.review-evaluation.md.tmp');
  try {
    await writeFile(temporaryJsonPath, input.json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await writeFile(temporaryMarkdownPath, input.markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryJsonPath, jsonPath);
    await rename(temporaryMarkdownPath, markdownPath);
    for (const path of [jsonPath, markdownPath]) {
      const artifact = await lstat(path);
      if (
        !artifact.isFile() ||
        artifact.isSymbolicLink() ||
        artifact.nlink !== 1 ||
        artifact.size > MAX_EVALUATION_ARTIFACT_BYTES
      ) {
        throw new Error('Evaluation artifact failed post-write validation');
      }
    }
    return { jsonPath, markdownPath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
