import type { Config, Rule } from "./types";
import { activeRules, DEFAULT_ENVIRONMENT_ID, emptyConfig } from "./types";
const TOKEN = /^[!#$%&'*+.^_`|~\w-]+$/;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function normalizeHost(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname
  )
    throw new Error("请输入有效的 HTTP / HTTPS 域名");
  return url.host.toLowerCase();
}
export function validateRule(input: Rule): Rule {
  if (!input || !["header", "cookie"].includes(input.kind))
    throw new Error("规则类型无效");
  if (!["global", "domain", "regex"].includes(input.scope))
    throw new Error("请选择生效范围");
  if (
    typeof input.key !== "string" ||
    typeof input.value !== "string" ||
    typeof input.pattern !== "string"
  )
    throw new Error("规则内容无效");
  const rule = {
    ...input,
    key: input.kind === "cookie" ? "Cookie" : input.key.trim(),
    enabled: !!input.enabled,
    includeSubdomains: !!input.includeSubdomains,
  };
  if (!TOKEN.test(rule.key))
    throw new Error("Header 名称只能包含字母、数字和合法符号");
  if (/[\r\n\0]/.test(rule.value)) throw new Error("值不能包含换行或空字符");
  if (rule.value.length > 16000)
    throw new Error("值过长，请限制在 16,000 字符以内");
  if (rule.kind === "header" && rule.key.toLowerCase() === "cookie")
    throw new Error("请在「请求 Cookie」中管理 Cookie 头");
  if (rule.kind === "header") rule.operation = "set";
  else {
    if (!["set", "append"].includes(rule.operation))
      throw new Error("请选择 Cookie 注入方式");
    if (
      !rule.value.trim() ||
      !rule.value.split(";").every((part) => {
        const i = part.indexOf("=");
        return i > 0 && TOKEN.test(part.slice(0, i).trim());
      })
    )
      throw new Error("Cookie 格式应为 name=value; other=value");
  }
  if (rule.scope === "domain") {
    if (!rule.pattern.trim()) throw new Error("请输入生效域名");
    rule.pattern = normalizeHost(rule.pattern.trim());
  } else if (rule.scope === "regex") {
    if (
      !rule.pattern.trim() ||
      rule.pattern.length > 1000 ||
      /[^\x00-\x7F]/.test(rule.pattern)
    )
      throw new Error("旧版正则必须为 ASCII 字符且不超过 1,000 字符");
    try {
      new RegExp(`^https?://${rule.pattern}/`);
    } catch {
      throw new Error("域名正则格式无效");
    }
  } else rule.pattern = "";
  return rule;
}
export function validateConfig(config: Config): Config {
  if (
    !config ||
    config.version !== 2 ||
    !Array.isArray(config.rules) ||
    config.rules.length > 500
  )
    throw new Error("配置无效或规则超过 500 条");
  const environments =
    config.environments === undefined
      ? emptyConfig().environments
      : config.environments;
  if (
    !Array.isArray(environments) ||
    !environments.length ||
    environments.length > 30
  )
    throw new Error("环境数量应为 1–30 个");
  const names = new Set<string>();
  const ids = new Set<string>();
  const normalizedEnvironments = environments.map((env) => {
    if (
      !env ||
      typeof env.id !== "string" ||
      !env.id ||
      env.id.length > 100 ||
      typeof env.name !== "string"
    )
      throw new Error("环境配置无效");
    const name = env.name.trim();
    if (!name || name.length > 24) throw new Error("环境名称需为 1–24 个字符");
    if (ids.has(env.id) || names.has(name.toLowerCase()))
      throw new Error("环境名称或标识重复");
    ids.add(env.id);
    names.add(name.toLowerCase());
    return { id: env.id, name };
  });
  const activeEnvironmentId =
    config.activeEnvironmentId || DEFAULT_ENVIRONMENT_ID;
  if (!ids.has(activeEnvironmentId)) throw new Error("当前环境不存在");
  const rules = config.rules.map((input) => {
    const rule = validateRule({
      ...input,
      environmentId: input.environmentId || DEFAULT_ENVIRONMENT_ID,
    });
    if (!ids.has(rule.environmentId!)) throw new Error("规则所属环境不存在");
    return rule;
  });
  if (new Set(rules.map((r) => r.id)).size !== rules.length)
    throw new Error("规则标识重复");
  const seen = new Set<string>();
  for (const rule of rules) {
    const identity = `${rule.environmentId}|${rule.kind}|${rule.key.toLowerCase()}|${rule.scope}|${rule.pattern}|${rule.scope === "domain" ? rule.includeSubdomains : ""}`;
    if (seen.has(identity))
      throw new Error(`相同范围已有 ${rule.key}，请编辑已有规则`);
    seen.add(identity);
  }
  return {
    version: 2,
    enabled: !!config.enabled,
    rules,
    environments: normalizedEnvironments,
    activeEnvironmentId,
  };
}
export function ruleRegex(rule: Rule): string {
  if (rule.scope === "global") return "^https?://";
  if (rule.scope === "regex") return `^https?://${rule.pattern}/`;
  const url = new URL(`https://${rule.pattern}`);
  const subdomains =
    rule.includeSubdomains &&
    !url.hostname.includes(":") &&
    !/^[\d.]+$/.test(url.hostname)
      ? "(?:[^/:]+\\.)*"
      : "";
  return `^https?://${subdomains}${escapeRegex(url.hostname)}${url.port ? `:${url.port}` : "(?::[0-9]+)?"}/`;
}
export function compileRules(
  config: Config,
): chrome.declarativeNetRequest.Rule[] {
  if (!config.enabled) return [];
  return activeRules(config).flatMap((rule, index) =>
    rule.enabled
      ? [
          {
            id: index + 1,
            priority:
              rule.scope === "global"
                ? 1
                : rule.scope === "regex"
                  ? 500
                  : 1000 +
                    rule.pattern.length * 2 +
                    (rule.includeSubdomains ? 0 : 1),
            action: {
              type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
              requestHeaders: [
                {
                  header: rule.key.toLowerCase(),
                  operation:
                    rule.operation as chrome.declarativeNetRequest.HeaderOperation,
                  value: rule.value,
                },
              ],
            },
            condition: {
              regexFilter: ruleRegex(rule),
              isUrlFilterCaseSensitive: false,
              resourceTypes: [
                "main_frame",
                "sub_frame",
                "stylesheet",
                "script",
                "image",
                "font",
                "object",
                "xmlhttprequest",
                "ping",
                "csp_report",
                "media",
                "websocket",
                "webtransport",
                "other",
              ] as chrome.declarativeNetRequest.ResourceType[],
            },
          },
        ]
      : [],
  );
}
export function matchesRule(rule: Rule, url: string): boolean {
  try {
    return new RegExp(ruleRegex(rule), "i").test(url);
  } catch {
    return false;
  }
}
export function migrateLegacy(headers: unknown): Config {
  const config = emptyConfig();
  if (!Array.isArray(headers)) return config;
  config.rules = headers.map((h, index) => ({
    id: typeof h.id === "string" ? h.id : `legacy-${index}`,
    environmentId: DEFAULT_ENVIRONMENT_ID,
    kind: String(h.key).toLowerCase() === "cookie" ? "cookie" : "header",
    key: String(h.key ?? ""),
    value: String(h.value ?? ""),
    enabled: h.enabled !== false,
    scope: h.type === "domain" ? "regex" : "global",
    pattern: String(h.pattern ?? ""),
    includeSubdomains: false,
    operation: "set",
  }));
  return config;
}
