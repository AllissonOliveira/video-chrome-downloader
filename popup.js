import { sanitizeFilename } from './net.js';

const params = new URLSearchParams(location.search);
const isPanel = params.has('panel');
const forcedTab = params.get('tabId') ? Number(params.get('tabId')) : null;
const ACTIVE = ['downloading', 'saving'];

let tab = null;
let items = [];
let jobs = {};
let thumb = null;
let editing = null;
let lastSig = '';
let capturing = false;
const selected = {};
const errors = {};

const $ = (id) => document.getElementById(id);

// ---------- formatação ----------
const fmtSize = (b) => {
  if (!b) return '';
  const mb = b / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2).replace('.', ',')} GB` : `${mb.toFixed(1).replace('.', ',')} MB`;
};
const fmtDuration = (sec) => {
  if (!sec) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${pad(h)}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};
const fmtEta = (sec) => {
  if (sec == null || !isFinite(sec)) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
};
const fmtBitrate = (bps) => (!bps ? '' : bps >= 1e6 ? `${(bps / 1e6).toFixed(1).replace('.', ',')} Mbps` : `${Math.round(bps / 1e3)} kbps`);
const fmtDate = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null && c !== false) e.append(c);
  return e;
}

function svg(path) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = path;
  return s;
}
const ICON_EDIT = '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>';
const ICON_X = '<path d="M6 6l12 12M18 6L6 18"/>';
const ICON_DL = '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>';
const ICON_PLAY = '<path d="M8 5l11 7-11 7z"/>';

// ---------- dados ----------
async function currentTab() {
  if (forcedTab != null) {
    try { return await chrome.tabs.get(forcedTab); } catch { return null; }
  }
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

const displayName = (item) => item.customName || sanitizeFilename(item.title || 'video');
const outExt = (item) => (item.kind === 'hls' ? 'mp4' : item.ext || 'mp4');

function jobFor(itemId) {
  const list = Object.values(jobs).filter((j) => j.itemId === itemId);
  return list.find((j) => ACTIVE.includes(j.status)) || list.sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}

function blockedReason(item) {
  if (item.kind !== 'hls') return null;
  if (!item.hls) return 'Não consegui ler este stream';
  if (item.hls.encrypted) return 'Protegido por criptografia';
  if (item.hls.isLive) return 'Ao vivo: não suportado';
  if (item.hls.type === 'master' && !item.hls.variants.length) return 'Sem qualidades disponíveis';
  return null;
}

function options(item) {
  if (item.kind === 'direct') return [{ value: 'd', label: item.size ? fmtSize(item.size) : 'Original' }];
  const h = item.hls;
  if (h.type === 'media') return [{ value: 'm', label: 'Original' }];
  const opts = h.variants.map((v, i) => ({
    value: `v${i}`,
    label: v.height ? `${v.height}p` : v.resolution || `Opção ${i + 1}`,
    title: fmtBitrate(v.bandwidth),
  }));
  h.audio.forEach((a, i) => opts.push({ value: `a${i}`, label: `Só áudio (${a.name})` }));
  return opts;
}

function resolveChoice(item, value) {
  if (item.kind === 'direct') return { url: item.url, quality: null };
  const h = item.hls;
  if (h.type === 'media') return { url: item.url, quality: null };
  if (value.startsWith('a')) {
    const a = h.audio[Number(value.slice(1))];
    return { url: a.url, quality: 'áudio', suffix: ` (áudio ${a.name})` };
  }
  const v = h.variants[Number(value.slice(1))];
  return { url: v.url, quality: v.height ? `${v.height}p` : null };
}

function separateAudio(item, value) {
  if (item.kind !== 'hls' || item.hls.type !== 'master' || !value.startsWith('v')) return false;
  const v = item.hls.variants[Number(value.slice(1))];
  return !!(v.audioGroup && item.hls.audio.some((a) => a.groupId === v.audioGroup));
}

// ---------- ações ----------
async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (r && r.ok === false) throw new Error(r.error);
  return r && r.result;
}

async function startDownload(item) {
  const value = selected[item.id] || options(item)[0].value;
  const choice = resolveChoice(item, value);
  delete errors[item.id];
  try {
    await send({
      type: 'start', tabId: tab.id, itemId: item.id, url: choice.url, quality: choice.quality,
      name: displayName(item) + (choice.suffix || ''),
    });
  } catch (e) {
    errors[item.id] = e.message;
    lastSig = '';
    render();
  }
}

function startEdit(item) {
  editing = item.id;
  lastSig = '';
  render();
  const input = document.querySelector(`li[data-id="${item.id}"] input.name-input`);
  if (input) { input.focus(); input.select(); }
}

async function commitEdit(item, value) {
  editing = null;
  const name = value.trim();
  if (name && name !== displayName(item)) await send({ type: 'rename', tabId: tab.id, itemId: item.id, name });
  lastSig = '';
  render();
}

// ---------- miniatura ----------
function findPlayerRect() {
  const els = [...document.querySelectorAll('video, iframe, canvas')]
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 160 && r.height > 90 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth);
  els.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  const best = els[0];
  if (!best) return null;
  const r = best.r;
  return { x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(r.width, innerWidth - Math.max(0, r.left)), h: Math.min(r.height, innerHeight - Math.max(0, r.top)), vw: innerWidth };
}

async function maybeCaptureThumb() {
  if (thumb || !items.length || !tab || !tab.active || capturing) return;
  capturing = true;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findPlayerRect });
    const r = res && res.result;
    if (!r) return;
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 });
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = shot; });
    const k = img.width / r.vw;
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 320, 180);
    const fit = Math.min(320 / r.w, 180 / r.h);
    const dw = r.w * fit;
    const dh = r.h * fit;
    ctx.drawImage(img, r.x * k, r.y * k, r.w * k, r.h * k, (320 - dw) / 2, (180 - dh) / 2, dw, dh);
    await chrome.storage.session.set({ [`thumb:${tab.id}`]: c.toDataURL('image/jpeg', 0.75) });
  } catch {
    // páginas internas do Chrome e algumas lojas bloqueiam captura: segue sem miniatura
  } finally {
    capturing = false;
  }
}

// ---------- renderização ----------
function progressInfo(job) {
  if (job.status === 'saving') return { pct: 100, text: 'Salvando o arquivo…' };
  if (job.kind === 'direct') {
    const pct = job.totalBytes ? Math.floor((job.received / job.totalBytes) * 100) : 0;
    const parts = [`${pct}%`, fmtSize(job.received)];
    if (job.speed) parts.push(`${fmtSize(job.speed)}/s`);
    return { pct, text: parts.filter(Boolean).join(' · ') };
  }
  const pct = job.total ? Math.floor((job.done / job.total) * 100) : 0;
  const speed = job.elapsed ? job.bytes / job.elapsed : 0;
  const eta = job.done ? (job.elapsed / job.done) * (job.total - job.done) : null;
  const parts = [`${pct}%`, fmtSize(job.bytes)];
  if (speed) parts.push(`${fmtSize(speed)}/s`);
  if (eta != null && job.done < job.total) parts.push(`faltam ${fmtEta(eta)}`);
  return { pct, text: job.total ? parts.filter(Boolean).join(' · ') : 'Preparando…' };
}

function card(item) {
  const job = jobFor(item.id);
  const blocked = blockedReason(item);

  const th = el('div', { class: 'thumb' });
  if (thumb) th.style.backgroundImage = `url("${thumb}")`;
  else th.append(el('span', { class: 'thumb-icon' }, svg(ICON_PLAY)));
  const dur = item.kind === 'hls' && item.hls ? item.hls.duration : null;
  if (dur) th.append(el('span', { class: 'dur' }, fmtDuration(dur)));

  const nameNode = editing === item.id
    ? el('input', {
      class: 'name-input', value: displayName(item),
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { editing = null; lastSig = ''; render(); } },
      onblur: (e) => { if (editing === item.id) commitEdit(item, e.target.value); },
    })
    : el('span', { class: 'name', title: `${displayName(item)}.${outExt(item)}` }, `${displayName(item)}.${outExt(item)}`);

  const head = el('div', { class: 'head' },
    el('span', { class: 'tag' }, item.kind === 'hls' ? 'HLS' : outExt(item).toUpperCase()),
    nameNode,
    el('button', { class: 'icon sm close', title: 'Remover da lista', onclick: () => send({ type: 'remove-item', tabId: tab.id, itemId: item.id }) }, svg(ICON_X)));

  let bottom;
  if (job && ACTIVE.includes(job.status)) {
    const p = progressInfo(job);
    bottom = el('div', { class: 'progress' },
      el('div', { class: 'bar' }, el('div', { class: 'fill', style: `width:${p.pct}%` })),
      el('div', { class: 'prow' },
        el('span', { class: 'pmeta' }, p.text),
        el('button', { class: 'link', onclick: () => send({ type: 'cancel', jobId: job.id }) }, 'Cancelar')));
  } else if (blocked) {
    bottom = el('div', { class: 'controls' }, el('span', { class: 'blocked' }, blocked));
  } else {
    const opts = options(item);
    const value = selected[item.id] && opts.some((o) => o.value === selected[item.id]) ? selected[item.id] : opts[0].value;
    selected[item.id] = value;
    const select = el('select', {
      class: 'quality',
      onchange: (e) => { selected[item.id] = e.target.value; lastSig = ''; render(); },
    }, ...opts.map((o) => el('option', { value: o.value, selected: o.value === value, title: o.title || null }, o.label)));
    bottom = el('div', { class: 'controls' },
      el('button', { class: 'icon sm', title: 'Editar nome do arquivo', onclick: () => startEdit(item) }, svg(ICON_EDIT)),
      el('div', { class: 'chip' }, el('span', { class: 'fmt' }, outExt(item).toUpperCase()), select),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary', onclick: () => startDownload(item) }, svg(ICON_DL), 'Baixar'));
  }

  const notes = [];
  if (!job || !ACTIVE.includes(job.status)) {
    if (errors[item.id]) notes.push(el('div', { class: 'msg error' }, errors[item.id]));
    if (job && job.status === 'error') notes.push(el('div', { class: 'msg error' }, job.error || 'O download falhou.'));
    if (job && job.status === 'canceled') notes.push(el('div', { class: 'msg' }, 'Download cancelado.'));
    if (job && job.status === 'done') {
      notes.push(el('div', { class: 'msg ok' },
        `Salvo${job.size ? ` · ${fmtSize(job.size)}` : ''}`,
        el('button', { class: 'link', onclick: () => openFile(job.downloadId) }, 'Abrir'),
        el('button', { class: 'link', onclick: () => chrome.downloads.show(job.downloadId) }, 'Mostrar na pasta')));
      if (job.ext && job.ext !== 'mp4' && job.kind === 'hls') {
        notes.push(el('div', { class: 'msg warn' }, `Este site usa um formato que não deu para converter; o arquivo foi salvo em .${job.ext}.`));
      }
    }
    if (!blocked && separateAudio(item, selected[item.id] || '')) {
      notes.push(el('div', { class: 'msg warn' }, 'Neste site o áudio vem separado. Baixe também a opção "Só áudio".'));
    }
    if (item.kind === 'hls' && !item.hls && item.error) notes.push(el('div', { class: 'msg error' }, item.error));
  }

  return el('li', { class: 'card', 'data-id': item.id }, th, el('div', { class: 'body' }, head, bottom, ...notes));
}

function signature() {
  return JSON.stringify([
    tab && tab.id, thumb ? thumb.length : 0, editing,
    items.map((i) => [i.id, i.customName, i.title, i.size, i.hls && i.hls.duration]),
    items.map((i) => { const j = jobFor(i.id); return j ? [j.id, j.status, j.ext] : null; }),
    Object.keys(errors),
  ]);
}

function updateProgress() {
  for (const item of items) {
    const job = jobFor(item.id);
    if (!job || !ACTIVE.includes(job.status)) continue;
    const li = document.querySelector(`li[data-id="${item.id}"]`);
    if (!li) continue;
    const p = progressInfo(job);
    const fill = li.querySelector('.fill');
    const meta = li.querySelector('.pmeta');
    if (fill) fill.style.width = `${p.pct}%`;
    if (meta) meta.textContent = p.text;
  }
}

function render() {
  const sig = signature();
  if (sig === lastSig) { updateProgress(); return; }
  lastSig = sig;
  $('list').replaceChildren(...items.map(card));
  $('empty').hidden = items.length > 0;
  const yt = tab && tab.url && /(^|\.)youtube\.com$/.test(new URL(tab.url).hostname);
  $('note').hidden = !yt;
  $('note').textContent = yt ? 'YouTube entrega vídeo e áudio separados e ainda não é suportado nesta versão.' : '';
}

async function load() {
  tab = await currentTab();
  if (!tab) { items = []; render(); return; }
  const keys = [`tab:${tab.id}`, `thumb:${tab.id}`, 'jobs'];
  const s = await chrome.storage.session.get(keys);
  items = s[`tab:${tab.id}`] || [];
  thumb = s[`thumb:${tab.id}`] || null;
  jobs = s.jobs || {};
  render();
  maybeCaptureThumb();
}

// Downloads diretos: progresso vem do gerenciador de downloads do Chrome
async function pollDirect() {
  const direct = Object.values(jobs).filter((j) => j.kind === 'direct' && j.status === 'downloading' && j.downloadId != null);
  for (const j of direct) {
    const [d] = await chrome.downloads.search({ id: j.downloadId });
    if (!d) continue;
    const prev = j.received || 0;
    j.received = d.bytesReceived;
    j.totalBytes = d.totalBytes;
    j.speed = Math.max(0, (d.bytesReceived - prev) / 0.8);
  }
  if (direct.length) updateProgress();
}
setInterval(pollDirect, 800);

function openFile(id) {
  Promise.resolve().then(() => chrome.downloads.open(id))
    .catch(() => alert('O arquivo não foi encontrado. Ele pode ter sido movido ou apagado.'));
}

// ---------- histórico ----------
async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  $('history-empty').hidden = history.length > 0;
  $('history').replaceChildren(...history.map((h) => {
    const file = h.file ? h.file.split(/[\\/]/).pop() : h.name;
    return el('li', { class: 'hist' },
      el('div', { class: 'hinfo' },
        el('div', { class: 'name', title: h.file || '' }, file),
        el('div', { class: 'hmeta' }, [fmtDate(h.date), h.quality, fmtSize(h.size)].filter(Boolean).join(' · '))),
      el('button', { class: 'link', onclick: () => openFile(h.downloadId) }, 'Abrir'),
      el('button', { class: 'link', onclick: () => { try { chrome.downloads.show(h.downloadId); } catch { chrome.downloads.showDefaultFolder(); } } }, 'Pasta'));
  }));
}

function showView(name) {
  $('view-videos').hidden = name !== 'videos';
  $('view-history').hidden = name !== 'history';
  $('btn-history').classList.toggle('active', name === 'history');
  if (name === 'history') renderHistory();
}

// ---------- eventos ----------
$('btn-help').addEventListener('click', () => { showView('videos'); $('help').hidden = !$('help').hidden; });
$('btn-history').addEventListener('click', () => showView($('view-history').hidden ? 'history' : 'videos'));
$('btn-folder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
$('btn-clear').addEventListener('click', async () => {
  if (!tab) return;
  for (const j of Object.values(jobs)) {
    if (j.tabId === tab.id && !ACTIVE.includes(j.status)) await send({ type: 'dismiss-job', jobId: j.id });
  }
  await send({ type: 'clear-tab', tabId: tab.id });
});
$('history-clear').addEventListener('click', async () => { await chrome.storage.local.set({ history: [] }); renderHistory(); });
$('btn-panel').title = isPanel ? 'Fechar painel lateral' : 'Abrir no painel lateral';
$('btn-panel').addEventListener('click', async () => {
  if (isPanel) { window.close(); return; }
  if (tab) await chrome.sidePanel.open({ windowId: tab.windowId });
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history && !$('view-history').hidden) renderHistory();
  if (area !== 'session' || !tab) return;
  let dirty = false;
  if (changes[`tab:${tab.id}`]) { items = changes[`tab:${tab.id}`].newValue || []; dirty = true; }
  if (changes[`thumb:${tab.id}`]) { thumb = changes[`thumb:${tab.id}`].newValue || null; dirty = true; }
  if (changes.jobs) {
    const fresh = changes.jobs.newValue || {};
    for (const [id, j] of Object.entries(fresh)) {
      const old = jobs[id];
      if (old && j.kind === 'direct') Object.assign(j, { received: old.received, totalBytes: old.totalBytes, speed: old.speed });
    }
    jobs = fresh;
    dirty = true;
  }
  if (dirty) { render(); maybeCaptureThumb(); }
});

if (isPanel) {
  document.body.classList.add('panel');
  chrome.tabs.onActivated.addListener(() => { lastSig = ''; load(); });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (tab && id === tab.id && (change.status === 'complete' || change.url)) { lastSig = ''; load(); }
  });
  chrome.windows.onFocusChanged.addListener(() => { lastSig = ''; load(); });
}

load();
