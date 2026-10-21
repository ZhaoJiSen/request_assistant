import { currentContext, listCookies, writeCookie } from "./cookies";
import {
  cookieIdentity,
  cookieSnapshot,
  planCookies,
  validateOptions,
  type ImportRequest,
} from "./transfer";
import type { CookieInput } from "./types";
export interface CookieImportResult {
  cookies: chrome.cookies.Cookie[];
  imported: number;
  skipped: number;
  failed: { name: string; error: string; input: CookieInput }[];
}
export async function importCookies(
  api: typeof chrome,
  payload: ImportRequest,
): Promise<CookieImportResult> {
  validateOptions(payload);
  if (payload.target !== "site") throw new Error("Cookie 导入类型无效");
  const context = await currentContext(api);
  if (!context || context.url !== payload.url)
    throw new Error("当前网站已变化，请重新打开插件");
  const cookies = await listCookies(api, context);
  if (cookieSnapshot(cookies) !== payload.expected)
    throw new Error("网站 Cookie 已变化，请返回列表后重新导入");
  const rows = planCookies(cookies, payload.text, context, payload.conflict);
  const result: CookieImportResult = {
    cookies: [],
    imported: 0,
    skipped: 0,
    failed: [],
  };
  // The browser Cookie API is not transactional. Validate everything first and report each write.
  for (const { item, action } of rows) {
    if (action === "skip") {
      result.skipped++;
      continue;
    }
    try {
      const now = await currentContext(api);
      if (!now || now.url !== context.url || now.storeId !== context.storeId)
        throw new Error("当前网站已变化，请返回原网站后重试");
      if (
        !item.original &&
        (await listCookies(api, context)).some(
          (c) => cookieIdentity(c) === cookieIdentity(item),
        )
      )
        throw new Error("此 Cookie 刚被网站创建，请重新预览后处理");
      await writeCookie(api, context, item);
      result.imported++;
    } catch (e) {
      const { original, ...input } = item;
      result.failed.push({
        name: item.name,
        error:
          e instanceof Error
            ? /failed to parse or set cookie/i.test(e.message)
              ? "浏览器拒绝写入，请检查 Domain、大小和 Cookie 属性"
              : e.message
            : "写入失败",
        input,
      });
    }
  }
  result.cookies = await listCookies(api, context);
  return result;
}
