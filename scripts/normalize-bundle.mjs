import { readFile, writeFile } from 'node:fs/promises';

for (const path of ['../dist/index.js', '../dist/action-release.js']) {
  const bundle = new URL(path, import.meta.url);
  const content = await readFile(bundle, 'utf8');
  await writeFile(bundle, content.replace(/[\t ]+$/gm, ''), 'utf8');
}
