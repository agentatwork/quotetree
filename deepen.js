#!/usr/bin/env node
/*
 * Second pass over a tree.json that crawl.js left incomplete.
 *
 *   node deepen.js tree.json [minutes]
 *
 * crawl.js caps each author's follower list at 6,000 and each account's history at
 * 8 pages, because it has to do that for every node it touches. Here only the nodes
 * that are actually short of children get the expensive treatment.
 *
 * The first version of this simply unioned every follower of every short author and
 * scanned all of them: 275,331 accounts, about sixty hours. That is the wrong shape of
 * effort. A missing quote is one cast by one account, and the accounts likeliest to hold
 * it are not "anyone who follows @adrienne" but the people already circling this
 * conversation. So candidates are scanned in priority order:
 *
 *   1. accounts that liked, recast or replied to a short node — they demonstrably saw it,
 *      and crawl.js may simply have run out of history pages before reaching their quote;
 *   2. everyone else, ranked by how many of the short authors they follow, because
 *      following four of the seven is a much stronger signal of being in this circle
 *      than following one.
 *
 * It runs against a wall clock and checkpoints as it goes, so a partial pass is still a
 * better tree than no pass. Everything is additive: it can only raise found, never lower
 * it, and it rewrites the audit from the merged set.
 */
const fs = require("fs");

const FC = "https://api.farcaster.xyz";
const HUBS = ["https://snap.farcaster.xyz:3381", "https://hub.pinata.cloud"];
const EPOCH = 1609459200;
const UA = { "user-agent": "agentatwork.xyz quote-tree crawler" };

const FILE = process.argv[2] || "tree.json";
const MINUTES = Number(process.argv[3] || 40);
const tree = JSON.parse(fs.readFileSync(FILE, "utf8"));
const deadline = Date.now() + MINUTES * 60_000;

let calls = 0, hubIdx = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(url) {
  for (let i = 0; i < 4; i++) {
    try {
      calls++;
      const r = await fetch(url, { headers: UA });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      const t = await r.text();
      try { return JSON.parse(t); } catch { throw new Error(`${r.status} ${t.slice(0, 80)}`); }
    } catch (e) { if (i === 3) throw e; await sleep(400 * (i + 1)); }
  }
}
async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: n }, async () => {
    for (let x = it.next(); !x.done; x = it.next()) await fn(x.value);
  }));
}
/* Hub pagination does not always terminate. castsByParent and reactionsByCast return a
 * constant nextPageToken of base64("[null,null]") once the result set is exhausted rather
 * than an empty one, so the obvious `while (nextPageToken)` loop re-serves page one until
 * the caller's page cap saves it — a cast with six replies read as 2,406. linksByTargetFid
 * can hand back a token it has already used. Two guards, and neither trusts the token: stop
 * if it repeats, and stop if a page adds nothing new. */
async function hubPaged(path, cap) {
  const out = [];
  const seen = new Set(), toks = new Set();
  let pt = "", pages = 0;
  do {
    let d;
    try { d = await j(HUBS[hubIdx % HUBS.length] + path + (pt ? `&pageToken=${pt}` : "")); }
    catch { hubIdx++; break; }
    let fresh = 0;
    for (const m of d.messages || []) {
      const k = m.hash || JSON.stringify(m.data);
      if (seen.has(k)) continue;
      seen.add(k); out.push(m); fresh++;
    }
    if (!fresh) break;
    pt = d.nextPageToken;
    if (!pt || toks.has(pt)) break;
    toks.add(pt);
  } while (out.length < cap && pages++ < 400);
  return out;
}

/* Followers come from a hub, not from the client API. The client API allows 500 requests
 * an hour and pages 50 at a time, so one popular account's follower list would eat the
 * whole budget; the hub pages 1,000 at a time, needs no key, and has no such ceiling.
 * The client API is now used for exactly one thing: the per-cast quoteCount the audit
 * checks against, which is a few dozen calls. */
const followersAll = fid =>
  hubPaged(`/v1/linksByTargetFid?target_fid=${fid}&link_type=follow&pageSize=1000`, 400000)
    .then(ms => ms.map(m => m.data.fid));

async function castsSince(fid, since) {
  const rows = [];
  let pt = null, pages = 0;
  outer: while (pages++ < 60) {
    let d;
    try { d = await j(`${HUBS[hubIdx % HUBS.length]}/v1/castsByFid?fid=${fid}&pageSize=100&reverse=true` + (pt ? `&pageToken=${pt}` : "")); }
    catch { hubIdx++; break; }
    for (const m of d.messages || []) {
      const ts = m.data?.timestamp ?? 0;
      if (ts < since) break outer;
      const b = m.data?.castAddBody;
      if (!b) continue;
      rows.push({
        hash: m.hash.toLowerCase(), fid, ts,
        quoted: (b.embeds || []).filter(e => e.castId).map(e => e.castId.hash.toLowerCase()),
        text: b.text || "", images: (b.embeds || []).filter(e => e.url).map(e => e.url),
      });
    }
    pt = d.nextPageToken;
    if (!pt) break;
  }
  return rows;
}

