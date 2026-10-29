import { defineConfig } from "wxt";
export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  manifest: {
    name: "请求助手",
    version: "2.1.0",
    minimum_chrome_version: "132",
    description: "管理请求 Header、请求 Cookie 与网站 Cookie，配置保存在本机。",
    permissions: ["storage", "declarativeNetRequest", "cookies", "activeTab"],
    host_permissions: ["http://*/*", "https://*/*"],
    action: { default_title: "请求助手" },
    icons: {
      16: "/icons/icon-16.png",
      48: "/icons/icon-48.png",
      128: "/icons/icon-128.png",
    },
  },
});
