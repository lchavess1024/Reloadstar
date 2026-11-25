import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || !['--check-auth', '--submit'].includes(mode)) {
  throw new Error('Specify exactly one mode: --check-auth or --submit.');
}
const publisher = 'bad675f9-6a41-4b7c-849f-7e15fba1be63';
const item = 'geaomghnmeopchckjpafooffcdbpgnkm';
const { CWS_ACCESS_TOKEN: token, CWS_PUBLISHER_ID, CWS_ITEM_ID } = process.env;
if (!token || CWS_PUBLISHER_ID !== publisher || CWS_ITEM_ID !== item) {
  throw new Error('Chrome Web Store credentials must target the production Reloadstar listing.');
}
const name = 'publishers/' + publisher + '/items/' + item;

async function request(method, action, { contentType, body, timeout = 60_000 } = {}) {
  const base = action === 'upload' ? '/upload/v2/' : '/v2/';
  const headers = { Authorization: 'Bearer ' + token };
  if (contentType) headers['Content-Type'] = contentType;
  const response = await fetch('https://chromewebstore.googleapis.com' + base + name + ':' + action, {
    method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(action + ' failed with HTTP ' + response.status + '.');
  const result = await response.json();
  if ((result.name !== undefined && result.name !== name) ||
      (result.itemId !== undefined && result.itemId !== item)) {
    throw new Error(action + ' returned an unexpected Store item.');
  }
  return result;
}

async function fetchStatus(timeout) {
  const status = await request('GET', 'fetchStatus', { timeout });
  if (status.name !== name || status.itemId !== item) throw new Error('The Store reported a different item.');
  return status;
}

function compareVersions(first, second) {
  const a = first.split('.').map(Number);
  const b = second.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

function verifyStoreReady(status, version) {
  const published = status.publishedItemRevisionStatus;
  const submitted = status.submittedItemRevisionStatus;
  if (!published?.distributionChannels?.length) throw new Error('Publish the first version from the Store dashboard.');
  if (status.warned || status.takenDown || status.lastAsyncUploadState === 'IN_PROGRESS' ||
      ['PENDING_REVIEW', 'STAGED'].includes(submitted?.state)) {
    throw new Error('Resolve the existing review, upload, staged release, or warning in the Store dashboard.');
  }
  for (const revision of [published, submitted]) {
    for (const { crxVersion } of revision?.distributionChannels ?? []) {
      if (crxVersion && compareVersions(version, crxVersion) <= 0) {
        throw new Error('Release version ' + version + ' must exceed Store version ' + crxVersion + '.');
      }
    }
  }
}

async function readRelease() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  const filename = 'reloadstar-' + version + '.zip';
  const path = 'dist/' + filename;
  const [archive, checksum] = await Promise.all([readFile(path), readFile(path + '.sha256', 'utf8')]);
  const hash = createHash('sha256').update(archive).digest('hex');
  if (checksum !== hash + '  ' + filename + '\n') throw new Error('The release checksum does not match the ZIP.');
  const manifest = JSON.parse(execFileSync('unzip', ['-p', path, 'manifest.json'], { encoding: 'utf8' }));
  if (manifest.name !== 'Reloadstar' || manifest.version !== version || manifest.manifest_version !== 3) {
    throw new Error('The release ZIP contains an unexpected extension or version.');
  }
  return { archive, version };
}

if (mode === '--check-auth') {
  await fetchStatus();
  console.log('Read access verified for Reloadstar Store item ' + item);
} else {
  const { archive, version } = await readRelease();
  verifyStoreReady(await fetchStatus(), version);
  const upload = await request('POST', 'upload', { contentType: 'application/zip', body: archive });
  let uploadState = upload.uploadState;
  if ((uploadState === 'SUCCEEDED' || upload.crxVersion !== undefined) && upload.crxVersion !== version) {
    throw new Error('Chrome Web Store returned a different uploaded version.');
  }
  const deadline = Date.now() + 90_000;
  while (uploadState === 'IN_PROGRESS' && Date.now() + 5_000 < deadline) {
    await wait(5_000);
    const status = await fetchStatus(Math.max(1, deadline - Date.now()));
    uploadState = status.lastAsyncUploadState ?? 'IN_PROGRESS';
    if (uploadState === 'SUCCEEDED') verifyStoreReady(status, version);
  }
  if (uploadState !== 'SUCCEEDED') throw new Error('Store upload did not succeed. State: ' + uploadState);

  const result = await request('POST', 'publish', {
    contentType: 'application/json',
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true }),
  });
  if (result.name !== name || result.itemId !== item || !['PENDING_REVIEW', 'PUBLISHED'].includes(result.state)) {
    throw new Error('Check the Chrome Web Store dashboard for the unexpected submission result.');
  }
  console.log('Chrome Web Store submission: ' + result.state);
}