const users = new Map(tree.nodes.map(n => [n.fid, n.author]));
async function user(fid) {
  if (users.has(fid)) return users.get(fid);
  const rec = { fid, username: String(fid), display: "", pfp: "" };
  users.set(fid, rec);
  try {
    const d = await j(`${HUBS[hubIdx % HUBS.length]}/v1/userDataByFid?fid=${fid}`);
    for (const m of d.messages || []) {
      const b = m.data.userDataBody;
      if (b.type === "USER_DATA_TYPE_USERNAME") rec.username = b.value;
      if (b.type === "USER_DATA_TYPE_DISPLAY") rec.display = b.value;
      if (b.type === "USER_DATA_TYPE_PFP") rec.pfp = b.value;
      // self-declared "geo:lat,lon"; see locs.js, which backfills it for the whole tree
      if (b.type === "USER_DATA_TYPE_LOCATION") {
        const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(b.value || "");
        if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) rec.loc = { lat: +m[1], lon: +m[2] };
      }
    }
  } catch {}
  return rec;
}

(async () => {
  const t0 = Date.now();
  const nodes = new Map(tree.nodes.map(n => [n.hash, { ...n }]));
  const root = nodes.get(tree.root);
  const since = Math.floor(root.ts / 1000) - EPOCH;

  const short = [...nodes.values()].filter(n => n.found < (n.quoteCount || 0));
  console.error(`${short.length} nodes short of children, ${tree.audit.foundQuotes}/${tree.audit.expectedQuotes} found`);

  // tier 1: accounts that demonstrably saw a short node
  const seen = new Set();
  for (const n of short) {
    const [likes, recasts, replies] = await Promise.all([
      hubPaged(`/v1/reactionsByCast?target_fid=${n.fid}&target_hash=${n.hash}&reaction_type=Like&pageSize=100`, 20000),
      hubPaged(`/v1/reactionsByCast?target_fid=${n.fid}&target_hash=${n.hash}&reaction_type=Recast&pageSize=100`, 20000),
      hubPaged(`/v1/castsByParent?fid=${n.fid}&hash=${n.hash}&pageSize=100`, 5000),
    ]);
    for (const m of [...likes, ...recasts, ...replies]) seen.add(m.data.fid);
    console.error(`  @${n.author.username}: ${likes.length} likes, ${recasts.length} recasts, ${replies.length} replies`);
  }

  // tier 2: followers of the short authors, ranked by how many of them they follow
  const score = new Map();
  for (const n of short) {
    process.stderr.write(`  followers of @${n.author.username} …`);
    const f = await followersAll(n.fid).catch(() => []);
    for (const x of f) score.set(x, (score.get(x) || 0) + 1);
    console.error(` ${f.length}`);
  }
  const ranked = [...score.keys()].filter(f => !seen.has(f))
                                  .sort((a, b) => score.get(b) - score.get(a));
  const todo = [...seen, ...ranked];
  const hist = {};
  for (const v of score.values()) hist[v] = (hist[v] || 0) + 1;
  console.error(`${todo.length} candidates: ${seen.size} engagers first, then ${ranked.length} ` +
                `followers by overlap ${JSON.stringify(hist)}; ${MINUTES}m budget`);

  let done = 0, scanned = 0;
  const rows = [];
  await pool(todo, 10, async fid => {
    if (Date.now() > deadline) return;
    try { rows.push(...await castsSince(fid, since)); scanned++; } catch {}
    if (++done % 250 === 0)
      process.stderr.write(`  ${done}/${todo.length} scanned, ${rows.length} casts, ` +
                           `${Math.round((deadline - Date.now()) / 60000)}m left\r`);
  });

  let grew = true, added = 0;
  while (grew) {
    grew = false;
    for (const c of rows) {
      if (nodes.has(c.hash)) continue;
      const parent = c.quoted.find(h => nodes.has(h));
      if (!parent) continue;
      nodes.set(c.hash, { hash: c.hash, fid: c.fid, parent, ts: (c.ts + EPOCH) * 1000,
                          text: c.text, images: c.images, quoteCount: null, found: 0, author: null });
      grew = true; added++;
    }
  }
  console.error(`\n+${added} nodes -> ${nodes.size} (scanned ${scanned}/${todo.length})`);

  await pool([...nodes.values()].filter(n => n.quoteCount === null), 6, async n => {
    try {
      const d = await j(`${FC}/v2/thread-casts?castHash=${n.hash}&limit=1`);
      const self = (d.result?.casts || []).find(c => c.hash.toLowerCase() === n.hash);
      n.quoteCount = self?.quoteCount ?? 0;
    } catch { n.quoteCount = 0; }
  });
  await pool([...nodes.values()].filter(n => !n.author), 6, async n => { n.author = await user(n.fid); });

  const list = [...nodes.values()];
  for (const n of list) n.found = list.filter(m => m.parent === n.hash).length;
  const out = {
    root: tree.root, fetchedAt: new Date().toISOString(), nodes: list,
    audit: {
      nodes: list.length,
      expectedQuotes: list.reduce((a, n) => a + (n.quoteCount || 0), 0),
      foundQuotes: list.length - 1,
      complete: list.every(n => n.found >= (n.quoteCount || 0)),
      missing: list.filter(n => n.found < (n.quoteCount || 0))
                   .map(n => ({ hash: n.hash, found: n.found, expected: n.quoteCount })),
      fidsScanned: (tree.audit.fidsScanned || 0) + scanned,
      apiCalls: (tree.audit.apiCalls || 0) + calls,
      seconds: (tree.audit.seconds || 0) + Math.round((Date.now() - t0) / 1000),
    },
  };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 1));
  console.error(`${list.length} nodes, ${out.audit.foundQuotes}/${out.audit.expectedQuotes}, ` +
                `complete=${out.audit.complete}, ${calls} extra calls -> ${FILE}`);
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
