import {
  activeRules,
  type Config,
  type Context,
  type CookieInput,
  type Rule,
  type RuleKind,
} from "./types";
import { validateConfig, validateRule } from "./rules";
import { validateCookieInput } from "./cookies";
export type TransferTarget = RuleKind | "site";
export interface ImportOptions {
  target: TransferTarget;
  conflict: "skip" | "replace";
  scope: "global" | "domain";
  pattern: string;
  operation: "set" | "append";
}
export interface ImportRequest extends ImportOptions {
  text: string;
  environmentId: string;
  expected: string;
  url?: string;
}
export interface ImportRow<T> {
  item: T;
  action: "add" | "replace" | "skip";
}
export const MAX_IMPORT_BYTES = 1024 * 1024;
function read(text: string): unknown {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > MAX_IMPORT_BYTES
  )
    throw new Error("内容不能超过 1 MB");
  const clean = text.replace(/^\uFEFF/, "").trim();
  if (!clean) throw new Error("请粘贴内容或选择文件");
  if (/^[\[{]/.test(clean)) {
    try {
      return JSON.parse(clean);
    } catch {
      throw new Error("JSON 格式不正确，请检查逗号和引号");
    }
  }
  return clean;
}
const record = (v: any): v is Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v);
function collection(value: any, field: "rules" | "cookies"): unknown {
  if (record(value) && "format" in value) {
    if (value.format !== `request-helper.${field}` || value.version !== 1)
      throw new Error("文件类型或版本不匹配，请选择对应的导入页");
    return value[field];
  }
  return value;
}
function pairs(text: string): { name: string; value: string }[] {
  return text
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/;\s*$/, "")
    .split(";")
    .map((part) => {
      const i = part.indexOf("=");
      if (i <= 0) throw new Error("Cookie 应为 name=value; other=value");
      return { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() };
    });
}
const ruleIdentity = (r: Rule) =>
  JSON.stringify([
    r.kind,
    r.key.toLowerCase(),
    r.scope,
    r.pattern,
    r.scope === "domain" && r.includeSubdomains,
  ]);
export const cookieIdentity = (
  c: Pick<CookieInput, "name" | "domain" | "path" | "partitionKey">,
) =>
  JSON.stringify([
    c.name,
    c.domain.replace(/^\./, "").toLowerCase(),
    c.path,
    c.partitionKey?.topLevelSite || "",
    !!c.partitionKey?.hasCrossSiteAncestor,
  ]);
export const ruleSnapshot = (c: Config) =>
  JSON.stringify([c.activeEnvironmentId, activeRules(c)]);
export const cookieSnapshot = (cookies: chrome.cookies.Cookie[]) =>
  JSON.stringify(
    [...cookies].sort((a, b) =>
      cookieIdentity(a).localeCompare(cookieIdentity(b)),
    ),
  );
