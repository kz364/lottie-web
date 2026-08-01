/**
 * This traverses all json files located on the examples folder, then iterates
 * over each file and opens a puppeteer page to a screenshot of all frames
 * combined in a single page.
 */

const puppeteer = require('puppeteer');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { promises: { readFile } } = require('fs');
const commandLineArgs = require('command-line-args');
const PNG = require('pngjs').PNG;
const pixelmatch = require('pixelmatch');

const examplesDirectory = '/test/animations/';
const createDirectory = 'screenshots/create';
const compareDirectory = 'screenshots/compare';
const serverPort = 9999;

// Every wait in this file is bounded. A renderer that never reaches DOMLoaded,
// a frame that never reports back or a page that dies must fail the run
// instead of blocking it forever.
const timeouts = {
  animationLoad: 30000,
  frame: 30000,
  pageLoad: 30000,
};

function createDirectoryPath(directoryPath) {
    const directories = directoryPath.split('/');
    directories.reduce((acc, current) => {
        let dir = acc + '/' + current
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir);
        }
        return dir
    }, '.')
}

const animations = [
  {
    fileName: 'banner.json',
    renderer: 'svg',
  },
  {
    fileName: 'adrock.json',
    renderer: 'canvas',
  },
  {
    fileName: 'bm_ronda.json',
    renderer: 'svg',
  },
  {
    fileName: 'bodymovin.json',
    renderer: 'svg',
  },
  {
    fileName: 'bodymovin.json',
    renderer: 'canvas',
  },
  {
    fileName: 'dalek.json',
    renderer: 'svg',
  },
  {
    fileName: 'navidad.json',
    renderer: 'svg',
  },
  {
    fileName: 'monster.json',
    renderer: 'svg',
  },
  {
    fileName: 'bacon.json',
    renderer: 'svg',
  },
  {
    fileName: 'lights.json',
    renderer: 'svg',
  },
  {
    fileName: 'ripple.json',
    renderer: 'svg',
  },
  {
    fileName: 'starfish.json',
    renderer: 'svg',
  },
  {
    directory: 'footage',
    fileName: 'data.json',
    renderer: 'svg',
  },
]

const getSettings = async () => {
    const defaultValues = {
        step: 'create',
    }
    const opts = [
        {
          name: 'step',
          alias: 's',
          type: (val) => {
            
            return val === 'compare' ? 'compare' : 'create';
          },
          description: 'Whether it is the create or the compare step',
        },
        {
          name: 'animation',
          alias: 'a',
          type: String,
          description: 'Only process animations whose file name contains this value',
        }
    ];
  const settings = {
    ...defaultValues,
    ...commandLineArgs(opts),
  };
  return settings;
};

const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));

// Rejects if the wrapped promise has not settled in time, so a stalled page
// surfaces as a failed animation rather than a hung process.
const withTimeout = (promise, ms, description) => {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${description}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const animationPath = (animation) => (
  `.${examplesDirectory}${animation.directory ? `${animation.directory}/` : ''}${animation.fileName}`
);

// The list above is maintained by hand, so a renamed or deleted animation used
// to show up as a page that never loads. Fail immediately and say which file.
const validateAnimations = () => {
  const missing = animations
    .map(animationPath)
    .filter((filePath) => !fs.existsSync(filePath));
  if (missing.length) {
    throw new Error(`Missing animation files: ${missing.join(', ')}`);
  }
};

const filesData = [
  {
    path: '/test/index.html',
    filePath: './test/index.html',
    type: 'html',
  },
  {
    path: '/lottie.min.js',
    filePath: './build/player/lottie.min.js',
    type: 'js',
  },
];

const getEncoding = (() => {
  const encodingMap = {
    js: 'utf8',
    json: 'utf8',
    html: 'utf8',
  };
  return (fileType) => encodingMap[fileType];
})();

const getContentTypeHeader = (() => {
  const contentTypeMap = {
    js: { 'Content-Type': 'application/javascript' },
    json: { 'Content-Type': 'application/json' },
    html: { 'Content-Type': 'text/html; charset=utf-8' },
    wasm: { 'Content-Type': 'application/wasm' },
    image: { 'Content-Type': 'image/jpeg' },
  };
  return (fileType) => contentTypeMap[fileType];
})();

const startServer = async () => {
  const app = express();
  await Promise.all(filesData.map(async (file) => {
    app.get(file.path, async (req, res) => {
      res.writeHead(200, getContentTypeHeader(file.type));
      // TODO: comment line. Only for live updates.
      const fileData = await readFile(file.filePath, getEncoding(file.type));
      res.end(fileData);
    });
    return file;
  }));

  app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
  });

  app.get('/*', async (req, res) => {
    const requestedPath = req.originalUrl.split('?')[0];
    const isJSON = path.extname(requestedPath) === '.json';
    try {
      // Read before writing the head: a missing file used to throw after the
      // response had started, which crashed the whole process.
      const data = await readFile(`.${requestedPath}`, isJSON ? 'utf8' : undefined);
      res.writeHead(200, getContentTypeHeader(isJSON ? 'json' : 'image'));
      res.end(data);
    } catch (err) {
      res.status(404).end();
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(serverPort);
    server.on('listening', () => resolve(server));
    server.on('error', reject);
  });
};

