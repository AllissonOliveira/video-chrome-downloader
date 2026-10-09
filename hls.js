// Leitura de playlists HLS (.m3u8). Código próprio, sem dependências.

function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function parseByteRange(value, lastEnd) {
  const [len, off] = value.split('@');
  const start = off !== undefined ? Number(off) : lastEnd;
  const end = start + Number(len) - 1;
  return { start, end };
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('O arquivo não é uma playlist HLS válida.');
  }
  const abs = (u) => new URL(u, baseUrl).href;

  // Playlist principal (lista de qualidades)
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const audio = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice('#EXT-X-STREAM-INF:'.length));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (j < lines.length) {
          const url = abs(lines[j]);
          if (!seen.has(url)) {
            seen.add(url);
            const res = a.RESOLUTION || null;
            variants.push({
              url,
              bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || null,
              resolution: res,
              height: res ? parseInt(res.split('x')[1], 10) || null : null,
              codecs: a.CODECS || null,
              audioGroup: a.AUDIO || null,
            });
          }
          i = j;
        }
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice('#EXT-X-MEDIA:'.length));
        if (a.TYPE === 'AUDIO' && a.URI) {
          audio.push({
            groupId: a['GROUP-ID'] || null,
            name: a.NAME || a.LANGUAGE || 'Áudio',
            language: a.LANGUAGE || null,
            url: abs(a.URI),
            isDefault: a.DEFAULT === 'YES',
          });
        }
      }
    }
    variants.sort((x, y) => (y.height || 0) - (x.height || 0) || (y.bandwidth || 0) - (x.bandwidth || 0));
    return { type: 'master', variants, audio };
  }

  // Playlist de mídia (lista de pedaços)
  const segments = [];
  let map = null;
  let encrypted = false;
  let encryptionMethod = null;
  let pendingDur = null;
  let pendingRange = null;
  const lastEndByUrl = {};
  let ended = false;

  for (const l of lines) {
    if (l.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(l.slice(8)) || 0;
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = l.slice('#EXT-X-BYTERANGE:'.length);
    } else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice('#EXT-X-KEY:'.length));
      if (a.METHOD && a.METHOD !== 'NONE') {
        encrypted = true;
        encryptionMethod = a.METHOD;
      }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice('#EXT-X-MAP:'.length));
      if (a.URI) {
        map = { url: abs(a.URI), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      }
    } else if (l === '#EXT-X-ENDLIST' || l === '#EXT-X-PLAYLIST-TYPE:VOD') {
      ended = true;
    } else if (!l.startsWith('#')) {
      const url = abs(l);
      let range = null;
      if (pendingRange) {
        range = parseByteRange(pendingRange, lastEndByUrl[url] || 0);
        lastEndByUrl[url] = range.end + 1;
      }
      segments.push({ url, duration: pendingDur || 0, range });
      pendingDur = null;
      pendingRange = null;
    }
  }

  return {
    type: 'media',
    segments,
    map,
    encrypted,
    encryptionMethod,
    duration: segments.reduce((s, x) => s + x.duration, 0),
    isLive: !ended,
    container: map ? 'mp4' : 'ts',
  };
}
