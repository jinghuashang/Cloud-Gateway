# 🌐 Cloud Gateway (统一云服务聚合门户与高性能子路径反向代理)

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.19-000000?style=flat-square&logo=express)](https://expressjs.com/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

**Cloud Gateway** 是一套专为单域名/单公网 IP 环境打造的高性能**二级子路径反向代理与统一云聚合门户**。

它从根本上解决了将海量异构 Web 应用（如 Next.js、React SPA、Vue Router、Vite 打包应用、Web 终端、WebSocket 实时监控、BT 下载器等）挂载到单域名二级子路径（如 `/um/`、`/omp/`、`/kuma/`、`/qb/`）时普遍面临的**静态资源 404、路由循环重定向、页面白屏、iframe 递归套娃以及资源串线漂移**等棘手难题。

---

## ✨ 核心特性

- 🚀 **智能流式文本自愈引擎 (`autoPrefixSubpathText`)**
  - 在反向代理传输层注入通用文本自愈引擎，覆盖 HTML、JavaScript、JSON 以及 Next.js React Server Component (`text/x-component`) 流；
  - 自动扫描响应体中的相对根路径（如 `"/_next"`, `"/api"`, `"/assets"` 等），无损补全为带有二级目录前缀的完整路径，彻底解决现代 SPA 子路径静态资源 404 与白屏。
- 🛡️ **防漂移签名路由系统 (Signature Routing)**
  - 基于请求头 `Referer`、`Origin` 与专用会话 Cookie 特征，智能识别跨子路径的静态资源与异步 API 请求；
  - 杜绝同域名下多服务（如 Umami 与 Next.js）共享通用路径（如 `/_next/static/*`）时的相互踩踏与串线。
- 🔀 **全自动斜杠纠偏与多重子路径折叠**
  - 请求裸子路径（如 `/omp`）时自动执行 301/302 斜杠重定向（`/omp/`）；
  - 入口层智能折叠畸形多重子路径（如某些前端路由误判生成的 `/kuma/kuma/dashboard` $\rightarrow$ 自动校正回 `/kuma/dashboard`）。
- 🔌 **全双工 WebSocket / PTY 终端穿透**
  - 原生支持 HTTP 升级握手（`101 Switching Protocols`）；
  - 全链路兼容 Web 终端（xterm.js）、Socket.IO 双向流与实时监控长连接。
- 📊 **动态流量态势大屏 & 玻璃拟态门户**
  - 提供开箱即用的响应式导航首页，内置 Lucide 图标与分类标签过滤；
  - 集成**实时 QPS 与 7 日流量滑动走势图**，采用 Catmull-Rom 贝塞尔平滑插值，支持毫秒级动态跳动。
- ⚙️ **可视化管理控制台与零重启热重载**
  - 提供完备的管理员 API 与前台配置管理模态框，支持在线增删改查路由、调整显示顺序与高级代理选项；
  - 修改持久化于本地 `data/config.json`，全系统实时热重载，无需停机或重启容器。
- 🔒 **生产级安全防护与鉴权**
  - 管理后台采用 JWT 隔离认证，管理员密码基于 Bcrypt 加盐哈希加密；
  - SPA 兜底与 iframe 递归探测，杜绝路由缺失时的递归套娃消耗。

---

## 🏛️ 系统架构与路由拓扑

```
                           【客户端访问入口】
                       https://cloud.example.com
                                   │
                    ┌──────────────▼──────────────┐
                    │        Cloud Gateway        │
                    │   (Port: 8088 / Docker)     │
                    └──────────────┬──────────────┘
                                   │
       ┌──────────────┬────────────┼────────────┬──────────────┐
       ▼              ▼            ▼            ▼              ▼
     / (首页)       /um/          /omp/       /kuma/         /qb/
  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ 聚合门户 │  │  Umami   │  │Oh My Pi  │  │  Uptime  │  │qBittor-  │
  │态势大屏  │  │ 统计分析 │  │自主智能体│  │   Kuma   │  │   rent   │
  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
```

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
   网关服务将在本地 `http://0.0.0.0:8088` 启动。

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
  "siteSubtitle": "统一云聚合门户与高性能子路径反向代理",
  "themeColor": "#3b82f6",
  "adminPasswordHash": "$2a$10$ImJfKVA0ZweONqTDLUJrC.pHwTcViCE.H89D/2msx5auOMTVMGfN.",
  "jwtSecret": "cloud_gateway_secret_custom_key",
  "categories": ["全部", "常用服务", "媒体影音", "系统运维", "开发工具"],
  "routes": [
    {
      "id": "route_omp",
      "name": "Oh My Pi WebUI",
      "category": "开发工具",
      "icon": "terminal",
      "description": "自主编码智能体 Oh My Pi 官方 Web 控制台与交互终端",
      "subpath": "/omp",
      "target": "http://127.0.0.1:8172",
      "enabled": true,
      "order": 1,
      "options": {
        "autoSlash": true,
        "injectBase": true,
        "rewriteHtml": true,
        "autoPrefixSubpath": true,
        "rewriteLocation": true,
        "rewriteCookie": false,
        "ws": true,
        "changeOrigin": true
      }
    }
  ]
}
```

### 🎛️ 高级代理开关解析 (`options`)

| 配置项 | 类型 | 默认值 | 作用说明 |
| :--- | :--- | :--- | :--- |
| `autoSlash` | `boolean` | `true` | **自动尾部斜杠校正**：访问 `/app` 自动 301 重定向至 `/app/`，保障相对路径资源正确解析。 |
| `injectBase` | `boolean` | `true` | **HTML Base 注入**：向响应 HTML `<head>` 中动态注入 `<base href="/subpath/">`。 |
| `rewriteHtml` | `boolean` | `true` | **HTML 相对路径自愈**：扫描 HTML 内部引用的根路径静态资源并附加子路径前缀。 |
| `autoPrefixSubpath` | `boolean` | `false` | **通用流式深层重写**：针对 Next.js、React 等流式 SPA 应用，在 JS/JSON/RSC 流中全量重写相对根路径。 |
| `rewriteLocation` | `boolean` | `true` | **重定向 Header 矫正**：截获后端上游返回的 `Location` 头，将 `/login` 等绝对根路径矫正为 `/subpath/login`。 |
| `rewriteCookie` | `boolean` | `false` | **Cookie 路径重写**：将 `Set-Cookie` 中的 `Path=/` 重写为 `Path=/subpath/`，防止会话冲突。 |
| `ws` | `boolean` | `true` | **WebSocket 穿透**：开启全双工长连接升级支持，服务于终端、实时监控与 Socket 通信。 |
| `changeOrigin` | `boolean` | `true` | **Host 头改写**：将上游请求的 `Host` 头修改为目标后端的主机地址。 |

---

## 🔒 默认密码与管理

- **默认管理员密码**：`admin123456`
- 点击门户页面右上角右上角的齿轮/设置图标即可进入控制台登录弹窗。
- 登录后可在页面上直接添加新路由、修改反代目标、启停服务及切换高级重写特性。
- 生产环境建议在管理面板中及时修改初始管理员密码！

---

## 📁 目录结构说明

```
Cloud-Gateway/
├── server.js              # 网关核心引擎：反向代理流式重写、路由调度与管理接口
├── public/                # 聚合门户静态前端
│   └── index.html         # 门户仪表盘、Catmull-Rom 贝塞尔动态曲线与路由控制台
├── data/                  # 持久化数据目录
│   └── config.example.json# 模板配置文件
├── ssl/                   # SSL/TLS 证书目录 (可选，放置 fullchain.pem 与 privkey.pem)
├── scripts/               # 验证与辅助运维脚本
│   └── verify.sh          # 链路与 Base Href 校验脚本
├── Dockerfile             # 容器化构建描述
├── docker-compose.yml     # 一键编排部署配置
├── package.json           # 依赖清单
└── LICENSE                # MIT 开源协议
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 许可协议开源。
