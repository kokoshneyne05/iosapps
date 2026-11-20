const zlib = require('zlib');
const bplist = require('bplist-parser');
const plist = require('plist');

async function readIpaMetaFromUrl(url, fallbackName) {
  let title = fallbackName.replace(/\.ipa$/i, '');
  let bundleId = 'com.custom.ota.app';
  let version = '1.0';

  try {
    const headRes = await fetch(url, { method: 'HEAD' });
    const finalUrl = headRes.url || url;
    const totalSize = parseInt(headRes.headers.get('content-length') || '0', 10);
    if (!totalSize) return { title, bundleId, version };

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
    if (eocdPos === -1) return { title, bundleId, version };

    const cdSize = tail.readUInt32LE(eocdPos + 12);
    const cdOffset = tail.readUInt32LE(eocdPos + 16);
    let cdBuf;

    if (cdOffset >= tailStart) {
      cdBuf = tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
    } else {
      const cdRes = await fetch(finalUrl, {
        headers: { Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` },
      });
      cdBuf = Buffer.from(await cdRes.arrayBuffer());
    }

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

      if (/^Payload\/[^/]+\.app\/Info\.plist$/.test(name)) {
        const endByte = Math.min(totalSize - 1, localOffset + 30 + nameLen + 4096 + compSize);
        const fileRes = await fetch(finalUrl, {
          headers: { Range: `bytes=${localOffset}-${endByte}` },
        });
        const fileBuf = Buffer.from(await fileRes.arrayBuffer());
        const lNameLen = fileBuf.readUInt16LE(26);
        const lExtraLen = fileBuf.readUInt16LE(28);
        const dataStart = 30 + lNameLen + lExtraLen;
        const compData = fileBuf.subarray(dataStart, dataStart + compSize);
        const rawPlist = method === 8 ? zlib.inflateRawSync(compData) : compData;

        const parsed =
          rawPlist.subarray(0, 6).toString('ascii') === 'bplist'
            ? bplist.parseBuffer(rawPlist)[0]
            : plist.parse(rawPlist.toString('utf8'));

        title = parsed.CFBundleDisplayName || parsed.CFBundleName || title;
        bundleId = parsed.CFBundleIdentifier || bundleId;
        version = parsed.CFBundleShortVersionString || parsed.CFBundleVersion || version;
        break;
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
  } catch (e) {
    console.error('Ошибка чтения Info.plist:', e.message);
  }

  return { title, bundleId, version };
}

module.exports = async (req, res) => {
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const repo = process.env.VERCEL_GIT_REPO_SLUG;

  if (!owner || !repo) {
    return res.status(500).json({ error: 'Проект не привязан к GitHub-репозиторию в Vercel' });
  }

  try {
    const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
      headers: { 'User-Agent': 'vercel-ota-installer' },
    });
    const releases = await ghRes.json();

    if (!Array.isArray(releases)) {
      return res.status(400).json({ error: 'Не удалось получить релизы. Убедитесь, что репозиторий Public.' });
    }

    const apps = [];
    for (const rel of releases) {
      for (const asset of rel.assets || []) {
        if (!asset.name.toLowerCase().endsWith('.ipa')) continue;
        const meta = await readIpaMetaFromUrl(asset.browser_download_url, asset.name);
        apps.push({
          url: asset.browser_download_url,
          fileName: asset.name,
          title: meta.title,
          bundleId: meta.bundleId,
          version: meta.version,
          sizeMb: (asset.size / 1024 / 1024).toFixed(1),
        });
      }
    }

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    res.status(200).json(apps);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
