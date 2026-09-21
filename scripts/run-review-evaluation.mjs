import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'code-review-evaluation-cli-'));
const output = join(directory, 'cli.cjs');
try {
  await build({
    entryPoints: [resolve('src/review-evaluation-cli.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    packages: 'bundle',
    legalComments: 'none',
    logLevel: 'silent',
  });
  const module = createRequire(import.meta.url)(output);
  const exitCode = await module.main(process.argv.slice(2), process.env);
  process.exitCode = exitCode;
} catch {
  console.error('Review evaluation failed; details suppressed');
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
