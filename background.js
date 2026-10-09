// Service worker: detecta vídeos, gerencia downloads e histórico.
import { parsePlaylist } from './hls.js';
import { setHeaderRule, clearRule, fetchWithRetry, sanitizeFilename } from './net.js';

const DETECT_RULE_ID = 1;
const MIN_DIRECT_SIZE = 300 * 1024;
const MEDIA_EXT = /\.(mp4|webm|mov|m4v|mkv|flv|ogv)$/;
const SEGMENT_EXT = /\.(ts|m4s|m4a|aac|mp3|vtt|webvtt|key|cmfv|cmfa|jpg|png)$/;
const SKIP_HOST = /(^|\.)googlevideo\.com$/; // YouTube: vídeo e áudio separados
const WATCH_TYPES = ['main_frame', 'media', 'xmlhttprequest', 'other', 'object'];

// ---------- estado ----------
const cache = {};
let queue = Promise.resolve();
const inFlight = new Set();
const refererByUrl = new Map();
let jobs = {};
const jobsReady = chrome.storage.session.get('jobs').then((r) => { jobs = r.jobs || {}; });

function enqueue(fn) {
  const p = queue.then(fn);
  queue = p.catch((e) => console.error('[baixador]', e));
  return p;
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

async function getItems(tabId) {
  if (!(tabId in cache)) {
    const key = `tab:${tabId}`;
    cache[tabId] = (await chrome.storage.session.get(key))[key] || [];
  }
  return cache[tabId];
}

async function saveItems(tabId, items) {
  cache[tabId] = items;
  await chrome.storage.session.set({ [`tab:${tabId}`]: items });
  await chrome.action.setBadgeText({ tabId, text: items.length ? String(items.length) : '' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b82f6' }).catch(() => {});
}

async function clearTab(tabId) {
  delete cache[tabId];
  await chrome.storage.session.remove([`tab:${tabId}`, `thumb:${tabId}`]);
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

let persistTimer = null;
function persistJobs(now) {
  clearTimeout(persistTimer);
  if (now) return chrome.storage.session.set({ jobs });
  persistTimer = setTimeout(() => chrome.storage.session.set({ jobs }), 250);
  return Promise.resolve();
}

// ---------- detecção ----------
function extFromType(ct, path) {
  const map = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'video/x-matroska': 'mkv', 'video/x-flv': 'flv', 'video/ogg': 'ogv', 'video/x-m4v': 'm4v',
  };
  if (map[ct]) return map[ct];
  const m = MEDIA_EXT.exec(path);
  return m ? m[1] : 'mp4';
}

function classify(details) {
  const url = details.url;
  if (!/^https?:/.test(url)) return null;
  if (details.statusCode !== 200 && details.statusCode !== 206) return null;
  const u = new URL(url);
  if (SKIP_HOST.test(u.hostname)) return null;
  const path = u.pathname.toLowerCase();
  const ct = header(details.responseHeaders, 'content-type').toLowerCase().split(';')[0].trim();

  if (ct.includes('mpegurl') || path.endsWith('.m3u8')) return { kind: 'hls' };
  if (SEGMENT_EXT.test(path)) return null;
  if (ct === 'video/mp2t' || ct === 'video/iso.segment' || ct.startsWith('audio/') || ct.startsWith('image/')) return null;

  const genericType = ct === '' || ct === 'application/octet-stream' || ct === 'binary/octet-stream';
  if (ct.startsWith('video/') || (MEDIA_EXT.test(path) && genericType)) {
    const m = /\/(\d+)\s*$/.exec(header(details.responseHeaders, 'content-range'));
    let size = m ? Number(m[1]) : null;
    if (!size && details.statusCode === 200) size = Number(header(details.responseHeaders, 'content-length')) || null;
    if (size && size < MIN_DIRECT_SIZE) return null;
    return { kind: 'direct', ext: extFromType(ct, path), size };
  }
  return null;
}

async function tabInfo(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return { pageUrl: t.url || '', title: t.title || '' };
  } catch {
    return { pageUrl: '', title: '' };
  }
}

function isChildOfMaster(items, url) {
  return items.some((it) => it.kind === 'hls' && it.hls && it.hls.type === 'master' &&
    (it.hls.variants.some((v) => v.url === url) || it.hls.audio.some((a) => a.url === url)));
}

async function handleDirect(tabId, url, info, referer) {
  const items = await getItems(tabId);
  const existing = items.find((x) => x.url === url);
  if (existing) {
    if (!existing.size && info.size) { existing.size = info.size; await saveItems(tabId, [...items]); }
    return;
  }
  const { pageUrl, title } = await tabInfo(tabId);
  items.push({
    id: crypto.randomUUID(), kind: 'direct', url, ext: info.ext, size: info.size,
    pageUrl, referer: referer || pageUrl, title, detectedAt: Date.now(),
  });
  await saveItems(tabId, [...items]);
}

async function readPlaylist(url, referer) {
  await setHeaderRule(DETECT_RULE_ID, referer, [new URL(url).hostname]);
  return parsePlaylist(await fetchWithRetry(url, { as: 'text', tries: 2 }), url);
}

function summarizeMedia(pl) {
  return {
    encrypted: pl.encrypted, encryptionMethod: pl.encryptionMethod, duration: pl.duration,
    isLive: pl.isLive, container: pl.container, segmentCount: pl.segments.length,
  };
}

async function handleHls(tabId, url, referer) {
  let items = await getItems(tabId);
  if (items.some((x) => x.url === url) || isChildOfMaster(items, url)) return;
  const { pageUrl, title } = await tabInfo(tabId);
  referer = referer || pageUrl;

  let hls = null;
  let error = null;
  try {
    const pl = await readPlaylist(url, referer);
    if (pl.type === 'master') {
      hls = { type: 'master', variants: pl.variants, audio: pl.audio };
      // lê uma das qualidades para saber duração e se há proteção
      if (pl.variants[0]) {
        try {
          const v = await readPlaylist(pl.variants[0].url, referer);
          if (v.type === 'media') Object.assign(hls, summarizeMedia(v));
        } catch {}
      }
    } else {
      hls = { type: 'media', ...summarizeMedia(pl) };
    }
  } catch (e) {
    error = String(e.message || e);
  }

  items = await getItems(tabId);
  if (items.some((x) => x.url === url) || isChildOfMaster(items, url)) return;
  if (hls && hls.type === 'master') {
    const children = new Set([...hls.variants.map((v) => v.url), ...hls.audio.map((a) => a.url)]);
    items = items.filter((x) => !children.has(x.url));
  }
  items.push({ id: crypto.randomUUID(), kind: 'hls', url, pageUrl, referer, title, hls, error, detectedAt: Date.now() });
  await saveItems(tabId, items);
}

const ownOrigin = `chrome-extension://${chrome.runtime.id}`;

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const r = header(d.requestHeaders, 'referer');
    if (!r) return;
    refererByUrl.set(d.url, r);
    if (refererByUrl.size > 800) refererByUrl.delete(refererByUrl.keys().next().value);
  },
  { urls: ['<all_urls>'], types: WATCH_TYPES },
  ['requestHeaders', 'extraHeaders'],
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { tabId } = details;
    if (tabId < 0) return;
    if (details.initiator && details.initiator.startsWith(ownOrigin)) return;
    if (details.type === 'main_frame') { enqueue(() => clearTab(tabId)); return; }
    const info = classify(details);
    if (!info) return;
    const referer = refererByUrl.get(details.url) || null;
    const key = `${tabId}|${details.url}`;
    if (info.kind === 'hls') {
      if (inFlight.has(key)) return;
      inFlight.add(key);
      enqueue(() => handleHls(tabId, details.url, referer)).finally(() => inFlight.delete(key));
    } else {
      enqueue(() => handleDirect(tabId, details.url, info, referer));
    }
  },
  { urls: ['<all_urls>'], types: WATCH_TYPES },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => enqueue(() => clearTab(tabId)));

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.title) return;
  enqueue(async () => {
    const items = await getItems(tabId);
    if (!items.length) return;
    items.forEach((it) => { it.title = change.title; });
    await saveItems(tabId, [...items]);
  });
});

