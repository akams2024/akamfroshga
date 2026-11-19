const L = require("./_lib");

module.exports = L.wrap(async (req, res) => {
  const id = String(req.query.id || "").replace(/[^a-f0-9]/g, "");
  const v = id ? await L.redis("GET", "pimg:" + id) : null;
  const m = v && L.IMG_RE.exec(v);
  if (!m) return res.status(404).end();
  res.setHeader("Content-Type", "image/" + m[1]);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.status(200).send(Buffer.from(m[2], "base64"));
});