const getBrowser = async () => puppeteer.launch({
  defaultViewport: null,
  headless: 'new',
  args: [
    // CI runners have no usable Chromium sandbox.
    '--no-sandbox',
    '--disable-setuid-sandbox',
    // Text is the only thing that rendered differently between two runs of the
    // same bundle: glyph edges moved by a fraction of a pixel. Hinting and
    // subpixel positioning are what make that vary.
    '--font-render-hinting=none',
    '--disable-font-subpixel-positioning',
    '--disable-lcd-text',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
  ],
});

const startPage = async (browser, animationURL, renderer) => {
  const targetURL = `http://localhost:${serverPort}/test/index.html\
?path=${encodeURIComponent(animationURL)}&renderer=${renderer}`;
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('PAGE LOG:', msg.text())); // eslint-disable-line no-console
  await page.setViewport({
    width: 1024,
    height: 768,
  });
  await page.goto(targetURL, { timeout: timeouts.pageLoad });
  return page;
};

// Events emitted by the page are queued, so an event that arrives before its
// waiter is registered is still delivered instead of being dropped.
const createEventLatch = () => {
  const pending = [];
  let waiter = null;
  const push = (value) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(value);
    } else {
      pending.push(value);
    }
  };
  const next = () => (
    pending.length
      ? Promise.resolve(pending.shift())
      : new Promise((resolve) => { waiter = resolve; })
  );
  return { push, next };
};

const createBridgeHelper = async (page) => {
  const loaded = createEventLatch();
  const messages = createEventLatch();
  const failures = createEventLatch();
  await page.exposeFunction('onAnimationLoaded', () => loaded.push(true));
  await page.exposeFunction('onMessageReceivedEvent', (event) => messages.push(event));
  await page.exposeFunction('onAnimationFailed', (reason) => failures.push(new Error(reason)));
  // A crashed page or a failed animation load must lose the race against the
  // event it would otherwise make us wait for indefinitely.
  const rejectOnFailure = new Promise((resolve, reject) => {
    failures.next().then(reject);
    page.on('pageerror', (error) => reject(error));
  });
  // Nothing is waiting on it until the first race, and an unhandled rejection
  // would take the process down.
  rejectOnFailure.catch(() => {});
  const race = (promise, timeout, description) => (
    withTimeout(Promise.race([promise, rejectOnFailure]), timeout, description)
  );
  return {
    waitForAnimationLoaded: () => race(loaded.next(), timeouts.animationLoad, 'the animation to load'),
    waitForMessage: () => race(messages.next(), timeouts.frame, 'a frame to be rendered'),
  };
};

