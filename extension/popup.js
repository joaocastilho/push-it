import { isSafeHttpUrl, isValidKeyB64 } from './crypto.js';

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
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

let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
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

  for (const item of items.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = `item ${item.direction}`;

    const text = document.createElement('div');
    text.className = 'item-text';
    text.textContent = item.content;
    row.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    if (item.type === 'link' && isSafeHttpUrl(item.content)) {
      const openBtn = document.createElement('button');
      openBtn.className = 'btn small primary';
      openBtn.textContent = 'Open';
      openBtn.onclick = () => chrome.tabs.create({ url: item.content, active: true });
      actions.appendChild(openBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn small secondary';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(item.content);
      showToast('Copied');
    };
    actions.appendChild(copyBtn);

    row.appendChild(actions);
    historyList.appendChild(row);
  }
}

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

sendDraftBtn.addEventListener('click', async () => {
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
});

clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  refresh();
});

refresh();
