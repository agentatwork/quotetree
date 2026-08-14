#!/usr/bin/env node
/*
 * Build the full quote-cast tree under a root cast, using only public Farcaster
 * endpoints: the client API for engagement lists and the hubs for casts.
 *
 *   node crawl.js 0x3db990553cbe9e8e8993504624b5c2aaf483aa73 tree.json
 *
 * Why it works this way. Hubs are indexed by author, not by what a cast quotes, so
 * there is no "who quoted this" query anywhere in the public protocol. The one index
 * that has it — Neynar — wants either an account or a working x402 rail, and neither
 * is available here. So the tree is reconstructed: gather every fid plausibly close to
 * a node (its likers, its recasters, its repliers, and the people who follow its
 * author), pull each of their casts back to the root's timestamp, and keep the ones
 * whose embeds point at a cast already in the tree. Repeat until nothing new appears.
 *
 * The honest part is the audit: the client API reports a quoteCount per cast, so every
 * node knows how many children it *should* have. crawl writes found vs expected for
 * each node, and the app shows it. A reconstructed tree that cannot be checked is a
 * guess; one that can be is a measurement.
 */
const fs = require("fs");

const FC = "https://api.farcaster.xyz";
const HUBS = ["https://snap.farcaster.xyz:3381", "https://hub.pinata.cloud"];
const EPOCH = 1609459200;                       // Farcaster time is seconds since 2021-01-01
const UA = { "user-agent": "agentatwork.xyz quote-tree crawler" };

const ROOT = (process.argv[2] || "").toLowerCase();
const OUT = process.argv[3] || "tree.json";
if (!/^0x[0-9a-f]{40}$/.test(ROOT)) { console.error("usage: crawl.js <0x40-hex cast hash> [out.json]"); process.exit(1); }

let calls = 0;
async function j(url, opts) {
  for (let i = 0; i < 4; i++) {
    try {
      calls++;
      const r = await fetch(url, { headers: UA, ...opts });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      const t = await r.text();
      try { return JSON.parse(t); } catch { throw new Error(`${r.status} ${t.slice(0, 100)}`); }
    } catch (e) { if (i === 3) throw e; await sleep(400 * (i + 1)); }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: n }, async () => {
    for (let x = it.next(); !x.done; x = it.next()) await fn(x.value);
  });
  await Promise.all(workers);
}

/* ---- client API: the cast itself, and everyone who touched it ---------------- */

async function castInfo(hash) {
  const d = await j(`${FC}/v2/thread-casts?castHash=${hash}&limit=100`);
  const casts = d.result?.casts || [];
  const self = casts.find(c => c.hash.toLowerCase() === hash) || casts[0];
  return { self, thread: casts };
}

async function paged(path, key, pick, hash) {
  const out = new Set();
  let cursor = null;
  do {
    const d = await j(`${FC}/v2/${path}?castHash=${hash}&limit=100` + (cursor ? `&cursor=${cursor}` : ""));
    (d.result?.[key] || []).forEach(x => out.add(pick(x)));
    cursor = d.next?.cursor;
  } while (cursor);
  return out;
}

async function followers(fid, cap = 6000) {
  const out = new Set();
  let cursor = null;
  do {
    const d = await j(`${FC}/v2/followers?fid=${fid}&limit=50` + (cursor ? `&cursor=${cursor}` : ""));
    (d.result?.users || []).forEach(u => out.add(u.fid));
    cursor = d.next?.cursor;
  } while (cursor && out.size < cap);
  return out;
}

/* ---- hubs: every cast a fid wrote at or after the root's time ---------------- */

const castCache = new Map();          // fid -> [{hash, quoted, ts, text, embeds}]
let hubIdx = 0;

async function castsSince(fid, sinceFcTime) {
  if (castCache.has(fid)) return castCache.get(fid);
  const rows = [];
  const toks = new Set();
  let pt = null, pages = 0;
  outer: while (pages++ < 8) {
    const hub = HUBS[hubIdx % HUBS.length];
    let d;
    try {
      d = await j(`${hub}/v1/castsByFid?fid=${fid}&pageSize=100&reverse=true` + (pt ? `&pageToken=${pt}` : ""));
    } catch (e) { hubIdx++; break; }
    for (const m of d.messages || []) {
      const ts = m.data?.timestamp ?? 0;
      if (ts < sinceFcTime) break outer;                 // reverse order: everything after is older
      const body = m.data?.castAddBody;
      if (!body) continue;
      const quoted = (body.embeds || []).filter(e => e.castId).map(e => e.castId.hash.toLowerCase());
      rows.push({
        hash: m.hash.toLowerCase(), fid, ts, quoted,
        text: body.text || "",
        images: (body.embeds || []).filter(e => e.url).map(e => e.url),
      });
    }
    // some hub endpoints hand back the same nextPageToken forever instead of an empty one
    pt = d.nextPageToken;
    if (!pt || toks.has(pt)) break;
    toks.add(pt);
  }
  castCache.set(fid, rows);
  return rows;
}

/* ---- author profiles -------------------------------------------------------- */

