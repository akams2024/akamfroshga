const crypto = require("crypto");

const DB_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_URL;
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

async function call(path, body) {
  if (!DB_URL || !DB_TOKEN) throw new Error("DB_NOT_CONFIGURED");
  const headers = { "Content-Type": "application/json" };
  if (DB_TOKEN) headers.Authorization = "Bearer " + DB_TOKEN;
  const r = await fetch(DB_URL + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return r.json();
}
async function redis(...cmd) {
  const j = await call("", cmd);
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function pipe(cmds) {
  const j = await call("/pipeline", cmds);
  return j.map((x) => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}
async function getJ(key) {
  const v = await redis("GET", key);
  return v ? JSON.parse(v) : null;
}
async function mgetJ(keys) {
  if (!keys.length) return [];
  const arr = await redis("MGET", ...keys);
  return arr.map((v) => (v ? JSON.parse(v) : null));
}

function cookies(req) {
  const o = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
function setCookie(res, name, val, maxAge) {
  const c = `${name}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev ? [].concat(prev, c) : c);
}
const token = () => crypto.randomBytes(24).toString("hex");
const ip = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";

async function limit(key, max, windowSec) {
  const n = await redis("INCR", key);
  if (n === 1) await redis("EXPIRE", key, windowSec);
  return n <= max;
}

function normPhone(s) {
  s = String(s || "")
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷٨۹".indexOf(d))
    .replace(/[^\d+]/g, "");
  if (s.startsWith("+964")) s = "0" + s.slice(4);
  else if (s.startsWith("964")) s = "0" + s.slice(3);
  else if (s.length === 10 && s[0] === "7") s = "0" + s;
  return /^07[3-9]\d{8}$/.test(s) ? s : null;
}

const finalPrice = (p) =>
  p.discount ? Math.max(0, Math.round((p.price * (100 - p.discount)) / 100 / 250) * 250) : p.price;

function publicProduct(p) {
  return {
    id: p.id,
    name: p.name,
    desc: p.desc || "",
    price: p.price,
    discount: p.discount || 0,
    final: finalPrice(p),
    inStock: !!p.inStock,
    img: p.hasImg ? `/api/img?id=${p.id}&v=${p.imgv || 0}` : "",
  };
}

async function getUser(req) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const phone = await redis("GET", "sess:" + sid);
  if (!phone) return null;
  const u = await getJ("user:" + phone);
  if (!u || u.blocked) return null;
  return u;
}
async function isAdmin(req) {
  const t = cookies(req).asid;
  if (!t) return false;
  return !!(await redis("GET", "asess:" + t));
}
const publicUser = (u) => ({ phone: u.phone, name: u.name || "", address: u.address || "" });

async function ensureSeed() {
  const first = await redis("SET", "seeded", "1", "NX");
  if (first !== "OK") return;
  const demo = [
    { name: "تیشێرتی ڕەش", price: 8000, discount: 0, desc: "نەرم و ڕەحەت، بۆ هەموو ڕۆژێک" },
    { name: "کلاوی وەرزشی", price: 5000, discount: 20, desc: "سووک و گونجاو" },
    { name: "جانتای شان", price: 6000, discount: 0, desc: "بەهێز و جوان" },
  ];
  const cmds = [];
  demo.forEach((d, i) => {
    const id = crypto.randomBytes(4).toString("hex");
    const p = { id, ...d, inStock: true, hasImg: false, imgv: 0, created: Date.now() - i };
    cmds.push(["SET", "product:" + id, JSON.stringify(p)], ["SADD", "products", id]);
  });
  await pipe(cmds);
}

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e.message === "DB_NOT_CONFIGURED") return res.status(503).json({ error: "داتابەیس هێشتا ڕێکنەخراوە" });
      console.error(e);
      res.status(500).json({ error: "هەڵەی سێرڤەر" });
    }
  };
}

const IMG_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

module.exports = {
  crypto, redis, pipe, getJ, mgetJ, cookies, setCookie, token, ip, limit, normPhone,
  finalPrice, publicProduct, getUser, isAdmin, publicUser, ensureSeed, wrap, IMG_RE,
};
