// Monta um MP4 tradicional (não fragmentado) a partir de fragmentos fMP4.
// Motivo: o QuickTime e vários editores não tocam MP4 fragmentado; eles exigem
// o índice completo (moov com tabelas de amostras). Código próprio, sem dependências.
//
// Layout gravado: ftyp | mdat (tamanho 64 bits) | moov (no final)

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'moof', 'traf', 'mvex', 'udta']);
const enc = new TextEncoder();

function readBoxes(buf, start = 0, end = buf.length) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(off + 8)); hdr = 16; }
    else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) break;
    out.push({ type, start: off, end: off + size, body: off + hdr });
    off += size;
  }
  return out;
}

function child(buf, box, type) {
  return readBoxes(buf, box.body, box.end).find((b) => b.type === type) || null;
}

function concat(parts) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function box(type, ...payload) {
  const body = concat(payload);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(enc.encode(type), 4);
  out.set(body, 8);
  return out;
}

function u32array(values) {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0));
  return out;
}

function fullHeader(version, flags) {
  return new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]);
}

export class Mp4Builder {
  // sink: { write(Uint8Array) -> Promise, writeAt(position, Uint8Array) -> Promise }
  constructor(sink) {
    this.sink = sink;
    this.pos = 0;
    this.tracks = new Map();
    this.order = [];
    this.init = null;
    this.mdatStart = 0;
  }

  async start() {
    const ftyp = box('ftyp', enc.encode('isom'), u32array([512]), enc.encode('isomiso2avc1mp41'));
    await this.sink.write(ftyp);
    this.pos = ftyp.length;
    this.mdatStart = this.pos;
    const mdatHeader = new Uint8Array(16);
    new DataView(mdatHeader.buffer).setUint32(0, 1);
    mdatHeader.set(enc.encode('mdat'), 4);
    await this.sink.write(mdatHeader);
    this.pos += 16;
  }

  // Segmento de inicialização (ftyp+moov do fMP4). Só o primeiro é usado.
  setInit(initBytes) {
    if (this.init) return;
    const buf = initBytes instanceof Uint8Array ? initBytes : new Uint8Array(initBytes);
    const moov = readBoxes(buf).find((b) => b.type === 'moov');
    if (!moov) throw new Error('Segmento de inicialização sem moov.');
    this.init = { buf, moov };
    for (const trak of readBoxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak')) {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const tkhd = child(buf, trak, 'tkhd');
      const v = buf[tkhd.body];
      const trackId = dv.getUint32(tkhd.body + (v === 1 ? 20 : 12));
      const mdia = child(buf, trak, 'mdia');
      const mdhd = child(buf, mdia, 'mdhd');
      const mv = buf[mdhd.body];
      const timescale = dv.getUint32(mdhd.body + (mv === 1 ? 20 : 12));
      const hdlr = child(buf, mdia, 'hdlr');
      const handler = String.fromCharCode(...buf.subarray(hdlr.body + 8, hdlr.body + 12));
      const t = {
        trackId, trak, timescale, handler,
        durations: [], sizes: [], ctos: [], syncs: [],
        chunkOffsets: [], chunkCounts: [],
        firstDecode: null, nextDecode: null, hasNegCto: false, anyCto: false, allSync: true,
      };
      this.tracks.set(trackId, t);
      this.order.push(trackId);
    }
    // valores padrão do mvex/trex
    const mvex = child(buf, moov, 'mvex');
    this.trex = new Map();
    if (mvex) {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (const trex of readBoxes(buf, mvex.body, mvex.end).filter((b) => b.type === 'trex')) {
        const p = trex.body + 4;
        this.trex.set(dv.getUint32(p), { dur: dv.getUint32(p + 8), size: dv.getUint32(p + 12), flags: dv.getUint32(p + 16) });
      }
    }
  }

