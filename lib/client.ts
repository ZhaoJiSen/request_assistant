import { importRules, planCookies, cookieSnapshot } from "./transfer";
import type { Config, Context, State, Rule } from "./types";
import { activeRules, emptyConfig } from "./types";
import { updateEnvironment } from "./environments";
import { validateConfig } from "./rules";
// Preview is an explicit development route. Production extension always uses Chrome APIs.
const preview =
  import.meta.env.DEV && location.protocol !== "chrome-extension:";
export const isPreview = preview;
const sampleConfig: Config = {
  ...emptyConfig(),
  version: 2,
  enabled: true,
  rules: [
    {
      id: "preview-auth",
      kind: "header",
      key: "Authorization",
      value: "Bearer eyJhbGciOiJIUzI1NiJ9.local-dev-token",
      enabled: true,
      scope: "domain",
      pattern: "console.internal.test",
      includeSubdomains: true,
      operation: "set",
    },
    {
      id: "preview-env",
      kind: "header",
      key: "X-Environment",
      value: "staging",
      enabled: true,
      scope: "global",
      pattern: "",
      includeSubdomains: true,
      operation: "set",
    },
    {
      id: "preview-user",
      kind: "header",
      key: "X-Debug-User",
      value: "zhaojisen",
      enabled: false,
      scope: "domain",
      pattern: "console.internal.test",
      includeSubdomains: true,
      operation: "set",
    },
    {
      id: "preview-cookie",
      kind: "cookie",
      key: "Cookie",
      value: "tenant=shanghai; debug_mode=1",
      enabled: true,
      scope: "domain",
      pattern: "console.internal.test",
      includeSubdomains: false,
      operation: "set",
    },
  ],
};
const sampleCookies = [
  {
    name: "session_id",
    value: "c7a42f8e-91d3-local-session",
    domain: "console.internal.test",
    path: "/",
    secure: true,
    httpOnly: true,
    hostOnly: true,
    sameSite: "lax",
    session: true,
    storeId: "0",
  },
  {
    name: "tenant",
    value: "shanghai",
    domain: ".internal.test",
    path: "/",
    secure: true,
    httpOnly: false,
    hostOnly: false,
    sameSite: "lax",
    session: false,
    expirationDate: Date.now() / 1000 + 86400 * 30,
    storeId: "0",
  },
] as chrome.cookies.Cookie[];
async function previewRequest(type: string, payload: any): Promise<any> {
  const key = "header-manager-preview";
  let config: Config = validateConfig(
    JSON.parse(localStorage.getItem(key) || "null") ||
      (new URLSearchParams(location.search).get("state") === "empty"
        ? emptyConfig()
        : structuredClone(sampleConfig)),
  );
  let cookies: chrome.cookies.Cookie[] =
    JSON.parse(localStorage.getItem(`${key}-cookies`) || "null") ||
    structuredClone(sampleCookies);
  const state = (): State => ({
    config,
    syncError: "",
    dynamicRuleCount: config.enabled
      ? activeRules(config).filter((r) => r.enabled).length
      : 0,
  });
  if (type === "CONTEXT")
    return {
      url: "https://console.internal.test/orders",
      hostname: "console.internal.test",
      host: "console.internal.test",
      storeId: "0",
      tabId: 1,
    } satisfies Context;
  if (type === "STATE" || type === "SYNC") return state();
  if (type === "COOKIES") return cookies;
  if (new URLSearchParams(location.search).get("fail") === "1")
    throw new Error("保存失败，请重试。输入内容已保留");
  if (type === "IMPORT_RULES") config = importRules(config, payload);
  else if (type === "IMPORT_COOKIES") {
    if (payload.expected !== cookieSnapshot(cookies))
      throw new Error("网站 Cookie 已变化，请返回列表后重新导入");
    const context = await previewRequest("CONTEXT", null);
    const rows = planCookies(cookies, payload.text, context, payload.conflict);
    let imported = 0,
      skipped = 0;
    for (const { item, action } of rows) {
      if (action === "skip") {
        skipped++;
        continue;
      }
      const { original, ...input } = item;
      const value = {
        ...input,
        session: input.expirationDate === undefined,
        storeId: "0",
      } as chrome.cookies.Cookie;
      if (original) cookies[cookies.indexOf(original)] = value;
      else cookies.push(value);
      imported++;
    }
    localStorage.setItem(`${key}-cookies`, JSON.stringify(cookies));
    return { cookies, imported, skipped, failed: [] };
  } else if (type === "SAVE_RULE") {
    if (
      payload.environmentId &&
      payload.environmentId !== config.activeEnvironmentId
    )
      throw new Error("环境已切换，请重新打开规则编辑");
    const rule: Rule = {
      ...payload,
      environmentId: config.activeEnvironmentId,
      id: payload.id || crypto.randomUUID(),
    };
    const index = config.rules.findIndex((r) => r.id === rule.id);
    if (index < 0) config.rules.push(rule);
    else config.rules[index] = rule;
  } else if (type === "ENVIRONMENT")
    config = updateEnvironment(config, payload);
  else if (type === "TOGGLE_ALL") config.enabled = payload;
  else if (type === "TOGGLE_RULE") {
    const r = activeRules(config).find((r) => r.id === payload);
    if (r) r.enabled = !r.enabled;
  } else if (type === "DELETE_RULE")
    config.rules = config.rules.filter((r) => r.id !== payload);
  else if (type === "WRITE_COOKIE") {
    const c = {
      ...payload.input,
      session: !payload.input.expirationDate,
      storeId: "0",
    };
    const i = cookies.findIndex(
      (k) => k.name === c.name && k.domain === c.domain && k.path === c.path,
    );
    if (i < 0) cookies.push(c);
    else cookies[i] = c;
  } else if (type === "DELETE_COOKIE")
    cookies = cookies.filter(
      (c) =>
        !(
          c.name === payload.cookie.name &&
          c.domain === payload.cookie.domain &&
          c.path === payload.cookie.path
        ),
    );
  if (type === "WRITE_COOKIE" || type === "DELETE_COOKIE") {
    localStorage.setItem(`${key}-cookies`, JSON.stringify(cookies));
    return cookies;
  }
  config = validateConfig(config);
  localStorage.setItem(key, JSON.stringify(config));
  return state();
}
export async function request<T>(type: string, payload?: unknown): Promise<T> {
  if (preview) return previewRequest(type, payload);
  const result = await chrome.runtime.sendMessage({ type, payload });
  if (!result?.ok)
    throw new Error(result?.error || "后台未响应，请在扩展管理页重新加载插件");
  return result.data;
}
