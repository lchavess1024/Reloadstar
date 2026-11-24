import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const { CWS_ACCESS_TOKEN: token, CWS_PUBLISHER_ID: publisher, CWS_ITEM_ID: item } = process.env;
const checkOnly = process.argv[2] === '--check-auth';
if (!token || !/^[a-zA-Z0-9_-]+$/.test(publisher ?? '') || !/^[a-p]{32}$/.test(item ?? '')) {
  throw new Error('Missing or invalid Chrome Web Store token, publisher ID, or item ID.');
}

const origin = 'https://chromewebstore.googleapis.com';
const name = 'publishers/' + publisher + '/items/' + item;
async function request(method, action, { contentType, body } = {}) {
  const base = action === 'upload' ? '/upload/v2/' : '/v2/';
  const headers = { Authorization: 'Bearer ' + token };
  if (contentType) headers['Content-Type'] = contentType;
  const response = await fetch(origin + base + name + ':' + action, {
    method, headers, body, signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(action + ' failed (' + response.status + '): ' + (result.error?.message ?? response.statusText));
  if (result.itemId !== undefined && result.itemId !== item) {
    throw new Error(action + ' returned an unexpected Store item ID.');
  }
  return result;
}

function compareVersions(first, second) {
  const a = first.split('.').map(Number);
  const b = second.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

const status = await request('GET', 'fetchStatus');
if (status.name !== name || status.itemId !== item) throw new Error('The Store reported a different item.');
console.log('Authenticated to Reloadstar Store item ' + item);
if (!checkOnly) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
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

  const archive = await readFile('dist/reloadstar-' + version + '.zip');
  const upload = await request('POST', 'upload', { contentType: 'application/zip', body: archive });
  let uploadState = upload.uploadState;
  if (uploadState === 'SUCCEEDED' && upload.crxVersion !== version) {
    throw new Error('Chrome Web Store returned a different uploaded version.');
  }
  for (let attempt = 0; uploadState === 'IN_PROGRESS' && attempt < 18; attempt++) {
    await wait(5000);
    uploadState = (await request('GET', 'fetchStatus')).lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED') throw new Error('Store upload did not succeed. State: ' + uploadState);

  const { state } = await request('POST', 'publish', {
    contentType: 'application/json',
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true }),
  });
  if (!['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS', 'STAGED'].includes(state)) {
    throw new Error('Unexpected Chrome Web Store submission state: ' + state);
  }
  console.log('Chrome Web Store submission: ' + state);
}