// ---------- documento offscreen (onde o vídeo é montado) ----------
let offscreenReady = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Juntar os pedaços do vídeo e montar o arquivo MP4 antes de salvar.',
    }).catch((e) => { if (!String(e).includes('single offscreen')) throw e; })
      .finally(() => { offscreenReady = null; });
  }
  await offscreenReady;
}

async function toOffscreen(msg) {
  for (let i = 0; i < 20; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error('O módulo de download não respondeu.');
}

async function maybeCloseOffscreen() {
  const active = Object.values(jobs).some((j) => j.kind === 'hls' && ['downloading', 'saving'].includes(j.status));
  if (active) return;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument().catch(() => {});
}

// ---------- downloads ----------
function nextRuleId() {
  const used = new Set(Object.values(jobs).map((j) => j.ruleId));
  let id = 1000;
  while (used.has(id)) id++;
  return id;
}

async function addHistory(job, downloadItem) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({
    name: job.filename, file: downloadItem ? downloadItem.filename : null, downloadId: job.downloadId,
    size: downloadItem ? downloadItem.fileSize || downloadItem.totalBytes : job.size || null,
    quality: job.quality || null, pageUrl: job.pageUrl, date: Date.now(),
  });
  await chrome.storage.local.set({ history: history.slice(0, 200) });
}

async function finishJob(job, status, error) {
  job.status = status;
  if (error) job.error = error;
  if (job.ruleId) await clearRule(job.ruleId).catch(() => {});
  await persistJobs(true);
  if (job.kind === 'hls') {
    await toOffscreen({ type: 'cleanup', jobId: job.id }).catch(() => {});
    await maybeCloseOffscreen();
  }
}

