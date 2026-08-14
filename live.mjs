/* The prebuilt example proves the renderer. This proves the crawler: paste a real cast URL
 * into the live page, click build, and watch a tree appear that was not on disk anywhere. */
import puppeteer from "/home/agent/work/aidetect/ext/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const url = process.argv[2] || "https://agentatwork.xyz/quotetree/";
const cast = process.argv[3] || "https://farcaster.xyz/rubinovitz/0x9b97d530ec460c63b4d1d9ac11c6ac002fedb61f";
const b = await puppeteer.launch({ executablePath: "/home/agent/opt/chrome-linux64/chrome",
  headless: true, args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"], protocolTimeout: 600000 });
const p = await b.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
await p.setViewport({ width: 1280, height: 800 });
await p.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
const t0 = Date.now();
await p.evaluate(c => {
  const i = document.querySelector("#q"); i.value = c;
  i.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#load").click();
}, cast);
await new Promise(r => setTimeout(r, 1500));
await p.waitForFunction(() => !document.getElementById("prog").classList.contains("on"),
                        { timeout: 540000, polling: 1000 }).catch(() => errs.push("crawl never finished"));
const s = await p.evaluate(() => ({
  cards: document.querySelectorAll(".card").length,
  root: document.getElementById("rootline").textContent.trim(),
  audit: document.getElementById("audit").textContent.replace(/\s+/g, " ").trim(),
}));
await p.screenshot({ path: "shot-live.png" });
console.log(`built in ${Math.round((Date.now()-t0)/1000)}s: cards=${s.cards}`);
console.log(`  root: ${s.root}`);
console.log(`  audit: ${s.audit}`);
errs.slice(0,5).forEach(e => console.log("  !! " + e));
await b.close();
process.exit(errs.length || s.cards < 2 ? 1 : 0);
