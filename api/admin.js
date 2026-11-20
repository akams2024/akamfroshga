const L = require("./_lib");

const STATUSES = ["pending", "approved", "shipped", "rejected"];
const HALF_DAY = 60 * 60 * 12;

function safeEq(a, b) {
  const x = L.crypto.createHash("sha256").update(String(a)).digest();
  const y = L.crypto.createHash("sha256").update(String(b)).digest();
  return L.crypto.timingSafeEqual(x, y);
}

module.exports = L.wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  // وێنەی وەسڵ (تەنیا بەڕێوەبەر)
  if (req.method === "GET") {
    if (!(await L.isAdmin(req))) return res.status(401).end();
    const no = String(req.query.receipt || "").replace(/[^A-Z0-9-]/g, "");
    const v = no ? await L.redis("GET", "receipt:" + no) : null;
    const m = v && L.IMG_RE.exec(v);
    if (!m) return res.status(404).end();
    res.setHeader("Content-Type", "image/" + m[1]);
    return res.status(200).send(Buffer.from(m[2], "base64"));
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const b = req.body || {};

  if (b.action === "login") {
    const key = "rl:admin:" + L.ip(req);
    if (!(await L.limit(key, 5, 900)))
      return res.status(429).json({ error: "زۆر هەوڵت دا. ١٥ خولەک چاوەڕێ بکە" });
    const pass = process.env.ADMIN_PASS;
    if (!pass) return res.status(503).json({ error: "ADMIN_PASS ڕێکنەخراوە" });
    if (!safeEq(b.password || "", pass)) return res.status(401).json({ error: "پاسۆرد هەڵەیە" });
    await L.redis("DEL", key);
    const t = L.token();
    await L.redis("SET", "asess:" + t, "1", "EX", HALF_DAY);
    L.setCookie(res, "asid", t, HALF_DAY);
    return res.status(200).json({ ok: true });
  }

  if (!(await L.isAdmin(req))) return res.status(401).json({ error: "پێویستە بچیتە ژوورەوە" });

  switch (b.action) {
    case "me":
      return res.status(200).json({ ok: true });

    case "logout": {
      const t = L.cookies(req).asid;
      if (t) await L.redis("DEL", "asess:" + t);
      L.setCookie(res, "asid", "", 0);
      return res.status(200).json({ ok: true });
    }

    case "stats": {
      const [orders, users] = await L.pipe([["LRANGE", "orders", 0, 499], ["SCARD", "users"]]);
      const list = (await L.mgetJ(orders.map((n) => "order:" + n))).filter(Boolean);
      const sold = list.filter((o) => o.status === "approved" || o.status === "shipped").reduce((s, o) => s + o.total, 0);
      return res.status(200).json({
        pending: list.filter((o) => o.status === "pending").length,
        orders: list.length, sold, users,
      });
    }

    case "products": {
      const ids = await L.redis("SMEMBERS", "products");
      const list = (await L.mgetJ(ids.map((i) => "product:" + i))).filter(Boolean)
        .sort((a, b2) => b2.created - a.created).map(L.publicProduct);
      return res.status(200).json({ products: list });
    }

    case "productSave": {
      const name = String(b.name || "").trim().slice(0, 80);
      const price = Number(b.price), discount = Number(b.discount || 0);
      if (!name) return res.status(400).json({ error: "ناوی کاڵا بنووسە" });
      if (!Number.isInteger(price) || price < 0 || price > 100000000) return res.status(400).json({ error: "نرخ دروست نییە" });
      if (!Number.isInteger(discount) || discount < 0 || discount > 90) return res.status(400).json({ error: "داشکان لە 0 تا 90 بێت" });
      let p = b.id ? await L.getJ("product:" + String(b.id).replace(/[^a-f0-9]/g, "")) : null;
      if (b.id && !p) return res.status(404).json({ error: "کاڵاکە نەدۆزرایەوە" });
      if (!p) p = { id: L.crypto.randomBytes(4).toString("hex"), created: Date.now(), hasImg: false, imgv: 0 };
      Object.assign(p, { name, price, discount, inStock: !!b.inStock, desc: String(b.desc || "").trim().slice(0, 200) });
      const cmds = [["SET", "product:" + p.id, ""], ["SADD", "products", p.id]];
      if (b.image) {
        if (!L.IMG_RE.test(b.image) || b.image.length > 900000) return res.status(400).json({ error: "وێنە دروست نییە یان زۆر گەورەیە" });
        p.hasImg = true; p.imgv = Date.now();
        cmds.push(["SET", "pimg:" + p.id, b.image]);
      } else if (b.removeImage) {
        p.hasImg = false; p.imgv = Date.now();
        cmds.push(["DEL", "pimg:" + p.id]);
      }
      cmds[0][2] = JSON.stringify(p);
      await L.pipe(cmds);
      return res.status(200).json({ product: L.publicProduct(p) });
    }

    case "productDelete": {
      const id = String(b.id || "").replace(/[^a-f0-9]/g, "");
      await L.pipe([["DEL", "product:" + id], ["DEL", "pimg:" + id], ["SREM", "products", id]]);
      return res.status(200).json({ ok: true });
    }

    case "orders": {
      const nos = await L.redis("LRANGE", "orders", 0, 199);
      let list = (await L.mgetJ(nos.map((n) => "order:" + n))).filter(Boolean);
      if (STATUSES.includes(b.status)) list = list.filter((o) => o.status === b.status);
      return res.status(200).json({ orders: list.map(({ rh, ...o }) => o) });
    }

    case "orderStatus": {
      const no = String(b.no || "").replace(/[^A-Z0-9-]/g, "");
      const o = await L.getJ("order:" + no);
      if (!o) return res.status(404).json({ error: "داواکاری نەدۆزرایەوە" });
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: "دۆخ دروست نییە" });
      o.status = b.status;
      o.note = String(b.note || "").slice(0, 300);
      o.updated = Date.now();
      const cmds = [["SET", "order:" + no, JSON.stringify(o)]];
      if (b.status === "rejected" && o.rh) cmds.push(["DEL", "rh:" + o.rh]);
      await L.pipe(cmds);
      return res.status(200).json({ ok: true });
    }

    case "customers": {
      const phones = await L.redis("SMEMBERS", "users");
      const users = (await L.mgetJ(phones.map((p) => "user:" + p))).filter(Boolean);
      const counts = users.length ? await L.pipe(users.map((u) => ["LLEN", "uorders:" + u.phone])) : [];
      const out = users.map((u, i) => ({ ...u, orders: counts[i] })).sort((a, b2) => b2.created - a.created);
      return res.status(200).json({ customers: out });
    }

    case "customerBlock": {
      const phone = L.normPhone(b.phone);
      const u = phone && (await L.getJ("user:" + phone));
      if (!u) return res.status(404).json({ error: "کڕیار نەدۆزرایەوە" });
      u.blocked = !!b.blocked;
      await L.redis("SET", "user:" + phone, JSON.stringify(u));
      return res.status(200).json({ ok: true });
    }

    case "customerOrders": {
      const phone = L.normPhone(b.phone);
      const nos = phone ? await L.redis("LRANGE", "uorders:" + phone, 0, 49) : [];
      const list = (await L.mgetJ(nos.map((n) => "order:" + n))).filter(Boolean);
      return res.status(200).json({ orders: list.map(({ rh, ...o }) => o) });
    }

    case "settingsGet": {
      const s = (await L.getJ("settings")) || {};
      return res.status(200).json({ account: s.account || process.env.ACCOUNT || "7821131517" });
    }
    case "settingsSave": {
      const account = String(b.account || "").replace(/\D/g, "");
      if (account.length < 6 || account.length > 20) return res.status(400).json({ error: "ژمارەی هەژمار دروست نییە" });
      await L.redis("SET", "settings", JSON.stringify({ account }));
      return res.status(200).json({ ok: true });
    }
  }
  res.status(400).json({ error: "کارەکە نەناسرایەوە" });
});
