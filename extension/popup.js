import { toDataURL as qrToDataURL } from './qrcode.js';
import { clearExtBlobs, getExtBlob, saveExtBlob } from './db.js';
import {
  blobAad,
  decryptBytes,
  defaultDeviceName,
  deriveRoomId,
  DEVICE_COLOR_OPTIONS,
  deviceColorIndex,
  formatFileSize,
  formatRelativeTime,
  formatRemainingTime,
  isSafeHttpUrl,
  makeAuthHeader,
} from './crypto.js';

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const toggleSearchBtn = document.getElementById('toggleSearch');
const searchBar = document.getElementById('searchBar');
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
const devicePill = document.getElementById('devicePill');
const toggleSettingsBtn = document.getElementById('toggleSettings');
const toastEl = document.getElementById('toast');
const setupView = document.getElementById('setupView');
const setupNoticeBanner = document.getElementById('setupNoticeBanner');
const serverUrlCard = document.getElementById('serverUrlCard');
const serverFooter = document.getElementById('serverFooter');
const serverFooterHost = document.getElementById('serverFooterHost');
const changeServerBtn = document.getElementById('changeServerBtn');
const setupVersionText = document.getElementById('setupVersionText');
const settingsView = document.getElementById('settingsView');
const chatView = document.getElementById('chatView');
const noticeBanner = document.getElementById('noticeBanner');
const devicesHeading = document.getElementById('devicesHeading');
const deviceList = document.getElementById('deviceList');
const inviteBtn = document.getElementById('inviteBtn');
const inviteBox = document.getElementById('inviteBox');
const inviteTimerEl = document.getElementById('inviteTimer');
const inviteCodeDisplay = document.getElementById('inviteCodeDisplay');
const copyCodeBtn = document.getElementById('copyCodeBtn');
const inviteQrWrap = document.getElementById('inviteQrWrap');
const inviteQrImg = document.getElementById('inviteQrImg');
const inviteOutput = document.getElementById('inviteOutput');
const copyInviteBtn = document.getElementById('copyInviteBtn');
const cancelInviteBtn = document.getElementById('cancelInviteBtn');
const soloBanner = document.getElementById('soloBanner');
const soloAddDeviceBtn = document.getElementById('soloAddDeviceBtn');
const toggleLinkModeBtn = document.getElementById('toggleLinkMode');
const pairByCode = document.getElementById('pairByCode');
const pairByLink = document.getElementById('pairByLink');
const serverUrlInput = document.getElementById('serverUrlInput');
const pairCodeInput = document.getElementById('pairCodeInput');
const pairInput = document.getElementById('pairInput');
const roomPinBox = document.getElementById('roomPinBox');
const roomPinInput = document.getElementById('roomPinInput');
const savePairBtn = document.getElementById('savePair');
const createPinToggle = document.getElementById('createPinToggle');
const createPinInput = document.getElementById('createPinInput');
const accessKeyInput = document.getElementById('accessKeyInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const autoOpenEl = document.getElementById('autoOpen');
const targetBar = document.getElementById('targetBar');
const sendTabBtn = document.getElementById('sendTab');
const burnControl = document.getElementById('burnControl');
const burnLabelEl = document.getElementById('burnLabel');
const burnSelect = document.getElementById('burnSelect');
const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');
const draftEl = document.getElementById('draft');
const sendDraftBtn = document.getElementById('sendDraft');
const clearBtn = document.getElementById('clearBtn');
const leaveRow = document.getElementById('leaveRow');
const leaveBtn = document.getElementById('leaveBtn');
const versionText = document.getElementById('versionText');
const updateHint = document.getElementById('updateHint');
const historyList = document.getElementById('historyList');
const extVersion = chrome.runtime.getManifest().version;
versionText.textContent = `Version v${extVersion}`;
setupVersionText.textContent = `Version v${extVersion}`;

let myDeviceId = '';
let currentDeviceToken = '';
let currentDeviceOs = 'windows';
let currentDeviceName = 'Windows';
let currentServerUrl = '';
let currentKeyB64 = '';
let pairedDevices = [];
let selectedTargetIds = [];
let isPairedState = false;
let showingSettings = false;
let showingServerEditor = false;
let pairMode = 'code';
let activeInviteCode = '';
let pendingResolved = null;
let allHistory = [];
let searchQuery = '';
let burnMs = 0;
let toastTimer;
let inviteInterval;
const blobObjectUrls = new Map();

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

function setView(showSettings) {
  showingSettings = showSettings;
  if (!isPairedState) {
    setupView.classList.remove('hidden');
    settingsView.classList.add('hidden');
    chatView.classList.add('hidden');
    devicePill.classList.add('hidden');
    toggleSearchBtn.classList.add('hidden');
    toggleSettingsBtn.classList.add('hidden');
    return;
  }
  setupView.classList.add('hidden');
  settingsView.classList.toggle('hidden', !showSettings);
  chatView.classList.toggle('hidden', showSettings);
  devicePill.classList.toggle('hidden', showSettings);
  toggleSearchBtn.classList.toggle('hidden', showSettings);
  toggleSettingsBtn.classList.remove('hidden');
  toggleSettingsBtn.textContent = showSettings ? '← Back' : 'Settings';
}

function updateServerUrlVisibility() {
  const hasServer = Boolean(currentServerUrl);
  // Hide the Push It URL input completely when we already know the server (unless user clicks "Change server")
  const needInput = (!hasServer && pairMode === 'code') || showingServerEditor;
  serverUrlCard.classList.toggle('hidden', !needInput);
  if (hasServer && !showingServerEditor) {
    try {
      serverFooterHost.textContent = new URL(currentServerUrl).host;
    } catch {
      serverFooterHost.textContent = currentServerUrl;
    }
    serverFooter.classList.remove('hidden');
  } else {
    serverFooter.classList.add('hidden');
  }
}

function createCopySvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', '9');
  rect.setAttribute('y', '9');
  rect.setAttribute('width', '13');
  rect.setAttribute('height', '13');
  rect.setAttribute('rx', '2');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
  svg.appendChild(rect);
  svg.appendChild(path);
  return svg;
}

function createTrashSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [
    'M3 6h18',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  ]) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function renderDevicePill() {
  devicePill.innerHTML = '';
  devicePill.appendChild(createOsSvg(currentDeviceOs, 13));
  const span = document.createElement('span');
  span.textContent = currentDeviceName;
  devicePill.appendChild(span);
}

function renderTargetBar() {
  const others = pairedDevices.filter((d) => d.deviceId !== myDeviceId);
  if (others.length < 2) {
    targetBar.classList.add('hidden');
    selectedTargetIds = [];
    return;
  }

  targetBar.classList.remove('hidden');
  targetBar.innerHTML = '';

  const lbl = document.createElement('span');
  lbl.className = 'target-label';
  lbl.textContent = 'To:';
  targetBar.appendChild(lbl);

  const allBtn = document.createElement('button');
  allBtn.className = `target-pill ${selectedTargetIds.length === 0 ? 'active' : ''}`;
  allBtn.textContent = 'All';
  allBtn.onclick = () => {
    selectedTargetIds = [];
    renderTargetBar();
  };
  targetBar.appendChild(allBtn);

  for (const dev of others) {
    const btn = document.createElement('button');
    btn.className = `target-pill ${selectedTargetIds.includes(dev.deviceId) ? 'active' : ''}`;
    btn.appendChild(createOsSvg(dev.os, 11));
    const s = document.createElement('span');
    s.textContent = dev.name;
    btn.appendChild(s);
    btn.onclick = () => {
      if (selectedTargetIds.includes(dev.deviceId)) {
        selectedTargetIds = selectedTargetIds.filter((id) => id !== dev.deviceId);
      } else {
        selectedTargetIds = [...selectedTargetIds, dev.deviceId];
      }
      renderTargetBar();
    };
    targetBar.appendChild(btn);
  }
}

function getDeviceColor(senderId, fallback) {
  if (senderId) {
    const match = pairedDevices.find((d) => d.deviceId === senderId);
    if (typeof match?.color === 'number') return match.color;
  }
  return deviceColorIndex(senderId || fallback);
}

