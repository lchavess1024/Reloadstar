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
      const values = typeof key === 'string' ? { [key]: data[key] } : Object.fromEntries(
        Object.entries(key).map(([name, fallback]) => [name, Object.hasOwn(data, name) ? data[name] : fallback]),
      );
      return structuredClone(values);
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
  };
}

let worker = 0;
async function setup(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const refreshed = [];
  const badges = new Map();
  let nextAlarm;
  let activeTabId = 1;
  let menuTitle;
  const pages = new Map([[1, { url: 'https://example.com/', status: 'complete' }],
    [2, { url: 'https://example.org/', status: 'complete' }]]);
  const chrome = {
    storage: { local: storage(), session: storage() },
    runtime: {
      id: 'test-extension',
      getURL: path => 'chrome-extension://test-extension/' + path,
      onInstalled: event(), onStartup: event(), onMessage: event(),
    },
    contextMenus: {
      onClicked: event(),
      removeAll(done) { menuTitle = undefined; done(); },
      create({ title }, done) { menuTitle = title; done(); },
      update(id, { title }, done) {
        assert.equal(id, 'toggle-refresh');
        menuTitle = title;
        done();
      },
    },
    action: {
      async setBadgeText({ tabId, text }) { badges.set(tabId, text); },
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
    },
    alarms: {
      onAlarm: event(),
      async get() { return nextAlarm; },
      async create(name, { when }) { nextAlarm = { name, scheduledTime: when }; },
      async clear() { nextAlarm = undefined; },
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: event() },
    tabs: {
      onActivated: event(),
      async query(options) {
        assert.deepEqual(options, { active: true, lastFocusedWindow: true });
        return [{ id: activeTabId }];
      },
      onRemoved: event(), onReplaced: event(), onUpdated: event(),
      async get(tabId) {
        if (!pages.has(tabId)) throw new Error('Tab was closed');
        return pages.get(tabId);
      },
      async reload(tabId) { refreshed.push(tabId); },
    },
  };
  const errors = [];
  t.mock.method(console, 'error', (label, ...args) => {
    if (label === 'Reloadstar:') errors.push(...args);
  });
  t.after(() => assert.deepEqual(errors, []));
  globalThis.chrome = chrome;
  t.after(() => { delete globalThis.chrome; });
  await import('../extension/background.js?worker=' + ++worker);
  function request(type, tabId = 1, fields = {}) {
    return new Promise(resolve => chrome.runtime.onMessage.fire({ type, tabId, ...fields }, { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') }, resolve));
  }
  async function fireAlarm() {
    const alarm = nextAlarm;
    nextAlarm = undefined;
    chrome.alarms.onAlarm.fire(alarm);
    await request('state');
  }
  function activate(tabId, windowChanged = false) {
    activeTabId = tabId;
    if (windowChanged) chrome.windows.onFocusChanged.fire(2);
    else chrome.tabs.onActivated.fire({ tabId, windowId: 1 });
  }
  return { request, fireAlarm, chrome, refreshed, badges, pages, activate,
    menuTitle: () => menuTitle, nextAlarm: () => nextAlarm };
}

test('page menu shows Start or Stop for the active tab and defaults to 30 seconds', async t => {
  const app = await setup(t);
  assert.equal((await app.request('state')).settings.interval, 30);
  assert.equal(app.menuTitle(), 'Reloadstar · Start');
  const menu = { menuItemId: 'toggle-refresh' };
  app.chrome.contextMenus.onClicked.fire(menu, { id: 1 });
  assert.equal((await app.request('state')).session.interval, 30);
  assert.equal((await app.request('state', 2)).session, null);
  assert.equal(app.nextAlarm().scheduledTime, 31_000);
  assert.equal(app.badges.get(1), 'ON');
  assert.equal(app.menuTitle(), 'Reloadstar · Stop');
  app.activate(2);
  await app.request('state', 2);
  assert.equal(app.menuTitle(), 'Reloadstar · Start');
  app.activate(1, true);
  await app.request('state');
  assert.equal(app.menuTitle(), 'Reloadstar · Stop');
  t.mock.timers.tick(30_000);
  await app.fireAlarm();
  assert.deepEqual(app.refreshed, [1]);
  app.chrome.contextMenus.onClicked.fire(menu, { id: 1 });
  assert.equal((await app.request('state')).session, null);
  assert.equal(app.nextAlarm(), undefined);
  assert.equal(app.badges.get(1), '');
  assert.equal(app.menuTitle(), 'Reloadstar · Start');
});

test('a running tab restores its badge during and after reload', async t => {
  const app = await setup(t);
  await app.request('start', 1, { interval: 30 });
  t.mock.timers.tick(30_000);
  await app.fireAlarm();
  assert.deepEqual(app.refreshed, [1]);

  // Chrome discards the tab-specific badge when the new document commits.
  app.badges.delete(1);
  app.chrome.tabs.onUpdated.fire(1, { status: 'loading' });
  await app.request('state');
  assert.equal(app.badges.get(1), 'ON');

  app.chrome.tabs.onUpdated.fire(1, { status: 'complete' });
  app.chrome.tabs.onUpdated.fire(2, { status: 'complete' });
  await app.request('state');
  assert.equal(app.badges.get(1), 'ON');
  assert.equal(app.badges.get(2), undefined);

  await app.request('stop');
  app.chrome.tabs.onUpdated.fire(1, { status: 'complete' });
  await app.request('state');
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

test('sessions stop when their tabs close or lose access', async t => {
  const app = await setup(t);
  await app.request('start', 1, { interval: 30 });
  await app.request('start', 2, { interval: 45 });
  app.pages.delete(1);
  app.chrome.tabs.onRemoved.fire(1);
  assert.equal((await app.request('state')).session, null);
  assert.equal((await app.request('state', 2)).session.interval, 45);

  app.pages.get(2).url = undefined;
  app.chrome.tabs.onUpdated.fire(2, { status: 'complete' });
  assert.equal((await app.request('state', 2)).session, null);
  assert.equal(app.badges.get(2), '');
  assert.equal(app.nextAlarm(), undefined);
});

test('upgrading removes the retired preference while retaining the interval', async t => {
  const app = await setup(t);
  await app.request('interval', 1, { interval: 45 });
  await app.chrome.storage.local.set({ keepAwake: true });
  app.chrome.runtime.onInstalled.fire({ reason: 'update' });
  assert.deepEqual((await app.request('state')).settings, { interval: 45 });
  assert.equal((await app.chrome.storage.local.get('keepAwake')).keepAwake, undefined);
});

test('a refresh session does not follow an independently authorized second site', async t => {
  const app = await setup(t);
  await app.request('start', 1, { interval: 30 });
  app.pages.get(1).url = 'https://example.com/another-page';
  app.chrome.tabs.onUpdated.fire(1, { status: 'complete' });
  assert.equal((await app.request('state')).session.interval, 30);

  app.pages.get(1).url = 'https://example.org/';
  app.chrome.tabs.onUpdated.fire(1, { status: 'loading' });
  assert.equal((await app.request('state')).session, null);
  assert.equal(app.badges.get(1), '');
  assert.deepEqual(app.refreshed, []);
});

test('a badge failure cannot interrupt other running tabs', async t => {
  const app = await setup(t);
  await app.request('start', 1, { interval: 30 });
  await app.request('start', 2, { interval: 30 });
  const setBadgeText = app.chrome.action.setBadgeText;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(app.chrome.action, 'setBadgeText', async update => {
    if (update.tabId === 1 && update.text === '') throw new Error('Badge unavailable');
    return setBadgeText(update);
  });
  app.pages.get(1).url = undefined;
  t.mock.timers.tick(30_000);
  await app.fireAlarm();
  assert.equal((await app.request('state')).session, null);
  assert.equal(app.nextAlarm().scheduledTime, 61_000);
  t.mock.timers.tick(30_000);
  await app.fireAlarm();
  assert.deepEqual(app.refreshed, [2, 2]);
});
