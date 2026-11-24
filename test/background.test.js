import assert from 'node:assert/strict';
import { test } from 'node:test';

function event() {
  let handler;
  return {
    addListener(callback) { handler = callback; },
    fire(...args) { return handler(...args); },
  };
}

function storage() {
  const data = {};
  return {
    async get(key) {
      return structuredClone(typeof key === 'string' ? { [key]: data[key] } : { ...key, ...data });
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
}

let worker = 0;
async function setup(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const refreshed = [];
  const power = [];
  const badges = new Map();
  let nextAlarm;
  const pages = new Map([[1, { url: 'https://example.com/', status: 'complete' }],
    [2, { url: 'https://example.org/', status: 'complete' }]]);
  const chrome = {
    storage: { local: storage(), session: storage() },
    runtime: { id: 'test-extension', onInstalled: event(), onMessage: event() },
    contextMenus: { onClicked: event() },
    action: { async setBadgeText({ tabId, text }) { badges.set(tabId, text); } },
    alarms: {
      onAlarm: event(),
      async get() { return nextAlarm; },
      async create(name, { when }) { nextAlarm = { name, scheduledTime: when }; },
      async clear() { nextAlarm = undefined; },
    },
    permissions: { async contains() { return true; }, onRemoved: event() },
    power: { requestKeepAwake(mode) { power.push(mode); }, releaseKeepAwake() { power.push('release'); } },
    tabs: {
      onRemoved: event(), onReplaced: event(), onUpdated: event(),
      async get(tabId) {
        if (!pages.has(tabId)) throw new Error('Tab was closed');
        return pages.get(tabId);
      },
      async reload(tabId) { refreshed.push(tabId); },
    },
  };
  t.mock.method(console, 'error', error => assert.fail(error));
  globalThis.chrome = chrome;
  t.after(() => { delete globalThis.chrome; });
  await import('../extension/background.js?worker=' + ++worker);
  function request(type, tabId = 1, fields = {}) {
    return new Promise(resolve => chrome.runtime.onMessage.fire({ type, tabId, ...fields }, { id: chrome.runtime.id }, resolve));
  }
  async function fireAlarm() {
    const alarm = nextAlarm;
    nextAlarm = undefined;
    chrome.alarms.onAlarm.fire(alarm);
    await request('state');
  }
  return { request, fireAlarm, chrome, refreshed, power, badges, pages, nextAlarm: () => nextAlarm };
}

test('page menu starts at 30 seconds and stops the selected tab', async t => {
  const app = await setup(t);
  assert.equal((await app.request('state')).settings.interval, 30);
  const menu = { menuItemId: 'toggle-refresh' };
  app.chrome.contextMenus.onClicked.fire(menu, { id: 1 });
  assert.equal((await app.request('state')).session.interval, 30);
  assert.equal((await app.request('state', 2)).session, null);
  assert.equal(app.nextAlarm().scheduledTime, 31_000);
  assert.equal(app.badges.get(1), 'ON');
  t.mock.timers.tick(30_000);
  await app.fireAlarm();
  assert.deepEqual(app.refreshed, [1]);
  app.chrome.contextMenus.onClicked.fire(menu, { id: 1 });
  assert.equal((await app.request('state')).session, null);
  assert.equal(app.nextAlarm(), undefined);
  assert.equal(app.badges.get(1), '');
});

test('sub-30-second timer runs with a 30-second fallback and skips tabs that are loading', async t => {
  const app = await setup(t);
  await app.request('start', 1, { interval: 1 });
  assert.equal(app.nextAlarm().scheduledTime, 31_000);
  t.mock.timers.tick(1000);
  await app.request('state');
  assert.deepEqual(app.refreshed, [1]);
  app.pages.get(1).status = 'loading';
  t.mock.timers.tick(1000);
  await app.request('state');
  assert.deepEqual(app.refreshed, [1]);
  app.pages.get(1).status = 'complete';
  t.mock.timers.tick(1000);
  await app.request('state');
  assert.deepEqual(app.refreshed, [1, 1]);
  assert.equal((await app.request('start', 2, { interval: 0 })).error,
    'Enter a whole number from 1 to 86,400 seconds.');
  await app.request('stop');
});

test('optional wake request follows the last session and stops on access loss', async t => {
  const app = await setup(t);
  await app.request('wake', 1, { enabled: true });
  assert.deepEqual(app.power, ['release']);
  await app.request('start', 1, { interval: 30 });
  await app.request('start', 2, { interval: 45 });
  assert.deepEqual(app.power, ['release', 'system']);
  app.pages.delete(1);
  app.chrome.tabs.onRemoved.fire(1);
  assert.equal((await app.request('state')).session, null);
  assert.deepEqual(app.power, ['release', 'system']);
  app.pages.get(2).url = undefined;
  app.chrome.tabs.onUpdated.fire(2, { status: 'complete' });
  assert.equal((await app.request('state', 2)).session, null);
  assert.deepEqual(app.power, ['release', 'system', 'release']);
});