const compareFiles = (folderName, fileName) => {
    const createPath = `${createDirectory}/${folderName}/${fileName}`;
    const comparePath = `${compareDirectory}/${folderName}/${fileName}`;
    const img1 = PNG.sync.read(fs.readFileSync(createPath));
    const img2 = PNG.sync.read(fs.readFileSync(comparePath));
    const {width, height} = img1;
    const diff = new PNG({width, height});

    const result = pixelmatch(img1.data, img2.data, diff.data, width, height, {threshold: 0.1});
    // Using 50 as threshold because it should be an acceptable difference
    // that doesn't raise false positives
    if (result > 200) {
        console.log('RESULT NOT ZERO: ', result);
        throw new Error(`Animation failed: ${folderName} at frame: ${fileName}`)
    }
}

const createIndividualAssets = async (page, folderName, settings) => {
  const filePath = `${settings.step === 'create' ? createDirectory : compareDirectory}/${folderName}`;
  createDirectoryPath(filePath);
  let isLastFrame = false;
  const bridgeHelper = await (createBridgeHelper(page));
  page.evaluate(() => {
    window.startProcess();
  });
  await bridgeHelper.waitForAnimationLoaded();
  while (!isLastFrame) {
    // Disabling rule because execution can't be parallelized
    /* eslint-disable no-await-in-loop */
    await wait(1);
    page.evaluate(() => {
        window.continueExecution();
    });
    const message = await bridgeHelper.waitForMessage();
    const fileNumber = message.currentFrame.toString().padStart(5, '0');
    const fileName = `image_${fileNumber}.png`;
    const localDestinationPath = `${filePath}/${fileName}`;
    await page.screenshot({
      path: localDestinationPath,
      fullPage: false,
    });
    if (settings.step === 'compare') {
      try {
        compareFiles(folderName, fileName);
      } catch (err) {
        console.log('FAILED AT FRAME: ', message.currentFrame);
        throw err;
      }
    }
    isLastFrame = message.isLast;
  }
};

async function processPage(browser, settings, directory, animation) {
  let fullDirectory = `${directory}`;
  if (animation.directory) {
    fullDirectory += `${animation.directory}/`;
  }
  const fileName = animation.fileName;
  const page = await startPage(browser, fullDirectory + fileName, animation.renderer);
  const fileNameWithoutExtension = fileName.replace(/\.[^/.]+$/, '');
  let fullName = `${fileNameWithoutExtension}_${animation.renderer}`
  if (animation.directory) {
    fullName = `${animation.directory}_` + fullName;
  }
  try {
    await createIndividualAssets(page, fullName, settings);
  } finally {
    await page.close();
  }
}

const iteratePages = async (browser, settings) => {
  const failedAnimations = [];
  const selected = settings.animation
    ? animations.filter((animation) => animation.fileName.indexOf(settings.animation) !== -1)
    : animations;
  for (let i = 0; i < selected.length; i += 1) {
    const animation = selected[i];
    let fileName =  `${animation.renderer}_${animation.fileName}`;
    if (animation.directory) {
      fileName = `${animation.directory}_` + fileName;
    }
    try {
        // eslint-disable-next-line no-await-in-loop
        await processPage(browser, settings, examplesDirectory, animation);
        if (settings.step === 'create') {
          console.log(`Creating animation: ${fileName}`);
        }
        if (settings.step === 'compare') {
            console.log(`Animation passed: ${fileName}`);
        }
    } catch (error) {
        // Both steps report failures. The create step used to swallow them and
        // exit successfully having written no screenshots at all.
        console.log(`Animation errored: ${fileName}`, error.message);
        failedAnimations.push({
          fileName: fileName
        })
    }
  }
  if (failedAnimations.length) {
    failedAnimations.forEach(animation => {
        console.log(`Animation failed: ${animation.fileName}`);
    })
    throw new Error('Animations failed');
  }
};


const takeImageStrip = async () => {
  let server;
  let browser;
  try {
    validateAnimations();
    server = await startServer();
    const settings = await getSettings();
    browser = await getBrowser();
    await iteratePages(browser, settings);
    process.exit(0);
  } catch (error) {
    console.log(error); // eslint-disable-line no-console
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
    if (server) {
      server.close();
    }
  }
};

takeImageStrip();
