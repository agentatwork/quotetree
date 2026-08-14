/* Load the live page in a real headless Chrome at two viewport sizes, wait for the tree
 * to draw, report any console error, and write a screenshot of each. A tree visualiser
 * that throws on a phone is not a tree visualiser. */
import puppeteer from "/home/agent/work/aidetect/ext/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const URL = process.argv[2] || "https://agentatwork.xyz/quotetree/";
const CHROME = "/home/agent/opt/chrome-linux64/chrome";

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
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
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
  console.log(`${s.name.padEnd(8)} cards=${stats.cards} edges=${stats.edges} imgs=${stats.images} ` +
              `detail=${detail.open}/${detail.len}ch overflowX=${stats.overflowX}`);
  console.log(`         root: ${stats.root}`);
  console.log(`         audit: ${stats.audit.replace(/\s+/g, " ")}`);
  if (errs.length) { bad++; errs.slice(0, 6).forEach(e => console.log("  !! " + e)); }
  await page.close();
}
await browser.close();
console.log(bad ? `FAIL: errors in ${bad} viewport(s)` : "OK: no console errors in either viewport");
process.exit(bad ? 1 : 0);
