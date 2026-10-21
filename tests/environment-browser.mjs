import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = resolve(root, "evidence/environment-groups/browser");
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
  const legacyRule = {
    id: "preserved-rule",
    kind: "header",
    key: "X-Legacy",
    value: "preserved",
    enabled: true,
    scope: "global",
    pattern: "",
    includeSubdomains: false,
    operation: "set",
  };
  await evaluate(
    popup,
    `chrome.storage.local.set({headerManagerV2:${JSON.stringify({ version: 2, enabled: true, rules: [legacyRule] })}})`,
  );
  let state = await message("SYNC");
  assert.equal(state.config.activeEnvironmentId, "default");
  assert.equal(state.config.rules[0].id, "preserved-rule");
  assert.equal(state.config.rules[0].environmentId, "default");
  assert.equal((await echo())["x-legacy"], "preserved");
  const backup = await evaluate(
    popup,
    'chrome.storage.local.get("headerManagerBeforeEnvironments")',
  );
  assert.equal(
    backup.headerManagerBeforeEnvironments.rules[0].value,
    "preserved",
  );
  passed(
    "existing configuration migrates into default group and still affects real requests",
  );

  async function reloadPopup() {
    const time = await evaluate(popup, "performance.timeOrigin");
    await cdp("Page.reload", {}, popup);
    await until(
      () =>
        evaluate(
          popup,
          `performance.timeOrigin > ${time} && !!document.querySelector('.add-button') && !document.querySelector('.add-button').disabled`,
        ),
      "popup reloaded",
    );
  }
  async function click(selector) {
    await evaluate(
      popup,
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
  }
  async function fill(selector, value) {
    await evaluate(
      popup,
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  }
  async function key(value) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: value }, popup);
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: value }, popup);
  }
  async function idle() {
    await until(
      () =>
        evaluate(popup, '!document.querySelector(".master-control").disabled'),
      "mutation completed",
    );
  }
  async function menu(selector) {
    await evaluate(
      popup,
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.click();})()`,
    );
    await until(
      () =>
        evaluate(
          popup,
          '!!document.querySelector(".select-popover") && getComputedStyle(document.querySelector(".select-popover")).opacity === "1"',
        ),
      "custom menu visible",
    );
    const bounds = await evaluate(
      popup,
      `(()=>{const r=document.querySelector('.select-popover').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`,
    );
    assert.ok(
      bounds.left >= 0 &&
        bounds.right <= bounds.width + 1 &&
        bounds.top >= 0 &&
        bounds.bottom <= bounds.height + 1,
    );
  }
  async function manage() {
    await click(".manage-environments");
    await until(
      () => evaluate(popup, '!!document.querySelector(".environment-manager")'),
      "environment manager",
    );
  }
  async function closeEditor() {
    await click('[aria-label="返回列表"]');
    await until(
      () => evaluate(popup, '!document.querySelector(".editor")'),
      "editor closed",
    );
  }
  async function createHeader(value) {
    await click(".add-button");
    await until(
      () => evaluate(popup, '!!document.querySelector("#rule-key")'),
      "header editor",
    );
    await fill("#rule-key", "X-Group");
    await fill("#rule-value", value);
    await menu("#rule-scope");
    await key("End");
    await key("Enter");
    await until(
      () => evaluate(popup, '!document.querySelector("#rule-domain")'),
      "scope changed to global",
    );
    await click(".save-button");
    await until(
      () => evaluate(popup, '!document.querySelector(".editor")'),
      "header saved",
    );
    await idle();
  }
  await reloadPopup();
  assert.equal(
    await evaluate(popup, 'document.querySelectorAll("select").length'),
    0,
  );
  await click(".add-button");
  await until(
    () => evaluate(popup, '!!document.querySelector("#rule-scope")'),
    "scope field",
  );
  await menu("#rule-scope");
  await until(
    () =>
      evaluate(
        popup,
        `Math.abs(document.querySelector('.select-popover').getBoundingClientRect().left - document.querySelector('#rule-scope').getBoundingClientRect().left) < 1 && getComputedStyle(document.querySelector('.editor')).transform === "none"`,
      ),
    "menu follows editor transition",
  );
  await snapshot("scope-menu");
  assert.ok(
    await evaluate(
      popup,
      `Math.abs(document.querySelector('.select-popover').getBoundingClientRect().left - document.querySelector('#rule-scope').getBoundingClientRect().left) < 1`,
    ),
    "menu stays aligned after opening during editor transition",
  );
  const inset = await evaluate(
    popup,
    `(()=>{const trigger=document.querySelector('#rule-scope'), arrow=trigger.querySelector('.select-chevron'); return trigger.getBoundingClientRect().right-arrow.getBoundingClientRect().right;})()`,
  );
  assert.ok(inset >= 10 && inset <= 18, "arrow has consistent right padding");
  await key("Escape");
  await until(
    () => evaluate(popup, '!document.querySelector(".select-popover")'),
    "menu exit complete",
  );
  assert.equal(
    await evaluate(
      popup,
      '!!document.querySelector(".editor") && !document.querySelector(".select-popover")',
    ),
    true,
  );
  await closeEditor();
  await menu(".filter-select .select-trigger");
  await snapshot("filter-menu");
  await key("End");
  await key("Enter");
  assert.equal(
    await evaluate(
      popup,
      'document.querySelector(".filter-select .select-value").textContent',
    ),
    "当前网站",
  );
  await menu(".filter-select .select-trigger");
  await key("Home");
  await key("Enter");
  passed(
    "custom selects replace native controls, align arrows, fit popup bounds and support keyboard/Escape",
  );

  await createHeader("default");
  const browserCookie = {
    name: "keep_cookie",
    value: "browser-value",
    domain: ctx.hostname,
    path: "/",
    hostOnly: true,
    secure: false,
    httpOnly: true,
    sameSite: "lax",
  };
  await message("WRITE_COOKIE", { url: ctx.url, input: browserCookie });
  await manage();
  await click(".new-environment");
  await fill("#environment-name", "测试环境");
  await click(".environment-save");
  await until(
    () =>
      evaluate(
        popup,
        '!document.querySelector("#environment-name") && [...document.querySelectorAll(".environment-details strong")].some(e=>e.textContent==="测试环境")',
      ),
    "new environment created",
  );
  await idle();
  state = await message("STATE");
  const testId = state.config.activeEnvironmentId;
  assert.notEqual(testId, "default");
  assert.equal((await echo())["x-group"], undefined);
  assert.equal((await echo()).cookie, "keep_cookie=browser-value");
  passed(
    "UI creates and activates an empty group, removes previous injection and preserves browser cookies",
  );
  await closeEditor();
  await createHeader("testing");
  state = await message("SAVE_RULE", {
    ...legacyRule,
    id: "",
    environmentId: testId,
    kind: "cookie",
    key: "Cookie",
    value: "tenant=testing",
  });
  assert.equal((await echo())["x-group"], "testing");
  assert.equal((await echo()).cookie, "tenant=testing");
  await reloadPopup();
  await menu(".environment-picker .select-trigger");
  await snapshot("environment-menu");
  await key("Home");
  await key("Enter");
  await idle();
  assert.equal((await echo())["x-group"], "default");
  assert.equal((await echo()).cookie, "keep_cookie=browser-value");
  assert.equal(
    await evaluate(popup, 'document.querySelectorAll(".rule-row").length'),
    2,
  );
  await menu(".environment-picker .select-trigger");
  await key("End");
  await key("Enter");
  await idle();
  assert.equal((await echo())["x-group"], "testing");
  assert.equal((await echo()).cookie, "tenant=testing");
  passed(
    "environment keyboard switch isolates same-name headers and request cookies on actual network requests",
  );

  await manage();
  await click('[aria-label="重命名环境 测试环境"]');
  await fill("#environment-name", "默认环境");
  await click(".environment-save");
  await until(
    () =>
      evaluate(
        popup,
        '!!document.querySelector(".environment-form [role=alert]")',
      ),
    "duplicate name rejected",
  );
  assert.equal(
    await evaluate(popup, 'document.querySelector("#environment-name").value'),
    "默认环境",
  );
  assert.equal((await message("STATE")).config.activeEnvironmentId, testId);
  assert.equal((await echo())["x-group"], "testing");
  await until(() => evaluate(popup, '!document.querySelector(".toast")'), "prior success feedback has exited");
  assert.equal(
    await evaluate(popup, '!!document.querySelector(".toast")'),
    false,
    "no success overlay obscures the environment form or contradicts its error",
  );
  await snapshot("environment-error");
  await fill("#environment-name", "联调环境");
  await click(".environment-save");
  await until(
    () =>
      evaluate(
        popup,
        '!document.querySelector("#environment-name") && [...document.querySelectorAll("button")].some(e=>e.getAttribute("aria-label")==="复制环境 联调环境")',
      ),
    "rename saved",
  );
  await idle();
  await snapshot("environment-manager");
  passed(
    "invalid environment name preserves input and active configuration; correction saves successfully",
  );

  await click('[aria-label="复制环境 默认环境"]');
  await fill("#environment-name", "预发环境");
  await click(".environment-save");
  await until(
    () =>
      evaluate(
        popup,
        '!document.querySelector("#environment-name") && [...document.querySelectorAll("button")].some(e=>e.getAttribute("aria-label")==="删除环境 预发环境")',
      ),
    "environment copied",
  );
  await idle();
  state = await message("STATE");
  const copyId = state.config.activeEnvironmentId;
  const originalIds = state.config.rules
    .filter((r) => r.environmentId === "default")
    .map((r) => r.id);
  const copied = state.config.rules.filter((r) => r.environmentId === copyId);
  assert.equal(copied.length, 2);
  assert.ok(copied.every((r) => !originalIds.includes(r.id)));
  assert.equal((await echo())["x-group"], "default");
  await click('[aria-label="删除环境 预发环境"]');
  await snapshot("environment-delete");
  await click(".environment-delete .danger-button");
  await idle();
  state = await message("STATE");
  assert.equal(state.config.activeEnvironmentId, "default");
  assert.equal(state.config.environments.length, 2);
  assert.ok(!state.config.rules.some((r) => r.environmentId === copyId));
  assert.equal(
    state.config.rules.filter((r) => r.environmentId === "default").length,
    2,
  );
  passed(
    "copy gives independent rule identities; deleting active copy falls back without deleting source rules",
  );

  await closeEditor();
  await reloadPopup();
  state = await message("STATE");
  assert.equal(state.config.activeEnvironmentId, "default");
  assert.equal(
    state.config.environments.find((e) => e.id === testId).name,
    "联调环境",
  );
  assert.equal(
    state.config.rules.find(
      (r) => r.environmentId === testId && r.key === "X-Group",
    ).value,
    "testing",
  );
  assert.equal(
    (await message("COOKIES", { url: ctx.url })).find(
      (c) => c.name === "keep_cookie",
    ).value,
    "browser-value",
  );
  await message("TOGGLE_ALL", false);
  await message("ENVIRONMENT", { action: "switch", id: testId });
  assert.equal((await echo())["x-group"], undefined);
  assert.equal((await echo()).cookie, "keep_cookie=browser-value");
  passed(
    "group selection and contents survive reload; switching while paused never resumes injection or alters browser cookie jar",
  );

  // Open a lower form control in a short popup to cover upward menu placement.
  await message("TOGGLE_ALL", true);
  await reloadPopup();
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 400, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  await click(".add-button");
  await until(
    () => evaluate(popup, '!!document.querySelector("#rule-scope")'),
    "short scope form",
  );
  await evaluate(
    popup,
    "document.querySelector('#rule-scope').scrollIntoView({block:'end'})",
  );
  await menu("#rule-scope");
  assert.equal(
    await evaluate(
      popup,
      `document.querySelector('.select-popover').getBoundingClientRect().bottom < document.querySelector('#rule-scope').getBoundingClientRect().top`,
    ),
    true,
  );
  await snapshot("scope-menu-short");
  passed("custom menu flips upward and remains inside a short popup");
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
  console.log(`${checks.length} environment browser checks passed`);
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  try {
    await cdp("Browser.close");
  } catch {}
  child.kill();
  server.close();
}
