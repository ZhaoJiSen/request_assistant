import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = resolve(root, "evidence/browser");
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
  assert.equal(ctx.host, `127.0.0.1:${port}`);
  passed("popup reads current website and cookie store");
  const rule = (input = {}) => ({
    id: "",
    kind: "header",
    key: "X-Environment",
    value: "global",
    enabled: true,
    scope: "global",
    pattern: "",
    includeSubdomains: true,
    operation: "set",
    ...input,
  });
  await message("SAVE_RULE", rule());
  await message(
    "SAVE_RULE",
    rule({ scope: "domain", pattern: `127.0.0.1:${port}`, value: "site" }),
  );
  assert.equal((await echo())["x-environment"], "site");
  passed("real network receives site Header over global Header");
  const { targetId: otherId } = await cdp("Target.createTarget", {
    url: `http://localhost:${port}/echo`,
    background: true,
  });
  const { sessionId: other } = await cdp("Target.attachToTarget", {
    targetId: otherId,
    flatten: true,
  });
  await until(
    () =>
      evaluate(
        other,
        'location.hostname === "localhost" && document.readyState === "complete" && !!document.body && document.body.innerText.trim().startsWith("{")',
      ),
    "other host",
  );
  assert.equal(
    await evaluate(
      other,
      'JSON.parse(document.body.innerText)["x-environment"]',
    ),
    "global",
  );
  passed("domain rule does not leak into a different host");
  await cdp("Target.closeTarget", { targetId: otherId });
  await cdp("Target.activateTarget", { targetId: fixtureId });
  const input = {
    name: "browser_cookie",
    value: "stored",
    domain: "127.0.0.1",
    path: "/",
    hostOnly: true,
    secure: false,
    httpOnly: true,
    sameSite: "lax",
  };
  const cookies = await message("WRITE_COOKIE", { url: ctx.url, input });
  assert.equal(cookies.find((c) => c.name === "browser_cookie").httpOnly, true);
  assert.match((await echo()).cookie, /browser_cookie=stored/);
  passed("website HttpOnly Cookie is written, read back and sent by browser");
  const cookieRule = rule({
    kind: "cookie",
    key: "Cookie",
    value: "tenant=north; debug_mode=1",
    scope: "domain",
    pattern: `127.0.0.1:${port}`,
  });
  let state = await message("SAVE_RULE", cookieRule);
  assert.equal((await echo()).cookie, "tenant=north; debug_mode=1");
  assert.equal(
    (await message("COOKIES", { url: ctx.url })).find(
      (c) => c.name === "browser_cookie",
    ).value,
    "stored",
  );
  passed(
    "request Cookie replacement changes network and preserves browser Cookie jar",
  );
  const savedCookieRule = state.config.rules.find((r) => r.kind === "cookie");
  await message("SAVE_RULE", {
    ...savedCookieRule,
    operation: "append",
    value: "append_cookie=yes",
  });
  const appended = (await echo()).cookie;
  assert.match(appended, /browser_cookie=stored/);
  assert.match(appended, /append_cookie=yes/);
  passed("request Cookie append preserves existing Cookie on real request");
  await message("TOGGLE_ALL", false);
  const paused = await echo();
  assert.equal(paused["x-environment"], undefined);
  assert.equal(paused.cookie, "browser_cookie=stored");
  passed("master switch removes injected rules and keeps website Cookie");
  await message("TOGGLE_ALL", true);
  // Exercise the actual Vue form, then reload it to verify persistence.
  const firstOrigin = await evaluate(popup, "performance.timeOrigin");
  await cdp("Page.reload", {}, popup);
  await until(
    () => evaluate(popup, `performance.timeOrigin > ${firstOrigin}`),
    "popup navigation",
  );
  await until(
    () =>
      evaluate(
        popup,
        '!!document.querySelector(".add-button") && !document.querySelector(".add-button").disabled',
      ),
    "reloaded popup",
  );
  await evaluate(popup, 'document.querySelector(".add-button").click()');
  await until(
    () => evaluate(popup, '!!document.querySelector("#rule-key")'),
    "rule form",
  );
  await evaluate(
    popup,
    `(() => { for (const [selector,value] of [['#rule-key','X-UI-Saved'],['#rule-value','from-popup']]) { const el=document.querySelector(selector); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); } document.querySelector('#config-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); })()`,
  );
  await until(
    () =>
      evaluate(
        popup,
        '[...document.querySelectorAll(".rule-name")].some(e => e.textContent.includes("X-UI-Saved"))',
      ),
    "UI saved row",
  );
  assert.equal((await echo())["x-ui-saved"], "from-popup");
  const secondOrigin = await evaluate(popup, "performance.timeOrigin");
  await cdp("Page.reload", {}, popup);
  await until(
    () => evaluate(popup, `performance.timeOrigin > ${secondOrigin}`),
    "popup second navigation",
  );
  await until(
    () =>
      evaluate(
        popup,
        '[...document.querySelectorAll(".rule-name")].some(e => e.textContent.includes("X-UI-Saved"))',
      ),
    "saved row after reload",
  );
  passed("popup form saves a real rule, affects requests and survives reload");
  await evaluate(popup, 'document.querySelector(".add-button").click()');
  await until(
    () => evaluate(popup, '!!document.querySelector("#rule-key")'),
    "failure form",
  );
  await evaluate(
    popup,
    `(() => { for (const [selector,value] of [['#rule-key','X-Invalid-UI'],['#rule-value','one\\ntwo']]) { const el=document.querySelector(selector); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); } document.querySelector('#config-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); })()`,
  );
  await until(
    () => evaluate(popup, '!!document.querySelector(".editor-error")'),
    "visible save error",
  );
  assert.equal(
    await evaluate(popup, 'document.querySelector("#rule-value").value'),
    "one\ntwo",
  );
  await snapshot("save-error");
  await until(
    () =>
      evaluate(
        popup,
        '!document.querySelector("[aria-label=返回列表]").disabled',
      ),
    "save error settled",
  );
  await evaluate(
    popup,
    'document.querySelector("[aria-label=返回列表]").click()',
  );
  await until(
    () => evaluate(popup, '!document.querySelector(".editor")'),
    "return after error",
  );
  passed("failed popup save preserves inputs and shows visible error");
  await evaluate(
    popup,
    'document.querySelector(".rule-list").scrollTop = 100000',
  );
  assert.equal(
    await evaluate(
      popup,
      'document.querySelector(".rule-row:last-child").getBoundingClientRect().bottom <= document.querySelector(".app-footer").getBoundingClientRect().top - 20',
    ),
    true,
  );
  passed("last rule remains readable above fixed footer after scrolling");
  await snapshot("headers");
  await evaluate(popup, 'document.querySelector("#tab-cookie").click()');
  await until(
    () =>
      evaluate(
        popup,
        'document.querySelector(".section-title h2").textContent.includes("注入")',
      ),
    "request Cookie tab",
  );
  await snapshot("request-cookie");
  await evaluate(popup, 'document.querySelector("#tab-site").click()');
  await until(
    () => evaluate(popup, '!!document.querySelector(".site-cookie-row")'),
    "site Cookie tab",
  );
  await snapshot("website-cookie");
  await evaluate(popup, 'document.querySelector(".add-button").click()');
  await until(
    () => evaluate(popup, '!!document.querySelector("#cookie-name")'),
    "website Cookie form",
  );
  await evaluate(
    popup,
    `(() => { for (const [selector,value] of [['#cookie-name','ui_cookie'],['#cookie-value','stored-ui']]) { const el=document.querySelector(selector); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); } document.querySelector('#config-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); })()`,
  );
  await until(
    () => evaluate(popup, '!document.querySelector(".editor")'),
    "website Cookie saved",
  );
  assert.equal(
    (await message("COOKIES", { url: ctx.url })).find(
      (c) => c.name === "ui_cookie",
    ).value,
    "stored-ui",
  );
  passed("website Cookie form creates a real browser Cookie");
  const original = (await message("COOKIES", { url: ctx.url })).find(
    (c) => c.name === "browser_cookie",
  );
  await message("WRITE_COOKIE", {
    url: ctx.url,
    input: { ...input, original, value: "updated" },
  });
  assert.equal(
    (await message("COOKIES", { url: ctx.url })).find(
      (c) => c.name === "browser_cookie",
    ).value,
    "updated",
  );
  const updated = (await message("COOKIES", { url: ctx.url })).find(
    (c) => c.name === "browser_cookie",
  );
  await message("DELETE_COOKIE", { url: ctx.url, cookie: updated });
  const uiCookie = (await message("COOKIES", { url: ctx.url })).find(
    (c) => c.name === "ui_cookie",
  );
  await message("DELETE_COOKIE", { url: ctx.url, cookie: uiCookie });
  assert.equal((await message("COOKIES", { url: ctx.url })).length, 0);
  passed("website Cookie edit and exact deletion work");
  await assert.rejects(
    message("WRITE_COOKIE", { url: "https://different.test/", input }),
    /网站已变化/,
  );
  passed("stale tab context blocks Cookie write");
  const before = await message("STATE");
  await assert.rejects(
    message("SAVE_RULE", rule({ key: "X-Invalid", value: "bad\r\nheader" })),
    /换行/,
  );
  assert.deepEqual((await message("STATE")).config, before.config);
  passed("invalid rule rejected without changing persisted configuration");
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 600, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  assert.equal(
    await evaluate(
      popup,
      'getComputedStyle(document.documentElement).minWidth === "480px"',
    ),
    true,
  );
  await snapshot("intrinsic-popup-size");
  await cdp(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
    popup,
  );
  assert.equal(
    await evaluate(
      popup,
      'getComputedStyle(document.querySelector(".main-view")).animationName',
    ),
    "none",
  );
  passed("popup intrinsic minimum width and reduced-motion are respected");
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
  console.log(`${checks.length} browser checks passed`);
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  try {
    await cdp("Browser.close");
  } catch {}
  child.kill();
  server.close();
}