function renderDeviceList() {
  devicesHeading.textContent = `Devices (${pairedDevices.length})`;
  deviceList.innerHTML = '';

  for (const dev of pairedDevices) {
    const isSelf = dev.deviceId === myDeviceId;
    const row = document.createElement('div');
    row.className = 'device-row';

    const mainRow = document.createElement('div');
    mainRow.className = 'device-row-main';

    const info = document.createElement('div');
    info.className = 'device-info';

    const dot = document.createElement('span');
    dot.className = `dot ${dev.online || isSelf ? 'connected' : 'disconnected'}`;
    info.appendChild(dot);
    info.appendChild(createOsSvg(dev.os, 13));

    const textCol = document.createElement('div');
    textCol.className = 'device-meta-col';

    const nameEl = document.createElement('span');
    nameEl.className = 'device-name';
    nameEl.textContent = isSelf ? `${dev.name} (You)` : dev.name;
    textCol.appendChild(nameEl);

    const actEl = document.createElement('span');
    actEl.className = 'device-activity';
    actEl.textContent =
      dev.online || isSelf ? 'Online' : formatRelativeTime(dev.lastSeenAt || dev.updatedAt);
    textCol.appendChild(actEl);

    info.appendChild(textCol);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'chip';
    renameBtn.textContent = 'Rename';
    renameBtn.onclick = () => {
      mainRow.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 24;
      input.value = dev.name;
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn primary small';
      saveBtn.textContent = 'Save';
      const commit = async () => {
        const nextName = input.value.trim() || defaultDeviceName(dev.os);
        await chrome.runtime.sendMessage({
          type: 'RENAME_DEVICE',
          deviceId: dev.deviceId,
          name: nextName,
          os: dev.os,
          color: dev.color,
        });
        showToast(`Renamed to "${nextName}"`);
        refresh();
      };
      saveBtn.onclick = commit;
      input.onkeydown = (e) => {
        if (e.key === 'Enter') commit();
      };
      mainRow.appendChild(input);
      mainRow.appendChild(saveBtn);
      input.focus();
      input.select();
    };
    actions.appendChild(renameBtn);

    if (!isSelf) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chip danger';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = async () => {
        await chrome.runtime.sendMessage({
          type: 'REMOVE_DEVICE',
          deviceId: dev.deviceId,
        });
        showToast(`Removed "${dev.name}"`);
        refresh();
      };
      actions.appendChild(removeBtn);
    }

    mainRow.appendChild(info);
    mainRow.appendChild(actions);
    row.appendChild(mainRow);

    const colorRow = document.createElement('div');
    colorRow.className = 'device-color-row';
    const colorLbl = document.createElement('span');
    colorLbl.className = 'device-color-label';
    colorLbl.textContent = 'Chat color:';
    colorRow.appendChild(colorLbl);

    const swatches = document.createElement('div');
    swatches.className = 'color-swatches';
    const activeColor = typeof dev.color === 'number' ? dev.color : deviceColorIndex(dev.deviceId);
    for (const opt of DEVICE_COLOR_OPTIONS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = `color-swatch ${activeColor === opt.index ? 'active' : ''}`;
      sw.style.setProperty('--swatch', opt.swatch);
      sw.title = opt.name;
      sw.setAttribute('aria-label', `${opt.name} color`);
      sw.setAttribute('aria-pressed', String(activeColor === opt.index));
      sw.onclick = async () => {
        dev.color = opt.index;
        renderDeviceList();
        renderHistory(allHistory);
        await chrome.runtime.sendMessage({
          type: 'SET_DEVICE_COLOR',
          deviceId: dev.deviceId,
          name: dev.name,
          os: dev.os,
          color: opt.index,
        });
        showToast(`${dev.name} color set to ${opt.name}`);
        refresh();
      };
      swatches.appendChild(sw);
    }
    colorRow.appendChild(swatches);
    row.appendChild(colorRow);

    deviceList.appendChild(row);
  }
}