function checkCount(items: unknown[]): void {
  if (!items.length || items.length > 500) throw new Error("每次导入 1–500 条");
}
export function parseRules(text: string, options: ImportOptions): Rule[] {
  let data = collection(read(text), "rules");
  if (typeof data === "string") {
    if (options.target === "cookie")
      data = [
        {
          key: "Cookie",
          value: pairs(data)
            .map((p) => `${p.name}=${p.value}`)
            .join("; "),
        },
      ];
    else
      data = data
        .split(/\r?\n/)
        .filter((s) => s.trim())
        .map((line, index) => {
          const i = line.indexOf(":");
          if (i <= 0) throw new Error(`第 ${index + 1} 行应为 Header 名称: 值`);
          return {
            key: line.slice(0, i).trim(),
            value: line.slice(i + 1).trim(),
          };
        });
  } else if (record(data) && !Array.isArray(data))
    data = Object.entries(data).map(([key, value]) => ({ key, value }));
  if (!Array.isArray(data))
    throw new Error("请输入 Header 文本、JSON 对象或规则数组");
  checkCount(data);
  const seen = new Set<string>();
  return data.map((input, index) => {
    if (!record(input)) throw new Error(`第 ${index + 1} 条规则格式无效`);
    if (input.kind && input.kind !== options.target)
      throw new Error("规则类型不匹配，请切换到对应的标签页导入");
    const rule = validateRule({
      id: `import-${index}`,
      kind: options.target as RuleKind,
      key: input.key ?? input.name,
      value: input.value,
      enabled: input.enabled ?? true,
      scope: input.scope ?? options.scope,
      pattern: input.pattern ?? options.pattern,
      includeSubdomains: input.includeSubdomains ?? true,
      operation: input.operation ?? options.operation,
    });
    const identity = ruleIdentity(rule);
    if (seen.has(identity))
      throw new Error(`导入内容中存在重复规则：${rule.key}`);
    seen.add(identity);
    return rule;
  });
}
export function planRules(
  config: Config,
  text: string,
  options: ImportOptions,
): ImportRow<Rule>[] {
  return parseRules(text, options).map((item) => {
    const existing = activeRules(config).find(
      (r) => ruleIdentity(r) === ruleIdentity(item),
    );
    return {
      item: {
        ...item,
        ...(existing ? { id: existing.id } : {}),
        environmentId: config.activeEnvironmentId,
      },
      action: existing
        ? options.conflict === "replace"
          ? "replace"
          : "skip"
        : "add",
    };
  });
}
export function importRules(config: Config, payload: ImportRequest): Config {
  if (
    payload.environmentId !== config.activeEnvironmentId ||
    payload.expected !== ruleSnapshot(config)
  )
    throw new Error("环境或规则已变化，请返回列表后重新导入");
  validateOptions(payload);
  const rows = planRules(config, payload.text, payload);
  for (const row of rows) {
    if (row.action === "skip") continue;
    if (row.action === "add")
      config.rules.push({ ...row.item, id: crypto.randomUUID() });
    else
      config.rules[config.rules.findIndex((r) => r.id === row.item.id)] =
        row.item;
  }
  return validateConfig(config);
}
export function validateOptions(options: ImportOptions): void {
  if (
    !options ||
    !["header", "cookie", "site"].includes(options.target) ||
    !["skip", "replace"].includes(options.conflict) ||
    !["global", "domain"].includes(options.scope) ||
    !["set", "append"].includes(options.operation)
  )
    throw new Error("导入选项无效");
}
export function parseCookies(text: string, context: Context): CookieInput[] {
  let data = collection(read(text), "cookies");
  if (typeof data === "string") data = pairs(data);
  if (!Array.isArray(data)) throw new Error("请输入 Cookie 字符串或 JSON 数组");
  checkCount(data);
  const seen = new Set<string>();
  return data.map((v, index) => {
    if (!record(v) || typeof v.name !== "string" || typeof v.value !== "string")
      throw new Error(`第 ${index + 1} 条 Cookie 需要 name 和 value`);
    for (const flag of ["hostOnly", "secure", "httpOnly", "session"])
      if (v[flag] !== undefined && typeof v[flag] !== "boolean")
        throw new Error(`第 ${index + 1} 条的 ${flag} 必须为布尔值`);
    if (
      (v.domain !== undefined && typeof v.domain !== "string") ||
      (v.path !== undefined && typeof v.path !== "string")
    )
      throw new Error(`第 ${index + 1} 条 Domain 或 Path 格式无效`);
    if (
      v.partitionKey !== undefined &&
      (!record(v.partitionKey) ||
        typeof v.partitionKey.topLevelSite !== "string" ||
        (v.partitionKey.hasCrossSiteAncestor !== undefined &&
          typeof v.partitionKey.hasCrossSiteAncestor !== "boolean"))
    )
      throw new Error("Cookie 分区信息无效");
    const item: CookieInput = {
      name: v.name,
      value: v.value,
      domain: v.domain ?? context.hostname,
      path: v.path ?? "/",
      hostOnly: v.hostOnly ?? !v.domain?.startsWith("."),
      secure: v.secure ?? context.url.startsWith("https:"),
      httpOnly: v.httpOnly ?? false,
      sameSite: v.sameSite ?? "lax",
      expirationDate: v.session === true ? undefined : v.expirationDate,
      ...(v.partitionKey
        ? {
            partitionKey: {
              topLevelSite: v.partitionKey.topLevelSite,
              ...(v.partitionKey.hasCrossSiteAncestor === undefined
                ? {}
                : {
                    hasCrossSiteAncestor: v.partitionKey.hasCrossSiteAncestor,
                  }),
            },
          }
        : {}),
    };
    validateCookieInput(context, item);
    const key = cookieIdentity(item);
    if (seen.has(key))
      throw new Error(
        `导入内容中存在同名且相同 Domain / Path 的 Cookie：${item.name}`,
      );
    seen.add(key);
    return item;
  });
}
export function planCookies(
  cookies: chrome.cookies.Cookie[],
  text: string,
  context: Context,
  conflict: "skip" | "replace",
): ImportRow<CookieInput>[] {
  const plain = typeof collection(read(text), "cookies") === "string";
  return parseCookies(text, context).map((item) => {
    const existing = cookies.find(
      (c) => cookieIdentity(c) === cookieIdentity(item),
    );
    if (
      existing &&
      !plain &&
      conflict === "replace" &&
      existing.hostOnly !== item.hostOnly
    )
      throw new Error(
        `${item.name} 的主机范围与已有 Cookie 不同，请先在列表中处理`,
      );
    const planned: CookieInput = {
      ...item,
      ...(existing && plain
        ? {
            hostOnly: existing.hostOnly,
            secure: existing.secure,
            httpOnly: existing.httpOnly,
            sameSite: existing.sameSite,
            expirationDate: existing.expirationDate,
          }
        : {}),
      ...(existing ? { domain: existing.domain, original: existing } : {}),
    };
    if (conflict === "replace") validateCookieInput(context, planned);
    return {
      item: planned,
      action: existing ? (conflict === "replace" ? "replace" : "skip") : "add",
    };
  });
}
export function exportRules(config: Config, kind: RuleKind): string {
  return JSON.stringify(
    {
      format: "request-helper.rules",
      version: 1,
      environment: config.environments.find(
        (e) => e.id === config.activeEnvironmentId,
      )?.name,
      rules: activeRules(config)
        .filter((r) => r.kind === kind)
        .map(({ id, environmentId, ...r }) => r),
    },
    null,
    2,
  );
}
export function exportCookies(cookies: chrome.cookies.Cookie[]): string {
  return JSON.stringify(
    {
      format: "request-helper.cookies",
      version: 1,
      cookies: cookies.map(({ storeId, ...c }) => c),
    },
    null,
    2,
  );
}
