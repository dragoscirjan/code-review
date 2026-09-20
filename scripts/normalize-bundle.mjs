import { readFile, writeFile } from 'node:fs/promises';

const bundle = new URL('../dist/index.js', import.meta.url);
const content = await readFile(bundle, 'utf8');
await writeFile(bundle, content.replace(/[\t ]+$/gm, ''), 'utf8');