async function ensureExtBlobUrl(item) {
  if (!item.blobId || !item.blobIv || !currentServerUrl || !currentKeyB64 || !myDeviceId || !currentDeviceToken) {
    return null;
  }
  if (blobObjectUrls.has(item.blobId)) {
    return blobObjectUrls.get(item.blobId);
  }
  let cached = await getExtBlob(item.blobId).catch(() => null);
  if (!cached) {
    try {
      const roomId = await deriveRoomId(currentKeyB64);
      const base = new URL(currentServerUrl);
      const res = await fetch(
        `${base.origin}/api/room/${encodeURIComponent(roomId)}/blob/${encodeURIComponent(item.blobId)}`,
        { headers: { authorization: makeAuthHeader(myDeviceId, currentDeviceToken) } },
      );
      if (!res.ok) return null;
      const cipher = new Uint8Array(await res.arrayBuffer());
      const plain = await decryptBytes(
        currentKeyB64,
        item.blobIv,
        cipher,
        blobAad(roomId, item.blobId),
      );
      const copyBuf = plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
      cached = {
        id: item.blobId,
        data: copyBuf,
        mimeType: item.mimeType || 'application/octet-stream',
        fileName: item.fileName || 'file',
      };
      await saveExtBlob(cached).catch(() => {});
    } catch {
      return null;
    }
  }
  const url = URL.createObjectURL(new Blob([cached.data], { type: cached.mimeType }));
  blobObjectUrls.set(item.blobId, url);
  return url;
}

async function downloadFileItem(item) {
  const url = await ensureExtBlobUrl(item);
  if (!url) {
    showToast('File already expired or downloaded');
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = item.fileName || 'file';
  a.click();
}

function clearInviteUi() {
  if (inviteInterval) {
    clearInterval(inviteInterval);
    inviteInterval = null;
  }
  activeInviteCode = '';
  inviteCodeDisplay.textContent = '--- – ---';
  inviteQrWrap.classList.add('hidden');
  inviteQrImg.src = '';
  inviteBox.classList.add('hidden');
  inviteOutput.value = '';
}

function setPairMode(mode) {
  pairMode = mode;
  pendingResolved = null;
  roomPinBox.classList.add('hidden');
  roomPinInput.value = '';
  pairByCode.classList.toggle('hidden', mode !== 'code');
  pairByLink.classList.toggle('hidden', mode !== 'link');
  toggleLinkModeBtn.textContent =
    mode === 'code' ? 'Or paste an invite link' : 'Use 6-digit pairing code instead';
  updateServerUrlVisibility();
}

function startInviteCountdown(expiresAt) {
  if (inviteInterval) clearInterval(inviteInterval);
  const tick = () => {
    const secs = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    inviteTimerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    if (secs <= 0) {
      clearInviteUi();
      showToast('Invite expired');
    }
  };
  tick();
  inviteInterval = setInterval(tick, 1000);
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  myDeviceId = state.deviceId || '';
  currentDeviceToken = state.deviceToken || '';
  currentDeviceOs = state.deviceOs || 'windows';
  currentDeviceName = state.deviceName || defaultDeviceName(currentDeviceOs);
  currentServerUrl = state.serverUrl || '';
  if (currentServerUrl && !serverUrlInput.value) {
    serverUrlInput.value = currentServerUrl;
  }
  currentKeyB64 = state.keyB64 || '';
  pairedDevices = Array.isArray(state.devices) ? state.devices : [];
  renderDevicePill();
  renderDeviceList();
  renderTargetBar();
  soloBanner.classList.toggle('hidden', !state.paired || pairedDevices.length !== 1);

  isPairedState = Boolean(state.paired);
  statusDot.className = `dot ${isPairedState ? state.status : 'disconnected'}`;
  statusText.textContent = !isPairedState
    ? 'Not paired'
    : state.status === 'connected'
      ? 'Connected'
      : state.status === 'connecting'
        ? 'Connecting...'
        : 'Offline';
  autoOpenEl.checked = Boolean(state.autoOpen);

  if (state.revokedNotice) {
    setupNoticeBanner.textContent = state.revokedNotice;
    setupNoticeBanner.classList.remove('hidden');
    noticeBanner.textContent = state.revokedNotice;
    noticeBanner.classList.remove('hidden');
  } else {
    setupNoticeBanner.classList.add('hidden');
    noticeBanner.classList.add('hidden');
  }

  if (!isPairedState) {
    clearInviteUi();
    updateServerUrlVisibility();
    setView(false);
  } else {
    setView(showingSettings);
    if (currentServerUrl) {
      fetch(`${new URL(currentServerUrl).origin}/api/version`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.version && d.version !== extVersion) {
            updateHint.textContent = `v${d.version} available · reload extension`;
            updateHint.classList.remove('hidden');
          } else {
            updateHint.classList.add('hidden');
          }
        })
        .catch(() => {});
    }
  }

  allHistory = Array.isArray(state.history) ? state.history : [];
  renderHistory(allHistory);
}

