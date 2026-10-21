import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileRules,
  matchesRule,
  migrateLegacy,
  validateConfig,
  validateRule,
} from "../lib/rules";
import { CONFIG_KEY, createController } from "../lib/controller";
import {
  currentContext,
  domainMatches,
  listCookies,
  removeCookie,
  writeCookie,
} from "../lib/cookies";
import { emptyConfig, type Rule, type CookieInput } from "../lib/types";
const rule = (changes: Partial<Rule> = {}): Rule => ({
  id: "rule-1",
  environmentId: "default",
  kind: "header",
  key: "X-Test",
  value: "first",
  enabled: true,
  scope: "domain",
  pattern: "api.example.com",
  includeSubdomains: true,
  operation: "set",
  ...changes,
});
function mockApi(initial: Record<string, unknown> = {}) {
  const store = structuredClone(initial);
  let rules: chrome.declarativeNetRequest.Rule[] = [];
  let failDnr = false;
  let failCommit = false;
  const api = {
    storage: {
      local: {
        get: async () => structuredClone(store),
        set: async (data: Record<string, unknown>) => {
          if (
            failCommit &&
            CONFIG_KEY in data &&
            !("headerManagerLegacyBackup" in data)
          ) {
            failCommit = false;
            throw new Error("storage quota");
          }
          Object.assign(store, structuredClone(data));
        },
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => structuredClone(rules),
      isRegexSupported: async () => ({ isSupported: true }),
      updateDynamicRules: async (input: {
        addRules: chrome.declarativeNetRequest.Rule[];
      }) => {
        if (failDnr) {
          failDnr = false;
          throw new Error("DNR rejected");
        }
        rules = structuredClone(input.addRules);
      },
    },
  } as unknown as typeof chrome;
  return {
    api,
    store,
    rules: () => rules,
    rejectDnr: () => {
      failDnr = true;
    },
    rejectCommit: () => {
      failCommit = true;
    },
  };
}
test("domain matches respect boundaries, subdomains, ports, HTTP and HTTPS", () => {
  const r = validateRule(rule());
  for (const url of [
    "https://api.example.com/path",
    "http://api.example.com:8080/",
    "https://sub.api.example.com/",
  ])
    assert.equal(matchesRule(r, url), true);
  for (const url of [
    "https://evilapi.example.com/",
    "https://api.example.com.evil.test/",
    "file:///api.example.com",
  ])
    assert.equal(matchesRule(r, url), false);
  assert.equal(
    matchesRule(
      { ...r, includeSubdomains: false },
      "https://sub.api.example.com/",
    ),
    false,
  );
  assert.equal(
    matchesRule(
      validateRule(rule({ pattern: "localhost:8080" })),
      "http://localhost:8081/",
    ),
    false,
  );
  assert.equal(
    matchesRule(
      validateRule(rule({ pattern: "localhost:8080" })),
      "http://localhost:8080/",
    ),
    true,
  );
});
test("site set rules override global, disabled configs compile to no rules", () => {
  const c = {
    ...emptyConfig(),
    rules: [rule({ id: "a", scope: "global", pattern: "" }), rule({ id: "b" })],
  };
  const compiled = compileRules(c);
  assert.ok(compiled[1]!.priority! > compiled[0]!.priority!);
  assert.equal(compileRules({ ...c, enabled: false }).length, 0);
});
test("validates input and duplicates without rejecting empty header values", () => {
  assert.equal(validateRule(rule({ value: "" })).value, "");
  assert.throws(
    () => validateRule(rule({ value: "x\r\ninjected: true" })),
    /换行/,
  );
  assert.throws(() => validateRule(rule({ key: "bad header" })), /名称/);
  assert.throws(() => validateRule(rule({ key: "Cookie" })), /请求 Cookie/);
  assert.throws(
    () =>
      validateConfig({
        ...emptyConfig(),
        rules: [rule(), rule({ id: "two", key: "x-test" })],
      }),
    /相同范围/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...emptyConfig(),
        rules: [
          rule({ scope: "global" }),
          rule({ id: "global-2", scope: "global", includeSubdomains: false }),
        ],
      }),
    /相同范围/,
  );
  assert.throws(
    () => validateRule(rule({ kind: "cookie", value: "not-a-pair" })),
    /name=value/,
  );
  assert.equal(
    validateRule(
      rule({ kind: "cookie", value: "token=a=b; flag=1", operation: "append" }),
    ).operation,
    "append",
  );
});
test("migration keeps legacy regex semantics and leaves original data intact", async () => {
  const legacy = [
    {
      id: "old",
      key: "Authorization",
      value: "Bearer old",
      type: "domain",
      pattern: "example\\.com",
      enabled: true,
    },
  ];
  const c = migrateLegacy(legacy);
  assert.equal(c.rules[0]!.scope, "regex");
  assert.equal(matchesRule(c.rules[0]!, "https://example.com/"), true);
  assert.equal(matchesRule(c.rules[0]!, "https://example.com:8080/"), false);
  const m = mockApi({ headers: legacy });
  await createController(m.api).sync();
  assert.deepEqual(m.store.headerManagerLegacyBackup, legacy);
  assert.deepEqual(m.store.headers, legacy);
});
test("DNR rejection does not persist the new config", async () => {
  const config = { ...emptyConfig(), rules: [rule()] };
  const m = mockApi({ [CONFIG_KEY]: config });
  const c = createController(m.api);
  await c.sync();
  m.rejectDnr();
  await assert.rejects(c.saveRule(rule({ value: "new" })), /DNR rejected/);
  assert.deepEqual(await c.read(), config);
  assert.equal(m.rules()[0]!.action.requestHeaders![0]!.value, "first");
});
test("storage failure rolls browser rules back and a new controller reads persisted state", async () => {
  const config = { ...emptyConfig(), rules: [rule()] };
  const m = mockApi({ [CONFIG_KEY]: config });
  const c = createController(m.api);
  await c.sync();
  m.rejectCommit();
  await assert.rejects(c.saveRule(rule({ value: "new" })), /quota/);
  assert.equal(m.rules()[0]!.action.requestHeaders![0]!.value, "first");
  assert.deepEqual(await createController(m.api).read(), config);
  await c.saveRule(rule({ value: "persisted" }));
  assert.equal(
    (await createController(m.api).read()).rules[0]!.value,
    "persisted",
  );
});
test("concurrent mutations are serialized without lost updates", async () => {
  const m = mockApi({ [CONFIG_KEY]: emptyConfig() });
  const c = createController(m.api);
  await Promise.all([
    c.saveRule(rule({ id: "", key: "X-One" })),
    c.saveRule(rule({ id: "", key: "X-Two" })),
    c.saveRule(rule({ id: "", key: "X-Three" })),
  ]);
  assert.equal((await c.read()).rules.length, 3);
  assert.equal(m.rules().length, 3);
});
const context = {
  url: "https://app.example.com/account",
  host: "app.example.com",
  hostname: "app.example.com",
  storeId: "1",
  tabId: 42,
};
const cookieInput: CookieInput = {
  name: "tenant",
  value: "shanghai",
  domain: "app.example.com",
  path: "/",
  hostOnly: true,
  secure: true,
  httpOnly: true,
  sameSite: "lax",
};
function cookieApi() {
  let jar: chrome.cookies.Cookie[] = [];
  let lastSet: any;
  const api = {
    cookies: {
      getAll: async (details: any) =>
        jar.filter(
          (c) =>
            !details.partitionKey ||
            JSON.stringify(c.partitionKey) ===
              JSON.stringify(details.partitionKey),
        ),
      set: async (d: any) => {
        lastSet = d;
        const c = {
          ...d,
          domain: d.domain || new URL(d.url).hostname,
          hostOnly: !d.domain,
          session: d.expirationDate === undefined,
        };
        jar = [c];
        return c;
      },
      get: async () => jar[0],
      remove: async () => {
        jar = [];
        return {};
      },
      getAllCookieStores: async () => [
        { id: "0", tabIds: [] },
        { id: "1", tabIds: [42] },
      ],
      getPartitionKey: async () => ({
        partitionKey: { topLevelSite: "https://example.com" },
      }),
    },
    tabs: { query: async () => [{ id: 42, url: context.url }] },
  } as unknown as typeof chrome;
  return {
    api,
    jar: () => jar,
    lastSet: () => lastSet,
    replace: (cookies: chrome.cookies.Cookie[]) => {
      jar = cookies;
    },
  };
}
test("Cookie operations use current tab cookie store, preserve HttpOnly and read after write", async () => {
  const m = cookieApi();
  const ctx = await currentContext(m.api);
  assert.equal(ctx!.storeId, "1");
  const written = await writeCookie(m.api, context, cookieInput);
  assert.equal(written.value, "shanghai");
  assert.equal(m.lastSet().storeId, "1");
  assert.equal(m.lastSet().httpOnly, true);
  await removeCookie(m.api, context, written);
  assert.equal((await listCookies(m.api, context)).length, 0);
});
test("Cookie constraints reject unrelated domains, invalid values and unsafe SameSite", async () => {
  const m = cookieApi();
  assert.equal(domainMatches(context.hostname, ".example.com"), true);
  assert.equal(domainMatches("badexample.com", "example.com"), false);
  await assert.rejects(
    writeCookie(m.api, context, { ...cookieInput, domain: "evil.test" }),
    /Domain/,
  );
  await assert.rejects(
    writeCookie(m.api, context, {
      ...cookieInput,
      sameSite: "no_restriction",
      secure: false,
    }),
    /Secure/,
  );
  await assert.rejects(
    writeCookie(m.api, context, { ...cookieInput, value: "a;b" }),
    /分号/,
  );
  await assert.rejects(
    writeCookie(m.api, context, {
      ...cookieInput,
      name: "__Host-test",
      hostOnly: false,
    }),
    /__Host-/,
  );
});
test("partition keys persist and concurrent site changes are detected", async () => {
  const m = cookieApi();
  const original = {
    ...cookieInput,
    storeId: "1",
    session: true,
    partitionKey: { topLevelSite: "https://example.com" },
  } as chrome.cookies.Cookie;
  m.replace([original]);
  await writeCookie(m.api, context, { ...cookieInput, original, value: "new" });
  assert.deepEqual(m.lastSet().partitionKey, original.partitionKey);
  m.replace([{ ...original, value: "website-updated" }]);
  await assert.rejects(
    writeCookie(m.api, context, { ...cookieInput, original }),
    /已被网站更新/,
  );
  await assert.rejects(
    removeCookie(m.api, context, { ...original, path: "/other" }),
    /更优先/,
  );
});
