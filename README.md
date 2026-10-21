# 请求助手

一个中文 Chrome 插件，集中管理请求 Header、请求 Cookie 和浏览器中保存的网站 Cookie。

## 直接安装

无需安装 Node.js，也不需要运行开发命令。Chrome 版本需为 **132 或更新版本**。

1. 先停用旧版插件，避免两个插件重复修改同一个请求。
2. 打开 `chrome://extensions/`，开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目里的 **`chrome-extension` 文件夹**，不是整个项目目录。
4. 在工具栏固定 请求助手，打开需要调试的网站后点击插件图标。

源码、依赖、截图和测试均不需要提交给 Chrome。安装后请保留 `chrome-extension` 目录，不要移动它；移动后需要重新加载。

## 三种能力

| 页签        | 行为                                                       | 持续时间                                               |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Header      | 按全局或请求目标域名设置请求头；同名网站规则优先于全局规则 | 规则保存到本机，浏览器重启后仍保留                     |
| 请求 Cookie | 替换整段 Cookie 头，或者追加 Cookie 内容                   | 仅影响后续匹配请求，不修改浏览器保存的 Cookie          |
| 网站 Cookie | 查看当前网站及父域的 Cookie，写入、编辑、删除              | 实际修改浏览器 Cookie；会话/到期时间由 Cookie 属性决定 |

点击条目或铅笔按钮编辑；眼睛按钮显示/隐藏敏感值；删除前有二次确认。Header 值允许为空。

顶部总开关只暂停 **Header 与请求 Cookie 注入**，不会撤销已写入的网站 Cookie。停用单条规则只改变其后续注入行为。

### 域名匹配

- 匹配的是**请求 URL**，例如页面位于 `localhost:5173`，API 位于 `api.company.test`，应将 API 域名填为规则目标。
- 新增规则默认填入当前页面主机，可手动改成实际 API 主机。
- 输入普通域名或网址即可；粘贴网址时只取主机，忽略路径和查询参数。
- 可选择包含子域名；填写端口时只匹配该端口，不填写时匹配任意端口。
- 同名 `set` 规则按具体程度处理：全局 < 旧版域名正则 < 指定网站；更具体的域名优先；相同主机的精确匹配优先于包含子域名。
- 「N 条匹配」由当前页面 URL 推算，是匹配配置数量，**不是请求命中次数**。跨域 API 是否匹配应以该 API 的 URL 和 DevTools Network 中的请求头为准。
- 修改规则只影响后续请求。已经发出的请求不会改变，页面或 Service Worker 缓存中的响应也不会因此重新请求。

### Cookie 细节

- 请求 Cookie 的「替换整段」会覆盖原 Cookie 头；「追加」保留原内容并追加，**不会按 Cookie 名称去重**。同名覆盖需求使用「替换整段」或编辑网站 Cookie。
- 网站 Cookie 包含 Domain、Path、Secure、HttpOnly、SameSite 和到期时间。到期时间留空为会话 Cookie。
- 编辑时锁定名称、Domain 和 Path，避免误生成第二条 Cookie。需要更改这些字段时新建一条，再删除原条目。
- 读取当前标签所在 Cookie store；可查看和编辑该网站分区中的已有 Cookie，保留其 partitionKey。新建的是普通非分区 Cookie。
- 浏览器会继续执行 Cookie 前缀、Secure、SameSite、公共后缀和第三方 Cookie 策略等约束；界面写入失败时保留输入并显示原因。
- 网站自身可能再次覆盖 Cookie；插件在 Cookie 变化时重新读取列表。
- 若同名、不同 Domain 的 Cookie 无法通过 Chrome 删除 API 唯一定位，插件会拒绝删除，防止误删其他项。
- 不支持在 `chrome://`、扩展管理页等非 HTTP/HTTPS 页面操作网站 Cookie。

## 本地开发

技术栈：Vue 3、TypeScript、WXT / Vite、Lucide 图标。控件是项目内样式，没有引入整套后台组件库。

需要 **Node.js 22.12+**（推荐 Node.js 24 LTS）。系统默认 Node 若低于该版本，请先切换版本。

```sh
npm install
npm run dev
```

常用命令：

```sh
npm run typecheck       # TypeScript / Vue 类型检查
npm test               # 规则、事务回滚、并发、Cookie 测试
npm run package:local  # 生成可直接加载的 chrome-extension 目录
npm run test:popup      # 从真实工具栏入口验证弹窗自动尺寸
npm run test:browser    # 隔离 Chrome + 本机测试网站，验证真实请求
npm run preview        # 仅开发用 UI 预览，使用独立的虚构配置
```