function renderHistory(items) {
  historyList.innerHTML = '';
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? items.filter((m) => {
        const hay = [
          m.content,
          m.title,
          m.fileName,
          m.senderName,
          ...(Array.isArray(m.targetNames) ? m.targetNames : []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
    : items;

  if (q) {
    searchCount.textContent = `${filtered.length}/${items.length}`;
    searchCount.classList.remove('hidden');
  } else {
    searchCount.classList.add('hidden');
  }

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = q ? `No messages matching "${searchQuery.trim()}".` : 'Nothing pushed yet.';
    historyList.appendChild(empty);
    return;
  }

  const visible = q ? filtered : filtered.slice(-40);
  for (const item of visible) {
    const row = document.createElement('div');
    row.className = `bubble-row ${item.direction}`;

    const colorIdx = getDeviceColor(item.senderId, item.senderName);
    const bubble = document.createElement('div');
    bubble.className = `bubble ${item.direction} dev-c${colorIdx}`;

    if (item.type !== 'file') {
      bubble.addEventListener('click', async (e) => {
        if (window.getSelection()?.toString().trim()) return;
        if (e.target.closest('a, button, input')) return;
        await navigator.clipboard.writeText(item.content).catch(() => {});
        showToast('Copied to clipboard');
      });
    }

    const head = document.createElement('div');
    head.className = 'bubble-head';

    const sender = document.createElement('span');
    sender.className = 'sender-tag';
    const os = item.senderOs || (item.direction === 'out' ? currentDeviceOs : 'other');
    sender.appendChild(createOsSvg(os, 12));
    const nameSpan = document.createElement('span');
    const baseName =
      item.senderName || (item.direction === 'out' ? currentDeviceName : 'Other device');
    const toSuffix =
      Array.isArray(item.targetNames) && item.targetNames.length > 0
        ? ` → ${item.targetNames.join(', ')}`
        : '';
    nameSpan.textContent = `${baseName}${toSuffix}`;
    sender.appendChild(nameSpan);
    head.appendChild(sender);

    const metaRight = document.createElement('span');
    metaRight.className = 'meta-right';
    if (item.expiresAt && item.expiresAt > Date.now()) {
      const burn = document.createElement('span');
      burn.className = 'burn-badge';
      burn.textContent = `🔥 ${formatRemainingTime(item.expiresAt)}`;
      burn.title = 'Auto-expires';
      metaRight.appendChild(burn);
    }
    const time = document.createElement('time');
    time.textContent = new Date(item.ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    metaRight.appendChild(time);

    if (item.direction === 'out') {
      const check = document.createElement('span');
      check.className = `check ${item.status === 'delivered' ? 'delivered' : ''}`;
      check.textContent = item.status === 'delivered' ? '✓✓' : '✓';
      check.title = item.status === 'delivered' ? 'Delivered' : 'Queued';
      metaRight.appendChild(check);
    }

    head.appendChild(metaRight);
    bubble.appendChild(head);

    if (item.type === 'link' && isSafeHttpUrl(item.content)) {
      const link = document.createElement('a');
      link.className = 'bubble-link';
      link.href = item.content;
      link.textContent = item.content;
      link.onclick = (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: item.content, active: true });
      };
      bubble.appendChild(link);
    } else if (item.type === 'file') {
      const fileWrap = document.createElement('div');
      fileWrap.className = 'file-card';
      if (item.mimeType?.startsWith('image/') && item.blobId) {
        const imgLink = document.createElement('a');
        imgLink.className = 'photo-link hidden';
        const img = document.createElement('img');
        img.className = 'photo-preview';
        img.alt = item.fileName || 'Photo';
        imgLink.appendChild(img);
        imgLink.onclick = (e) => {
          e.preventDefault();
          if (imgLink.href) chrome.tabs.create({ url: imgLink.href, active: true });
        };
        fileWrap.appendChild(imgLink);
        ensureExtBlobUrl(item).then((url) => {
          if (url) {
            img.src = url;
            imgLink.href = url;
            imgLink.classList.remove('hidden');
            historyList.scrollTop = historyList.scrollHeight;
          }
        });
      }
      const text = document.createElement('div');
      text.className = 'bubble-text';
      text.textContent = `${item.fileName || item.content}${item.fileSize ? ` (${formatFileSize(item.fileSize)})` : ''}`;
      fileWrap.appendChild(text);
      bubble.appendChild(fileWrap);
    } else {
      const text = document.createElement('div');
      text.className = 'bubble-text';
      text.textContent = item.content;
      bubble.appendChild(text);
    }

    const actions = document.createElement('div');
    actions.className = 'bubble-actions';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'bubble-actions-group';

    if (item.type === 'file') {
      const dlBtn = document.createElement('button');
      dlBtn.className = 'chip primary';
      dlBtn.textContent = 'Download';
      dlBtn.onclick = () => downloadFileItem(item);
      leftGroup.appendChild(dlBtn);
    } else if (item.type === 'link' && isSafeHttpUrl(item.content)) {
      const openBtn = document.createElement('button');
      openBtn.className = 'chip primary';
      openBtn.textContent = 'Open';
      openBtn.onclick = () => chrome.tabs.create({ url: item.content, active: true });
      leftGroup.appendChild(openBtn);
    }

    if (item.type !== 'file') {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'icon-chip';
      copyBtn.title = 'Copy to clipboard';
      copyBtn.appendChild(createCopySvg());
      const copyLbl = document.createElement('span');
      copyLbl.textContent = 'Copy';
      copyBtn.appendChild(copyLbl);
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(item.content);
        showToast('Copied to clipboard');
      };
      leftGroup.appendChild(copyBtn);
    }

    const rightGroup = document.createElement('div');
    rightGroup.className = 'bubble-actions-group';

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-chip danger';
    delBtn.title = 'Delete message';
    delBtn.setAttribute('aria-label', 'Delete message');
    delBtn.appendChild(createTrashSvg());
    delBtn.onclick = (e) => {
      e.stopPropagation();
      rightGroup.innerHTML = '';
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'icon-chip danger';
      confirmBtn.textContent = 'Delete?';
      confirmBtn.onclick = async (ev) => {
        ev.stopPropagation();
        await chrome.runtime.sendMessage({ type: 'DELETE_MESSAGE', id: item.id });
        allHistory = allHistory.filter((m) => m.id !== item.id);
        showToast('Message deleted');
        renderHistory(allHistory);
      };
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'icon-chip';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = (ev) => {
        ev.stopPropagation();
        renderHistory(allHistory);
      };
      rightGroup.appendChild(confirmBtn);
      rightGroup.appendChild(cancelBtn);
    };
    rightGroup.appendChild(delBtn);

    actions.appendChild(leftGroup);
    actions.appendChild(rightGroup);
    bubble.appendChild(actions);
    row.appendChild(bubble);
    historyList.appendChild(row);
  }

  historyList.scrollTop = historyList.scrollHeight;
}

toggleSettingsBtn.addEventListener('click', () => {
  setView(!showingSettings);
});

toggleSearchBtn.addEventListener('click', () => {
  const willOpen = searchBar.classList.contains('hidden');
  searchBar.classList.toggle('hidden', !willOpen);
  toggleSearchBtn.classList.toggle('active', willOpen);
  if (willOpen) {
    searchInput.focus();
  } else {
    searchQuery = '';
    searchInput.value = '';
    renderHistory(allHistory);
  }
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderHistory(allHistory);
});

devicePill.addEventListener('click', () => {
  setView(true);
});

toggleLinkModeBtn.addEventListener('click', () => {
  setPairMode(pairMode === 'code' ? 'link' : 'code');
});

changeServerBtn.addEventListener('click', () => {
  showingServerEditor = !showingServerEditor;
  updateServerUrlVisibility();
  if (showingServerEditor) serverUrlInput.focus();
});

createPinToggle.addEventListener('change', () => {
  createPinInput.classList.toggle('hidden', !createPinToggle.checked);
  if (!createPinToggle.checked) createPinInput.value = '';
});

createRoomBtn.addEventListener('click', async () => {
  const serverUrl = (serverUrlInput.value || currentServerUrl || '').trim();
  if (!serverUrl) {
    showingServerEditor = true;
    updateServerUrlVisibility();
    serverUrlInput.focus();
    showToast('Enter your Push It website URL once');
    return;
  }
  const roomPin = createPinToggle.checked ? createPinInput.value.replace(/\D/g, '') : '';
  if (createPinToggle.checked && roomPin.length !== 6) {
    showToast('Enter a 6-digit Room PIN');
    return;
  }
  const accessKey = accessKeyInput.value.trim();

  createRoomBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'CREATE_ROOM',
      serverUrl,
      roomPin: roomPin || undefined,
      accessKey: accessKey || undefined,
    });
    if (!res.ok) {
      if (res.accessKeyRequired) {
        accessKeyInput.classList.remove('hidden');
        accessKeyInput.focus();
      }
      showToast(res.error || 'Could not create room');
      return;
    }
    showingServerEditor = false;
    createPinToggle.checked = false;
    createPinInput.value = '';
    createPinInput.classList.add('hidden');
    accessKeyInput.value = '';
    accessKeyInput.classList.add('hidden');
    showingSettings = false;
    showToast('New private room created!');
    setTimeout(refresh, 350);
  } catch {
    showToast('Could not create room');
  } finally {
    createRoomBtn.disabled = false;
  }
});

