import { maxInterval, powerPermission } from './preferences.js';

const byId = id => document.getElementById(id);
const form = byId('refresh-form');
const interval = byId('interval');
const start = byId('start');
const stop = byId('stop');
const save = byId('save');
const wake = byId('keep-awake');
const dialog = byId('settings');
const refreshError = byId('refresh-error');
const wakeError = byId('wake-error');
let tabId;
let current;
let busy = false;

function showError(node, message = '') {
  node.textContent = message;
  node.hidden = !message;
}

async function send(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId, ...fields });
  if (!result || result.error) throw new Error(result?.error ?? 'Reloadstar could not read this tab.');
  return result;
}

function renderInterval() {
  byId('timer-note').hidden = !interval.validity.valid || interval.valueAsNumber >= 30;
  save.hidden = !current?.session || interval.valueAsNumber === current.session.interval;
  save.disabled = busy || !interval.validity.valid;
}

function render() {
  const { eligible, session, settings } = current;
  interval.value = session?.interval ?? settings.interval;
  interval.disabled = !eligible;
  start.hidden = Boolean(session);
  start.disabled = busy || !eligible;
  stop.hidden = !session;
  stop.disabled = busy;
  wake.disabled = false;
  wake.checked = settings.keepAwake;
  byId('status').classList.toggle('is-running', Boolean(session));
  byId('status-text').textContent = session ? 'Auto-refresh is on for this tab' :
    eligible ? 'Auto-refresh is off for this tab' : 'Open a webpage to use auto-refresh';
  renderInterval();
}

async function changeRefresh(type) {
  if (busy || !current || (type !== 'stop' && !interval.reportValidity())) return;
  busy = true;
  start.disabled = stop.disabled = save.disabled = true;
  showError(refreshError);
  try {
    current = await send(type, { interval: interval.valueAsNumber });
  } catch (error) {
    showError(refreshError, error.message);
  } finally {
    busy = false;
    render();
  }
}

interval.max = maxInterval;
interval.addEventListener('input', renderInterval);
form.addEventListener('submit', event => {
  event.preventDefault();
  changeRefresh(current?.session ? 'interval' : 'start');
});
stop.addEventListener('click', () => changeRefresh('stop'));
save.addEventListener('click', () => changeRefresh('interval'));
byId('open-settings').addEventListener('click', () => dialog.showModal());

wake.addEventListener('change', async () => {
  const enabled = wake.checked;
  wake.disabled = true;
  showError(wakeError);
  try {
    if (enabled && !await chrome.permissions.request(powerPermission)) {
      throw new Error('Chrome permission is needed to keep the device awake.');
    }
    const result = await send('wake', { enabled });
    current.settings = result.settings;
  } catch (error) {
    showError(wakeError, error.message);
  } finally {
    wake.checked = current.settings.keepAwake;
    wake.disabled = false;
  }
});

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (!Number.isInteger(tabId)) throw new Error('No active Chrome tab found.');
  current = await send('state');
  render();
} catch (error) {
  byId('status-text').textContent = 'Auto-refresh is unavailable';
  showError(refreshError, error.message);
}