`test:browser` 默认使用 macOS 的 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`；其他平台通过 `CHROME_PATH` 指定可执行文件。测试创建临时 profile，不使用个人浏览器数据。

预览中的虚构配置不会进入正式插件。正式插件首次安装为空，使用真实 Chrome API；开发预览可通过 `?state=request`、`?state=cookies`、`?state=empty` 查看状态，通过 `?fail=1` 检查失败后输入保留。

## 目录

```text
entrypoints/background.ts   消息路由和后台生命周期
entrypoints/popup/          Vue 弹窗和统一样式
lib/rules.ts                规则验证、域名匹配和 DNR 编译
lib/controller.ts           串行修改、保存失败回滚、启动恢复
lib/cookies.ts              真实 Cookie 查询、写入、删除
lib/client.ts               类型化 UI 通信和独立开发预览
tests/                      逻辑测试和隔离 Chrome 端到端测试
chrome-extension/           直接加载到 Chrome 的成品
docs/                       设计、评审和验证记录
evidence/                   页面截图、录像、浏览器验证报告
```

## 数据与升级

配置仅存于 `chrome.storage.local`，不上传到服务器。插件需要所有 HTTP/HTTPS 网站访问权限，以支持用户显式配置的全局注入；`cookies` 权限用于真实网站 Cookie 读写，`activeTab` 用于当前网站上下文。

后台串行处理配置修改；Chrome 的 DNR 更新是原子操作，但 DNR 与 storage 不是同一个事务。插件使用 pending 标记和失败回滚，并在后台启动时以已提交配置恢复规则；恢复失败会显示同步异常，不宣称已成功生效。

只有在**相同扩展 ID** 下升级时才能读取旧版的 `headers` 数据；迁移保留原数据和备份，并保留旧版正则语义。新文件夹通常具有新的扩展 ID，因此本次独立安装不会自动读取另一个插件的数据，需要重新配置。原项目文件和旧插件数据均未修改。

独立设计评审及实测结果见 `docs/VERIFICATION.md`。


## 环境配置组

顶部下拉切换当前环境，右侧管理按钮可新建、复制、重命名与删除环境。新建从空白开始，复制得到独立规则，创建后立即切换。Header 和请求 Cookie 随组切换，网站 Cookie 不随组改动。总开关暂停后，切换环境也保持暂停。

更新后原有规则会自动归入“默认环境”，保留原 ID、启用状态和内容。迁移前配置备份在本机扩展存储中。至少保留一个环境；最多 30 个环境，全部环境共 500 条规则。

专项验证：现代 Node 下运行 `node --import tsx --test tests/environments.test.ts`、`node tests/environment-browser.mjs`；原有浏览器回归与原生弹窗检查继续适用。所有选择菜单均在扩展内渲染，不依赖系统原生 select。


### 批量导入与导出

三个标签页右上角均提供“导入 / 导出”。导入支持直接粘贴或选择 JSON / TXT 文件，先解析、检查新增/覆盖/跳过，再确认写入。

- **Header**：每行 `X-Environment: staging`；也支持 `{ "X-Environment": "staging" }` 或插件导出的规则 JSON。
- **请求 Cookie**：粘贴 `tenant=shanghai; debug=1` 或 `Cookie: tenant=shanghai; debug=1`；也支持规则 JSON。它只修改请求头。
- **网站 Cookie**：粘贴 Cookie 字符串，或导入 Chrome Cookie 数组/插件导出的 Cookie JSON。JSON 会保留 Cookie 属性；字符串覆盖同一项时保留已有属性，新建项使用当前主机与 `/`。
- 默认跳过已有项，选“覆盖”才修改现有值。规则重复判断包含生效范围；网站 Cookie 包含名称、Domain、Path 与分区。一次最多 500 条，输入/文件最大 1 MB。
- 规则只操作当前环境；网站 Cookie 与环境无关。导出当前标签的全部内容，不受搜索筛选影响，规则包括已停用项。
- 导出支持复制或下载 JSON，可再次导入。包含明文 Cookie / Token，请妥善保管。
- 网站 Cookie 由浏览器逐条写入，部分拒绝时会显示具体结果并保留失败项，修改后可再次预览重试。

本轮验证详见 [导入导出验证](evidence/import-export/VERIFICATION.md)。
