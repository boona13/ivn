import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const copies = [
  ['src/web-dashboard.html', 'dist/web-dashboard.html'],
  ['src/web-dashboard.css', 'dist/web-dashboard.css'],
  ['src/web-dashboard.js', 'dist/web-dashboard.js'],
];

for (const [sourceRelative, targetRelative] of copies) {
  const source = resolve(ROOT, sourceRelative);
  const target = resolve(ROOT, targetRelative);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
