import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = resolve(
  root,
  process.env.EVIDENCE_DIR || "evidence/popup-alias-polish/browser",
);
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
    path: resolve(
      process.env.EXTENSION_PATH || resolve(root, ".output/chrome-mv3-dev"),
    ),
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
  async function saveAdded() {
    await click(".select-create-save");
    await until(
      () =>
        evaluate(
          popup,
          "!document.querySelector('.select-create') && !!document.querySelector('.select-editable')",
        ),
      "candidate added inside menu",
    );
    await idle();
    assert.equal(
      await evaluate(popup, "!!document.querySelector('.editor')"),
      false,
    );
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
      "document.querySelector('.rule-value-picker .select-value > span:first-child').textContent",
    ),
    "899",
  );
  await snapshot("list");
  passed(
    "create several values and select the active value in the editor; actual request uses selected value",
  );

  await menu(".rule-value-picker button");
  await snapshot("menu");
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-option-description').textContent",
    ),
    "未设置别名",
  );
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-column-labels').textContent",
    ),
    "值别名",
  );
  await click(".select-option:nth-child(1)");
  await idle();
  assert.equal((await echo())["pversion-id"], "898");
  await reloadPopup();
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.rule-value-picker .select-value > span:first-child').textContent",
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
    () => evaluate(popup, "!!document.querySelector('.select-create-value')"),
    "quick add editor",
  );
  await fill(".select-create-value", "831");
  await fill(".select-create-fields label:nth-child(2) input", "生产");
  await snapshot("quick-add");
  await saveAdded();
  assert.equal((await echo())["pversion-id"], "831");
  assert.equal(
    await evaluate(
      popup,
      "document.activeElement.matches('.select-search input')",
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
    "831生产",
  );
  passed(
    "footer quick-add persists alias and immediately applies the new Header value",
  );
  await key("Escape");

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
  assert.deepEqual(
    await evaluate(
      popup,
      "[...document.querySelectorAll('.select-option-description')].map(e=>e.textContent)",
    ),
    ["测试环境", "预发布", "生产"],
  );
  assert.equal(
    await evaluate(
      popup,
      "[...document.querySelectorAll('.select-option-description')].every(e=>e.getBoundingClientRect().width>0 && getComputedStyle(e).visibility==='visible')",
    ),
    true,
  );
  await key("Escape");
  const { targetId: blankId } = await cdp("Target.createTarget", {
    url: "about:blank",
  });
  await cdp("Target.activateTarget", { targetId: blankId });
  await reloadPopup();
  assert.equal(
    await evaluate(popup, "!document.querySelector('.site-context')"),
    true,
  );
  await menu(".rule-value-picker button");
  await snapshot("no-site-menu");
  assert.deepEqual(
    await evaluate(
      popup,
      "[...document.querySelectorAll('.select-option-description')].map(e=>e.textContent)",
    ),
    ["测试环境", "预发布", "生产"],
  );
  await key("Escape");
  await click("#tab-site");
  await until(
    () =>
      evaluate(
        popup,
        "document.querySelector('#content-panel').getAttribute('aria-busy')==='false' && document.querySelector('.add-button').disabled && document.querySelector('.action-menu-trigger').disabled",
      ),
    "all website Cookie actions disabled without a website",
  );
  await click(".action-menu-trigger");
  await evaluate(
    popup,
    "document.querySelector('.action-menu-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))",
  );
  assert.equal(
    await evaluate(popup, "!!document.querySelector('.action-menu')"),
    false,
  );
  assert.equal(
    await evaluate(
      popup,
      "getComputedStyle(document.querySelector('.add-button')).opacity === getComputedStyle(document.querySelector('.action-menu-trigger')).opacity",
    ),
    true,
  );
  await snapshot("no-site-actions-disabled");
  await click("#tab-header");
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.action-menu-trigger').disabled",
    ),
    false,
  );
  passed(
    "website Cookie split button is consistently disabled without a website; click and keyboard cannot open an empty menu",
  );
  await cdp("Target.activateTarget", { targetId: fixtureId });
  await cdp("Target.closeTarget", { targetId: blankId });
  await reloadPopup();
  await menu(".rule-value-picker button");
  passed(
    "aliases remain visible on non-website tabs and rules survive reopening on a website",
  );
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
    () => evaluate(popup, "!!document.querySelector('.select-create-value')"),
    "keyboard quick add",
  );
  await fill(".select-create-value", "831");
  await fill(".select-create-fields label:nth-child(2) input", "重复环境");
  await click(".select-create-save");
  await until(
    () =>
      evaluate(
        popup,
        'document.querySelector(".select-create-error")?.textContent.includes("重复")',
      ),
    "duplicate quick-add rejected",
  );
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-create-fields label:nth-child(2) input').value",
    ),
    "重复环境",
  );
  assert.equal((await echo())["pversion-id"], "899");
  await fill(".select-create-value", "833");
  await fill(".select-create-fields label:nth-child(2) input", "联调");
  await saveAdded();
  assert.equal((await echo())["pversion-id"], "833");
  await key("Escape");
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
    () => evaluate(popup, "!!document.querySelector('.select-create-value')"),
    "concurrent editor",
  );
  await fill(".select-create-value", "835");
  await fill(".select-create-fields label:nth-child(2) input", "新环境");
  await message("ADD_RULE_VALUE", {
    id,
    environmentId: "default",
    value: "834",
    alias: "并发新增",
  });
  await saveAdded();
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

  await key("Escape");

  await menu(".rule-value-picker button");
  await fill(".select-search input", "暂不新增");
  await click(".select-add");
  await until(
    () => evaluate(popup, "!!document.querySelector('.select-create-value')"),
    "add form inside menu",
  );
  assert.equal(
    await evaluate(popup, "!!document.querySelector('.editor')"),
    false,
  );
  await fill(".select-create-value", "cancelled");
  await key("Escape");
  await until(
    () =>
      evaluate(
        popup,
        "!document.querySelector('.select-create') && !!document.querySelector('.select-editable')",
      ),
    "Escape cancels add without closing menu",
  );
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-search input').value",
    ),
    "暂不新增",
  );
  assert.equal((await echo())["pversion-id"], "835");
  await click(".select-add");
  await until(
    () => evaluate(popup, "!!document.querySelector('.select-create-value')"),
    "reopen empty add draft",
  );
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-create-value').value",
    ),
    "",
  );
  await click(".select-create-actions .secondary-button");
  await key("Escape");
  passed(
    "inline add cancels without changing selection, preserves search, and starts a clean draft next time",
  );

  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 400, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  await menu(".rule-value-picker button");
  await click(".select-add");
  await until(
    () => evaluate(popup, "!!document.querySelector('.select-create-value')"),
    "short inline add",
  );
  await snapshot("inline-add-short");
  assert.equal(
    await evaluate(
      popup,
      `(() => {
    const save = document.querySelector('.select-create-save').getBoundingClientRect();
    const input = document.querySelector('.select-create-value').getBoundingClientRect();
    return input.top >= 0 && save.bottom <= innerHeight && save.right <= innerWidth;
  })()`,
    ),
    true,
  );
  await fill(".select-create-value", "836");
  await fill(".select-create-fields label:nth-child(2) input", "短窗联调");
  await key("Enter");
  await until(
    () =>
      evaluate(
        popup,
        "!document.querySelector('.select-create') && !!document.querySelector('.select-editable')",
      ),
    "Enter adds in short menu",
  );
  await idle();
  assert.equal((await echo())["pversion-id"], "836");
  await key("Escape");
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 600, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  passed(
    "short popup keeps inline add fields and actions visible; Enter saves and applies without navigation",
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

  await click('[aria-label="关闭编辑"]');
  await until(
    () => evaluate(popup, '!document.querySelector(".editor")'),
    "close short editor",
  );
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 600, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  await message("SAVE_RULE", {
    ...(await message("STATE")).config.rules.find((r) => r.id === id),
    value: "898",
    values: ["898", "831", "231"],
    valueAliases: ["测试", "", "生产"],
    enabled: true,
  });
  await reloadPopup();
  async function editCell(index, field) {
    await click(
      `.select-option:nth-child(${index}) .select-cell-edit[data-option-action="${field}"]`,
    );
    await until(
      () =>
        evaluate(
          popup,
          `!!document.querySelector('input[aria-label="${field === "value" ? "编辑候选值" : "编辑别名"}"]')`,
        ),
      "inline editor",
    );
    assert.equal(
      await evaluate(popup, "!!document.querySelector('.editor')"),
      false,
    );
  }
  async function inlineSaved() {
    await until(
      () =>
        evaluate(
          popup,
          "!document.querySelector('.select-inline-input') && !!document.querySelector('.select-editable')",
        ),
      "inline save keeps menu open",
    );
    await idle();
  }
  await menu(".rule-value-picker button");
  const textCell = ".select-option:nth-child(1) .select-option-label > span";
  const cellCenter = await evaluate(
    popup,
    `(() => {
    const r = document.querySelector(${JSON.stringify(textCell)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`,
  );
  await cdp(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...cellCenter },
    popup,
  );
  assert.equal(
    await evaluate(popup, "!!document.querySelector('.select-inline-input')"),
    false,
  );
  assert.deepEqual(
    await evaluate(
      popup,
      `(() => {
    const cell = document.querySelector('.select-option-label.select-cell');
    const style = getComputedStyle(cell);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  })()`,
    ),
    { background: "rgba(0, 0, 0, 0)", shadow: "none" },
  );
  await click(textCell);
  await until(
    () => evaluate(popup, "!document.querySelector('.select-editable')"),
    "text selects without entering edit",
  );
  assert.equal(
    await evaluate(
      popup,
      "!!document.querySelector('.select-inline-input') || !!document.querySelector('.editor')",
    ),
    false,
  );
  assert.equal(
    (await message("STATE")).config.rules.find((r) => r.id === id).value,
    "898",
  );
  passed(
    "candidate text stays plain on hover and selects; only pencil controls enter editing",
  );
  await menu(".rule-value-picker button");
  await editCell(2, "value");
  await fill(".select-inline-input", "832");
  await snapshot("inline-value-edit");
  await click(".select-inline-save");
  await inlineSaved();
  assert.equal((await echo())["pversion-id"], "898");
  assert.deepEqual(
    (await message("STATE")).config.rules.find((r) => r.id === id).values,
    ["898", "832", "231"],
  );
  passed(
    "inline non-current value edits keep the menu open and preserve actual injected value",
  );

  await editCell(2, "alias");
  await fill(".select-inline-input", "灰度环境");
  await snapshot("inline-alias-edit");
  await key("Enter");
  await inlineSaved();
  assert.deepEqual(
    (await message("STATE")).config.rules.find((r) => r.id === id).valueAliases,
    ["测试", "灰度环境", "生产"],
  );
  await snapshot("inline-alias-saved");
  await key("Escape");
  await reloadPopup();
  await menu(".rule-value-picker button");
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.select-option:nth-child(2) .select-option-description').textContent",
    ),
    /灰度环境/,
  );
  passed(
    "inline alias edits save with Enter and survive reopening without changing the current candidate",
  );

  await editCell(1, "value");
  await fill(".select-inline-input", "899");
  await key("Enter");
  await inlineSaved();
  assert.equal((await echo())["pversion-id"], "899");
  assert.equal(
    (await message("STATE")).config.rules.find((r) => r.id === id).value,
    "899",
  );
  passed(
    "editing the current candidate immediately changes subsequent real network requests",
  );

  await editCell(2, "value");
  await fill(".select-inline-input", "899");
  await click(".select-inline-save");
  await until(
    () =>
      evaluate(
        popup,
        "document.querySelector('.select-edit-error')?.textContent.includes('重复')",
      ),
    "duplicate inline value rejected",
  );
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-inline-input').value",
    ),
    "899",
  );
  assert.equal((await echo())["pversion-id"], "899");
  await snapshot("inline-duplicate-error");
  await fill(".select-inline-input", "833");
  await click(".select-inline-save");
  await inlineSaved();
  assert.deepEqual(
    (await message("STATE")).config.rules.find((r) => r.id === id).values,
    ["899", "833", "231"],
  );
  passed(
    "invalid inline save retains input and network state; correcting it succeeds in place",
  );

  await editCell(2, "alias");
  await fill(".select-inline-input", "不保存");
  await key("Escape");
  await until(
    () => evaluate(popup, '!document.querySelector(".select-inline-input")'),
    "Escape cancels only inline draft",
  );
  assert.equal(
    await evaluate(popup, '!!document.querySelector(".select-editable")'),
    true,
  );
  assert.equal(
    (await message("STATE")).config.rules.find((r) => r.id === id)
      .valueAliases[1],
    "灰度环境",
  );
  await editCell(2, "alias");
  await fill(".select-inline-input", "我的备注");
  const concurrent = (await message("STATE")).config.rules.find(
    (r) => r.id === id,
  );
  await message("SAVE_RULE", {
    ...concurrent,
    valueAliases: ["测试", "并发备注", "生产"],
    includeSubdomains: !concurrent.includeSubdomains,
  });
  await click(".select-inline-save");
  await until(
    () =>
      evaluate(
        popup,
        "document.querySelector('.select-edit-error')?.textContent.includes('别名已变化')",
      ),
    "stale alias rejected",
  );
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-inline-input').value",
    ),
    "我的备注",
  );
  assert.equal(
    (await message("STATE")).config.rules.find((r) => r.id === id)
      .valueAliases[1],
    "并发备注",
  );
  await click('[aria-label="取消修改"]');
  await key("Escape");
  passed(
    "Escape cancels drafts and stale inline aliases cannot overwrite concurrent changes",
  );

  await reloadPopup();
  await click(".master-control");
  await idle();
  await menu(".rule-value-picker button");
  await editCell(1, "value");
  await fill(".select-inline-input", "900");
  await click(".select-inline-save");
  await inlineSaved();
  assert.equal((await message("STATE")).config.enabled, false);
  assert.equal(
    (await message("STATE")).config.rules.find((r) => r.id === id).value,
    "900",
  );
  assert.equal((await echo())["pversion-id"], undefined);
  await key("Escape");
  await click(".master-control");
  await idle();
  assert.equal((await echo())["pversion-id"], "900");
  passed(
    "inline save while paused preserves pause and applies the edited value only after resuming",
  );

  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 400, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  await menu(".rule-value-picker button");
  await editCell(1, "alias");
  await snapshot("inline-short-menu");
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-edit-actions').getBoundingClientRect().bottom <= innerHeight && document.querySelector('.select-edit-actions').getBoundingClientRect().top >= 0",
    ),
    true,
  );
  await key("Escape");
  await key("Escape");
  passed(
    "inline editing keeps save and cancel controls visible in a short popup",
  );

  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 480, height: 600, deviceScaleFactor: 1, mobile: false },
    popup,
  );
  const deleteFixture = (await message("STATE")).config.rules.find(
    (r) => r.id === id,
  );
  await message("SAVE_RULE", {
    ...deleteFixture,
    value: "",
    values: ["898", "231", "831", ""],
    valueAliases: ["城代测试", "姚明浩联调环境", "自己的环境", ""],
  });
  await reloadPopup();
  await menu(".rule-value-picker button");
  await click(".select-option:nth-child(4) .select-delete");
  await until(
    () => evaluate(popup, "!!document.querySelector('.select-remove-confirm')"),
    "confirm candidate deletion",
  );
  assert.match(
    await evaluate(
      popup,
      "document.querySelector('.select-remove-confirm').textContent",
    ),
    /首个剩余值/,
  );
  await snapshot("delete-current-confirm");
  await key("Escape");
  await until(
    () => evaluate(popup, "!document.querySelector('.select-remove-confirm')"),
    "cancel deletion",
  );
  assert.equal(
    (await message("STATE")).config.rules.find((r) => r.id === id).value,
    "",
  );
  assert.equal(
    await evaluate(popup, "!!document.querySelector('.select-editable')"),
    true,
  );
  await click(".select-option:nth-child(4) .select-delete");
  await click(".select-remove-save");
  await until(
    () =>
      evaluate(
        popup,
        "!document.querySelector('.select-remove-confirm') && document.querySelectorAll('.select-option').length === 3",
      ),
    "empty candidate removed",
  );
  await idle();
  assert.equal((await echo())["pversion-id"], "898");
  assert.deepEqual(
    (await message("STATE")).config.rules.find((r) => r.id === id).valueAliases,
    ["城代测试", "姚明浩联调环境", "自己的环境"],
  );
  await snapshot("delete-current-done");
  passed(
    "deleting the current empty candidate confirms, supports cancel, selects first remaining value and updates real requests",
  );

  await fill(".select-search input", "姚明浩");
  await click(".select-option .select-delete");
  await click(".select-remove-save");
  await until(
    () =>
      evaluate(
        popup,
        "!document.querySelector('.select-remove-confirm') && !!document.querySelector('.select-empty')",
      ),
    "noncurrent candidate deleted from search",
  );
  await idle();
  assert.equal((await echo())["pversion-id"], "898");
  assert.equal(
    await evaluate(
      popup,
      "document.querySelector('.select-search input').value",
    ),
    "姚明浩",
  );
  await key("Escape");
  await reloadPopup();
  assert.deepEqual(
    (await message("STATE")).config.rules.find((r) => r.id === id).values,
    ["898", "831"],
  );
  passed(
    "deleting a noncurrent candidate preserves selection/search and persists after reopening",
  );

  await menu(".rule-value-picker button");
  await click(".select-option:nth-child(2) .select-delete");
  await message("REMOVE_RULE_VALUE", {
    id,
    environmentId: "default",
    value: "831",
  });
  await click(".select-remove-save");
  await until(
    () =>
      evaluate(
        popup,
        "document.querySelector('.select-remove-confirm .select-create-error')?.textContent.includes('候选值已变化')",
      ),
    "stale deletion rejected",
  );
  assert.equal((await echo())["pversion-id"], "898");
  await snapshot("delete-stale-error");
  await key("Escape");
  await key("Escape");
  await reloadPopup();
  await menu(".rule-value-picker button");
  assert.equal(
    await evaluate(popup, "document.querySelector('.select-delete').disabled"),
    true,
  );
  await assert.rejects(
    message("REMOVE_RULE_VALUE", {
      id,
      environmentId: "default",
      value: "898",
    }),
    /至少保留/,
  );
  assert.equal((await echo())["pversion-id"], "898");
  await key("Escape");
  passed(
    "stale candidate deletion cannot change current state and both UI and background protect the last value",
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
