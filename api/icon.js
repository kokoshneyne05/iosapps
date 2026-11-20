const zlib = require('zlib');

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  let crc = 0xffffffff;
  for (const byte of typeBuf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function normalizeApplePng(pngBuf) {
  try {
    if (pngBuf.length < 33 || pngBuf.readUInt32BE(0) !== 0x89504e47) return pngBuf;

    let pos = 8;
    let isCgBI = false;
    let ihdr = null;
    const idatChunks = [];

    while (pos + 12 <= pngBuf.length) {
      const len = pngBuf.readUInt32BE(pos);
      if (pos + 12 + len > pngBuf.length) break;
      const type = pngBuf.subarray(pos + 4, pos + 8).toString('ascii');
      const data = pngBuf.subarray(pos + 8, pos + 8 + len);

      if (type === 'CgBI') isCgBI = true;
      else if (type === 'IHDR') ihdr = data;
      else if (type === 'IDAT') idatChunks.push(data);
      else if (type === 'IEND') break;

      pos += 12 + len;
    }

    if (!isCgBI || !ihdr || !idatChunks.length) return pngBuf;

    const width = ihdr.readUInt32BE(0);
    const height = ihdr.readUInt32BE(4);
    const bitDepth = ihdr[8];
    const colorType = ihdr[9];
    if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) return pngBuf;

    const raw = zlib.inflateRawSync(Buffer.concat(idatChunks));
    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp;
    if (raw.length < height * (1 + stride)) return pngBuf;

    const unfiltered = Buffer.alloc(height * stride);

    for (let y = 0; y < height; y++) {
      const filter = raw[y * (1 + stride)];
      const srcRow = y * (1 + stride) + 1;
      const dstRow = y * stride;
      const prevRow = (y - 1) * stride;

      for (let x = 0; x < stride; x++) {
        const val = raw[srcRow + x];
        const a = x >= bpp ? unfiltered[dstRow + x - bpp] : 0;
        const b = y > 0 ? unfiltered[prevRow + x] : 0;
        const c = x >= bpp && y > 0 ? unfiltered[prevRow + x - bpp] : 0;

        let recon = val;
        if (filter === 1) recon = (val + a) & 0xff;
        else if (filter === 2) recon = (val + b) & 0xff;
        else if (filter === 3) recon = (val + ((a + b) >> 1)) & 0xff;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          recon = (val + pr) & 0xff;
        }
        unfiltered[dstRow + x] = recon;
      }
    }

    for (let i = 0; i < unfiltered.length; i += bpp) {
      let b = unfiltered[i];
      let g = unfiltered[i + 1];
      let r = unfiltered[i + 2];
      if (bpp === 4) {
        const a = unfiltered[i + 3];
        if (a > 0 && a < 255) {
          r = Math.min(255, Math.round((r * 255) / a));
          g = Math.min(255, Math.round((g * 255) / a));
          b = Math.min(255, Math.round((b * 255) / a));
        }
      }
      unfiltered[i] = r;
      unfiltered[i + 1] = g;
      unfiltered[i + 2] = b;
    }

    const filtered = Buffer.alloc(height * (1 + stride));
    for (let y = 0; y < height; y++) {
      filtered[y * (1 + stride)] = 0;
      unfiltered.copy(filtered, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
    }

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makePngChunk('IHDR', ihdr),
      makePngChunk('IDAT', zlib.deflateSync(filtered)),
      makePngChunk('IEND', Buffer.alloc(0)),
    ]);
  } catch (_) {
    return pngBuf;
  }
}

module.exports = async (req, res) => {
  const { url, entry } = req.query;
  if (!url || !entry) return res.status(400).send('Missing parameters');

  if (!url.startsWith('https://github.com/') && !url.startsWith('https://objects.githubusercontent.com/')) {
    return res.status(403).send('Invalid source URL');
  }

  try {
    const headRes = await fetch(url, { method: 'HEAD' });
    const finalUrl = headRes.url || url;
    const totalSize = parseInt(headRes.headers.get('content-range')?.split('/')[1] || headRes.headers.get('content-length') || '0', 10);
    if (!totalSize) return res.status(404).end();

    const tailStart = Math.max(0, totalSize - 65536);
    const tailRes = await fetch(finalUrl, {
      headers: { Range: `bytes=${tailStart}-${totalSize - 1}` },
    });
    const tail = Buffer.from(await tailRes.arrayBuffer());

    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos === -1) return res.status(404).end();

    const cdSize = tail.readUInt32LE(eocdPos + 12);
    const cdOffset = tail.readUInt32LE(eocdPos + 16);
    const cdBuf =
      cdOffset >= tailStart
        ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
        : Buffer.from(
            await (
              await fetch(finalUrl, {
                headers: { Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` },
              })
            ).arrayBuffer()
          );

    let pos = 0;
    while (pos + 46 <= cdBuf.length) {
      if (cdBuf.readUInt32LE(pos) !== 0x02014b50) break;
      const method = cdBuf.readUInt16LE(pos + 10);
      const compSize = cdBuf.readUInt32LE(pos + 20);
      const nameLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      const localOffset = cdBuf.readUInt32LE(pos + 42);
      const name = cdBuf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');

      if (name === entry) {
        const endByte = Math.min(totalSize - 1, localOffset + 30 + nameLen + 4096 + compSize);
        const fileRes = await fetch(finalUrl, {
          headers: { Range: `bytes=${localOffset}-${endByte}` },
        });
        const fileBuf = Buffer.from(await fileRes.arrayBuffer());
        const lNameLen = fileBuf.readUInt16LE(26);
        const lExtraLen = fileBuf.readUInt16LE(28);
        const dataStart = 30 + lNameLen + lExtraLen;
        const compData = fileBuf.subarray(dataStart, dataStart + compSize);
        const rawPng = method === 8 ? zlib.inflateRawSync(compData) : compData;
        const cleanPng = normalizeApplePng(rawPng);

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        return res.status(200).send(cleanPng);
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }

    res.status(404).end();
  } catch (e) {
    res.status(500).end();
  }
};
