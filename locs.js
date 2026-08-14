#!/usr/bin/env node
/*
 * Add self-declared profile locations to a tree.json.
 *
 *   node locs.js tree.json
 *
 * Farcaster profiles can carry USER_DATA_TYPE_LOCATION, a string of the form
 * "geo:lat,lon". Most accounts leave it blank and the ones that fill it in are typing a
 * city, not a GPS fix — so this stores exactly what the hub returns and nothing is
 * inferred from it. Casts with no author location simply have no pin.
 *
 * Kept separate from crawl.js and deepen.js on purpose: this is one extra request per
 * distinct author, it is only needed by the map view, and a tree without it is still a
 * complete tree.
 */
const fs = require("fs");

const HUBS = ["https://snap.farcaster.xyz:3381", "https://hub.pinata.cloud"];
const UA = { "user-agent": "agentatwork.xyz quote-tree crawler" };
const FILE = process.argv[2] || "tree.json";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let hubIdx = 0;

function parseGeo(v) {
  const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(String(v || ""));
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

async function loc(fid) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${HUBS[hubIdx % HUBS.length]}/v1/userDataByFid?fid=${fid}`, { headers: UA });
      const d = await r.json();
      for (const m of d.messages || []) {
        const b = m.data.userDataBody;
        if (b.type === "USER_DATA_TYPE_LOCATION") return parseGeo(b.value);
      }
      return null;
    } catch { hubIdx++; await sleep(300 * (i + 1)); }
  }
  return null;
}

(async () => {
  const tree = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const fids = [...new Set(tree.nodes.map(n => n.fid))];
  const found = new Map();
  let done = 0;
  const it = fids[Symbol.iterator]();
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let x = it.next(); !x.done; x = it.next()) {
      const l = await loc(x.value);
      if (l) found.set(x.value, l);
      if (++done % 20 === 0) process.stderr.write(`  ${done}/${fids.length}\r`);
    }
  }));
  for (const n of tree.nodes) {
    const l = found.get(n.fid);
    if (n.author) { if (l) n.author.loc = l; else delete n.author.loc; }
  }
  fs.writeFileSync(FILE, JSON.stringify(tree, null, 1));
  console.error(`\n${found.size}/${fids.length} authors have a location -> ${FILE}`);
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
