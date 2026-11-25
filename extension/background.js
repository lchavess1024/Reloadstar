import { defaults, powerPermission, validateInterval } from './preferences.js';

const menu = 'toggle-refresh';
const startMenuTitle = 'Reloadstar · Start';
const stopMenuTitle = 'Reloadstar · Stop';
const alarm = 'next-refresh';
const minimumAlarmMs = 30_000;
const website = /^https?:\/\//i;
let settings;
let sessions;
let timer;
let keepAwake;
let shownMenuTitle;
let work = Promise.resolve();

function enqueue(action) {
  const result = work.then(action);
  work = result.catch(() => {});
  return result;
}

function run(action) {
  enqueue(action).catch(error => console.error('Reloadstar:', error));
}

async function getTab(tabId) {
  return chrome.tabs.get(tabId).catch(() => null);
}

function canRefresh(tab) {
  return website.test(tab?.url ?? '');
}

async function updateBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: sessions[tabId] ? 'ON' : '' });
  } catch (error) {
    if (await getTab(tabId)) throw error;
  }
}

function runMenuAction(action) {
  return new Promise((resolve, reject) => {
    action(() => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function syncMenuTitle() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const title = sessions[tab?.id] ? stopMenuTitle : startMenuTitle;
  if (title === shownMenuTitle) return;

  try {
    await runMenuAction(done => chrome.contextMenus.update(menu, { title }, done));
    shownMenuTitle = title;
  } catch (error) {
    // The install event creates the menu if this worker starts before the first install.
    if (!error.message.startsWith('Cannot find menu item with id')) throw error;
  }
}

async function updatePower() {
  const requested = Object.keys(sessions).length > 0 && settings.keepAwake;
  const permitted = requested && await chrome.permissions.contains(powerPermission);
  if (permitted === keepAwake) return;
  if (permitted) chrome.power.requestKeepAwake('system');
  else chrome.power?.releaseKeepAwake();
  keepAwake = permitted;
}

async function schedule() {
  clearTimeout(timer);
  const next = Math.min(...Object.values(sessions).map(session => session.dueAt));
  if (!Number.isFinite(next)) {
    await chrome.alarms.clear(alarm);
    return;
  }

  const now = Date.now();
  const wakeAt = Math.max(next, now + minimumAlarmMs);
  const fallback = await chrome.alarms.get(alarm);
  if (!fallback || fallback.scheduledTime < now || fallback.scheduledTime > wakeAt) {
    await chrome.alarms.create(alarm, { when: wakeAt });
  }

  // Real reload work sustains short intervals while the service worker is alive.
  // A Chrome alarm restores scheduling if the worker stops or the machine sleeps.
  const delay = next - Date.now();
  if (delay < minimumAlarmMs) {
    timer = setTimeout(() => run(refreshDueTabs), Math.max(0, delay));
  }
}

async function saveSessions() {
  await chrome.storage.session.set({ sessions });
  await updatePower();
  await schedule();
}

async function start(tabId, interval) {
  const tab = await getTab(tabId);
  if (!canRefresh(tab)) throw new Error('Open a webpage to start auto-refresh.');
  sessions[tabId] = { interval, dueAt: Date.now() + interval * 1000 };
  await saveSessions();
  await updateBadge(tabId);
  await syncMenuTitle();
}

async function stop(tabId) {
  if (!sessions[tabId]) return;
  delete sessions[tabId];
  await saveSessions();
  await updateBadge(tabId);
  await syncMenuTitle();
}

async function refreshDueTabs() {
  const now = Date.now();
  const due = Object.entries(sessions).filter(([, session]) => session.dueAt <= now);
  let removedSession = false;
  await Promise.all(due.map(async ([id, session]) => {
    const tabId = Number(id);
    const tab = await getTab(tabId);
    if (!canRefresh(tab)) {
      delete sessions[id];
      removedSession = true;
      await updateBadge(tabId);
      return;
    }

    session.dueAt = now + session.interval * 1000;
    if (tab.status === 'loading') return;
    try {
      await chrome.tabs.reload(tabId);
    } catch (error) {
      console.warn('Reloadstar could not refresh a tab:', error.message);
    }
  }));
  if (due.length) await saveSessions();
  else await schedule();
  if (removedSession) await syncMenuTitle();
}

async function saveSettings(updates) {
  await chrome.storage.local.set(updates);
  Object.assign(settings, updates);
}

async function state(tabId) {
  const tab = await getTab(tabId);
  return { settings, session: sessions[tabId] ?? null, eligible: canRefresh(tab) };
}

async function handleRequest(request) {
  const { tabId, type } = request;
  switch (type) {
    case 'start': {
      const interval = validateInterval(request.interval);
      await start(tabId, interval);
      await saveSettings({ interval });
      break;
    }
    case 'stop':
      await stop(tabId);
      break;
    case 'interval': {
      const interval = validateInterval(request.interval);
      if (sessions[tabId]) await start(tabId, interval);
      await saveSettings({ interval });
      break;
    }
    case 'wake': {
      const enabled = request.enabled === true;
      if (enabled && !await chrome.permissions.contains(powerPermission)) {
        throw new Error('Chrome permission is needed to keep the device awake.');
      }
      await saveSettings({ keepAwake: enabled });
      await updatePower();
      break;
    }
    case 'state':
      break;
    default:
      throw new Error('Unrecognized Reloadstar action.');
  }
  return state(tabId);
}

chrome.runtime.onInstalled.addListener(() => run(async () => {
  await runMenuAction(done => chrome.contextMenus.removeAll(done));
  await runMenuAction(done => chrome.contextMenus.create({
    id: menu,
    title: startMenuTitle,
    contexts: ['all'],
    documentUrlPatterns: ['https://*/*', 'http://*/*'],
  }, done));
  shownMenuTitle = startMenuTitle;
  await syncMenuTitle();
  await chrome.action.setBadgeBackgroundColor({ color: '#38bdf8' });
  await chrome.action.setBadgeTextColor({ color: '#07111f' });
}));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== menu || tab?.id === undefined) return;
  run(() => sessions[tab.id] ? stop(tab.id) : start(tab.id, settings.interval));
});

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(request?.tabId)) return;
  enqueue(() => handleRequest(request)).then(
    result => respond(result),
    error => respond({ error: error.message }),
  );
  return true;
});