async function startDownload({ tabId, itemId, url, quality, name }) {
  await jobsReady;
  const items = await getItems(tabId);
  const item = items.find((x) => x.id === itemId);
  if (!item) throw new Error('Vídeo não encontrado. Recarregue a página e tente de novo.');
  const filename = sanitizeFilename(name || item.customName || item.title);

  // um download por item de cada vez
  for (const j of Object.values(jobs)) {
    if (j.itemId === itemId && ['downloading', 'saving'].includes(j.status)) return j.id;
    if (j.itemId === itemId) delete jobs[j.id];
  }

  const id = crypto.randomUUID();
  const base = {
    id, tabId, itemId, kind: item.kind, filename, quality: quality || null, pageUrl: item.pageUrl,
    status: 'downloading', done: 0, total: 0, bytes: 0, elapsed: 0, startedAt: Date.now(),
  };

  if (item.kind === 'direct') {
    const job = { ...base, ext: item.ext || 'mp4', size: item.size };
    jobs[id] = job;
    await persistJobs(true);
    try {
      job.downloadId = await chrome.downloads.download({
        url: item.url, filename: `${filename}.${job.ext}`, conflictAction: 'uniquify',
      });
      await persistJobs(true);
    } catch (e) {
      await finishJob(job, 'error', String(e.message || e));
    }
    return id;
  }

  const job = { ...base, playlistUrl: url || item.url, referer: item.referer || item.pageUrl, ruleId: nextRuleId() };
  jobs[id] = job;
  await persistJobs(true);
  await setHeaderRule(job.ruleId, job.referer, [new URL(job.playlistUrl).hostname]);
  await ensureOffscreen();
  await toOffscreen({ type: 'run', job: { id, playlistUrl: job.playlistUrl } });
  return id;
}

async function cancelJob(jobId) {
  await jobsReady;
  const job = jobs[jobId];
  if (!job) return;
  if (job.kind === 'direct' && job.downloadId != null) {
    await chrome.downloads.cancel(job.downloadId).catch(() => {});
    await finishJob(job, 'canceled');
  } else if (job.status === 'saving' && job.downloadId != null) {
    await chrome.downloads.cancel(job.downloadId).catch(() => {});
  } else {
    await toOffscreen({ type: 'cancel', jobId }).catch(() => {});
  }
}

async function onJobReady(msg) {
  await jobsReady;
  const job = jobs[msg.jobId];
  if (!job) return;
  job.ext = msg.ext;
  job.size = msg.size;
  job.status = 'saving';
  try {
    job.downloadId = await chrome.downloads.download({
      url: msg.url, filename: `${job.filename}.${msg.ext}`, conflictAction: 'uniquify',
    });
    await persistJobs(true);
  } catch (e) {
    await finishJob(job, 'error', `Não consegui salvar o arquivo: ${e.message || e}`);
  }
}

chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state) return;
  await jobsReady;
  const job = Object.values(jobs).find((j) => j.downloadId === d.id);
  if (!job || !['downloading', 'saving'].includes(job.status)) return;
  if (d.state.current === 'complete') {
    const [item] = await chrome.downloads.search({ id: d.id });
    await addHistory(job, item);
    await finishJob(job, 'done');
  } else if (d.state.current === 'interrupted') {
    const canceled = d.error && d.error.current === 'USER_CANCELED';
    await finishJob(job, canceled ? 'canceled' : 'error', canceled ? null : `Download interrompido (${d.error && d.error.current}).`);
  }
});

// ---------- mensagens ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target === 'offscreen') return false;
  const run = (p) => {
    p.then((r) => reply({ ok: true, result: r }), (e) => reply({ ok: false, error: String(e.message || e) }));
    return true;
  };

  switch (msg.type) {
    case 'start': return run(startDownload(msg));
    case 'cancel': return run(cancelJob(msg.jobId));
    case 'clear-tab': return run(enqueue(() => clearTab(msg.tabId)));
    case 'dismiss-job': return run(jobsReady.then(() => { delete jobs[msg.jobId]; return persistJobs(true); }));
    case 'remove-item':
      return run(enqueue(async () => {
        const items = await getItems(msg.tabId);
        await saveItems(msg.tabId, items.filter((x) => x.id !== msg.itemId));
      }));
    case 'rename':
      return run(enqueue(async () => {
        const items = await getItems(msg.tabId);
        const it = items.find((x) => x.id === msg.itemId);
        if (it) it.customName = sanitizeFilename(msg.name);
        await saveItems(msg.tabId, [...items]);
      }));
    case 'job-hosts':
      return run(jobsReady.then(async () => {
        const job = jobs[msg.jobId];
        if (job) await setHeaderRule(job.ruleId, job.referer, msg.hosts);
      }));
    case 'job-progress':
      jobsReady.then(() => {
        const job = jobs[msg.jobId];
        if (!job || job.status !== 'downloading') return;
        Object.assign(job, { done: msg.done, total: msg.total, bytes: msg.bytes, elapsed: msg.elapsed });
        persistJobs(false);
      });
      return false;
    case 'job-ready': onJobReady(msg); return false;
    case 'job-error': jobsReady.then(() => jobs[msg.jobId] && finishJob(jobs[msg.jobId], 'error', msg.error)); return false;
    case 'job-canceled': jobsReady.then(() => jobs[msg.jobId] && finishJob(jobs[msg.jobId], 'canceled')); return false;
    default: return false;
  }
});
