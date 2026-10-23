# 🌐 Cloud Gateway (统一云服务聚合门户与高性能子路径反向代理)

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.19-000000?style=flat-square&logo=express)](https://expressjs.com/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

**Cloud Gateway** 是一套专为单域名/单公网 IP 环境打造的高性能**二级子路径反向代理与统一云聚合门户**。

它可以将 Next.js、React SPA、Vue Router、Web 终端与 WebSocket 服务等应用挂载到管理员配置的二级子路径，帮助处理静态资源路径、重定向、会话隔离与跨服务路由问题。

---

## ✨ 核心特性

- 🚀 **响应重写引擎 (`lib/text-rewriter.js`)**
  - 覆盖 HTML / SVG / CSS / JavaScript / JSON / Next.js RSC (`text/x-component`) 全谱系文本响应；
  - 补全 `href` / `src` / `action` / `poster` / `formaction` / `srcset` / `data-*` 属性、`<style>` 与内联 `style` 中的 `url()`、`@import`、`<meta http-equiv="refresh">`、内联脚本与 RSC 载荷中的裸路径；
  - 前端路由自成体系的应用额外补全 `basename`、`createWebHistory`、`serviceWorker.register`、`new Worker`、webpack `publicPath` 与 `sourceMappingURL`。
- **Service Worker 应用隔离**
  - HTML 在应用脚本之前约束原生注册入口，覆盖 Workbox 包装、变量与模板字符串；脚本 URL、显式 scope 均收敛到所属挂载点，独立于 `injectBase` 与深度补全开关。
  - Worker 安装请求必须携带显式应用路径；`Service-Worker-Allowed` 限定为该应用目录，主 Worker 内的根预缓存与导航回退一并补前缀。超限或非脚本响应拒绝安装，不作不安全透传。
  - 根 `/sw.js` 固定提供旧注册退休脚本；门户与应用加载 `/__gw/sw-recovery.js` 定向注销旧根注册，仅删除对应根 Workbox 预缓存，保留 Cookie、localStorage、其他应用注册与缓存。
- 🗜️ **压缩协商与再压缩**
  - 不再强制上游返回未压缩内容：解压 → 重写 → 按客户端 `Accept-Encoding` 重新压缩（gzip / br / deflate），并拒绝向无法解码的编码（如 zstd）发起协商；
  - 未发生改写的响应按原始字节透传，零额外 CPU 与缓存破坏。
- 🍪 **Cookie 归一化**
  - 一律剥离 `Domain`（避免浏览器因域名不匹配直接丢弃 Cookie 导致"登录后又退出"）；
  - 可选把 `Path=/` 收敛到子目录，杜绝同域多应用同名 Cookie 互相覆盖；
  - 自动补齐 `SameSite`，并在 `SameSite=None` 场景补 `Secure`。
- 🔀 **跳转标头统一收敛与环路保护**
  - `Location` / `Refresh` / `Link` / `x-nextjs-redirect` 四类标头同时处理，覆盖根相对、协议相对（`//host/x`）、上游绝对地址三种形态；
  - 上游把请求重定向回它自己时（GET/HEAD）返回 508，避免浏览器陷入无限重定向。
- 🧠 **声明式 + 自学习签名路由 (`lib/proxy-engine.js`)**
  - 归属判定四级递进：显式子路径 → `Referer` 上下文 → 签名路由（声明式 + 自学习）→ 会话 Cookie；
  - 自学习：从文档引用与已服务请求中自动归纳应用的根路径（如 `/_next`、`/assets`、`/api`），新应用**无需改代码**即可避免根路径请求脱轨；
  - 多个应用声明同一根路径时**不猜测**，回落到 Referer / Cookie 判定，杜绝同域踩踏。
- ⚡ **缓存语义修正**
  - `/_next/static`、`*.js`、字体、图片等静态资源保留上游强缓存（仅摘除随重写失效的 `ETag` / `Last-Modified`）；
  - HTML 与动态接口保持 `no-store`，避免网关把带会话的响应缓存给其他访问者。
- 🧱 **大响应与非 UTF-8 保护**
  - 超过阈值（`GW_MAX_REWRITE_BYTES`，默认 16 MiB）的响应原样透传，不会把内存打爆；
  - 声明为非 UTF-8 的文本（如 GBK 页面）字节原样透传，避免改写把中文变成乱码。
- 🔌 **全双工 WebSocket / PTY 终端穿透**
  - 与 HTTP 侧共用同一套归属判定与 `X-Forwarded-*` 标头，升级前剥离二级目录前缀，服务于终端、实时监控与 Socket.IO 长连接。
- 📊 **动态流量态势大屏 & 玻璃拟态门户**
  - 提供开箱即用的响应式导航首页，内置 Lucide 图标与分类标签过滤；
  - 集成**实时 QPS 与 7 日流量滑动走势图**，支持毫秒级动态跳动。
- ⚙️ **可视化管理控制台与零重启热重载**
  - 提供完备的管理员 API 与前台配置管理模态框，支持在线增删改查路由、调整显示顺序与高级代理选项；
  - 选项写入前统一白名单归一化，历史脏字段不会落盘；修改持久化于本地 `data/config.json` 并实时热重载。
- 🔒 **生产级安全防护与鉴权**
  - 管理后台采用 JWT 隔离认证，管理员密码基于 Bcrypt 加盐哈希加密；
  - SPA 兜底与 iframe 递归探测，杜绝路由缺失时的递归套娃消耗。
- 🩺 **路由诊断 (Route Doctor)**
  - 控制台点「诊断」即可对任意路由做只读体检：上游可达性、状态码、延迟、内容类型；
  - 用**与线上完全相同**的重写规则干跑一次响应体，逐条列出"哪些引用会被补全、哪些被白名单跳过"，不会出现"诊断说没事、线上却 404"的偏差；
  - 响应头体检：`Location` 补全预演、自跳转环路告警、`Set-Cookie` 的 Domain/Path/SameSite、CSP/X-Frame-Options、缓存语义；
  - 技术栈嗅探（Next.js / RSC / Vite / webpack / React Router / Vue Router / Socket.IO / Service Worker / SvelteKit / Nuxt）并给出中文可执行建议。
- 🧪 **可回归的冒烟测试**
  - `node scripts/smoke-subpath.mjs` 自带上游夹具与临时配置，逐项校验重写契约及 Worker 安装隔离边界（158 项断言），重构反代引擎时可放心回归。

---

## 🏛️ 系统架构与路由拓扑

```text
                           【客户端访问入口】
                     https://gateway.example.com
                                   │
                    ┌──────────────▼──────────────┐
                    │        Cloud Gateway        │
                    └──────────────┬──────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
       /service-a/                                /service-b/
              │                                         │
              ▼                                         ▼
  https://service-a.example.com          https://service-b.example.net
```

仓库默认不包含任何代理路由。管理员可在控制台中按实际部署添加上游服务。

---

## 🚀 快速启动

### 方式一：使用 Docker Compose (推荐)

1. **克隆项目并进入目录**：
   ```bash
   git clone https://github.com/JinghuaShang/Cloud-Gateway.git
   cd "Cloud-Gateway"
   ```

2. **准备配置文件**：
   ```bash
   cp data/config.example.json data/config.json
   ```

3. **一键启动**：
   ```bash
   docker compose up -d
   ```
   网关服务启动后，请通过部署环境中配置的监听地址访问。

### 方式二：直接使用 Node.js 运行

1. **安装依赖**：
   ```bash
   npm install
   ```

2. **初始化配置**：
   ```bash
   cp data/config.example.json data/config.json
   ```

3. **启动网关**：
   ```bash
   npm start
   # 或者开发模式 (带文件监听)
   npm run dev
   ```

---

## ⚙️ 路由配置与选项参考

配置文件位于 `data/config.json`，格式如下：

```json
{
  "siteTitle": "Cloud Gateway",
  "siteSubtitle": "统一云服务门户",
  "themeColor": "#3b82f6",
  "categories": ["全部"],
  "routes": []
}
```

添加代理路由时，请在管理员控制台中填写您自己的子路径、上游地址和转发选项；不要将本机地址、凭据或私有配置提交到仓库。

### 🎛️ 高级代理开关解析 (`options`)

| 配置项 | 类型 | 默认值 | 作用说明 |
| :--- | :--- | :--- | :--- |
| `autoSlash` | `boolean` | `true` | **自动尾部斜杠校正**：访问 `/app` 自动 301 重定向至 `/app/`，保障相对路径资源正确解析。 |
| `injectBase` | `boolean` | `true` | **HTML Base 注入**：向响应 HTML `<head>` 中动态注入 `<base href="/subpath/">` 与 history 垫片。 |
| `rewriteHtml` | `boolean` | `true` | **HTML/SVG 路径自愈**：扫描 HTML/SVG 中的根绝对引用（属性、`srcset`、`meta refresh`）补全子路径前缀。 |
| `rewriteCss` | `boolean` | `true` | **CSS 路径自愈**：补全 `<style>`、内联 `style` 与 `.css` 文件中的 `url()`、`@import`。 |
| `autoPrefixSubpath` | `boolean` | `false` | **深度字面量补全**：在 JS/JSON/RSC 字面量流中补全裸路径（写入侧），白名单 = 内置根 + 自学习根，可用 `deepPaths` 追加。 |
| `rewriteLocation` | `boolean` | `true` | **跳转标头矫正**：收敛 `Location` / `Refresh` / `Link` 三类标头中的根相对、协议相对与上游绝对地址。 |
| `rewriteCookie` | `boolean` | `true` | **Cookie 路径收敛**：把 `Set-Cookie` 中的 `Path=/` 收敛为 `Path=/subpath/`，防止同域应用互相覆盖（`Domain` 始终会被剥离；`__Host-`/`__Secure-` 前缀 Cookie 自动跳过）。 |
| `cookieSameSite` | `string` | `Lax` | Cookie 缺失 `SameSite` 时的补齐值：`Lax` / `Strict` / `None` / `keep`（`keep` 表示不干预；`None` 在 HTTPS 入口下自动补 `Secure`）。 |
| `referrerPolicy` | `string` | `no-referrer-when-downgrade` | 文本类响应的 `Referrer-Policy`；`keep` 表示保留上游原值。 |
| `stripFrameGuards` | `boolean` | `true` | 剥离 `X-Frame-Options` / `Content-Security-Policy`，允许应用被门户 iframe 内嵌（自托管应用前提下的取舍）。 |
| `relaxIframeSandbox` | `boolean` | `true` | 修正应用自身 `sandbox="allow-scripts allow-forms"`（缺 `allow-same-origin` 会导致 localStorage 报错）。 |
| `autoLearn` | `boolean` | `true` | **自学习根路径**：自动从文档引用与已服务请求中归纳应用根路径，用于签名路由与深度补全白名单。 |
| `cacheAssets` | `boolean` | `true` | 静态资源（`*.js`/`*.css`/字体/图片等）保留上游强缓存；置 `false` 时全部响应强制 `no-store`。 |
| `ws` | `boolean` | `true` | **WebSocket 穿透**：开启全双工长连接升级支持，服务于终端、实时监控与 Socket 通信。 |
| `changeOrigin` | `boolean` | `true` | **Host 头改写**：将上游请求的 `Host` 头修改为目标后端的主机地址。 |
| `deepPaths` | `string[]` | `[]` | 追加深度补全白名单根路径（如 `["assets","_next","api"]`）。 |
| `signaturePaths` | `string[]` | `[]` | 声明该应用在根路径下"拥有"的前缀（如 `["/api/websites"]`），请求无 `Referer` 时用于归属判定。 |
| `driftPaths` | `string[]` | `[]` | 声明需要纠偏的根路径段（如 `["websites"]`）：访问 `/websites` 自动 302 到 `/subpath/websites`。 |
| `forceAjaxHeader` | `boolean` | `true` | 向上游补 `X-Requested-With: XMLHttpRequest`（历史兼容开关，部分应用依赖它区分 AJAX 请求）。 |
| `insecureTLS` | `boolean` | `false` | 跳过上游 HTTPS 证书校验（仅自签后端需要；默认校验，避免中间人）。 |
| `rewriteOrigin` | `boolean` | `false` | 把上游请求的 `Origin` 改写为后端地址（历史兼容开关；默认保留客户端 Origin，不破坏上游 CSRF/CSWSH 校验）。 |
| `rewriteFetchSite` | `boolean` | `false` | 强制 `Sec-Fetch-Site: same-origin`（历史兼容开关，默认保留客户端值）。 |
| `profile` | `string` | `auto` | **应用画像**：`auto`（按子路径匹配内置画像）/ `none`（纯通用模式）/ 具体画像名（内置或 `config.profiles` 自定义）。 |

### 🧩 应用画像（`config.profiles`）

"画像"= 某个应用在二级目录下需要的一组补丁。历史版本把它们写死在代码里，现在内置画像只是**默认数据**，可在配置中覆盖或新增：

```json
{
  "profiles": {
    "myapp": {
      "label": "我的应用",
      "signatures": ["/api/myapp", "/_next"],
      "drift": ["dashboard", "settings"],
      "deepRoots": ["api", "_next", "assets"],
      "deepByDefault": true,
      "noBase": true,
      "shimAlways": true,
      "storageIsolation": false,
      "staticBase": false,
      "syncTvRouter": false,
      "sessionCapsule": { "cookie": "webui_sid", "paths": ["/page"] }
    }
  },
  "routes": [
    { "subpath": "/app", "target": "http://127.0.0.1:3000", "enabled": true, "options": { "profile": "myapp" } }
  ]
}
```

| 画像字段 | 作用 |
| :--- | :--- |
| `signatures` | 该应用在根路径下"拥有"的前缀，无 `Referer` 时用于归属判定 |
| `drift` | 需要从根路径 302 纠偏回子目录的段（如 `dashboard`） |
| `deepRoots` / `deepByDefault` | 深度字面量补全白名单与其默认开关 |
| `noBase` / `shimAlways` | 不注入 `<base>` / 即使关闭 `injectBase` 也强制注入垫片 |
| `storageIsolation` | 注入 localStorage 前缀隔离垫片（多应用同域共用 `token` 键时很有用） |
| `staticBase` / `syncTvRouter` | 静态目录 `<base>` 兼容 / SyncTV 路由补丁 |
| `sessionCapsule` | 沙箱 iframe 丢失 Cookie 时按客户端 IP 补会话凭据（`cookie` 名 + 命中路径前缀） |

绑定优先级：`options.profile` → `config.profiles['<subpath>']` → 内置子路径绑定表（`/um`、`/v2`、`/en`、`/kuma`、`/frp`、`/newapi`、`/live`、`/orp`）。配置写错或指定了不存在的画像名都不会影响代理，只会退化为通用模式并在日志中提示。

相关管理接口（需管理员令牌）：

- `GET /__gw/api/admin/profiles`：列出内置/自定义画像、子路径绑定关系与"被哪些路由引用"
- `POST /__gw/api/admin/profiles`：新建或覆盖画像（同名覆盖内置画像；字段白名单校验，非法字段丢弃）
- `DELETE /__gw/api/admin/profiles/:name`：删除画像；仍被路由引用时返回 `409` + 引用清单，加 `?force=1` 强制删除（相关路由退化为通用模式并打日志）
- `GET /__gw/api/admin/routes`：额外返回每条路由的运行时状态（生效画像、自学习签名、漂移与签名清单）
- `GET /__gw/api/admin/route-probe?subpath=/app&path=/`：路由诊断（干跑体检：上游状态、响应体重写预演、响应头体检、技术栈嗅探、建议清单）
- `POST /__gw/api/admin/reload`：手工编辑 `config.json` 后从磁盘重载，无需重启

控制台里点顶栏 **画像管理** 即可在线增删改画像（编辑器内含全部字段与开关），保存后立即热生效；路由编辑弹窗中的「应用画像」下拉会实时反映可用画像。

---

## 🩺 二级目录反代疑难杂症与对策

二级目录反代（把整站挂到 `https://gateway/app/` 下）的坑大多集中在"应用不知道自己在子目录里"。下表是本项目对社区长期反馈的典型症状给出的处理方式：

| 症状 | 根因 | 本项目的处理 |
| :--- | :--- | :--- |
| 登录后立刻掉线 / Cookie 不生效 | 上游下发 `Domain=内部域名`，浏览器在网关域上直接丢弃该 Cookie | 始终剥离 `Set-Cookie` 的 `Domain`，可选收敛 `Path`，并补齐 `SameSite`（`None` 时补 `Secure`） |
| 点登录跳到了网站根目录 404 | 上游返回 `Location: /login` | 收敛 `Location`/`Refresh`/`Link` 中的根相对、协议相对与上游绝对地址 |
| 浏览器提示重定向次数过多 | 上游把请求重定向回自身，改写后形成自环 | GET/HEAD 自跳转拦截为 508，并打印上游跳转目标 |
| 页面样式/图片全丢 | CSS 里的 `url(/img/a.png)`、`@import "/x.css"` 不在 HTML 属性里 | CSS 与内联 `<style>`/`style=` 统一处理 |
| 高分辨率屏图片错乱 | `srcset` / `poster` 未处理 | 逐候选补全 `srcset`，并补全 `poster` 等媒体属性 |
| SPA 白屏、`_next`/`assets` 资源 404 | JS 运行时拼出的裸路径没被改写 | 深度字面量补全（含 RSC 转义斜杠 `\/` 形态）+ 对根路径请求做**自学习签名路由** |
| 终端 / 实时监控断连 | 升级握手未剥离前缀或缺少 `X-Forwarded-*` | WebSocket 与 HTTP 共用归属判定与转发标头，升级前剥离前缀 |
| 首屏很慢、TSF 卡在整页渲染完 | 上游被强制 `Accept-Encoding: identity` 且响应体整体缓冲 | 仅在需要改写时解码，按客户端能力重新压缩；SSE 与二进制流直接 `pipe` 透传 |
| 每次访问都重新下载几 MB 的 chunk | 网关对所有响应强制 `no-store` | 静态资源保留上游强缓存，仅摘除失效的 `ETag`/`Last-Modified` |
| 甲乙两个应用互相抢接口 | 同域下 `/_next/static/*`、`/api/*` 等通用路径被硬编码指给某一方 | 签名归属唯一才路由，多应用同时声明时**不猜测**，回落 Referer / 会话 Cookie 判定 |
| 应用把内部绝对地址吐回给浏览器 | 上游按 `Host` 生成绝对 URL | 同主机（上游或网关）的绝对地址收敛为子路径相对地址，外部域名原样放行 |
| 改写后中文变乱码 | 上游是 GBK 等非 UTF-8 页面 | 声明非 UTF-8 的文本字节原样透传 |
| 大文件/大接口把网关内存打爆 | 全量缓冲响应体 | 超过 `GW_MAX_REWRITE_BYTES`（默认 16 MiB）的响应原样透传 |
| 地址仍是应用子路径，内容却变成门户；访问 Clash 后影响其他应用 | 应用在 `/sw.js` 注册根 scope Worker，Workbox 把门户 `/` 预缓存并回送其他页面导航 | 注册、scope、主 Worker 预缓存与回退地址按应用隔离；旧根 Worker 定向退役，不再靠全站清数据恢复 |
| 白屏/掉登录但看不出是哪一环出问题 | 症状分散在响应体、响应头、前端路由与 Cookie 四处 | 控制台「诊断」：同一套规则干跑响应体 + 响应头体检 + 技术栈嗅探 + 中文建议清单 |

> 内置画像：为兼容历史部署，`/um`（Umami）、`/v2`（v2rayA）、`/en`（Entari）、`/kuma`（Uptime Kuma）、`/frp`、`/newapi`、`/live`（SyncTV）等子路径默认会绑定对应画像；它们已不再是写死的代码分支，而是可由 `config.profiles` 覆盖或新增的数据（见上文「应用画像」），新应用还可以完全依赖自学习签名。

Service Worker 修复上线后，旧根注册需在浏览器检查 `/sw.js` 更新或执行恢复脚本时才会退役；已打开的旧页面不会因服务器发布立即消失。离线浏览器需恢复联网。验收应在同一浏览器先打开 `/clash/`，等 Worker 激活，再依次访问其他应用，并检查它们不受 `/clash/sw.js` 控制；同时确认正确应用 Worker 仍可在自己的目录提供缓存。不要把 `Clear-Site-Data: "storage"` 或清空整个网站数据当作默认迁移方案。

---

## 🔒 安全基线（v1.1 起默认启用）

- **无默认口令**：首次启动生成 32 字节随机口令，仅在控制台打印一次；也可用 `GW_ADMIN_PASSWORD` 由编排系统注入（初始化后请在线改密并移除该变量）。
- **配置 fail-closed**：`config.json` 解析失败时拒绝启动（不再回落到"空配置 + 默认口令"）；写入采用 临时文件 + rename 并保留 `.bak`，权限 0600。
- **密钥强随机且持久化**：`jwtSecret` 使用 `crypto.randomBytes(48)` 生成并立即落盘；改密/登出通过 `tokenVersion` 吊销全部旧令牌（`POST /__gw/api/auth/logout`）。
- **登录限速**：同一来源 60 秒内 5 次失败后返回 `429`；口令比较使用异步 bcrypt（cost 12），不再阻塞事件循环。
- **输入校验**：子路径仅允许 `[A-Za-z0-9._~-]` 与 `/`（拒绝引号/尖括号/点段/编码字符）；分类、画像、签名/漂移路径、自定义镜像、上游地址全部白名单校验；门户所有动态字段统一转义，并下发 CSP（`script-src 'self' 'unsafe-inline'` + 两个 CDN 白名单）。
- **代理层加固**：默认只信任 TCP 对端 IP（需显式 `GW_TRUST_PROXY_HEADERS=true` 才采信 PROXY 头/XFF/X-Real-IP）；客户端 `X-Original-URI`/`X-Authenticated-User`/XFF 链在转发前清除；`Origin`/`Sec-Fetch-Site` 默认保留（不替上游绕过 CSRF 校验）；上游 HTTPS 默认校验证书（自签用 `insecureTLS: true`）；点段/编码斜杠路径直接 `400`。
- **会话胶囊**：改为网关签发的随机设备令牌（`__gw_capsule_id`，HttpOnly、10 分钟 TTL），不再以可伪造 IP 为键。
- **缓存与压缩**：带 `Set-Cookie` 的响应强制 `private, no-store`；解压设置 `maxOutputLength`，防止压缩炸弹；网关自用 Cookie 与上游 `Set-Cookie` 合并下发，不再互相覆盖。
- **容器**：镜像以非 root（`USER node`）运行，`npm ci --omit=dev` 按锁文件安装。

### 安全相关环境变量

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `GW_ADMIN_PASSWORD` | 空 | 首次启动初始化管理员口令（不落明文；建议用后移除） |
| `GW_TRUST_PROXY_HEADERS` | `false` | 置 `true` 才采信 PROXY 协议头与 `X-Forwarded-*`/`X-Real-IP`（仅当部署在可信反代之后） |
| `GW_PUBLIC_HOST` | 空 | 固定上游看到的 `X-Forwarded-Host`，避免 Host 头污染 |
| `GW_ALLOW_ENCODED_SLASH` | `false` | 允许路径中出现 `%2f`/`%2e`（仅当确有需要） |
| `GW_MAX_CONNECTIONS` | `2048` | 监听层最大并发连接数 |
| `GW_SOCKET_TIMEOUT_MS` | `15000` | 首包前空闲连接超时（防半开连接耗尽 fd） |
| `GW_MAX_REWRITE_BYTES` | `16777216` | 文本重写与解压输出上限（超过则原样透传/受控失败） |

> 依赖说明：`proxy-addr` 已升级到 2.0.8（修复 GHSA-jqcg-44mw-7w3h）；`braces/micromatch/http-proxy-middleware` 的 high 公告在本项目不涉及 glob context，不可达，且其"修复"是降级到 0.2.0（破坏性），故不采纳，等待上游。

---

## 🔒 管理员安全

- 首次启动请从控制台日志获取随机口令并立即修改；不要在示例文件或仓库中提交真实凭据。
- 管理控制台支持在线增删改查代理路由；修改密码会强制所有会话重新登录。
- 若网关前有可信反代，请设置 `GW_TRUST_PROXY_HEADERS=true` 与 `GW_PUBLIC_HOST`，并将上游应用端口限制为仅反代可达。

---

## 🧪 自检与回归

```bash
node scripts/smoke-subpath.mjs
```

脚本会自行拉起临时上游夹具与临时配置的网关实例，逐项校验斜杠纠偏、文档/CSS/JS/JSON/RSC 重写、跳转标头与 Cookie 归一化、压缩协商、缓存策略、体积降级、WebSocket/SSE 穿透、自学习签名路由、内置与自定义画像、画像在线增删改、路由诊断、安全回归（默认口令/注入/路径/胶囊/限速/炸弹）与管理接口热重载（共 148 项断言），结束后自动清理。

---

## 📁 目录结构说明

```
Cloud-Gateway/
├── server.js              # 网关入口：配置、管理接口、更新引擎、双协议监听层
├── lib/
│   ├── proxy-engine.js    # 二级目录反代引擎：路由画像、归属判定、代理中间件、WS 升级
│   └── text-rewriter.js   # 响应重写引擎：编码协商、文本重写、标头/Cookie 归一化、缓存策略
├── public/                # 聚合门户静态前端
│   └── index.html         # 门户仪表盘、Catmull-Rom 贝塞尔动态曲线与路由控制台
├── data/                  # 持久化数据目录
│   └── config.example.json# 模板配置文件
├── ssl/                   # SSL/TLS 证书目录 (可选，放置 fullchain.pem 与 privkey.pem)
├── scripts/               # 验证与辅助运维脚本
│   ├── verify.sh          # 链路与 Base Href 校验脚本
│   └── smoke-subpath.mjs  # 二级目录反代引擎冒烟测试（自包含夹具）
├── Dockerfile             # 容器化构建描述
├── docker-compose.yml     # 一键编排部署配置
├── package.json           # 依赖清单
└── LICENSE                # MIT 开源协议
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 许可协议开源。