async function openAndGenerateInvite() {
  inviteBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CREATE_INVITE' });
    if (!res.ok) {
      showToast(res.error || 'Could not create invite');
      return;
    }
    activeInviteCode = res.pairCode || '';
    inviteCodeDisplay.textContent = activeInviteCode
      ? `${activeInviteCode.slice(0, 3)} – ${activeInviteCode.slice(3)}`
      : '--- – ---';
    inviteOutput.value = res.inviteUrl;
    inviteBox.classList.remove('hidden');
    startInviteCountdown(res.expiresAt);
    try {
      const qrData = await qrToDataURL(res.inviteUrl, {
        width: 180,
        margin: 2,
        color: { dark: '#0b0f19', light: '#ffffff' },
      });
      inviteQrImg.src = qrData;
      inviteQrWrap.classList.remove('hidden');
    } catch {
      inviteQrWrap.classList.add('hidden');
    }
    showToast('Single-use invite ready');
  } finally {
    inviteBtn.disabled = false;
  }
}

inviteBtn.addEventListener('click', openAndGenerateInvite);

soloAddDeviceBtn.addEventListener('click', () => {
  setView(true);
  openAndGenerateInvite();
});

copyCodeBtn.addEventListener('click', async () => {
  if (!activeInviteCode) return;
  await navigator.clipboard.writeText(activeInviteCode);
  showToast('6-digit code copied');
});

