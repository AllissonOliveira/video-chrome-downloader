// Trabalha em segundo plano: baixa os pedaços do stream, converte para MP4
// e grava direto em disco (sistema de arquivos privado do navegador), sem
// acumular o vídeo inteiro na memória.
import { parsePlaylist } from './hls.js';
import { fetchWithRetry } from './net.js';
import { Mp4Builder } from './mp4.js';

const AHEAD_LIMIT = 24; // máximo de pedaços baixados à frente do que já foi gravado
const CONCURRENCY = 6;
const running = new Map();
const files = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (m) => chrome.runtime.sendMessage(m).catch(() => {});

// Limpa arquivos temporários que tenham sobrado de sessões anteriores.
(async () => {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      if (name.startsWith('job-')) await root.removeEntry(name).catch(() => {});
    }
  } catch {}
  send({ type: 'offscreen-ready' });
})();

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'ping') reply({ ok: true });
  else if (msg.type === 'run') { runJob(msg.job); reply({ ok: true }); }
  else if (msg.type === 'cancel') { running.get(msg.jobId)?.abort(); reply({ ok: true }); }
  else if (msg.type === 'cleanup') { cleanup(msg.jobId).then(() => reply({ ok: true })); return true; }
  return false;
});

function rawExtension(url) {
  const m = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(new URL(url).pathname);
  const e = m ? m[1].toLowerCase() : 'ts';
  return ['aac', 'mp3', 'ts'].includes(e) ? e : 'ts';
}

async function runJob(job) {
  const controller = new AbortController();
  running.set(job.id, controller);
  const { signal } = controller;
  const fname = `job-${job.id}`;
  let root;
  let writable;

  try {
    let pl = parsePlaylist(await fetchWithRetry(job.playlistUrl, { as: 'text', signal }), job.playlistUrl);
    if (pl.type === 'master') {
      const best = pl.variants[0];
      if (!best) throw new Error('A playlist não tem nenhuma qualidade disponível.');
      pl = parsePlaylist(await fetchWithRetry(best.url, { as: 'text', signal }), best.url);
    }
    if (pl.encrypted) throw new Error(`Este vídeo é protegido (${pl.encryptionMethod}) e não pode ser baixado.`);
    if (pl.isLive) throw new Error('Transmissões ao vivo não são suportadas.');
    if (!pl.segments.length) throw new Error('A playlist está vazia.');

    // Garante o Referer certo também nos servidores dos pedaços
    const hosts = [...new Set([pl.map && pl.map.url, ...pl.segments.map((s) => s.url)]
      .filter(Boolean).map((u) => new URL(u).hostname))];
    await chrome.runtime.sendMessage({ type: 'job-hosts', jobId: job.id, hosts });

    root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(fname, { create: true });
    writable = await handle.createWritable();

    const total = pl.segments.length;
    let mode = pl.map ? 'fmp4' : null; // 'fmp4' | 'mux' | 'raw'
    let ext = 'mp4';
    let transmuxer = null;
    let out = [];

    // Grava um MP4 tradicional (com índice completo), que abre no QuickTime e em editores
    const sink = {
      write: (data) => writable.write(data),
      writeAt: (position, data) => writable.write({ type: 'write', position, data }),
    };
    const mp4 = new Mp4Builder(sink);

    if (pl.map) {
      await mp4.start();
      mp4.setInit(await fetchWithRetry(pl.map.url, { range: pl.map.range, signal }));
    }

    const processSegment = async (buf) => {
      if (mode === 'raw') { await writable.write(buf); return; }
      if (mode === 'fmp4') { await mp4.addFragments(buf); return; }
      if (!transmuxer) {
        transmuxer = new self.muxjs.mp4.Transmuxer({ remux: true });
        transmuxer.on('data', (seg) => out.push(seg));
      }
      out = [];
      try {
        transmuxer.push(new Uint8Array(buf));
        transmuxer.flush();
      } catch (e) {
        if (mode === 'mux') throw new Error(`Falha ao converter para MP4: ${e.message || e}`);
        out = [];
      }
      if (mode === null) {
        if (!out.length) {
          // Formato que o conversor não reconhece: salva como veio, para não perder o vídeo
          mode = 'raw';
          ext = rawExtension(pl.segments[0].url);
          await writable.write(buf);
          return;
        }
        mode = 'mux';
        await mp4.start();
      }
      for (const s of out) {
        mp4.setInit(s.initSegment);
        await mp4.addFragments(s.data);
      }
    };

    const pending = new Map();
    let nextWrite = 0;
    let nextFetch = 0;
    let done = 0;
    let bytes = 0;
    let lastReport = 0;
    const started = Date.now();
    let chain = Promise.resolve();

    const drain = async () => {
      while (pending.has(nextWrite)) {
        const buf = pending.get(nextWrite);
        pending.delete(nextWrite);
        await processSegment(buf);
        nextWrite++;
      }
    };

    const report = (force) => {
      const now = Date.now();
      if (!force && now - lastReport < 400) return;
      lastReport = now;
      send({ type: 'job-progress', jobId: job.id, done, total, bytes, elapsed: (now - started) / 1000 });
    };
    report(true);

    const worker = async () => {
      while (nextFetch < total) {
        const i = nextFetch++;
        while (i - nextWrite > AHEAD_LIMIT) {
          if (signal.aborted) throw new DOMException('cancelado', 'AbortError');
          await sleep(80);
        }
        const seg = pl.segments[i];
        const buf = await fetchWithRetry(seg.url, { range: seg.range, signal });
        bytes += buf.byteLength;
        done++;
        pending.set(i, buf);
        chain = chain.then(drain);
        await chain;
        report(false);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    await chain;
    report(true);

    if (mode === 'mux' || mode === 'fmp4') {
      if (!mp4.hasSamples) throw new Error('Nenhum quadro de vídeo foi encontrado nos pedaços baixados.');
      await mp4.finish();
    }
    await writable.close();
    writable = null;
    const file = await handle.getFile();
    // O arquivo gravado não tem tipo; sem isso o Chrome o trata como texto e salva .txt
    const mime = { mp4: 'video/mp4', ts: 'video/mp2t', aac: 'audio/aac', mp3: 'audio/mpeg' }[ext] || 'video/mp4';
    const url = URL.createObjectURL(file.slice(0, file.size, mime));
    files.set(job.id, { url, fname });
    send({ type: 'job-ready', jobId: job.id, url, ext, size: file.size });
  } catch (e) {
    if (writable) await writable.abort().catch(() => {});
    if (root) await root.removeEntry(fname).catch(() => {});
    if (signal.aborted) send({ type: 'job-canceled', jobId: job.id });
    else send({ type: 'job-error', jobId: job.id, error: String((e && e.message) || e) });
  } finally {
    running.delete(job.id);
  }
}

async function cleanup(jobId) {
  const f = files.get(jobId);
  if (!f) return;
  files.delete(jobId);
  URL.revokeObjectURL(f.url);
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(f.fname);
  } catch {}
}
