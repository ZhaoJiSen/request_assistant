import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = resolve(root, "evidence/header-value-aliases/browser");
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
    const keyCode = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      ArrowUp: 38,
      ArrowDown: 40,
      Home: 36,
      End: 35,
    }[value];
    await cdp(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: value,
        code: value,
        windowsVirtualKeyCode: keyCode,
        ...(value === "Enter" ? { text: "\r" } : {}),
      },
      popup,
    );
    await cdp(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: value, windowsVirtualKeyCode: keyCode },
      popup,
    );
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

  async function saveEditor() {
    await click('button[form="config-form"]');
    await until(
      () => evaluate(popup, '!document.querySelector(".editor")'),
      "editor saved",
    );
    await idle();
  }
  const row = ".rule-row";
  await click(".add-button");
  await until(
    () => evaluate(popup, '!!document.querySelector("#rule-key")'),
    "editor",
  );
  await fill("#rule-key", "pversion-id");
  await fill("#rule-value", "898");
  await click(".add-value");
  await fill("#rule-value-1", "899");
  await click(".add-value");
  await fill("#rule-value-2", "900");

  await evaluate(
    popup,
    "document.querySelectorAll('.value-choice input')[1].click()",
  );
  await snapshot("editor");
  await saveEditor();
  assert.equal((await echo())["pversion-id"], "899");
  let state = await message("STATE");
  const id = state.config.rules[0].id;
  assert.deepEqual(state.config.rules[0].values, ["898", "899", "900"]);
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.rule-value-picker .select-value').textContent",
    ),
    "899",
  );
  await snapshot("list");
  passed(
    "create several values and select the active value in the editor; actual request uses selected value",
  );

  await menu(".rule-value-picker button");
  await snapshot("menu");
  await click(".select-option:nth-child(1)");
  await idle();
  assert.equal((await echo())["pversion-id"], "898");
  await reloadPopup();
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.rule-value-picker .select-value').textContent",
    ),
    "898",
  );
  passed(
    "list selection changes real network header and persists across popup reload",
  );

  await menu(".rule-value-picker button");
  await key("ArrowUp");
  await key("Enter");
  await idle();
  assert.equal((await echo())["pversion-id"], "900");
  passed("custom value picker supports keyboard selection");

  await menu(".rule-value-picker button");
  await key("ArrowDown");
  await until(
    () => evaluate(popup, '!document.querySelector(".toast")'),
    "selection toast finished",
  );
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.select-option.active').textContent",
    ),
    /898/,
  );
  await key("Enter");
  await idle();
  assert.equal((await echo())["pversion-id"], "898");
  passed(
    "toast updates do not reset the active keyboard option while a menu is open",
  );

  await click(".row-toggle");
  await idle();
  await menu(".rule-value-picker button");
  await click(".select-option:nth-child(2)");
  await idle();
  assert.equal((await echo())["pversion-id"], undefined);
  assert.equal((await message("STATE")).config.rules[0].value, "899");
  await click(".row-toggle");
  await idle();
  assert.equal((await echo())["pversion-id"], "899");
  await click(".master-control");
  await idle();
  await menu(".rule-value-picker button");
  await click(".select-option:nth-child(1)");
  await idle();
  assert.equal((await echo())["pversion-id"], undefined);
  assert.equal((await message("STATE")).config.enabled, false);
  await click(".master-control");
  await idle();
  assert.equal((await echo())["pversion-id"], "898");
  passed("value changes preserve individual disabled state and global pause");

  await click('.row-actions button[title="编辑规则"]');
  await until(
    () => evaluate(popup, '!!document.querySelector("#rule-key")'),
    "editor reopened",
  );
  await fill("#rule-value-1", "898");
  await click('button[form="config-form"]');
  await until(
    () =>
      evaluate(
        popup,
        'document.querySelector(".editor-error")?.textContent.includes("重复")',
      ),
    "duplicate error",
  );
  assert.equal((await message("STATE")).config.rules[0].value, "898");
  assert.equal(
    await evaluate(popup, 'document.querySelector("#rule-value-1").value'),
    "898",
  );
  await fill("#rule-value-1", "899");
  await evaluate(
    popup,
    "document.querySelectorAll('.value-draft .icon-button')[0].click()",
  );
  await saveEditor();
  assert.equal((await echo())["pversion-id"], "899");
  assert.deepEqual((await message("STATE")).config.rules[0].values, [
    "899",
    "900",
  ]);
  passed(
    "duplicates keep editor inputs intact; removing selected value chooses a remaining value",
  );

  await click('.row-actions button[title="编辑规则"]');
  await until(
    () => evaluate(popup, '!!document.querySelector("#rule-key")'),
    "editor reopened",
  );
  await evaluate(
    popup,
    "document.querySelectorAll('.value-draft .icon-button')[1].click()",
  );
  await saveEditor();
  assert.equal(
    await evaluate(popup, "!!document.querySelector('.rule-value-picker')"),
    true,
  );
  assert.equal((await message("STATE")).config.rules[0].values, undefined);
  assert.equal((await echo())["pversion-id"], "899");
  passed(
    "one remaining value keeps quick-add accessible in the single-value picker",
  );

  await message("SAVE_RULE", {
    ...(await message("STATE")).config.rules[0],
    value: "898",
    values: ["898", "899", "900"],
  });
  await reloadPopup();
  const fresh = (await message("STATE")).config.rules[0];
  await message("SAVE_RULE", { ...fresh, values: ["898", "899"] });
  await menu(".rule-value-picker button");
  await click(".select-option:nth-child(3)");
  await until(
    () =>
      evaluate(
        popup,
        'document.querySelector(".error-banner")?.textContent.includes("候选值已变化") || document.body.textContent.includes("候选值已变化")',
      ),
    "stale candidate rejected",
  );
  assert.equal((await message("STATE")).config.rules[0].value, "898");
  assert.equal((await echo())["pversion-id"], "898");
  passed(
    "stale candidate selection cannot overwrite a concurrently edited rule",
  );

  await reloadPopup();
  await menu(".rule-value-picker button");
  await click(".select-add");
  await until(
    () => evaluate(popup, '!!document.querySelector("#quick-value")'),
    "quick add editor",
  );
  await fill("#quick-value", "831");
  await fill("#quick-alias", "生产");
  await snapshot("quick-add");
  await saveEditor();
  assert.equal((await echo())["pversion-id"], "831");
  assert.equal(
    await evaluate(
      popup,
      "document.activeElement.classList.contains('select-trigger')",
    ),
    true,
  );
  assert.deepEqual((await message("STATE")).config.rules[0].valueAliases, [
    "",
    "",
    "生产",
  ]);
  await reloadPopup();
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.rule-value-picker .select-value').textContent",
    ),
    "生产831",
  );
  passed(
    "footer quick-add persists alias and immediately applies the new Header value",
  );

  await click('.row-actions button[title="编辑规则"]');
  await until(
    () => evaluate(popup, '!!document.querySelector("#rule-key")'),
    "alias editor",
  );
  await fill("#rule-alias-0", "测试环境");
  await fill("#rule-alias-1", "预发布");
  await snapshot("aliases-editor");
  await saveEditor();
  await menu(".rule-value-picker button");
  await snapshot("aliases-menu");
  await fill(".select-search input", "预发");
  assert.equal(
    await evaluate(popup, "document.querySelectorAll('.select-option').length"),
    1,
  );
  await key("Enter");
  await idle();
  assert.equal((await echo())["pversion-id"], "899");
  await menu(".rule-value-picker button");
  await fill(".select-search input", "98");
  assert.equal(
    await evaluate(popup, "document.querySelectorAll('.select-option').length"),
    1,
  );
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.select-option').textContent",
    ),
    /测试环境/,
  );
  await key("Escape");
  assert.equal((await echo())["pversion-id"], "899");
  passed(
    "aliases show alongside raw values; search matches alias or value and Escape keeps selection",
  );

  await menu(".rule-value-picker button");
  await fill(".select-search input", "没有这个环境");
  assert.equal(
    await evaluate(popup, "document.querySelectorAll('.select-option').length"),
    0,
  );
  await snapshot("search-empty");
  await key("Tab");
  assert.equal(
    await evaluate(
      popup,
      "document.activeElement.classList.contains('select-add')",
    ),
    true,
  );
  await key("Enter");
  await until(
    () => evaluate(popup, '!!document.querySelector("#quick-value")'),
    "keyboard quick add",
  );
  await fill("#quick-value", "831");
  await fill("#quick-alias", "重复环境");
  await click('button[form="config-form"]');
  await until(
    () =>
      evaluate(
        popup,
        'document.querySelector(".editor-error")?.textContent.includes("重复")',
      ),
    "duplicate quick-add rejected",
  );
  assert.equal(
    await evaluate(popup, "document.querySelector('#quick-alias').value"),
    "重复环境",
  );
  assert.equal((await echo())["pversion-id"], "899");
  await fill("#quick-value", "833");
  await fill("#quick-alias", "联调");
  await saveEditor();
  assert.equal((await echo())["pversion-id"], "833");
  passed(
    "no-results menu retains keyboard add action; invalid save preserves inputs and previous network value",
  );

  await fill(".search-field input", "联调");
  assert.equal(
    await evaluate(popup, "document.querySelectorAll('.rule-row').length"),
    1,
  );
  await fill(".search-field input", "");
  await menu(".rule-value-picker button");
  await click(".select-add");
  await until(
    () => evaluate(popup, '!!document.querySelector("#quick-value")'),
    "concurrent editor",
  );
  await fill("#quick-value", "835");
  await fill("#quick-alias", "新环境");
  await message("ADD_RULE_VALUE", {
    id,
    environmentId: "default",
    value: "834",
    alias: "并发新增",
  });
  await saveEditor();
  state = await message("STATE");
  assert.deepEqual(state.config.rules[0].values.slice(-2), ["834", "835"]);
  assert.deepEqual(state.config.rules[0].valueAliases.slice(-2), [
    "并发新增",
    "新环境",
  ]);
  assert.equal((await echo())["pversion-id"], "835");
  passed(
    "main search includes aliases; quick-add merges with candidates added concurrently",
  );

  await message("SAVE_RULE", {
    ...fresh,
    id: "",
    key: "Authorization",
    value: "Bearer sensitive-one",
    values: ["Bearer sensitive-one", "Bearer sensitive-two"],
    valueAliases: ["测试凭据", "生产凭据"],
  });
  await reloadPopup();
  await evaluate(
    popup,
    "[...document.querySelectorAll('.rule-value-picker button')].find(e=>e.getAttribute('aria-label').includes('Authorization')).click()",
  );
  await until(
    () => evaluate(popup, '!!document.querySelector(".select-popover")'),
    "sensitive menu",
  );
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-popover').textContent.includes('sensitive-')",
    ),
    false,
  );
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.select-popover').textContent",
    ),
    /生产凭据/,
  );
  await snapshot("sensitive");
  await key("Escape");
  passed(
    "sensitive Header candidates remain masked in the trigger and open menu",
  );

  const current = (await message("STATE")).config.rules.find(
    (r) => r.id === id,
  );
  await message("SAVE_RULE", {
    ...current,
    value: "0",
    values: Array.from({ length: 30 }, (_, i) => String(i)),
    valueAliases: Array.from({ length: 30 }, (_, i) => `环境 ${i + 1}`),
  });
  await reloadPopup();
  await menu(".rule-value-picker button");
  assert.equal(
    await evaluate(popup, "document.querySelector('.select-add').disabled"),
    true,
  );
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-options').scrollHeight > document.querySelector('.select-options').clientHeight",
    ),
    true,
  );
  await snapshot("long-menu");
  await key("Escape");
  passed(
    "30-value limit disables add while choices scroll independently from search and footer",
  );

  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 400, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  await menu(".rule-value-picker button");
  await snapshot("short-menu");
  await key("Escape");
  await cdp("Emulation.setPageScaleFactor", { pageScaleFactor: 2 }, popup);
  await menu(".rule-value-picker button");
  await snapshot("menu-200-percent");
  await key("Escape");
  await cdp("Emulation.setPageScaleFactor", { pageScaleFactor: 1 }, popup);
  await click('.row-actions button[title="编辑规则"]');
  await until(
    () => evaluate(popup, '!!document.querySelector("#rule-key")'),
    "short editor",
  );
  const fits = await evaluate(
    popup,
    "document.querySelector('.editor-footer').getBoundingClientRect().bottom <= innerHeight+1",
  );
  assert.equal(fits, true);
  await snapshot("short-editor");
  passed(
    "value menu stays inside short viewport and editor save footer remains visible",
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
  console.log(`${checks.length} Header candidate browser checks passed`);
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  try {
    await cdp("Browser.close");
  } catch {}
  child.kill();
  server.close();
}
