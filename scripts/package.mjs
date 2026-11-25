import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const app = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(app.version) || manifest.version !== app.version) {
  throw new Error('The extension manifest and package.json must have the same three-part version.');
}
const filename = 'reloadstar-' + app.version + '.zip';
const archive = resolve('dist', filename);
const icons = Object.values(manifest.icons);
if (!icons.every(path => /^icons\/[a-z0-9-]+\.png$/.test(path))) throw new Error('Unexpected icon path.');
const files = [...new Set(['manifest.json', 'background.js', 'preferences.js', 'popup.html',
  'popup.js', 'popup.css', ...icons])].sort();

await mkdir('dist', { recursive: true });
const staging = await mkdtemp(resolve('dist', '.package-'));
const content = resolve(staging, 'extension');
const pendingArchive = resolve(staging, filename);
const timestamp = new Date('2000-01-01T00:00:00Z');
try {
  for (const file of files) {
    const source = resolve('extension', file);
    const destination = resolve(content, file);
    if (!(await lstat(source)).isFile()) throw new Error('Unexpected package entry: ' + file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, 0o644);
    await utimes(destination, timestamp, timestamp);
  }
  execFileSync('zip', ['-X', '-q', pendingArchive, ...files], {
    cwd: content, stdio: 'inherit', env: { ...process.env, TZ: 'UTC', ZIPOPT: '' },
  });
  execFileSync('unzip', ['-tq', pendingArchive], { stdio: 'inherit' });
  const hash = createHash('sha256').update(await readFile(pendingArchive)).digest('hex');
  await writeFile(pendingArchive + '.sha256', hash + '  ' + filename + '\n');
  await rename(pendingArchive, archive);
  await rename(pendingArchive + '.sha256', archive + '.sha256');
} finally {
  await rm(staging, { recursive: true, force: true });
}
console.log('Packaged dist/' + filename);
