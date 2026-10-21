import type { Context, CookieInput } from "./types";
const cookieId = (c: chrome.cookies.Cookie) =>
  JSON.stringify([c.name, c.domain, c.path, c.storeId, c.partitionKey]);
export function domainMatches(hostname: string, domain: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  return hostname === d || hostname.endsWith(`.${d}`);
}
export async function currentContext(
  api: typeof chrome,
): Promise<Context | null> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) return null;
  const url = new URL(tab.url);
  const stores = await api.cookies.getAllCookieStores();
  const storeId = stores.find(
    (s) => tab.id !== undefined && s.tabIds.includes(tab.id),
  )?.id;
  let partitionKey: chrome.cookies.CookiePartitionKey | undefined;
  if (tab.id !== undefined) {
    try {
      partitionKey = (
        await api.cookies.getPartitionKey({ tabId: tab.id, frameId: 0 })
      ).partitionKey;
    } catch {
      /* Browser may not expose a key for a loading tab. */
    }
  }
  return {
    url: tab.url,
    hostname: url.hostname,
    host: url.host,
    tabId: tab.id,
    storeId,
    partitionKey,
  };
}
export async function listCookies(api: typeof chrome, context: Context) {
  const base = context.storeId ? { storeId: context.storeId } : {};
  const plain = await api.cookies.getAll(base);
  const partitioned = context.partitionKey
    ? await api.cookies.getAll({ ...base, partitionKey: context.partitionKey })
    : [];
  return [
    ...new Map(
      [...plain, ...partitioned]
        .filter((c) =>
          c.hostOnly
            ? c.domain === context.hostname
            : domainMatches(context.hostname, c.domain),
        )
        .map((c) => [cookieId(c), c]),
    ).values(),
  ].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.domain.localeCompare(b.domain) ||
      a.path.localeCompare(b.path),
  );
}
function cookieUrl(
  context: Context,
  cookie: Pick<chrome.cookies.Cookie, "domain" | "secure" | "path">,
) {
  const domain = cookie.domain.replace(/^\./, "");
  if (!domainMatches(context.hostname, domain))
    throw new Error("只能操作当前网站及其父域的 Cookie");
  return `${cookie.secure ? "https:" : new URL(context.url).protocol}//${domain}${cookie.path}`;
}
export function validateCookieInput(
  context: Context,
  input: CookieInput,
): CookieInput {
  if (!input || !input.name || /[\s;=\x00-\x1F\x7F]/.test(input.name))
    throw new Error("Cookie 名称不能包含空格、分号或等号");
  if (typeof input.value !== "string" || /[;\r\n\0]/.test(input.value))
    throw new Error("Cookie 值不能包含分号、换行或空字符");
  if (!input.path?.startsWith("/") || /[\r\n\0?#]/.test(input.path))
    throw new Error("Path 必须以 / 开头，且不含查询参数或片段");
  const domain = input.domain.replace(/^\./, "").toLowerCase();
  if (!domainMatches(context.hostname, domain) || /[:/\s]/.test(domain))
    throw new Error("Domain 必须是当前网站域名或其父域");
  if (
    (/^[\d.]+$/.test(context.hostname) || context.hostname.includes(":")) &&
    domain !== context.hostname
  )
    throw new Error("IP 地址的 Cookie 必须使用完整的当前主机地址");
  if (input.hostOnly && domain !== context.hostname)
    throw new Error("仅当前主机的 Cookie 必须使用当前网站域名");
  if (
    !["unspecified", "lax", "strict", "no_restriction"].includes(input.sameSite)
  )
    throw new Error("SameSite 无效");
  if (input.sameSite === "no_restriction" && !input.secure)
    throw new Error("SameSite=None 需要勾选 Secure");
  if (input.secure && new URL(context.url).protocol !== "https:")
    throw new Error("请在 HTTPS 页面写入 Secure Cookie");
  if (
    input.expirationDate !== undefined &&
    (!Number.isFinite(input.expirationDate) ||
      input.expirationDate <= Date.now() / 1000)
  )
    throw new Error("到期时间必须晚于当前时间");
  if (input.name.startsWith("__Secure-") && !input.secure)
    throw new Error("__Secure- Cookie 必须启用 Secure");
  if (
    input.name.startsWith("__Host-") &&
    (!input.secure || !input.hostOnly || input.path !== "/")
  )
    throw new Error("__Host- Cookie 必须启用 Secure、仅当前主机且 Path 为 /");
  if (input.partitionKey) {
    if (
      !input.secure ||
      !context.partitionKey ||
      input.partitionKey.topLevelSite !== context.partitionKey.topLevelSite ||
      !!input.partitionKey.hasCrossSiteAncestor !==
        !!context.partitionKey.hasCrossSiteAncestor
    )
      throw new Error("分区 Cookie 只能导入原分区的 HTTPS 网站");
  }
  return input;
}
export async function writeCookie(
  api: typeof chrome,
  context: Context,
  input: CookieInput,
) {
  validateCookieInput(context, input);
  const domain = input.domain.replace(/^\./, "").toLowerCase();
  if (input.original) {
    const original = (await listCookies(api, context)).find(
      (c) => cookieId(c) === cookieId(input.original!),
    );
    if (!original) throw new Error("此 Cookie 已被网站移除，请刷新列表");
    if (
      input.name !== original.name ||
      input.domain !== original.domain ||
      input.path !== original.path ||
      input.hostOnly !== original.hostOnly
    )
      throw new Error(
        "编辑时不能更改 Cookie 的名称、Domain 或 Path，请新建 Cookie",
      );
    if (original.value !== input.original.value)
      throw new Error("Cookie 已被网站更新，请刷新后再编辑");
  }
  const result = await api.cookies.set({
    url: cookieUrl(context, { domain, secure: input.secure, path: input.path }),
    name: input.name,
    value: input.value,
    path: input.path,
    secure: input.secure,
    httpOnly: input.httpOnly,
    sameSite: input.sameSite as chrome.cookies.SameSiteStatus,
    ...(input.hostOnly ? {} : { domain: input.domain }),
    ...(context.storeId ? { storeId: context.storeId } : {}),
    ...(input.expirationDate !== undefined
      ? { expirationDate: input.expirationDate }
      : {}),
    ...(input.original?.partitionKey || input.partitionKey
      ? { partitionKey: input.original?.partitionKey || input.partitionKey }
      : {}),
  });
  if (!result) throw new Error("浏览器未写入 Cookie，请检查域名、前缀和权限");
  const found = (await listCookies(api, context)).find(
    (c) => cookieId(c) === cookieId(result),
  );
  if (!found || found.value !== input.value)
    throw new Error("Cookie 写入后未能读回，请刷新检查网站是否覆盖了它");
  return found;
}
export async function removeCookie(
  api: typeof chrome,
  context: Context,
  cookie: chrome.cookies.Cookie,
) {
  const details = {
    url: cookieUrl(context, cookie),
    name: cookie.name,
    storeId: context.storeId,
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
  const selected = await api.cookies.get(details);
  if (!selected || cookieId(selected) !== cookieId(cookie))
    throw new Error(
      "存在同名且匹配更优先的 Cookie，请先处理该 Cookie 后再删除此项",
    );
  const removed = await api.cookies.remove(details);
  if (!removed) throw new Error("Cookie 已不存在，请刷新列表");
  if (
    (await listCookies(api, context)).some(
      (c) => cookieId(c) === cookieId(cookie),
    )
  )
    throw new Error("Cookie 仍存在，可能被网站重新写入，请刷新检查");
}
