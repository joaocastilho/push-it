import { defaultDeviceName, isSafeHttpUrl, isValidKeyB64 } from './crypto.js';

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const devicePill = document.getElementById('devicePill');
const deviceNameInput = document.getElementById('deviceNameInput');
const toastEl = document.getElementById('toast');
const setupBox = document.getElementById('setupBox');
const toggleSetupBtn = document.getElementById('toggleSetup');
const pairInput = document.getElementById('pairInput');
const savePairBtn = document.getElementById('savePair');
const autoOpenEl = document.getElementById('autoOpen');
const sendTabBtn = document.getElementById('sendTab');
const draftEl = document.getElementById('draft');
const sendDraftBtn = document.getElementById('sendDraft');
const clearBtn = document.getElementById('clearBtn');
const historyList = document.getElementById('historyList');

let currentDeviceOs = 'windows';
let currentDeviceName = 'Windows';
let toastTimer;

const OS_PATHS = {
  windows:
    'M3 5.5L10.8 4.4V11.5H3V5.5ZM11.8 4.25L21 3V11.5H11.8V4.25ZM3 12.5H10.8V19.6L3 18.5V12.5ZM11.8 12.5H21V21L11.8 19.75V12.5Z',
  android:
    'M17.6 9.48l1.84-3.18a.48.48 0 0 0-.18-.65.48.48 0 0 0-.65.18l-1.86 3.22a11.35 11.35 0 0 0-9.5 0L5.39 5.83a.48.48 0 0 0-.65-.18.48.48 0 0 0-.18.65L6.4 9.48A10.7 10.7 0 0 0 1 18.5h22a10.7 10.7 0 0 0-5.4-9.02zM7.5 15a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm9 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z',
  macos:
    'M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83zM13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z',
  ios: 'M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83zM13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z',
  linux:
    'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 5l3 3-3 3 1.4 1.4L12.8 12 8.4 7.6 7 9zm5 6h5v-2h-5v2z',
  other: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v10h16V7H4z',
};

function createOsSvg(os, size = 13) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', OS_PATHS[os] || OS_PATHS.other);
  svg.appendChild(path);
  return svg;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2400);
}

function renderDevicePill() {
  devicePill.innerHTML = '';
  devicePill.appendChild(createOsSvg(currentDeviceOs, 13));
  const span = document.createElement('span');
  span.textContent = currentDeviceName;
  devicePill.appendChild(span);
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  currentDeviceOs = state.deviceOs || 'windows';
  currentDeviceName = state.deviceName || defaultDeviceName(currentDeviceOs);
  renderDevicePill();

  statusDot.className = `dot ${state.paired ? state.status : 'disconnected'}`;
  statusText.textContent = !state.paired
    ? 'Not paired'
    : state.status === 'connected'
      ? 'Live E2EE'
      : state.status;
  autoOpenEl.checked = Boolean(state.autoOpen);

  if (!state.paired) {
    setupBox.classList.remove('hidden');
  }

  renderHistory(state.history || []);
}

function renderHistory(items) {
  historyList.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No messages yet.';
    historyList.appendChild(empty);
    return;
  }

  for (const item of items.slice(-20)) {
    const row = document.createElement('div');
    row.className = `bubble-row ${item.direction}`;

    const bubble = document.createElement('div');
    bubble.className = `bubble ${item.direction}`;

    const head = document.createElement('div');
    head.className = 'bubble-head';

    const sender = document.createElement('span');
    sender.className = 'sender-tag';
    const os = item.senderOs || (item.direction === 'out' ? currentDeviceOs : 'other');
    sender.appendChild(createOsSvg(os, 12));
    const nameSpan = document.createElement('span');
    nameSpan.textContent = item.senderName || (item.direction === 'out' ? currentDeviceName : 'Other device');
    sender.appendChild(nameSpan);
    head.appendChild(sender);

    const time = document.createElement('time');
    time.textContent = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    head.appendChild(time);
    bubble.appendChild(head);

    const text = document.createElement('div');
    text.className = 'bubble-text';
    text.textContent = item.content;
    bubble.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'bubble-actions';

    if (item.type === 'link' && isSafeHttpUrl(item.content)) {
      const openBtn = document.createElement('button');
      openBtn.className = 'chip primary';
      openBtn.textContent = 'Open';
      openBtn.onclick = () => chrome.tabs.create({ url: item.content, active: true });
      actions.appendChild(openBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'chip';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(item.content);
      showToast('Copied');
    };
    actions.appendChild(copyBtn);

    bubble.appendChild(actions);
    row.appendChild(bubble);
    historyList.appendChild(row);
  }

  historyList.scrollTop = historyList.scrollHeight;
}

devicePill.addEventListener('click', () => {
  devicePill.classList.add('hidden');
  deviceNameInput.value = currentDeviceName;
  deviceNameInput.classList.remove('hidden');
  deviceNameInput.focus();
  deviceNameInput.select();
});

async function commitDeviceName() {
  const next = deviceNameInput.value.trim() || defaultDeviceName(currentDeviceOs);
  currentDeviceName = next;
  await chrome.storage.local.set({ deviceName: next });
  deviceNameInput.classList.add('hidden');
  devicePill.classList.remove('hidden');
  renderDevicePill();
  showToast(`Device named "${next}"`);
}

deviceNameInput.addEventListener('blur', commitDeviceName);
deviceNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    deviceNameInput.blur();
  }
});

toggleSetupBtn.addEventListener('click', () => {
  setupBox.classList.toggle('hidden');
});

savePairBtn.addEventListener('click', async () => {
  const raw = pairInput.value.trim();
  try {
    const parsed = new URL(raw);
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const keyB64 = hashParams.get('key')?.trim() || '';
    if (!isValidKeyB64(keyB64)) {
      showToast('Pair link is missing a valid #key=...');
      return;
    }

    await chrome.storage.local.set({
      serverUrl: parsed.origin,
      keyB64,
    });
    pairInput.value = '';
    setupBox.classList.add('hidden');
    await chrome.runtime.sendMessage({ type: 'RECONNECT' });
    showToast('Paired and connecting...');
    setTimeout(refresh, 500);
  } catch {
    showToast('Paste the full pair URL (https://.../#key=...)');
  }
});

autoOpenEl.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoOpen: autoOpenEl.checked });
  showToast(autoOpenEl.checked ? 'Auto-open enabled' : 'Auto-open disabled');
});

sendTabBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !isSafeHttpUrl(tab.url)) {
    showToast('Active tab has no http/https URL');
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: 'SEND',
    content: tab.url,
    title: tab.title,
  });
  if (!res.ok) {
    showToast(res.error || 'Send failed');
    return;
  }
  showToast(`Sent (${res.result.wsDelivered} live, ${res.result.pushSent} push)`);
  refresh();
});

async function submitDraft() {
  const content = draftEl.value.trim();
  if (!content) return;
  const res = await chrome.runtime.sendMessage({ type: 'SEND', content });
  if (!res.ok) {
    showToast(res.error || 'Send failed');
    return;
  }
  draftEl.value = '';
  showToast(`Sent (${res.result.wsDelivered} live, ${res.result.pushSent} push)`);
  refresh();
}

sendDraftBtn.addEventListener('click', submitDraft);
draftEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitDraft();
  }
});

clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  refresh();
});

refresh();