copyInviteBtn.addEventListener('click', async () => {
  if (!inviteOutput.value) return;
  await navigator.clipboard.writeText(inviteOutput.value);
  showToast('Invite link copied');
});

cancelInviteBtn.addEventListener('click', async () => {
  clearInviteUi();
  await chrome.runtime.sendMessage({ type: 'CANCEL_INVITE' }).catch(() => {});
  showToast('Invite cancelled');
});

savePairBtn.addEventListener('click', async () => {
  const roomPin = roomPinInput.value.replace(/\D/g, '');
  savePairBtn.disabled = true;
  try {
    let res;
    if (pendingResolved) {
      res = await chrome.runtime.sendMessage({
        type: 'JOIN_RESOLVED',
        origin: pendingResolved.origin,
        keyB64: pendingResolved.keyB64,
        inviteToken: pendingResolved.inviteToken,
        roomPin,
      });
    } else if (pairMode === 'code') {
      const serverUrl = (serverUrlInput.value || currentServerUrl || '').trim();
      const code = pairCodeInput.value.replace(/\D/g, '');
      if (!serverUrl) {
        showingServerEditor = true;
        updateServerUrlVisibility();
        serverUrlInput.focus();
        showToast('Enter your Push It website URL once');
        return;
      }
      if (code.length !== 6) {
        showToast('Enter all 6 digits of the pairing code');
        return;
      }
      res = await chrome.runtime.sendMessage({
        type: 'JOIN_BY_CODE',
        serverUrl,
        code,
        roomPin: roomPin || undefined,
      });
    } else {
      const raw = pairInput.value.trim();
      if (!raw) return;
      res = await chrome.runtime.sendMessage({
        type: 'JOIN_ROOM',
        rawLink: raw,
        roomPin: roomPin || undefined,
      });
    }

    if (!res.ok) {
      if (res.pinRequired) {
        if (res.resolved) pendingResolved = res.resolved;
        roomPinBox.classList.remove('hidden');
        roomPinInput.focus();
      }
      showToast(res.error || 'Invite is invalid or expired');
      return;
    }

    pendingResolved = null;
    showingServerEditor = false;
    pairInput.value = '';
    pairCodeInput.value = '';
    roomPinInput.value = '';
    roomPinBox.classList.add('hidden');
    showingSettings = false;
    showToast('Paired!');
    setTimeout(refresh, 400);
  } catch {
    showToast('Could not pair right now');
  } finally {
    savePairBtn.disabled = false;
  }
});

leaveBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
  showToast('Left room');
  refresh();
});

autoOpenEl.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoOpen: autoOpenEl.checked });
  showToast(autoOpenEl.checked ? 'Auto-open on' : 'Auto-open off');
});

function getSelectedTargetsPayload() {
  const extra = burnMs > 0 ? { expiresInMs: burnMs } : {};
  if (!selectedTargetIds.length) return extra;
  const names = pairedDevices
    .filter((d) => selectedTargetIds.includes(d.deviceId))
    .map((d) => d.name);
  return { targetIds: selectedTargetIds, targetNames: names, ...extra };
}

burnSelect.addEventListener('change', () => {
  burnMs = Number(burnSelect.value) || 0;
  burnControl.classList.toggle('active', burnMs > 0);
  burnLabelEl.textContent = burnMs > 0 ? '🔥 Auto-burn:' : '⏱ Auto-burn:';
});

attachBtn.addEventListener('click', () => fileInput.click());

async function pushFileObject(file) {
  if (!file) return;
  if (file.size > 7.5 * 1024 * 1024) {
    showToast('File is too large (max 7.5 MB)');
    return;
  }
  showToast('Pushing file...');
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  const res = await chrome.runtime.sendMessage({
    type: 'SEND_FILE',
    bytes,
    fileName: file.name || (file.type?.startsWith('image/') ? 'screenshot.png' : 'file'),
    mimeType: file.type || 'application/octet-stream',
    ...getSelectedTargetsPayload(),
  });
  if (!res.ok) {
    showToast(res.error || 'Could not send file');
    return;
  }
  showToast('Pushed!');
  refresh();
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  await pushFileObject(file);
});

function autoResizeDraft() {
  draftEl.style.height = 'auto';
  draftEl.style.height = `${Math.min(draftEl.scrollHeight, 96)}px`;
}

draftEl.addEventListener('input', autoResizeDraft);

draftEl.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        pushFileObject(file);
        return;
      }
    }
  }
});

sendTabBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !isSafeHttpUrl(tab.url)) {
    showToast('Open a website tab first');
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: 'SEND',
    content: tab.url,
    title: tab.title,
    ...getSelectedTargetsPayload(),
  });
  if (!res.ok) {
    showToast(res.error || 'Could not send right now');
    return;
  }
  showToast('Pushed!');
  refresh();
});

async function submitDraft() {
  const content = draftEl.value.trim();
  if (!content) return;
  const res = await chrome.runtime.sendMessage({
    type: 'SEND',
    content,
    ...getSelectedTargetsPayload(),
  });
  if (!res.ok) {
    showToast(res.error || 'Could not send right now');
    return;
  }
  draftEl.value = '';
  autoResizeDraft();
  showToast('Pushed!');
  refresh();
}

sendDraftBtn.addEventListener('click', submitDraft);
draftEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitDraft();
  }
});

clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  await clearExtBlobs().catch(() => {});
  showToast('History cleared');
  refresh();
});

setInterval(() => {
  if (!allHistory.some((m) => m.expiresAt)) return;
  const now = Date.now();
  const next = allHistory.filter((m) => !m.expiresAt || m.expiresAt > now);
  if (next.length !== allHistory.length) {
    allHistory = next;
    chrome.storage.local.set({ history: next }).catch(() => {});
  }
  renderHistory(allHistory);
}, 5000);

chrome.runtime.sendMessage({ type: 'MARK_READ' }).catch(() => {});
refresh();
