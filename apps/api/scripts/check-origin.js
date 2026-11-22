const origins = String(process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
console.log(JSON.stringify({
  rawLength: String(process.env.CLIENT_ORIGIN || "").length,
  count: origins.length,
  origins,
  apiPublicUrl: process.env.API_PUBLIC_URL || null,
}, null, 2));
