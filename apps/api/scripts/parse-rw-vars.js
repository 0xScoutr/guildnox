import fs from "fs";

for (const f of ["rw.json", "rw-pg.json"]) {
  const p = `${process.env.TEMP}/${f}`;
  if (!fs.existsSync(p)) {
    console.log(f, "missing");
    continue;
  }
  let buf = fs.readFileSync(p);
  let s;
  if (buf[0] === 0xff && buf[1] === 0xfe) s = buf.toString("utf16le");
  else s = buf.toString("utf8");
  s = s.replace(/^\uFEFF/, "").trim();
  console.log("====", f, "len", s.length);
  try {
    const j = JSON.parse(s);
    for (const k of Object.keys(j)) {
      if (!/DATA|POST|PG/i.test(k)) continue;
      const v = String(j[k]).replace(/:([^:@/]+)@/, ":***@");
      console.log(k, v.slice(0, 160));
    }
  } catch (e) {
    console.log("parse fail", e.message, JSON.stringify(s.slice(0, 80)));
  }
}
