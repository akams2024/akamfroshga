const L = require("./_lib");

const MAX_RECEIPT = 900000; // characters (Upstash free request limit is 1MB)

async function notify(o, receipt) {
  const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) return;
  try {
    const m = L.IMG_RE.exec(receipt);
    const caption = [
      `داواکاری نوێ ${o.no}`, `ڕێگا: ${o.method}`, `بڕ: ${o.total.toLocaleString("en-US")} دینار`,
      `ناو: ${o.name}`, `تەلەفۆن: ${o.phone}`, `ناونیشان: ${o.address}`,
    ].join("\n");
    const f = new FormData();
    f.append("chat_id", c);
    f.append("caption", caption);
    f.append("photo", new Blob([Buffer.from(m[2], "base64")], { type: "image/" + m[1] }), "receipt.jpg");
    await fetch(`https://api.telegram.org/bot${t}/sendPhoto`, { method: "POST", body: f });
  } catch (e) { console.error("telegram", e.message); }
}

module.exports = L.wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = await L.getUser(req);
  if (!user) return res.status(401).json({ error: "پێویستە بچیتە ژوورەوە" });

  if (req.method === "GET") {
    const nos = await L.redis("LRANGE", "uorders:" + user.phone, 0, 49);
    const orders = (await L.mgetJ(nos.map((n) => "order:" + n))).filter(Boolean);
    return res.status(200).json({ orders: orders.map(({ rh, ...o }) => o) });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!(await L.limit("rl:order:" + user.phone, 10, 900)))
    return res.status(429).json({ error: "هەوڵەکان زۆرن، دواتر هەوڵ بدەوە" });

  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 80);
  const address = String(b.address || "").trim().slice(0, 300);
  const payer = String(b.payer_account || "").trim();
  const method = String(b.method || "");
  if (!name || !address) return res.status(400).json({ error: "ناو و ناونیشان پێویستە" });
  if (!/^[0-9]{6,20}$/.test(payer)) return res.status(400).json({ error: "ژمارەی هەژمار دروست نییە" });
  if (!["FIB", "FastPay", "کی کارد"].includes(method)) return res.status(400).json({ error: "ڕێگای پارەدان دروست نییە" });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50)
    return res.status(400).json({ error: "سەبەتە بەتاڵە" });

  const receipt = String(b.receipt || "");
  if (!L.IMG_RE.test(receipt) || receipt.length > MAX_RECEIPT)
    return res.status(400).json({ error: "وێنەی وەسڵ دروست نییە یان زۆر گەورەیە" });

  // نرخ و بەردەستبوون لە داتابەیسەوە (نەک لە کڕیار)
  const ids = b.items.map((i) => String(i.id).replace(/[^a-f0-9]/g, ""));
  const prods = await L.mgetJ(ids.map((i) => "product:" + i));
  let total = 0;
  const lines = [];
  for (let k = 0; k < ids.length; k++) {
    const p = prods[k], q = Number(b.items[k].q);
    if (!p || !Number.isInteger(q) || q < 1 || q > 50) return res.status(400).json({ error: "سەبەتە دروست نییە" });
    if (!p.inStock) return res.status(409).json({ error: `«${p.name}» نەماوە، لە سەبەتە لایبە` });
    const price = L.finalPrice(p);
    total += price * q;
    lines.push({ id: p.id, name: p.name, price, q });
  }

  const rh = L.crypto.createHash("sha256").update(receipt).digest("hex");
  const fresh = await L.redis("SET", "rh:" + rh, "1", "NX");
  if (fresh !== "OK") return res.status(409).json({ error: "ئەم وەسڵە پێشتر بەکارهاتووە" });

  const n = await L.redis("INCR", "orderseq");
  const no = "AK-" + (1000 + n);
  const order = {
    no, phone: user.phone, name, address, method, payer, items: lines, total,
    status: "pending", note: "", created: Date.now(), rh,
  };
  user.name = name;
  user.address = address;
  await L.pipe([
    ["SET", "order:" + no, JSON.stringify(order)],
    ["SET", "receipt:" + no, receipt],
    ["LPUSH", "orders", no],
    ["LPUSH", "uorders:" + user.phone, no],
    ["SET", "user:" + user.phone, JSON.stringify(user)],
  ]);
  await notify(order, receipt);
  res.status(200).json({ order_no: no, total });
});
