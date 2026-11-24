import { defaults, powerPermission, validateInterval } from './preferences.js';

const menu = 'toggle-refresh';
const alarm = 'next-refresh';
const minimumAlarmMs = 30_000;
const website = /^https?:\/\//i;
let settings;
let sessions;
let timer;
let keepAwake;
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
}

async function stop(tabId) {
  if (!sessions[tabId]) return;
  delete sessions[tabId];
  await saveSessions();
  await updateBadge(tabId);
}

async function refreshDueTabs() {
  const now = Date.now();
  const due = Object.entries(sessions).filter(([, session]) => session.dueAt <= now);
  await Promise.all(due.map(async ([id, session]) => {
    const tabId = Number(id);
    const tab = await getTab(tabId);
    if (!canRefresh(tab)) {
      delete sessions[id];
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

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.error('Reloadstar:', chrome.runtime.lastError.message);
      return;
    }
    chrome.contextMenus.create({
      id: menu,
      title: 'Reloadstar · Start / stop auto-refresh',
      contexts: ['all'],
      documentUrlPatterns: ['https://*/*', 'http://*/*'],
    });
  });
  await chrome.action.setBadgeBackgroundColor({ color: '#38bdf8' });
  await chrome.action.setBadgeTextColor({ color: '#07111f' });
});

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

chrome.tabs.onRemoved.addListener(tabId => run(() => stop(tabId)));
chrome.tabs.onReplaced.addListener((_, tabId) => run(() => stop(tabId)));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'complete' || !sessions?.[tabId]) return;
  run(async () => {
    if (sessions[tabId] && !canRefresh(await getTab(tabId))) await stop(tabId);
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
});
