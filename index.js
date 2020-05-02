let puppeteer = require("puppeteer");
let { PuppeteerBlocker } = require("@cliqz/adblocker-puppeteer");
let fetch = require("cross-fetch");
let path = require("path");
let fs = require("fs");
const pixelmatch = require("pixelmatch");
const PNG = require("pngjs").PNG;
let config = require("./config/config");

let BROWSER = null;
let INTERVAL = null;
let FILE_TYPE = ".png";
let RENDER_DIR = "images";
const MAX_PIXELS = 1920 * 1080;

function timeout(time) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, time);
  });
}

async function makeNewPage() {
  let page = await BROWSER.newPage();
  let blocker = await PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch);
  await blocker.enableBlockingInPage(page);
  await page.setViewport({
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1
  });
  return page;
}

function getDiffPixelCount(oldName, newName) {
  return new Promise((resolve) => {
    const img1 = fs.createReadStream(oldName).pipe(new PNG()).on('parsed', doneReading);
    const img2 = fs.createReadStream(newName).pipe(new PNG()).on('parsed', doneReading);

    let filesRead = 0;
    function doneReading() {
      // Wait until both files are read.
      if (++filesRead < 2) return;

      // Do the visual diff.
      const diff = new PNG({width: img1.width, height: img2.height});
      const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, {threshold: 0.1});
      resolve(numDiffPixels);
    }
  });
}

async function operate() {
  let page = await makeNewPage();
  for (let website of config.websites) {
    await page.goto(website.url);
    let locToWrite = path.join(process.cwd(), RENDER_DIR, website.name + FILE_TYPE);
    let oldLoc = path.join(process.cwd(), RENDER_DIR, "OLD-" + website.name + FILE_TYPE);
    if(fs.existsSync(locToWrite)) {
      fs.renameSync(locToWrite, oldLoc);
    }
    // wait a second to make sure page has loaded successfully
    await timeout(3000);
    await page.screenshot({path: locToWrite});
    if (fs.existsSync(oldLoc)) {
      let diff = await getDiffPixelCount(oldLoc, locToWrite);
      let percent = (diff / MAX_PIXELS) * 100;
      if (percent > website.diff) {
        console.log(`There is a difference with ${website.name} at ${new Date().toISOString()} - difference was ${percent}%`);
      }
    }
  }
  await page.close();
}

async function init() {
  BROWSER = await puppeteer.launch({args: ['--no-sandbox', '--disable-setuid-sandbox']});

  let updating = false;
  INTERVAL = setInterval(async () => {
    if (updating) {
      return;
    }
    updating = true;
    await operate();
    updating = false;
  }, config.period_ms);
  // first kick off
  await operate();
}

init().catch((err) => {
  console.error("Failed to startup, reason - " + err.toString());
});