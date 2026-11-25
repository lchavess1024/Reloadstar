import { defaults, validateInterval } from './preferences.js';

const menu = 'toggle-refresh';
const startMenuTitle = 'Reloadstar · Start';
const stopMenuTitle = 'Reloadstar · Stop';
const alarm = 'next-refresh';
const minimumAlarmMs = 30_000;
const website = /^https?:\/\//i;
let settings;
let sessions;
let timer;
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

async function siteFingerprint(tab) {
  if (!canRefresh(tab)) return null;
  const origin = new TextEncoder().encode(new URL(tab.url).origin);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', origin));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function updateBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: sessions[tabId] ? 'ON' : '' });
  } catch (error) {
    if (await getTab(tabId)) console.warn('Reloadstar could not update its toolbar badge:', error.message);
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
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const title = sessions[tab?.id] ? stopMenuTitle : startMenuTitle;
    if (title === shownMenuTitle) return;
    await runMenuAction(done => chrome.contextMenus.update(menu, { title }, done));
    shownMenuTitle = title;
  } catch (error) {
    // The install event creates the menu if this worker starts before the first install.
    if (!error.message.startsWith('Cannot find menu item with id')) {
      console.warn('Reloadstar could not update its page menu:', error.message);
    }
  }
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
  await schedule();
}

async function start(tabId, interval) {
  const site = await siteFingerprint(await getTab(tabId));
  if (!site) throw new Error('Open a webpage to start auto-refresh.');
  sessions[tabId] = { interval, dueAt: Date.now() + interval * 1000, site };
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
  const removedTabs = [];
  await Promise.all(due.map(async ([id, session]) => {
    const tabId = Number(id);
    const tab = await getTab(tabId);
    const site = await siteFingerprint(tab);
    if (!site || site !== session.site) {
      delete sessions[id];
      removedTabs.push(tabId);
      return;
    }

    session.dueAt = now + session.interval * 1000;
    if (tab.status === 'loading' || tab.pendingUrl) return;
    try {
      await chrome.tabs.reload(tabId);
    } catch (error) {
      console.warn('Reloadstar could not refresh a tab:', error.message);
    }
  }));
  if (due.length) await saveSessions();
  else await schedule();
  if (removedTabs.length) {
    await Promise.all(removedTabs.map(updateBadge));
    await syncMenuTitle();
  }
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
      if (sessions[tabId]) {
        const site = await siteFingerprint(await getTab(tabId));
        if (!site || site !== sessions[tabId].site) await stop(tabId);
        else {
          sessions[tabId].interval = interval;
          sessions[tabId].dueAt = Date.now() + interval * 1000;
          await saveSessions();
        }
      }
      await saveSettings({ interval });
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
  await chrome.storage.local.remove('keepAwake');
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
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') ||
      !Number.isInteger(request?.tabId) || request.tabId < 0) return;
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
    const session = sessions[tabId];
    if (!session) return;
    const site = await siteFingerprint(await getTab(tabId));
    if (!site && change.status === 'loading') return;
    if (!site || site !== session.site) {
      await stop(tabId);
      return;
    }
    // Chrome clears tab-specific toolbar state when a navigation commits.
    await updateBadge(tabId);
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
  await refreshDueTabs();
  await syncMenuTitle();
});