  // Um ou mais pares moof+mdat.
  async addFragments(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (const moof of readBoxes(buf).filter((b) => b.type === 'moof')) {
      for (const traf of readBoxes(buf, moof.body, moof.end).filter((b) => b.type === 'traf')) {
        const tfhd = child(buf, traf, 'tfhd');
        const tfFlags = dv.getUint32(tfhd.body) & 0xffffff;
        let p = tfhd.body + 4;
        const trackId = dv.getUint32(p); p += 4;
        const t = this.tracks.get(trackId);
        if (!t) continue;
        const trex = (this.trex && this.trex.get(trackId)) || { dur: 0, size: 0, flags: 0 };
        let base = moof.start;
        if (tfFlags & 0x1) { base = Number(dv.getBigUint64(p)); p += 8; }
        if (tfFlags & 0x2) p += 4;
        let defDur = trex.dur; let defSize = trex.size; let defFlags = trex.flags;
        if (tfFlags & 0x8) { defDur = dv.getUint32(p); p += 4; }
        if (tfFlags & 0x10) { defSize = dv.getUint32(p); p += 4; }
        if (tfFlags & 0x20) { defFlags = dv.getUint32(p); p += 4; }

        const tfdt = child(buf, traf, 'tfdt');
        let decodeTime = null;
        if (tfdt) decodeTime = buf[tfdt.body] === 1 ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);

        for (const trun of readBoxes(buf, traf.body, traf.end).filter((b) => b.type === 'trun')) {
          const version = buf[trun.body];
          const fl = dv.getUint32(trun.body) & 0xffffff;
          let q = trun.body + 4;
          const count = dv.getUint32(q); q += 4;
          let dataOffset = 0;
          if (fl & 0x1) { dataOffset = dv.getInt32(q); q += 4; }
          let firstFlags = null;
          if (fl & 0x4) { firstFlags = dv.getUint32(q); q += 4; }

          // corrige buracos/sobreposições na linha do tempo ajustando a amostra anterior
          if (decodeTime != null) {
            if (t.firstDecode == null) { t.firstDecode = decodeTime; t.nextDecode = decodeTime; }
            const delta = decodeTime - t.nextDecode;
            if (delta !== 0 && t.durations.length) {
              const last = t.durations.length - 1;
              t.durations[last] = Math.max(0, t.durations[last] + delta);
              t.nextDecode += delta;
            }
            decodeTime = null; // só o primeiro trun do traf usa o tfdt
          } else if (t.firstDecode == null) {
            t.firstDecode = 0; t.nextDecode = 0;
          }

          let total = 0;
          for (let i = 0; i < count; i++) {
            const dur = fl & 0x100 ? dv.getUint32((q += 4) - 4) : defDur;
            const size = fl & 0x200 ? dv.getUint32((q += 4) - 4) : defSize;
            let flags = fl & 0x400 ? dv.getUint32((q += 4) - 4) : defFlags;
            if (i === 0 && firstFlags != null) flags = firstFlags;
            let cto = 0;
            if (fl & 0x800) { cto = version === 1 ? dv.getInt32(q) : dv.getUint32(q); q += 4; }
            const sync = !(flags & 0x10000);
            t.durations.push(dur);
            t.sizes.push(size);
            t.ctos.push(cto);
            t.syncs.push(sync);
            if (cto) t.anyCto = true;
            if (cto < 0) t.hasNegCto = true;
            if (!sync) t.allSync = false;
            t.nextDecode += dur;
            total += size;
          }
          if (!count || !total) continue;
          const start = base + dataOffset;
          if (start < 0 || start + total > buf.length) throw new Error('Fragmento MP4 inconsistente.');
          t.chunkOffsets.push(this.pos);
          t.chunkCounts.push(count);
          await this.sink.write(buf.subarray(start, start + total));
          this.pos += total;
        }
      }
    }
  }

  get hasSamples() {
    return [...this.tracks.values()].some((t) => t.sizes.length);
  }

  async finish() {
    if (!this.init) throw new Error('MP4 sem segmento de inicialização.');
    const { buf, moov } = this.init;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const mvhdBox = child(buf, moov, 'mvhd');
    const movieTs = dv.getUint32(mvhdBox.body + (buf[mvhdBox.body] === 1 ? 20 : 12));

    const used = this.order.map((id) => this.tracks.get(id)).filter((t) => t.sizes.length);
    const trakBoxes = [];
    let movieDur = 0;
    let nextId = 1;
    for (const t of used) {
      const mediaDur = t.durations.reduce((s, d) => s + d, 0);
      const delay = t.firstDecode || 0;
      const trackMovieDur = Math.round(((mediaDur + delay) * movieTs) / t.timescale);
      movieDur = Math.max(movieDur, trackMovieDur);
      trakBoxes.push(this.buildTrak(t, mediaDur, trackMovieDur, delay, movieTs));
      nextId = Math.max(nextId, t.trackId + 1);
    }

    const mvhd = this.patchDuration(buf.slice(mvhdBox.start, mvhdBox.end), movieDur, 'mvhd', nextId);
    const moovOut = box('moov', mvhd, ...trakBoxes);

    const mdatSize = this.pos - this.mdatStart;
    const sizeBytes = new Uint8Array(8);
    new DataView(sizeBytes.buffer).setBigUint64(0, BigInt(mdatSize));
    await this.sink.write(moovOut);
    await this.sink.writeAt(this.mdatStart + 8, sizeBytes);
    this.pos += moovOut.length;
    return { duration: movieDur / movieTs };
  }

  patchDuration(bytes, duration, type, nextTrackId) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = bytes[8];
    // posições do campo duration: mvhd/mdhd v0=24 v1=32 | tkhd v0=28 v1=36 (a partir do início do box)
    const off = type === 'tkhd' ? (v === 1 ? 36 : 28) : (v === 1 ? 32 : 24);
    if (v === 1) dv.setBigUint64(off, BigInt(duration));
    else dv.setUint32(off, Math.min(duration, 0xffffffff));
    if (type === 'mvhd' && nextTrackId) dv.setUint32(bytes.length - 4, nextTrackId);
    return bytes;
  }

  buildTrak(t, mediaDur, trackMovieDur, delay, movieTs) {
    const { buf } = this.init;
    const out = [];
    for (const b of readBoxes(buf, t.trak.body, t.trak.end)) {
      if (b.type === 'tkhd') out.push(this.patchDuration(buf.slice(b.start, b.end), trackMovieDur, 'tkhd'));
      else if (b.type === 'mdia') out.push(this.buildMdia(t, b, mediaDur));
      else if (b.type !== 'edts') out.push(buf.slice(b.start, b.end));
    }
    // lista de edição para manter a sincronia quando a faixa começa depois de zero
    if (delay > 0) {
      const delayMovie = Math.round((delay * movieTs) / t.timescale);
      const mediaMovie = Math.round((mediaDur * movieTs) / t.timescale);
      const elst = box('elst', fullHeader(0, 0), u32array([2, delayMovie, 0xffffffff, 0x00010000, mediaMovie, 0, 0x00010000]));
      out.splice(1, 0, box('edts', elst));
    }
    return box('trak', ...out);
  }

  buildMdia(t, mdia, mediaDur) {
    const { buf } = this.init;
    const out = [];
    for (const b of readBoxes(buf, mdia.body, mdia.end)) {
      if (b.type === 'mdhd') out.push(this.patchDuration(buf.slice(b.start, b.end), mediaDur, 'mdhd'));
      else if (b.type === 'minf') {
        const parts = [];
        for (const m of readBoxes(buf, b.body, b.end)) {
          if (m.type === 'stbl') parts.push(this.buildStbl(t, m));
          else parts.push(buf.slice(m.start, m.end));
        }
        out.push(box('minf', ...parts));
      } else out.push(buf.slice(b.start, b.end));
    }
    return box('mdia', ...out);
  }

  buildStbl(t, stbl) {
    const { buf } = this.init;
    const stsd = child(buf, stbl, 'stsd');
    const parts = [buf.slice(stsd.start, stsd.end)];

    // stts: durações em sequência (run-length)
    const stts = [];
    for (const d of t.durations) {
      if (stts.length && stts[stts.length - 1] === d) stts[stts.length - 2]++;
      else stts.push(1, d);
    }
    parts.push(box('stts', fullHeader(0, 0), u32array([stts.length / 2]), u32array(stts)));

    // ctts: deslocamento de composição (quadros B)
    if (t.anyCto) {
      const ctts = [];
      for (const c of t.ctos) {
        if (ctts.length && ctts[ctts.length - 1] === c) ctts[ctts.length - 2]++;
        else ctts.push(1, c);
      }
      parts.push(box('ctts', fullHeader(t.hasNegCto ? 1 : 0, 0), u32array([ctts.length / 2]), u32array(ctts)));
    }

    // stss: quadros-chave (só quando nem todos são)
    if (!t.allSync) {
      const keys = [];
      t.syncs.forEach((s, i) => { if (s) keys.push(i + 1); });
      parts.push(box('stss', fullHeader(0, 0), u32array([keys.length]), u32array(keys)));
    }

    // stsc: amostras por bloco
    const stsc = [];
    t.chunkCounts.forEach((c, i) => {
      if (!stsc.length || stsc[stsc.length - 2] !== c) stsc.push(i + 1, c, 1);
    });
    parts.push(box('stsc', fullHeader(0, 0), u32array([stsc.length / 3]), u32array(stsc)));

    // stsz: tamanho de cada amostra
    parts.push(box('stsz', fullHeader(0, 0), u32array([0, t.sizes.length]), u32array(t.sizes)));

    // co64: posição de cada bloco no arquivo (64 bits, suporta arquivos > 4 GB)
    const co = new Uint8Array(t.chunkOffsets.length * 8);
    const cdv = new DataView(co.buffer);
    t.chunkOffsets.forEach((o, i) => cdv.setBigUint64(i * 8, BigInt(o)));
    parts.push(box('co64', fullHeader(0, 0), u32array([t.chunkOffsets.length]), co));

    return box('stbl', ...parts);
  }
}
