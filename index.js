let puppeteer = require("puppeteer");
let { PuppeteerBlocker } = require("@cliqz/adblocker-puppeteer");
let fetch = require("cross-fetch");
let path = require("path");
let fs = require("fs");
const pixelmatch = require("pixelmatch");
const PNG = require("pngjs").PNG;
let config = require("./config/config");
var nodemailer = require("nodemailer");
let transporter = null;

let BROWSER = null;
let INTERVAL = null;
let FILE_TYPE = ".png";
let RENDER_DIR = "renders";
let OLD_RENDER_DIR = "prevrenders";
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

function confirmDirExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
}

function sendEmail(to, msg) {
  let mailOptions = {
    from: process.env["EMAIL_USER"],
    to: to,
    subject: config.email_title,
    text: msg
  };
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log(error);
    } else {
      console.log('Email sent: ' + info.response);
    }
  });
}

async function runOnPage(page, website) {
  await page.goto(website.url);
  let locToWrite = path.join(process.cwd(), RENDER_DIR, website.name + FILE_TYPE);
  let oldLoc = path.join(process.cwd(), OLD_RENDER_DIR, website.name + FILE_TYPE);
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
      let msg = `There is a difference with ${website.name} at ${new Date().toISOString()} - difference was ${percent}%`
      console.log(msg);
      sendEmail(config.to, `${msg} - URL: ${website.url}`);
    }
  }
}

async function operate() {
  confirmDirExists(RENDER_DIR);
  confirmDirExists(OLD_RENDER_DIR);
  let parallel = Math.max(1, config.parallel);
  let pages = [];
  for (let i = 0; i < parallel; i++) {
    pages.push(await makeNewPage());
  }
  let websiteIdx = 0;
  do {
    let promises = [];
    for (let page of pages) {
      if (websiteIdx >= config.websites.length) {
        break;
      }
      promises.push(runOnPage(page, config.websites[websiteIdx++]));
    }
    if (promises.length !== 0) {
      await Promise.all(promises);
    }
  } while (websiteIdx < config.websites.length);
  // cleanup
  for (let page of pages) {
    await page.close();
  }
  console.log(`Operation completed at ${(new Date()).toISOString()}`);
}

async function init() {
  if (process.env["EMAIL_USER"] == null || process.env["EMAIL_PASS"] == null) {
    console.error("Please specify environment variables 'EMAIL_USER' and 'EMAIL_PASS' for gmail.");
    process.exit(-1);
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env["EMAIL_USER"],
      pass: process.env["EMAIL_PASS"]
    }
  });
  console.log("System init'd, commencing operations.");
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
