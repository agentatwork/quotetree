/* Load the live page in a real headless Chrome at two viewport sizes, wait for the tree
 * to draw, report any console error, and write a screenshot of each. A tree visualiser
 * that throws on a phone is not a tree visualiser. */
import puppeteer from "/home/agent/work/aidetect/ext/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const URL = process.argv[2] || "https://agentatwork.xyz/quotetree/";
const CHROME = "/home/agent/opt/chrome-linux64/chrome";
const ORIGIN = new globalThis.URL(URL).origin;

const sizes = [
  { name: "desktop", width: 1280, height: 800, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  protocolTimeout: 180000,
});

let bad = 0;
for (const s of sizes) {
  const page = await browser.newPage();
  const errs = [], notes = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  /* Third-party images are not this page's bug: several posters' photos live on hosts that
   * refuse a headless Chrome's hotlink (imgur answers 403). A card renders its alt text and
   * moves on, so those are reported, not failed on. */
  const thirdParty = u => u && !u.startsWith(ORIGIN);
  page.on("console", m => {
    if (m.type() !== "error") return;
    if (/Failed to load resource/.test(m.text()) && thirdParty(m.location()?.url)) {
      notes.push("3rd-party " + m.location().url.replace(/^https?:\/\//, "").slice(0, 48));
      return;
    }
    errs.push("console: " + m.text());
  });
  await page.setViewport({ width: s.width, height: s.height, isMobile: s.mobile,
                           hasTouch: s.mobile, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(".card", { timeout: 30000 }).catch(() => errs.push("no cards drawn"));

  const stats = await page.evaluate(() => ({
    cards: document.querySelectorAll(".card").length,
    edges: document.querySelectorAll(".edge").length,
    images: document.querySelectorAll("image").length,
    audit: document.getElementById("audit").textContent.trim(),
    root: document.getElementById("rootline").textContent.trim(),
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  }));

  await page.screenshot({ path: `shot-${s.name}.png` });

  // click the deepest card and confirm the detail panel opens with content
  const detail = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card")];
    cards[cards.length - 1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const d = document.getElementById("detail");
    return { open: d.classList.contains("open"), len: d.textContent.trim().length };
  });

  await page.screenshot({ path: `shot-${s.name}-detail.png` });

  /* The map is the other half of the page and it is easy to ship broken, because it only
   * draws for authors who filled in a profile location. Open it, count the pins, play one
   * round by clicking a point on the map, and assert the guess scored. */
  const map = await page.evaluate(() => {
    document.getElementById("mapbtn").click();
    return { on: document.getElementById("map").classList.contains("on"),
             pins: document.querySelectorAll("#map circle.pin").length,
             say: document.getElementById("gsay").textContent.replace(/\s+/g, " ").trim().slice(0, 80) };
  });
  let round = { played: false };
  if (map.pins >= 3) {
    await page.evaluate(() => document.getElementById("gbtn").click());
    round = await page.evaluate(() => {
      const m = document.getElementById("map"), r = m.getBoundingClientRect();
      const opts = { bubbles: true, clientX: r.left + r.width * 0.45, clientY: r.top + r.height * 0.4, pointerId: 1 };
      m.setPointerCapture = () => {};
      m.dispatchEvent(new PointerEvent("pointerdown", opts));
      m.dispatchEvent(new PointerEvent("pointerup", opts));
      return { played: true, img: !!document.getElementById("gimg").src,
               shots: document.querySelectorAll("#shots > *").length,
               say: document.getElementById("gsay").textContent.replace(/\s+/g, " ").trim().slice(0, 60) };
    });
  }
  await new Promise(r => setTimeout(r, 400));       // let the detail panel finish sliding out
  await page.screenshot({ path: `shot-${s.name}-map.png` });
  if (map.pins < 3) errs.push(`map: only ${map.pins} pins, game unplayable`);
  else if (round.shots !== 3) errs.push(`map: guess drew ${round.shots} marks, expected 3`);

  console.log(`${s.name.padEnd(8)} cards=${stats.cards} edges=${stats.edges} imgs=${stats.images} ` +
              `detail=${detail.open}/${detail.len}ch overflowX=${stats.overflowX}`);
  console.log(`         root: ${stats.root}`);
  console.log(`         audit: ${stats.audit.replace(/\s+/g, " ")}`);
  console.log(`         map: on=${map.on} pins=${map.pins} played=${round.played} ${round.say || map.say}`);
  if (notes.length) console.log(`         skipped ${notes.length} unloadable third-party image(s): ${notes.slice(0, 2).join(", ")}`);
  if (errs.length) { bad++; errs.slice(0, 6).forEach(e => console.log("  !! " + e)); }
  await page.close();
}
await browser.close();
console.log(bad ? `FAIL: errors in ${bad} viewport(s)` : "OK: no console errors in either viewport");
process.exit(bad ? 1 : 0);
