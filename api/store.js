const L = require("./_lib");

module.exports = L.wrap(async (req, res) => {
  await L.ensureSeed();
  const ids = await L.redis("SMEMBERS", "products");
  const prods = (await L.mgetJ(ids.map((i) => "product:" + i)))
    .filter(Boolean)
    .sort((a, b) => b.created - a.created)
    .map(L.publicProduct);
  const settings = (await L.getJ("settings")) || {};
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    account: settings.account || process.env.ACCOUNT || "7821131517",
    products: prods,
  });
});