const users = new Map();
async function user(fid) {
  if (users.has(fid)) return users.get(fid);
  const d = await j(`${FC}/v2/user?fid=${fid}`);
  const u = d.result?.user || {};
  const rec = { fid, username: u.username || String(fid), display: u.displayName || "", pfp: u.pfp?.url || "" };
  users.set(fid, rec);
  return rec;
}

/* ---- the crawl -------------------------------------------------------------- */

(async () => {
  const t0 = Date.now();
  const { self: root } = await castInfo(ROOT);
  if (!root) throw new Error("root cast not found");
  const sinceFc = Math.floor(root.timestamp / 1000) - EPOCH;
  console.error(`root by @${root.author.username}, ${root.quoteCount} quotes expected`);

  const nodes = new Map();                       // hash -> node
  const scanned = new Set();                     // fids whose casts we already pulled
  const seedDone = new Set();                    // hashes whose engagement we already listed

  nodes.set(ROOT, {
    hash: ROOT, fid: root.author.fid, parent: null, ts: root.timestamp,
    text: root.text || "", images: (root.embeds?.images || []).map(i => i.url),
    quoteCount: root.quoteCount ?? 0,
  });

  let round = 0;
  while (true) {
    round++;
    // 1. candidate fids for every node we have not seeded yet
    const cands = new Set();
    for (const n of [...nodes.values()]) {
      if (seedDone.has(n.hash)) continue;
      seedDone.add(n.hash);
      // a node discovered in the last round does not know its own quoteCount yet, and
      // "0 quotes" and "not asked yet" are not the same thing — ask before deciding.
      if (n.quoteCount === null) {
        try { n.quoteCount = (await castInfo(n.hash)).self?.quoteCount ?? 0; } catch { n.quoteCount = 0; }
      }
      if (!n.quoteCount) { cands.add(n.fid); continue; }   // leaf: still worth its own casts
      const [likers, recasters, info] = await Promise.all([
        paged("cast-reactions", "reactions", r => r.reactor.fid, n.hash).catch(() => new Set()),
        paged("cast-recasters", "users", u => u.fid, n.hash).catch(() => new Set()),
        castInfo(n.hash).catch(() => ({ thread: [] })),
      ]);
      likers.forEach(f => cands.add(f));
      recasters.forEach(f => cands.add(f));
      info.thread.forEach(c => cands.add(c.author.fid));
      // the people most likely to quote a cast are the ones who see it: its author's followers
      (await followers(n.fid).catch(() => new Set())).forEach(f => cands.add(f));
    }
    const todo = [...cands].filter(f => !scanned.has(f));
    if (!todo.length && round > 1) break;
    console.error(`round ${round}: ${todo.length} fids to scan (${nodes.size} nodes so far)`);

    let done = 0;
    await pool(todo, 8, async fid => {
      scanned.add(fid);
      try { await castsSince(fid, sinceFc); } catch {}
      if (++done % 200 === 0) process.stderr.write(`  ${done}/${todo.length}\r`);
    });

    // 2. join every cached cast against the current node set, repeatedly, so a quote of
    //    a quote resolves without another network round
    let grew = true, added = 0;
    while (grew) {
      grew = false;
      for (const rows of castCache.values()) {
        for (const c of rows) {
          if (nodes.has(c.hash)) continue;
          const parent = c.quoted.find(h => nodes.has(h));
          if (!parent) continue;
          nodes.set(c.hash, { hash: c.hash, fid: c.fid, parent, ts: (c.ts + EPOCH) * 1000,
                              text: c.text, images: c.images, quoteCount: null });
          grew = true; added++;
        }
      }
    }
    console.error(`  +${added} nodes -> ${nodes.size}`);
    if (!added && round > 1) break;
    if (round > 6) break;
  }

  // 3. expected child counts + author profiles
  await pool([...nodes.values()].filter(n => n.quoteCount === null), 6, async n => {
    try { const { self } = await castInfo(n.hash); n.quoteCount = self?.quoteCount ?? 0; } catch { n.quoteCount = 0; }
  });
  await pool([...new Set([...nodes.values()].map(n => n.fid))], 6, f => user(f).catch(() => {}));

  const list = [...nodes.values()].map(n => ({
    ...n, author: users.get(n.fid) || { fid: n.fid, username: String(n.fid), display: "", pfp: "" },
    found: [...nodes.values()].filter(m => m.parent === n.hash).length,
  }));
  const complete = list.every(n => n.found >= (n.quoteCount || 0));
  const out = {
    root: ROOT, fetchedAt: new Date().toISOString(), nodes: list,
    audit: {
      nodes: list.length,
      expectedQuotes: list.reduce((a, n) => a + (n.quoteCount || 0), 0),
      foundQuotes: list.length - 1,
      complete,
      missing: list.filter(n => n.found < (n.quoteCount || 0))
                   .map(n => ({ hash: n.hash, found: n.found, expected: n.quoteCount })),
      fidsScanned: scanned.size, apiCalls: calls, seconds: Math.round((Date.now() - t0) / 1000),
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.error(`\n${list.length} nodes, ${out.audit.foundQuotes}/${out.audit.expectedQuotes} quotes, ` +
                `complete=${complete}, ${scanned.size} fids, ${calls} calls, ${out.audit.seconds}s -> ${OUT}`);
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
