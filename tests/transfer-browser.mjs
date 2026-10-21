import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = resolve(root, "evidence/import-export/browser");
await mkdir(evidence, { recursive: true });
const chromePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = await mkdtemp(resolve(tmpdir(), "header-manager-test-"));
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.url.startsWith("/echo")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.headers));
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><html><head><title>Header Manager local test</title></head><body><h1>Local verification</h1></body></html>",
    );
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const child = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--window-size=480,600",
  ],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
);
let id = 0;
let buffer = Buffer.alloc(0);
const pending = new Map();
child.stdio[4].on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let zero;
  while ((zero = buffer.indexOf(0)) >= 0) {
    const text = buffer.subarray(0, zero).toString();
    buffer = buffer.subarray(zero + 1);
    if (!text) continue;
    const result = JSON.parse(text);
    const entry = pending.get(result.id);
    if (entry) {
      pending.delete(result.id);
      clearTimeout(entry.timer);
      result.error
        ? entry.reject(new Error(JSON.stringify(result.error)))
        : entry.resolve(result.result);
    }
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const number = ++id;
    const timer = setTimeout(() => {
      pending.delete(number);
      reject(new Error(`CDP timeout: ${method}`));
    }, 20000);
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
}
async function evaluate(session, expression) {
  const result = await cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    session,
  );
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timed out: ${label}`);
}
const checks = [];
function passed(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}
try {
  console.log("Browser", (await cdp("Browser.getVersion")).product);
  const { id: extensionId } = await cdp("Extensions.loadUnpacked", {
    path: resolve(root, ".output/chrome-mv3-dev"),
  });
  assert.ok(extensionId);
  passed("unpacked Manifest V3 extension loads");
  const { targetId: fixtureId } = await cdp("Target.createTarget", {
    url: origin,
  });
  const { sessionId: fixture } = await cdp("Target.attachToTarget", {
    targetId: fixtureId,
    flatten: true,
  });
  await until(
    () =>
      evaluate(
        fixture,
        'location.hostname === "127.0.0.1" && document.title === "Header Manager local test" && document.readyState === "complete"',
      ),
    "fixture",
  );
  const { targetId: popupId } = await cdp("Target.createTarget", {
    url: "about:blank",
    background: true,
  });
  const { sessionId: popup } = await cdp("Target.attachToTarget", {
    targetId: popupId,
    flatten: true,
  });
  await cdp("Target.activateTarget", { targetId: fixtureId });
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 600, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  // Keep the popup rendering while the fixture remains the active website tab.
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, popup);
  await cdp(
    "Page.navigate",
    { url: `chrome-extension://${extensionId}/popup.html` },
    popup,
  );
  await until(
    () =>
      evaluate(
        popup,
        '!!document.querySelector(".add-button") && !document.querySelector(".add-button").disabled',
      ),
    "popup",
  );
  async function message(type, payload) {
    const result = await evaluate(
      popup,
      `chrome.runtime.sendMessage(${JSON.stringify({ type, payload })})`,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }
  async function snapshot(name) {
    await until(
      () =>
        evaluate(
          popup,
          `(() => { const e=document.querySelector('.editor'); return !e || (getComputedStyle(e).transform==='none' && getComputedStyle(e).opacity==='1'); })()`,
        ),
      "settled editor",
    );
    await evaluate(
      popup,
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await evaluate(
      popup,
      `Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => true)`,
    );
    const { data } = await cdp(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      popup,
    );
    await writeFile(
      resolve(evidence, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  }
  async function echo() {
    return evaluate(
      fixture,
      `fetch(${JSON.stringify(origin + "/echo?t=")} + Date.now(), {cache:'no-store'}).then(r=>r.json())`,
    );
  }
  const ctx = await message("CONTEXT");
  const downloads = await mkdtemp(
    resolve(tmpdir(), "request-helper-download-"),
  );
  await cdp("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
  const click = async (selector) => {
    await evaluate(
      popup,
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
  };
  const fill = async (selector, text) => {
    await evaluate(
      popup,
      `(() => {const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(text)}; e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  };
  const visible = (selector) =>
    until(
      () =>
        evaluate(
          popup,
          `!!document.querySelector(${JSON.stringify(selector)})`,
        ),
      selector,
    );
  const gone = (selector) =>
    until(
      () =>
        evaluate(popup, `!document.querySelector(${JSON.stringify(selector)})`),
      `gone ${selector}`,
    );
  async function reloadPopup() {
    const before = await evaluate(popup, "performance.timeOrigin");
    await cdp("Page.reload", {}, popup);
    await until(
      () =>
        evaluate(
          popup,
          `performance.timeOrigin!==${before} && !!document.querySelector('.import-button') && !document.querySelector('.import-button').disabled`,
        ),
      "reload popup",
    );
  }
  async function customSelect(selector, value) {
    await click(selector);
    await visible(".select-popover");
    await evaluate(
      popup,
      `[...document.querySelectorAll('.select-option')].find(e=>e.textContent.includes(${JSON.stringify(value)})).click()`,
    );
    await gone(".select-popover");
  }
  async function openImport(text) {
    await click(".import-button");
    await visible("#import-text");
    await fill("#import-text", text);
  }
  async function confirmImport() {
    await click(".import-submit");
    await visible(".import-preview");
    await click(".import-submit");
    await gone(".transfer-panel");
  }
  await snapshot("main");
  await openImport("X-Batch: first\nInvalid line");
  await click(".import-submit");
  await visible(".editor-error");
  assert.equal((await message("STATE")).config.rules.length, 0);
  assert.equal(
    await evaluate(popup, "document.querySelector('#import-text').value"),
    "X-Batch: first\nInvalid line",
  );
  await snapshot("invalid-header");
  passed(
    "malformed pasted headers show an error and preserve all input without saving",
  );

  await fill("#import-text", "X-Batch: first\nX-Empty:");
  await snapshot("header-input");
  await click(".import-submit");
  await visible(".import-preview");
  assert.equal(
    await evaluate(popup, "document.querySelectorAll('.transfer-row').length"),
    2,
  );
  assert.equal((await message("STATE")).config.rules.length, 0);
  assert.deepEqual(
    await evaluate(
      popup,
      "[...document.querySelectorAll('.transfer-value')].map(e=>e.textContent.trim())",
    ),
    ["first", "（空值）"],
  );
  await snapshot("header-preview");
  await click(".import-submit");
  await gone(".transfer-panel");
  assert.equal((await echo())["x-batch"], "first");
  await reloadPopup();
  assert.equal((await message("STATE")).config.rules.length, 2);
  passed(
    "Header preview precedes an atomic save; real requests and popup reload use imported rules",
  );

  await openImport("X-Batch: replacement\nX-New: value");
  await click(".import-submit");
  await visible(".import-preview");
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.transfer-counts').textContent",
    ),
    /跳过 1/,
  );
  await click(".import-submit");
  await gone(".transfer-panel");
  assert.equal((await echo())["x-batch"], "first");
  await openImport("X-Batch: replacement");
  await customSelect("#import-conflict", "覆盖");
  await confirmImport();
  assert.equal((await echo())["x-batch"], "replacement");
  passed(
    "duplicate rule import defaults to skipping; explicit replace changes the outgoing header",
  );

  // A second extension view changes storage after preview. The first view must not overwrite it.
  await openImport("X-Stale: a");
  await click(".import-submit");
  await visible(".import-preview");
  await message("SAVE_RULE", {
    id: "",
    kind: "header",
    key: "X-Concurrent",
    value: "new",
    enabled: true,
    scope: "global",
    pattern: "",
    includeSubdomains: false,
    operation: "set",
    environmentId: "default",
  });
  await click(".import-submit");
  await visible(".editor-error");
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.editor-error').textContent",
    ),
    /已变化/,
  );
  assert.equal(
    (await message("STATE")).config.rules.some((r) => r.key === "X-Stale"),
    false,
  );
  await snapshot("stale-rule-error");
  await click('[aria-label="关闭编辑"]');
  await gone(".editor");
  passed(
    "a stale rule preview cannot overwrite a concurrently changed configuration",
  );

  await click(".export-button");
  await visible(".export-hidden");
  assert.equal(
    await evaluate(popup, "!!document.querySelector('.export-code')"),
    false,
  );
  await snapshot("header-export");
  await click(".export-download");
  const downloadFile = await until(
    async () => (await readdir(downloads)).find((n) => n.endsWith(".json")),
    "JSON download",
  );
  const exported = JSON.parse(
    await readFile(resolve(downloads, downloadFile), "utf8"),
  );
  assert.equal(exported.format, "request-helper.rules");
  assert.equal(exported.rules.length, 4);
  assert.equal(
    exported.rules.find((r) => r.key === "X-Batch").value,
    "replacement",
  );
  // Dispatch an actual pointer click so clipboard write receives a browser user gesture.
  const rect = await evaluate(
    popup,
    "(() => {const r=document.querySelector('.export-copy').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
  );
  await cdp(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", button: "left", clickCount: 1, ...rect },
    popup,
  );
  await cdp(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", button: "left", clickCount: 1, ...rect },
    popup,
  );
  await until(
    () =>
      evaluate(
        popup,
        "document.querySelector('.export-copy').textContent.includes('已复制')",
      ),
    "clipboard copy feedback",
  );
  await cdp("Browser.grantPermissions", {
    origin: `chrome-extension://${extensionId}`,
    permissions: ["clipboardReadWrite"],
  });
  assert.equal(
    JSON.parse(await evaluate(popup, "navigator.clipboard.readText()")).format,
    "request-helper.rules",
  );
  await click('[aria-label="关闭编辑"]');
  await gone(".editor");
  passed(
    "export stays masked until revealed, downloads complete JSON and copies with a real user gesture",
  );

  await message("ENVIRONMENT", { action: "create", name: "导入验证" });
  await reloadPopup();
  await click(".import-button");
  await visible("#import-text");
  const { root: dom } = await cdp("DOM.getDocument", {}, popup);
  const { nodeId: fileNode } = await cdp(
    "DOM.querySelector",
    { nodeId: dom.nodeId, selector: 'input[type="file"]' },
    popup,
  );
  await cdp(
    "DOM.setFileInputFiles",
    { nodeId: fileNode, files: [resolve(downloads, downloadFile)] },
    popup,
  );
  await until(
    () =>
      evaluate(
        popup,
        "document.querySelector('#import-text').value.includes('request-helper.rules')",
      ),
    "file loaded",
  );
  await confirmImport();
  assert.equal((await message("STATE")).config.rules.length, 8);
  assert.equal((await echo())["x-batch"], "replacement");
  passed(
    "downloaded rules import through the actual file input into a separate environment",
  );

  await click("#tab-cookie");
  await openImport("Cookie: tenant=shanghai; token=a=b");
  await snapshot("request-cookie-input");
  await confirmImport();
  assert.equal((await echo()).cookie, "tenant=shanghai; token=a=b");
  await click(".export-button");
  await visible(".export-hidden");
  await evaluate(
    popup,
    "[...document.querySelectorAll('button')].find(e=>e.textContent.includes('显示内容')).click()",
  );
  await visible(".export-code");
  const requestExport = JSON.parse(
    await evaluate(popup, "document.querySelector('.export-code').value"),
  );
  assert.equal(requestExport.rules.length, 1);
  assert.equal(requestExport.rules[0].kind, "cookie");
  await click('[aria-label="关闭编辑"]');
  await gone(".editor");
  passed(
    "request Cookie paste imports one injection rule and exports only the current Cookie tab",
  );

  await click("#tab-site");
  await until(
    () =>
      evaluate(popup, "!document.querySelector('.refresh-cookies').disabled"),
    "cookie list",
  );
  const cookieFile = [
    {
      name: "bulk_sid",
      value: "secret-value",
      domain: "127.0.0.1",
      path: "/",
      hostOnly: true,
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      session: false,
      expirationDate: Date.now() / 1000 + 86400,
    },
    { name: "locale", value: "zh-CN" },
  ];
  await openImport(JSON.stringify(cookieFile, null, 2));
  await snapshot("site-cookie-input");
  await click(".import-submit");
  await visible(".import-preview");
  assert.ok(
    (
      await evaluate(
        popup,
        "[...document.querySelectorAll('.transfer-value')].map(e=>e.textContent)",
      )
    ).every((v) => !v.includes("secret-value")),
  );
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.transfer-cookie-flags').textContent",
    ),
    /HttpOnly/,
  );
  await snapshot("site-cookie-preview");
  await click(".preview-reveal");
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.transfer-value').textContent",
    ),
    /secret-value/,
  );
  await snapshot("site-cookie-values");
  await click(".import-submit");
  await gone(".transfer-panel");
  const actual = await message("COOKIES", { url: ctx.url });
  assert.equal(actual.length, 2);
  assert.equal(actual.find((c) => c.name === "bulk_sid").httpOnly, true);
  assert.equal(actual.find((c) => c.name === "bulk_sid").session, false);
  // Disable the request Cookie rule; actual jar values now become visible on the wire.
  await message("TOGGLE_ALL", false);
  assert.match((await echo()).cookie, /bulk_sid=secret-value/);
  assert.match((await echo()).cookie, /locale=zh-CN/);
  await reloadPopup();
  await click("#tab-site");
  await until(
    () =>
      evaluate(
        popup,
        "document.querySelectorAll('.site-cookie-row').length===2",
      ),
    "persisted cookies",
  );
  passed(
    "website import writes real HttpOnly/expiry attributes; browser sends jar values and reload reads them",
  );

  await click(".export-button");
  await visible(".export-hidden");
  await snapshot("site-cookie-export");
  await click(".export-download");
  const siteDownload = await until(
    async () =>
      (await readdir(downloads)).find(
        (n) => n.includes("-site-") && n.endsWith(".json"),
      ),
    "website Cookie JSON download",
  );
  assert.equal(
    JSON.parse(
      await readFile(resolve(downloads, siteDownload), "utf8"),
    ).cookies.find((c) => c.name === "bulk_sid").httpOnly,
    true,
  );
  await evaluate(
    popup,
    "[...document.querySelectorAll('button')].find(e=>e.textContent.includes('显示内容')).click()",
  );
  await visible(".export-code");
  const jarExport = JSON.parse(
    await evaluate(popup, "document.querySelector('.export-code').value"),
  );
  assert.equal(
    jarExport.cookies.find((c) => c.name === "bulk_sid").httpOnly,
    true,
  );
  assert.ok(
    jarExport.cookies.find((c) => c.name === "bulk_sid").expirationDate >
      Date.now() / 1000,
  );
  assert.equal(jarExport.cookies[0].storeId, undefined);
  await click('[aria-label="关闭编辑"]');
  await gone(".editor");
  await openImport("bulk_sid=changed; new_item=added");
  await click(".import-submit");
  await visible(".import-preview");
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.transfer-counts').textContent",
    ),
    /跳过 1/,
  );
  await click(".import-submit");
  await gone(".transfer-panel");
  assert.equal(
    (await message("COOKIES", { url: ctx.url })).find(
      (c) => c.name === "bulk_sid",
    ).value,
    "secret-value",
  );
  await openImport(JSON.stringify(jarExport));
  await customSelect("#import-conflict", "覆盖");
  await confirmImport();
  assert.equal(
    (await message("COOKIES", { url: ctx.url })).find(
      (c) => c.name === "bulk_sid",
    ).httpOnly,
    true,
  );
  await openImport("bulk_sid=updated-value");
  await customSelect("#import-conflict", "覆盖");
  await confirmImport();
  const plainReplaced = (await message("COOKIES",{url:ctx.url})).find(c=>c.name === "bulk_sid");
  assert.equal(plainReplaced.value,"updated-value");
  assert.equal(plainReplaced.httpOnly,true);
  assert.ok(plainReplaced.expirationDate > Date.now()/1000);
  passed(
    "website Cookie export preserves attributes and round-trips with explicit conflict handling",
  );

  await openImport("new_cookie=ok");
  await click(".import-submit");
  await visible(".import-preview");
  await message("WRITE_COOKIE", {
    url: ctx.url,
    input: {
      name: "concurrent",
      value: "server",
      domain: ctx.hostname,
      path: "/",
      hostOnly: true,
      secure: false,
      httpOnly: false,
      sameSite: "lax",
    },
  });
  await click(".import-submit");
  await visible(".editor-error");
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.editor-error').textContent",
    ),
    /已变化/,
  );
  assert.equal(
    (await message("COOKIES", { url: ctx.url })).some(
      (c) => c.name === "new_cookie",
    ),
    false,
  );
  await snapshot("cookie-stale-error");
  await click('[aria-label="关闭编辑"]');
  await gone(".editor");
  passed(
    "website Cookie changes after preview cause a safe error without writing the stale batch",
  );

  // Browser-specific size limits can still reject a syntactically valid Cookie.
  await openImport(
    JSON.stringify([
      { name: "valid_partial", value: "yes" },
      { name: "rejected_size", value: "a".repeat(5000), secure: false },
    ]),
  );
  await click(".import-submit");
  await visible(".import-preview");
  await click(".import-submit");
  await visible(".transfer-feedback");
  await until(
    () =>
      evaluate(
        popup,
        "document.querySelector('.transfer-feedback').textContent.includes('未完成')",
      ),
    "partial result",
  );
  assert.equal(
    (await message("COOKIES", { url: ctx.url })).some(
      (c) => c.name === "valid_partial",
    ),
    true,
  );
  const remaining = JSON.parse(
    await evaluate(popup, "document.querySelector('#import-text').value"),
  );
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].name, "rejected_size");
  await snapshot("cookie-partial-failure");
  remaining[0].value = "no";
  await fill("#import-text", JSON.stringify(remaining));
  await confirmImport();
  assert.equal(
    (await message("COOKIES", { url: ctx.url })).find(
      (c) => c.name === "rejected_size",
    ).value,
    "no",
  );
  passed(
    "browser rejection reports partial success, keeps only failed inputs, and supports a corrected retry",
  );

  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 400, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  await openImport("short_popup=ok");
  await snapshot("short-input");
  const footerFits = await evaluate(
    popup,
    "document.querySelector('.transfer-footer').getBoundingClientRect().bottom <= innerHeight && document.querySelector('.transfer-body').scrollHeight > document.querySelector('.transfer-body').clientHeight",
  );
  assert.equal(footerFits, true);
  await click(".import-submit");
  await visible(".import-preview");
  await snapshot("short-preview");
  await cdp(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
    popup,
  );
  assert.equal(
    await evaluate(
      popup,
      "getComputedStyle(document.querySelector('.import-preview')).animationName",
    ),
    "none",
  );
  passed(
    "short popup scrolls the form while keeping confirmation visible and respects reduced motion",
  );
  await click('[aria-label="关闭编辑"]');
  await gone(".editor");
  await openImport(
    Array.from({ length: 40 }, (_, i) => `long_${i}=value`).join("; "),
  );
  await click(".import-submit");
  await visible(".import-preview");
  await evaluate(
    popup,
    "document.querySelector('.transfer-body').scrollTop = document.querySelector('.transfer-body').scrollHeight",
  );
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.transfer-row:last-child').getBoundingClientRect().bottom <= document.querySelector('.transfer-footer').getBoundingClientRect().top + 1",
    ),
    true,
  );
  await snapshot("long-preview-end");
  passed(
    "the final item in a long import preview remains reachable above the fixed footer",
  );
  await writeFile(
    resolve(evidence, "report.json"),
    JSON.stringify(
      {
        browser: (await cdp("Browser.getVersion")).product,
        checks,
        result: "passed",
      },
      null,
      2,
    ),
  );
  console.log(`${checks.length} import/export browser checks passed`);
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  try {
    await cdp("Browser.close");
  } catch {}
  child.kill();
  server.close();
}
