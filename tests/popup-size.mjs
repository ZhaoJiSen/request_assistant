import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root =
  process.env.REQUEST_HELPER_ROOT ||
  resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "evidence/native-popup");
await mkdir(output, { recursive: true });
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    "<!doctype html><title>Popup size fixture</title><h1>Local fixture</h1>",
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}/`;
const profile = await mkdtemp(resolve(tmpdir(), "request-helper-popup-"));
const child = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
  ],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
);
let id = 0,
  buffer = Buffer.alloc(0);
const pending = new Map();
child.stdio[4].on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let z;
  while ((z = buffer.indexOf(0)) >= 0) {
    const raw = buffer.subarray(0, z).toString();
    buffer = buffer.subarray(z + 1);
    if (!raw) continue;
    const msg = JSON.parse(raw),
      p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      msg.error
        ? p.reject(new Error(JSON.stringify(msg.error)))
        : p.resolve(msg.result);
    }
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const number = ++id,
      timer = setTimeout(() => {
        pending.delete(number);
        reject(new Error("timeout " + method));
      }, 15000);
    pending.set(number, { resolve, reject, timer });
    child.stdio[3].write(
      JSON.stringify({
        id: number,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }) + "\0",
    );
  });
async function evaluate(session, expression) {
  const r = await cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    session,
  );
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function until(fn, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      if (Date.now() + 100 > end) throw e;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("timeout " + label);
}
try {
  console.log("Browser", (await cdp("Browser.getVersion")).product);
  const { id: extensionId } = await cdp("Extensions.loadUnpacked", {
    path: resolve(root, "chrome-extension"),
  });
  const { targetId: fixtureId } = await cdp("Target.createTarget", {
    url: origin,
  });
  const { sessionId: fixture } = await cdp("Target.attachToTarget", {
    targetId: fixtureId,
    flatten: true,
  });
  await until(
    () => evaluate(fixture, 'document.title === "Popup size fixture"'),
    "fixture",
  );
  const worker = await until(
    async () =>
      (await cdp("Target.getTargets")).targetInfos.find(
        (t) =>
          t.type === "service_worker" &&
          t.url.startsWith(`chrome-extension://${extensionId}/`),
      ),
    "worker",
  );
  const { sessionId: background } = await cdp("Target.attachToTarget", {
    targetId: worker.targetId,
    flatten: true,
  });
  // A newly discovered service worker target can precede Chrome's extension bindings.
  await until(
    () =>
      evaluate(background, 'typeof chrome?.action?.openPopup === "function"'),
    "extension action API ready",
  );
  const results = [];
  const { windowId } = await cdp("Browser.getWindowForTarget", {
    targetId: fixtureId,
  });
  for (let run = 1; run <= 3; run++) {
    const windowHeight = run === 2 ? 600 : 900;
    await cdp("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal", width: 1280, height: windowHeight },
    });
    await until(
      () => evaluate(fixture, `innerHeight ${run === 2 ? "< 600" : "> 700"}`),
      "native browser window resize",
    );
    await cdp("Target.activateTarget", { targetId: fixtureId });
    await evaluate(background, "chrome.action.openPopup().then(()=>true)");
    const target = await until(
      async () =>
        (await cdp("Target.getTargets")).targetInfos.find(
          (t) => t.url === `chrome-extension://${extensionId}/popup.html`,
        ),
      "native popup",
    );
    console.log("Popup target", JSON.stringify(target));
    const { sessionId: popup } = await cdp("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    // Headless Chrome pauses animation frames in the separate popup target.
    // Emulate focus only; leave the popup viewport and native sizing untouched.
    await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, popup);
    await until(
      () =>
        evaluate(
          popup,
          '!!document.querySelector(".add-button") && !document.querySelector(".add-button").disabled',
        ),
      "popup loaded",
    );
    const measure = () =>
      evaluate(
        popup,
        `({innerWidth,innerHeight,htmlWidth:document.documentElement.getBoundingClientRect().width,bodyWidth:document.body.getBoundingClientRect().width,bodyHeight:document.body.getBoundingClientRect().height,scrollWidth:document.documentElement.scrollWidth,footerBottom:document.querySelector('.app-footer').getBoundingClientRect().bottom, title:document.title})`,
      );
    let previous = "",
      stableSince = 0;
    await until(async () => {
      const m = await measure(),
        key = JSON.stringify(m);
      if (key !== previous) {
        previous = key;
        stableSince = Date.now();
        return false;
      }
      return Date.now() - stableSince >= 300;
    }, "stable native popup size");
    const initial = await measure();
    console.log("Native initial size", JSON.stringify(initial));
    const capture = async (name) => {
      await evaluate(popup, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      await evaluate(popup, "Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)");
      const shot = await cdp(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        popup,
      );
      await writeFile(resolve(output, name), Buffer.from(shot.data, "base64"));
    };
    await capture(`open-${run}.png`);
    assert.equal(
      initial.bodyWidth,
      480,
      "native document width must be 480 without viewport emulation",
    );
    assert.ok(
      initial.innerWidth >= 480 && initial.innerWidth <= 500,
      "native popup must fit the document",
    );
    assert.ok(
      initial.innerHeight >= 300 && initial.innerHeight <= 600,
      "native popup height must fit available window",
    );
    assert.ok(
      initial.footerBottom <= initial.innerHeight + 0.5,
      "footer remains inside popup",
    );
    assert.ok(
      await evaluate(
        popup,
        `document.querySelector('.empty-state p').getBoundingClientRect().bottom <= document.querySelector('.app-footer').getBoundingClientRect().top && document.querySelector('.rule-list').scrollHeight <= document.querySelector('.rule-list').clientHeight + 1`,
      ),
      "empty-state explanation is visible without scrolling in a short popup",
    );
    await evaluate(popup, 'document.querySelector(".add-button").click()');
    await until(
      () => evaluate(popup, '!!document.querySelector(".editor")'),
      "editor",
    );
    await until(
      () =>
        evaluate(
          popup,
          'getComputedStyle(document.querySelector(".editor")).opacity === "1" && getComputedStyle(document.querySelector(".editor")).transform === "none"',
        ),
      "editor transition complete",
    );
    const editor = await evaluate(
      popup,
      `({innerWidth,innerHeight,saveBottom:document.querySelector('.editor-footer').getBoundingClientRect().bottom})`,
    );
    assert.ok(editor.innerWidth >= 480 && editor.innerWidth <= 500);
    assert.ok(editor.saveBottom <= editor.innerHeight + 0.5);
    await capture(`editor-${run}.png`);
    await evaluate(
      popup,
      `document.querySelector('[aria-label="关闭编辑"]').click()`,
    );
    await until(
      () => evaluate(popup, '!document.querySelector(".editor")'),
      "close editor",
    );
    await evaluate(popup, 'document.querySelector(".import-button").click()');
    await until(
      () =>
        evaluate(
          popup,
          '!!document.querySelector("#import-text") && getComputedStyle(document.querySelector(".editor")).transform === "none"',
        ),
      "native import editor",
    );
    const transfer = await evaluate(
      popup,
      `({footerBottom:document.querySelector('.transfer-footer').getBoundingClientRect().bottom,innerHeight})`,
    );
    assert.ok(transfer.footerBottom <= transfer.innerHeight + 0.5);
    await capture(`import-${run}.png`);
    await evaluate(
      popup,
      `(() => {const input=document.querySelector('#import-text'); input.value='X-Native: checked'; input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await evaluate(popup, 'document.querySelector(".import-submit").click()');
    await until(
      () => evaluate(popup, '!!document.querySelector(".import-preview")'),
      "native import preview",
    );
    assert.ok(
      await evaluate(
        popup,
        `document.querySelector('.transfer-footer').getBoundingClientRect().bottom <= innerHeight + 0.5`,
      ),
    );
    await capture(`import-preview-${run}.png`);
    results.push({ run, windowHeight, initial, editor, transfer });
    await cdp("Target.closeTarget", { targetId: target.targetId });
  }
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        result: "passed",
        source:
          "chrome.action.openPopup, no viewport or device metrics emulation",
        results,
      },
      null,
      2,
    ),
  );
  console.log("PASS 3 native toolbar popup openings and editor dimensions");
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  try {
    await cdp("Browser.close");
  } catch {}
  child.kill();
  server.close();
}