chrome.alarms.onAlarm.addListener(event => {
  if (event.name === alarm) run(refreshDueTabs);
});

chrome.runtime.onStartup.addListener(() => run(syncMenuTitle));
chrome.tabs.onActivated.addListener(() => run(syncMenuTitle));
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) run(syncMenuTitle);
});

chrome.tabs.onRemoved.addListener(tabId => run(() => stop(tabId)));
chrome.tabs.onReplaced.addListener((_, tabId) => run(() => stop(tabId)));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading' && change.status !== 'complete') return;
  run(async () => {
    if (!sessions[tabId]) return;
    if (change.status === 'complete' && !canRefresh(await getTab(tabId))) {
      await stop(tabId);
      return;
    }
    // Chrome clears tab-specific toolbar state when a navigation commits.
    await updateBadge(tabId);
  });
});

chrome.permissions.onRemoved.addListener(event => {
  if (!event.permissions?.includes('power')) return;
  run(async () => {
    await saveSettings({ keepAwake: false });
    await updatePower();
  });
});

// Load the state whenever Chrome starts a fresh service worker.
run(async () => {
  const [storedSettings, storedSession] = await Promise.all([
    chrome.storage.local.get(defaults),
    chrome.storage.session.get('sessions'),
  ]);
  settings = storedSettings;
  sessions = storedSession.sessions ?? {};
  await updatePower();
  await refreshDueTabs();
  await syncMenuTitle();
});
