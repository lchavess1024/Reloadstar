import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const app = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(app.version) || manifest.version !== app.version) {
  throw new Error('The extension manifest and package.json must have the same three-part version.');
}
const filename = 'reloadstar-' + app.version + '.zip';
const archive = resolve('dist', filename);
const files = ['manifest.json', 'background.js', 'preferences.js', 'popup.html', 'popup.js', 'popup.css',
  ...Object.values(manifest.icons)];

await mkdir('dist', { recursive: true });
await rm(archive, { force: true });
execFileSync('zip', ['-X', '-q', archive, ...files], { cwd: 'extension', stdio: 'inherit' });
execFileSync('unzip', ['-tq', archive], { stdio: 'inherit' });
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', hash + '  ' + filename + '\n');
console.log('Packaged dist/' + filename);
