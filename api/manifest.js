module.exports = (req, res) => {
  const { url, id = 'com.custom.ota.app', title = 'App', ver = '1.0' } = req.query;

  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  const escapeXml = (str) =>
    String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${escapeXml(url)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapeXml(id)}</string>
        <key>bundle-version</key>
        <string>${escapeXml(ver)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${escapeXml(title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.status(200).send(manifest);
};
