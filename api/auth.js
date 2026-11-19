const L = require("./_lib");

const MONTH = 60 * 60 * 24 * 30;

module.exports = L.wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const u = await L.getUser(req);
    return res.status(200).json({ user: u ? L.publicUser(u) : null });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const b = req.body || {};

  if (b.action === "login") {
    if (!(await L.limit("rl:login:" + L.ip(req), 20, 900)))
      return res.status(429).json({ error: "هەوڵەکان زۆرن، دواتر هەوڵ بدەوە" });
    const phone = L.normPhone(b.phone);
    if (!phone) return res.status(400).json({ error: "ژمارەی مۆبایل دروست نییە (نموونە: 07501234567)" });

    let u = await L.getJ("user:" + phone);
    if (u && u.blocked) return res.status(403).json({ error: "ئەم ئەکاونتە بلۆک کراوە" });
    if (!u) {
      u = { phone, name: String(b.name || "").trim().slice(0, 60), address: "", blocked: false, created: Date.now() };
      await L.pipe([["SET", "user:" + phone, JSON.stringify(u)], ["SADD", "users", phone]]);
    }
    const t = L.token();
    await L.redis("SET", "sess:" + t, phone, "EX", MONTH);
    L.setCookie(res, "sid", t, MONTH);
    return res.status(200).json({ user: L.publicUser(u) });
  }

  if (b.action === "logout") {
    const sid = L.cookies(req).sid;
    if (sid) await L.redis("DEL", "sess:" + sid);
    L.setCookie(res, "sid", "", 0);
    return res.status(200).json({ ok: true });
  }

  if (b.action === "profile") {
    const u = await L.getUser(req);
    if (!u) return res.status(401).json({ error: "پێویستە بچیتە ژوورەوە" });
    u.name = String(b.name || "").trim().slice(0, 60);
    u.address = String(b.address || "").trim().slice(0, 300);
    await L.redis("SET", "user:" + u.phone, JSON.stringify(u));
    return res.status(200).json({ user: L.publicUser(u) });
  }

  res.status(400).json({ error: "داواکاری دروست نییە" });
});
