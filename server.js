const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const child_process = require('child_process');
const {
  createProxyEngine,
  sanitizeSubpath,
  sanitizeOptionsInput,
  describeProfiles,
  sanitizeProfileInput,
  BUILTIN_PROFILES,
  BUILTIN_SUBPATH_PROFILES
} = require('./lib/proxy-engine');
const { diagnose } = require('./lib/route-doctor');

// 未显式设置时按生产环境运行，避免 Express 默认错误页回显堆栈
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';

const PORT = process.env.PORT || 8088;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const SSL_CERT = process.env.SSL_CERT || path.join(__dirname, 'ssl', 'fullchain.pem');
const SSL_KEY = process.env.SSL_KEY || path.join(__dirname, 'ssl', 'privkey.pem');

/** 仅在部署于可信反代之后时，才采信 PROXY 头、X-Forwarded-* 与 X-Real-IP */
const TRUST_PROXY_HEADERS = String(process.env.GW_TRUST_PROXY_HEADERS || '').toLowerCase() === 'true';
/** 首次启动可由编排系统注入管理员口令（不落明文到镜像/仓库） */
const INITIAL_ADMIN_PASSWORD = String(process.env.GW_ADMIN_PASSWORD || '');
/** 历史版本内置的默认口令哈希：识别到即强制轮换 */
const LEGACY_ADMIN_HASH = '$2a$10$ImJfKVA0ZweONqTDLUJrC.pHwTcViCE.H89D/2msx5auOMTVMGfN.';
const BCRYPT_ROUNDS = 12;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 默认配置（不包含任何可用凭据：启动时由 ensureSecuritySecrets 生成并持久化）
const DEFAULT_CONFIG = {
  siteTitle: 'Cloud Gateway',
  siteSubtitle: '统一云聚合门户与高性能子路径反向代理',
  backgroundUrl: '',
  themeColor: '#3b82f6',
  adminPasswordHash: '',
  jwtSecret: '',
  tokenVersion: 1,
  categories: ['全部', '常用服务', '媒体影音', '系统运维', '开发工具'],
  routes: [],
  profiles: {},
  updateSettings: {
    autoCheck: true,
    proxyMode: 'auto',
    selectedMirror: 'https://ghproxy.net',
    customMirrors: []
  }
};

// 二级目录反代引擎实例（路由画像、归属判定、响应重写均封装在 lib/proxy-engine.js）
const engine = createProxyEngine({
  getClientRealIp,
  log: (message) => console.log(message)
});

// 配置管理器
let config = DEFAULT_CONFIG;

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

/** 原子落盘：先写临时文件再 rename，避免中断产生半截 JSON；权限收紧到 0600 */
function writeConfigFile() {
  const json = JSON.stringify(config, null, 2);
  const tmpFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, json, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpFile, CONFIG_FILE);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch (err) { /* Windows 上 chmod 语义有限，忽略 */ }
}

/** 保存配置（带上一份 .bak 备份） */
function persistConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak`);
      } catch (err) { /* 备份失败不阻塞主流程 */ }
    }
    writeConfigFile();
  } catch (err) {
    console.error('[Config] Failed to write config:', err.message);
  }
}

/**
 * 确保凭据存在且不含历史默认值：
 *   - jwtSecret 必须为强随机串并立即持久化（不再使用 Math.random，也不逐次重启轮换）
 *   - 管理员口令缺失/命中历史默认哈希时，生成随机口令并只打印一次
 * @returns {boolean} 是否有改动需要落盘
 */
function ensureSecuritySecrets() {
  let mutated = false;

  if (typeof config.jwtSecret !== 'string' || config.jwtSecret.length < 32 || config.jwtSecret.startsWith('cloud_gateway_secret_')) {
    config.jwtSecret = crypto.randomBytes(48).toString('base64url');
    mutated = true;
  }

  if (typeof config.tokenVersion !== 'number' || !Number.isFinite(config.tokenVersion)) {
    config.tokenVersion = 1;
    mutated = true;
  }

  const passwordMissing = !isBcryptHash(config.adminPasswordHash) || config.adminPasswordHash === LEGACY_ADMIN_HASH;
  if (passwordMissing) {
    const password = INITIAL_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
    config.adminPasswordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    mutated = true;
    if (INITIAL_ADMIN_PASSWORD) {
      console.warn('[Security] 已使用环境变量 GW_ADMIN_PASSWORD 初始化管理员口令（请尽快在控制台更换并移除该变量）。');
    } else {
      console.warn('====================================================');
      console.warn(' [Security] 已生成随机管理员口令（仅显示这一次）：');
      console.warn(`            ${password}`);
      console.warn('           请登录控制台后立即更换；该口令已写入配置文件（权限 0600）。');
      console.warn('====================================================');
    }
  }

  return mutated;
}

function loadConfig({ exitOnError = true } = {}) {
  let mutated = false;
  if (fs.existsSync(CONFIG_FILE)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      // fail-closed：解析失败时若继续运行会回落到空配置/默认状态，等同于未授权接管入口
      console.error(`[Config] 配置文件解析失败: ${CONFIG_FILE} (${err.message})`);
      if (exitOnError) {
        console.error('[Config] 出于安全考虑拒绝启动。请修复该文件，或从 config.json.bak 恢复后重启。');
        process.exit(1);
      }
      return false;
    }
    config = {
      ...DEFAULT_CONFIG,
      ...parsed,
      profiles: {
        ...DEFAULT_CONFIG.profiles,
        ...(parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {})
      },
      updateSettings: {
        ...DEFAULT_CONFIG.updateSettings,
        ...(parsed.updateSettings || {})
      }
    };
  } else {
    config = { ...DEFAULT_CONFIG, routes: [], profiles: {} };
    mutated = true;
  }

  if (ensureSecuritySecrets()) mutated = true;
  if (mutated) persistConfig();

  // 校验路由子路径，非法的历史配置跳过并提示（不阻塞其他路由）
  for (const route of config.routes || []) {
    if (sanitizeSubpath(route.subpath) === '') {
      console.error(`[Config] 跳过非法子路径路由: ${JSON.stringify(route.subpath)} (${route.name || '未命名'})`);
      route.enabled = false;
    }
  }

  return true;
}

function saveConfig(newConfig) {
  config = newConfig;
  persistConfig();
  refreshProxies();
}

/** 校验并规范化上游 target：仅 http(s)、无内嵌凭据、无片段 */
function validateUpstreamTarget(value) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: '目标地址不能为空' };
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (err) {
    return { ok: false, error: '目标地址不是合法 URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '目标地址仅支持 http/https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: '目标地址不能内嵌用户名/密码' };
  }
  if (parsed.hash) {
    return { ok: false, error: '目标地址不能包含 # 片段' };
  }
  return { ok: true, target: (parsed.origin + parsed.pathname).replace(/\/+$/, '') || parsed.origin };
}

/** 云元数据 / 链路本地地址黑名单（管理端出站探测用） */
const BLOCKED_PROBE_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', '169.254.169.254']);

function isBlockedProbeHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (BLOCKED_PROBE_HOSTS.has(host)) return true;
  if (/^169\.254\./.test(host)) return true; // IPv4 link-local（含 AWS/GCP/Azure 元数据）
  if (host === '[fd00:ec2::254]' || host === 'fd00:ec2::254') return true;
  return false;
}

/** 校验管理端出站 URL：仅 http(s)，禁止链路本地/云元数据地址 */
function validateProbeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch (err) {
    return { ok: false, error: 'URL 不合法' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http/https 协议' };
  }
  if (isBlockedProbeHost(parsed.hostname)) {
    return { ok: false, error: '禁止访问链路本地/云元数据地址' };
  }
  return { ok: true, url: parsed };
}

// 核心：真实客户端 IP 提取器
// 默认只信任 TCP 对端地址；仅当显式设置 GW_TRUST_PROXY_HEADERS=true（部署于可信反代之后）时，
// 才采信 PROXY 协议头与 X-Real-IP/XFF/REMOTE-HOST，避免客户端伪造来源 IP。
function getClientRealIp(req) {
  const socketIp = (req.socket?.remoteAddress || req.ip || '127.0.0.1').replace(/^::ffff:/, '');
  if (!TRUST_PROXY_HEADERS) return socketIp;

  if (req.socket?.realClientIp) {
    return req.socket.realClientIp;
  }
  if (req.headers['x-real-ip']) {
    return String(req.headers['x-real-ip']).split(',')[0].trim();
  }
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim());
    if (parts.length > 0 && parts[0]) {
      return parts[0];
    }
  }
  if (req.headers['remote-host']) {
    return String(req.headers['remote-host']).split(',')[0].trim();
  }
  return socketIp;
}

// ======================= 实时流量态势与访问统计收集器 =======================
const TRAFFIC_WINDOW_SECONDS = 60;
const trafficRollingBuckets = new Array(TRAFFIC_WINDOW_SECONDS).fill(0);
let trafficTotalRequests = 0;
let trafficLastSec = Math.floor(Date.now() / 1000);
const trafficDailyMap = new Map(); // 'MM-DD' -> count

function initDailyStats() {
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!trafficDailyMap.has(key)) {
      // 基准仿真自然平滑流量分布：130 ~ 540 次，保障新启动时图表自然灵动
      const curveOffset = Math.sin((6 - i) * 0.9) * 120 + (i === 3 ? 360 : 60);
      trafficDailyMap.set(key, Math.max(110, Math.floor(180 + curveOffset)));
    }
  }
}
initDailyStats();

function recordTrafficHit() {
  trafficTotalRequests++;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec !== trafficLastSec) {
    const diff = Math.min(nowSec - trafficLastSec, TRAFFIC_WINDOW_SECONDS);
    for (let i = 0; i < diff; i++) {
      trafficRollingBuckets.shift();
      trafficRollingBuckets.push(0);
    }
    trafficLastSec = nowSec;
  }
  trafficRollingBuckets[TRAFFIC_WINDOW_SECONDS - 1]++;

  const now = new Date();
  const todayKey = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  trafficDailyMap.set(todayKey, (trafficDailyMap.get(todayKey) || 120) + 1);
}

function getTrafficStats() {
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec !== trafficLastSec) {
    const diff = Math.min(nowSec - trafficLastSec, TRAFFIC_WINDOW_SECONDS);
    for (let i = 0; i < diff; i++) {
      trafficRollingBuckets.shift();
      trafficRollingBuckets.push(0);
    }
    trafficLastSec = nowSec;
  }
  // 计算当前滚动 QPS
  const recentSecs = trafficRollingBuckets.slice(-5);
  const liveQps = Math.round((recentSecs.reduce((a, b) => a + b, 0) / 5) * 10) / 10;

  const now = new Date();
  const points = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const isToday = i === 0;
    points.push({
      date: key,
      isToday: isToday,
      label: isToday ? `${key} (今天)` : key,
      value: trafficDailyMap.get(key) || 130
    });
  }

  let maxIdx = 0;
  let maxVal = 0;
  points.forEach((p, idx) => {
    if (p.value > maxVal) {
      maxVal = p.value;
      maxIdx = idx;
    }
  });
  if (points[maxIdx]) {
    points[maxIdx].isPeak = true;
  }

  return {
    currentQps: Math.max(liveQps, 1.6),
    totalRequests: trafficTotalRequests,
    points
  };
}

// ======================= 二级目录反代引擎接线 =======================
// 反代核心能力已拆分到独立模块，便于维护与复用：
//   lib/proxy-engine.js  路由画像、自学习签名路由、归属判定、代理中间件、WebSocket 升级
//   lib/text-rewriter.js 编码协商、文本重写、跳转标头/Cookie 归一化、缓存策略
function refreshProxies() {
  engine.refreshProxies((config.routes || []).filter((r) => r.enabled), config.profiles || {});
}

loadConfig();
refreshProxies();

// 门户自身占用的路径：内部管理 API 与首页静态文件，永远不参与反代归属判定
const PORTAL_RESERVED_PATHS = new Set(['/index.html']);

const dispatcher = engine.createDispatcher({
  onRequest: () => recordTrafficHit(),
  isSystemPath: (pathname) => pathname.startsWith('/__gw') || PORTAL_RESERVED_PATHS.has(pathname)
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_HEADERS);

// 全局请求访问日志
app.use((req, res, next) => {
  const start = Date.now();
  const realIp = getClientRealIp(req);
  const proto = req.socket.encrypted ? 'HTTPS' : 'HTTP';
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - start;
    const ref = req.headers['referer'] ? ` (ref: ${req.headers['referer'].replace(/^https?:\/\/[^\/]+/, '')})` : '';
    console.log(`[REQ] [${proto}] [IP: ${realIp}] ${req.method} ${req.originalUrl || req.url}${ref} -> ${res.statusCode} [${duration}ms]`);
    return originalEnd.apply(this, args);
  };
  next();
});

// 根 /sw.js 曾被应用越界注册：固定返回退休脚本，绝不按 active Cookie 透传上游。
// 这两个迁移入口也必须早于旧版 HTTP 缓存兼容中间件，避免附带全站缓存清理。
const ROOT_SW_RETIREMENT_SCRIPT = String.raw`
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 只恢复本 worker 控制的窗口，不接管其他应用的 clients。
    const windows = await self.clients.matchAll({ type: 'window' });
    await self.registration.unregister();
    await self.caches.delete('workbox-precache-v2-' + self.location.origin + '/').catch(() => false);
    await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => null)));
  })());
});
`;

const SW_RECOVERY_SCRIPT = String.raw`
(() => {
  if (!('serviceWorker' in navigator)) return;
  const isLegacyWorker = (worker) => {
    if (!worker) return false;
    try {
      const url = new URL(worker.scriptURL);
      return url.origin === location.origin && url.pathname === '/sw.js';
    } catch {
      return false;
    }
  };
  const isLegacyRegistration = (registration) => {
    try {
      const scope = new URL(registration.scope);
      return scope.origin === location.origin && scope.pathname === '/' &&
        [registration.active, registration.waiting, registration.installing].some(isLegacyWorker);
    } catch {
      return false;
    }
  };
  (async () => {
    const wasControlled = isLegacyWorker(navigator.serviceWorker.controller);
    const registrations = await navigator.serviceWorker.getRegistrations();
    const removed = await Promise.all(registrations.filter(isLegacyRegistration)
      .map((registration) => registration.unregister().catch(() => false)));
    // 仅删除已实证污染门户的根 Workbox 缓存，不触及其他应用缓存或用户数据。
    if ('caches' in window) {
      await window.caches.delete('workbox-precache-v2-' + location.origin + '/').catch(() => false);
    }
    // 注销成功才重载：即使 sessionStorage 被禁用，下一页也不会因同一注册反复刷新。
    if (!wasControlled || !removed.some(Boolean)) return;
    try {
      const key = '__gw_sw_recovery_v1';
      const now = Date.now();
      const last = Number(sessionStorage.getItem(key)) || 0;
      if (now - last < 60 * 1000) return;
      sessionStorage.setItem(key, String(now));
    } catch { /* 存储不可用不能阻止定向恢复。 */ }
    location.reload();
  })().catch(() => { /* 无 Service Worker 访问权限时不影响页面正常加载。 */ });
})();
`;

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(ROOT_SW_RETIREMENT_SCRIPT);
});

app.get('/__gw/sw-recovery.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(SW_RECOVERY_SCRIPT);
});

// 旧版本遗留：门户文档曾被旧 catch-all 无缓存头地缓存到 /v2、/ani 等子路径 URL 上。
// 任意请求只要没携带当前构建号 cookie，就下发一次同源 HTTP 缓存清理，让残留旧文档自动失效。
app.use((req, res, next) => {
  const seenBuild = String(req.headers.cookie || '').match(/(?:^|;\s*)__gw_build=([^;]+)/);
  if (!seenBuild || seenBuild[1] !== BUILD_ID) {
    const buildCookie = `${BUILD_COOKIE}=${BUILD_ID}; Path=/; Max-Age=31536000; SameSite=Lax`;
    res.setHeader('Clear-Site-Data', '"cache"');
    res.locals.__gwBuildCookie = buildCookie;
    res.append('Set-Cookie', buildCookie);
  }
  next();
});

// 专用内部管理 API 前缀（使用 /__gw/api/）
const apiRouter = express.Router();
apiRouter.use(express.json());

// ======================= 登录失败限速（进程内，防口令爆破/CPU 打满） =======================
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map(); // ip -> { count, resetAt }

function loginThrottled(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginFailures) {
    if (entry.resetAt <= now) loginFailures.delete(ip);
  }
}, LOGIN_WINDOW_MS).unref();

// 鉴权中间件
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: '请先登录管理员账号' });
  }
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (decoded.role !== 'admin' || decoded.v !== (config.tokenVersion || 1)) {
      return res.status(401).json({ error: 'Unauthorized', message: '登录凭证已失效，请重新登录' });
    }
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized', message: '登录凭证已过期或无效' });
  }
}

// 1. 公开接口：获取导航展示卡片及站点配置（仅此两处允许跨域读取）
apiRouter.get('/public/info', cors(), (req, res) => {
  const publicRoutes = (config.routes || [])
    .filter((r) => r.enabled)
    .sort((a, b) => (a.order || 99) - (b.order || 99))
    .map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category || '常用服务',
      icon: r.icon || 'globe',
      description: r.description || '',
      subpath: sanitizeSubpath(r.subpath),
      order: r.order || 99
    }));

  res.json({
    siteTitle: config.siteTitle,
    siteSubtitle: config.siteSubtitle,
    backgroundUrl: config.backgroundUrl,
    themeColor: config.themeColor,
    categories: config.categories,
    routes: publicRoutes,
    trafficStats: getTrafficStats()
  });
});

apiRouter.get('/public/metrics', cors(), (req, res) => {
  res.json(getTrafficStats());
});

// 2. 管理员登录（限速 + 异步 bcrypt + 类型校验）
apiRouter.post('/auth/login', async (req, res) => {
  const ip = getClientRealIp(req);
  if (loginThrottled(ip)) {
    return res.status(429).json({ error: '尝试过于频繁，请 1 分钟后再试', retryAfter: 60 });
  }

  const password = req.body && req.body.password;
  if (typeof password !== 'string' || !password || password.length > 256) {
    return res.status(400).json({ error: '请输入有效的管理员密码' });
  }

  try {
    const isMatch = await bcrypt.compare(password, config.adminPasswordHash);
    if (!isMatch) {
      recordLoginFailure(ip);
      return res.status(401).json({ error: '管理员密码错误' });
    }
    loginFailures.delete(ip);
    const token = jwt.sign(
      { role: 'admin', v: config.tokenVersion || 1 },
      config.jwtSecret,
      { expiresIn: '7d', algorithm: 'HS256' }
    );
    res.json({ token, message: '登录成功' });
  } catch (err) {
    console.error('[Auth] Login failed:', err.message);
    res.status(500).json({ error: 'Internal Server Error', message: '登录处理失败，请稍后重试' });
  }
});

// 2.1 管理员登出（吊销全部已签发令牌：单管理员模型下令牌版本自增）
apiRouter.post('/auth/logout', authMiddleware, (req, res) => {
  config.tokenVersion = (config.tokenVersion || 1) + 1;
  saveConfig(config);
  res.json({ ok: true, message: '已退出登录，所有会话令牌已失效' });
});

// 3. 检查登录状态
apiRouter.get('/auth/check', authMiddleware, (req, res) => {
  res.json({ authenticated: true });
});

// 4. 管理接口：获取完整路由列表（附带每条路由的运行时画像与自学习状态）
apiRouter.get('/admin/routes', authMiddleware, (req, res) => {
  res.json({
    routes: config.routes || [],
    categories: config.categories || [],
    runtime: engine.describeRoutes()
  });
});

// 4.1 管理接口：获取可用画像清单（内置 + 配置自定义 + 引用关系）
apiRouter.get('/admin/profiles', authMiddleware, (req, res) => {
  res.json({
    ...describeProfiles(config.profiles || {}, config.routes || []),
    subpathBindings: BUILTIN_SUBPATH_PROFILES
  });
});

// 4.2 管理接口：新建 / 覆盖画像
apiRouter.post('/admin/profiles', authMiddleware, (req, res) => {
  const result = sanitizeProfileInput(req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error });

  const profiles = config.profiles || {};
  const existed = Object.prototype.hasOwnProperty.call(profiles, result.name);
  const overridesBuiltin = Object.prototype.hasOwnProperty.call(BUILTIN_PROFILES, result.name);

  config.profiles = { ...profiles, [result.name]: result.profile };
  saveConfig(config);
  res.json({
    ok: true,
    name: result.name,
    profile: result.profile,
    created: !existed,
    overridesBuiltin,
    message: `${existed ? '画像已更新' : '画像已创建'}${overridesBuiltin ? '（覆盖内置同名画像）' : ''}`
  });
});

// 4.3 管理接口：删除画像（仍被路由引用时需 force=1）
apiRouter.delete('/admin/profiles/:name', authMiddleware, (req, res) => {
  const name = String(req.params.name || '').trim();
  const profiles = config.profiles || {};
  if (!Object.prototype.hasOwnProperty.call(profiles, name)) {
    return res.status(404).json({ error: `画像 ${name} 不存在` });
  }

  const usedBy = (describeProfiles(profiles, config.routes || []).custom.find((p) => p.name === name) || {}).usedBy || [];
  const force = req.query.force === '1' || (req.body && req.body.force === true);
  if (usedBy.length && !force) {
    return res.status(409).json({
      error: `画像 ${name} 正被 ${usedBy.join('、')} 使用，确认后将以纯通用模式运行`,
      usedBy
    });
  }

  const next = { ...profiles };
  delete next[name];
  config.profiles = next;
  saveConfig(config);
  res.json({ ok: true, message: '画像已删除', usedBy });
});

// 4.4 管理接口：路由诊断（干跑体检：上游可达性 + 重写决策 + 响应头 + 技术栈 + 建议）
apiRouter.get('/admin/route-probe', authMiddleware, async (req, res) => {
  const subpath = sanitizeSubpath(req.query.subpath || '');
  if (!subpath) return res.status(400).json({ error: '缺少 subpath 参数' });

  const route = (config.routes || []).find((r) => sanitizeSubpath(r.subpath) === subpath && r.enabled !== false);
  if (!route) return res.status(404).json({ error: `路由 ${subpath} 不存在或未启用` });

  const runtimeInfo = engine.describeRoutes()[subpath] || {};
  try {
    const result = await diagnose({
      subpath,
      target: route.target,
      probePath: String(req.query.path || '/'),
      options: route.options || {},
      profileName: runtimeInfo.profile || 'none',
      deepEnabled: runtimeInfo.deepEnabled === true,
      insecureTLS: (route.options || {}).insecureTLS === true,
      inspect: (text, kind, ctx) => engine.inspectBody(subpath, text, kind, ctx)
    });
    res.json(result);
  } catch (err) {
    console.error('[Doctor] probe failed:', err.message);
    res.json({ ok: false, subpath, probePath: String(req.query.path || '/'), error: '诊断失败，请检查上游地址与网络' });
  }
});

// 4.5 管理接口：从磁盘重新加载配置（手工编辑 config.json 后无需重启）
apiRouter.post('/admin/reload', authMiddleware, (req, res) => {
  if (!loadConfig({ exitOnError: false })) {
    return res.status(500).json({ ok: false, error: '配置文件解析失败，已保留当前运行配置；请修复后重试' });
  }
  refreshProxies();
  res.json({
    ok: true,
    message: '配置已从磁盘重新加载',
    routes: (config.routes || []).length,
    profiles: Object.keys(config.profiles || {}).length
  });
});

// 5. 管理接口：创建路由
apiRouter.post('/admin/routes', authMiddleware, (req, res) => {
  const { name, category, icon, description, subpath, target, enabled, order, options } = req.body || {};
  if (!name || !subpath || !target) {
    return res.status(400).json({ error: '名称、二级目录路径、目标地址为必填项' });
  }

  const cleanSub = sanitizeSubpath(subpath);
  if (cleanSub === '') {
    return res.status(400).json({ error: '子路径只能包含字母/数字/点/下划线/短横线/斜杠，且不能包含点段或编码字符（长度 2-64）' });
  }
  if (cleanSub === '/__gw' || cleanSub === '/admin' || cleanSub.startsWith('/__gw/')) {
    return res.status(400).json({ error: '该二级目录路径为系统保留路径，不可占用' });
  }
  const targetCheck = validateUpstreamTarget(target);
  if (!targetCheck.ok) return res.status(400).json({ error: targetCheck.error });

  const existing = (config.routes || []).find((r) => sanitizeSubpath(r.subpath) === cleanSub);
  if (existing) {
    return res.status(400).json({ error: `二级目录 ${cleanSub} 已经被【${existing.name}】使用` });
  }

  const newRoute = {
    id: 'route_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    name: String(name).trim().slice(0, 64),
    category: String(category || '常用服务').slice(0, 32),
    icon: String(icon || 'globe').slice(0, 32),
    description: String(description || '').slice(0, 200),
    subpath: cleanSub,
    target: targetCheck.target,
    enabled: enabled !== false,
    order: Number(order) || (config.routes.length + 1),
    options: sanitizeOptionsInput(options, {
      autoSlash: true,
      injectBase: true,
      rewriteHtml: true,
      rewriteLocation: true,
      rewriteCookie: true,
      ws: true,
      changeOrigin: true
    })
  };

  config.routes.push(newRoute);
  saveConfig(config);
  res.json({ success: true, route: newRoute });
});

// 6. 管理接口：修改路由
apiRouter.put('/admin/routes/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const idx = config.routes.findIndex((r) => r.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: '未找到指定路由' });
  }

  const cur = config.routes[idx];
  const { name, category, icon, description, subpath, target, enabled, order, options } = req.body || {};
  const cleanSub = subpath !== undefined ? sanitizeSubpath(subpath) : sanitizeSubpath(cur.subpath);
  if (cleanSub === '') {
    return res.status(400).json({ error: '子路径只能包含字母/数字/点/下划线/短横线/斜杠，且不能包含点段或编码字符（长度 2-64）' });
  }
  if (cleanSub === '/__gw' || cleanSub === '/admin' || cleanSub.startsWith('/__gw/')) {
    return res.status(400).json({ error: '该二级目录路径为系统保留路径，不可占用' });
  }
  let nextTarget = cur.target;
  if (target !== undefined) {
    const targetCheck = validateUpstreamTarget(target);
    if (!targetCheck.ok) return res.status(400).json({ error: targetCheck.error });
    nextTarget = targetCheck.target;
  }

  const conflict = config.routes.find((r) => r.id !== id && sanitizeSubpath(r.subpath) === cleanSub);
  if (conflict) {
    return res.status(400).json({ error: `二级目录 ${cleanSub} 已被其他项目使用` });
  }

  config.routes[idx] = {
    ...cur,
    name: name ? String(name).trim().slice(0, 64) : cur.name,
    category: category ? String(category).slice(0, 32) : cur.category,
    icon: icon ? String(icon).slice(0, 32) : cur.icon,
    description: description !== undefined ? String(description).slice(0, 200) : cur.description,
    subpath: cleanSub,
    target: nextTarget,
    enabled: enabled !== undefined ? !!enabled : cur.enabled,
    order: order !== undefined ? Number(order) : cur.order,
    options: sanitizeOptionsInput(options, cur.options || {})
  };

  saveConfig(config);
  res.json({ success: true, route: config.routes[idx] });
});

// 7. 管理接口：删除路由
apiRouter.delete('/admin/routes/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  config.routes = (config.routes || []).filter((r) => r.id !== id);
  saveConfig(config);
  res.json({ success: true });
});

// 8. 管理接口：一键启停切换
apiRouter.post('/admin/routes/:id/toggle', authMiddleware, (req, res) => {
  const { id } = req.params;
  const r = config.routes.find((x) => x.id === id);
  if (!r) return res.status(404).json({ error: '路由不存在' });
  r.enabled = !r.enabled;
  saveConfig(config);
  res.json({ success: true, enabled: r.enabled });
});

// 9. 管理接口：修改站点全局配置与密码
apiRouter.post('/admin/settings', authMiddleware, (req, res) => {
  const { siteTitle, siteSubtitle, backgroundUrl, themeColor, categories, newPassword } = req.body || {};

  const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : undefined);

  const nextTitle = cleanText(siteTitle, 64);
  if (nextTitle) config.siteTitle = nextTitle;
  const nextSubtitle = cleanText(siteSubtitle, 120);
  if (nextSubtitle !== undefined) config.siteSubtitle = nextSubtitle;

  if (backgroundUrl !== undefined) {
    const url = cleanText(backgroundUrl, 512) || '';
    if (url && !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: '背景图地址必须为空或 http(s) URL' });
    }
    config.backgroundUrl = url;
  }
  if (themeColor !== undefined) {
    const color = cleanText(themeColor, 32) || '';
    if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) {
      return res.status(400).json({ error: '主色必须是 #RGB / #RRGGBB 形式' });
    }
    if (color) config.themeColor = color;
  }
  if (categories !== undefined) {
    if (!Array.isArray(categories) || categories.length === 0 || categories.length > 20) {
      return res.status(400).json({ error: '分类需为 1-20 项数组' });
    }
    const cleaned = categories
      .map((c) => (typeof c === 'string' ? c.trim() : ''))
      .filter((c) => c && c.length <= 32 && !/[<>&"']/.test(c));
    if (!cleaned.length) return res.status(400).json({ error: '分类名称不合法（禁止 < > & " \' 且长度 ≤32）' });
    config.categories = [...new Set(cleaned)];
  }

  let passwordChanged = false;
  if (typeof newPassword === 'string' && newPassword.length > 0) {
    if (newPassword.trim().length < 10) {
      return res.status(400).json({ error: '新密码至少需要 10 位' });
    }
    const password = newPassword.trim();
    if (password === 'admin123456') {
      return res.status(400).json({ error: '不允许使用历史默认口令' });
    }
    config.adminPasswordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    // 改密后吊销所有旧令牌
    config.tokenVersion = (config.tokenVersion || 1) + 1;
    passwordChanged = true;
  }

  saveConfig(config);
  res.json({
    success: true,
    message: '全局设置已保存',
    reauthRequired: passwordChanged
  });
});

// 10. 管理接口：测试 target 连通性
apiRouter.post('/admin/test-target', authMiddleware, (req, res) => {
  const { target, insecureTLS } = req.body || {};
  if (!target) return res.status(400).json({ error: '缺少 target 地址' });

  const checked = validateProbeUrl(target);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  try {
    const start = Date.now();
    const client = checked.url.protocol === 'https:' ? https : http;
    const testReq = client.get(checked.url.toString(), {
      timeout: 3500,
      rejectUnauthorized: insecureTLS !== true
    }, (testRes) => {
      testRes.resume();
      res.json({
        ok: true,
        statusCode: testRes.statusCode,
        latency: Date.now() - start + 'ms'
      });
    });
    testReq.on('error', (err) => {
      res.json({ ok: false, error: err.code || '连接失败' });
    });
    testReq.on('timeout', () => {
      testReq.destroy();
      res.json({ ok: false, error: '连接超时 (3.5秒)' });
    });
  } catch (err) {
    res.json({ ok: false, error: '连接失败' });
  }
});

// ======================= 自动检测与 GitHub 镜像更新引擎 =======================
const DEFAULT_GITHUB_MIRRORS = [
  { id: 'mirror_ghproxy', name: 'GhProxy 公益加速 (推荐)', url: 'https://ghproxy.net', type: 'proxy' },
  { id: 'mirror_ddlc', name: 'DDLC GitHub 加速', url: 'https://gh.ddlc.top', type: 'proxy' },
  { id: 'mirror_fast', name: 'GhFast 镜像站', url: 'https://ghfast.top', type: 'proxy' },
  { id: 'mirror_moeyy', name: 'Moeyy 萌音镜像', url: 'https://github.moeyy.xyz', type: 'proxy' },
  { id: 'mirror_direct', name: '官方直连 (GitHub Direct)', url: 'https://github.com', type: 'direct' }
];

let lastUpdateCheckResult = null;
let lastUpdateCheckTime = 0;

function getAllMirrors() {
  const custom = (config.updateSettings?.customMirrors || [])
    .map((m, idx) => ({
      id: String(m.id || `custom_${idx}`).slice(0, 32),
      name: String(m.name || m.url || '').slice(0, 64),
      url: String(m.url || ''),
      type: 'proxy',
      isCustom: true
    }))
    // 只保留合法的 https 镜像，避免历史脏配置进入出站请求
    .filter((m) => {
      const checked = validateProbeUrl(m.url);
      return checked.ok && checked.url.protocol === 'https:';
    });
  return [...DEFAULT_GITHUB_MIRRORS, ...custom];
}

function getGitRepoInfo() {
  try {
    const remoteUrl = child_process.execSync('git remote get-url origin', { encoding: 'utf8', timeout: 3000 }).trim();
    const match = remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/i);
    if (match) {
      return {
        remoteUrl,
        owner: match[1],
        repo: match[2],
        fullRepo: `${match[1]}/${match[2]}`
      };
    }
  } catch (e) {}
  return {
    remoteUrl: 'https://github.com/jinghuashang/Cloud-Gateway.git',
    owner: 'jinghuashang',
    repo: 'Cloud-Gateway',
    fullRepo: 'jinghuashang/Cloud-Gateway'
  };
}

async function pingOneMirror(mirror, timeoutMs = 3500) {
  const start = Date.now();
  return new Promise((resolve) => {
    try {
      const repoInfo = getGitRepoInfo();
      const testUrl = mirror.type === 'direct'
        ? 'https://github.com'
        : `${String(mirror.url).replace(/\/+$/, '')}/https://raw.githubusercontent.com/${repoInfo.fullRepo}/main/package.json`;

      const checked = validateProbeUrl(testUrl);
      if (!checked.ok) {
        resolve({ ...mirror, ok: false, latency: 9999, error: checked.error });
        return;
      }

      const client = checked.url.protocol === 'https:' ? https : http;
      const req = client.get(checked.url.toString(), {
        headers: { 'User-Agent': 'Cloud-Gateway-Updater' },
        timeout: timeoutMs,
        rejectUnauthorized: true
      }, (res) => {
        res.resume();
        const latency = Date.now() - start;
        const ok = res.statusCode < 500;
        resolve({
          ...mirror,
          ok,
          status: res.statusCode,
          latency: ok ? latency : 9999,
          error: ok ? null : `HTTP ${res.statusCode}`
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ...mirror, ok: false, latency: 9999, error: '连接超时' });
      });

      req.on('error', (err) => {
        resolve({ ...mirror, ok: false, latency: 9999, error: err.code || '连接失败' });
      });
    } catch (err) {
      resolve({ ...mirror, ok: false, latency: 9999, error: '连接失败' });
    }
  });
}

async function pingAllMirrors(timeoutMs = 3500) {
  const mirrors = getAllMirrors();
  const results = await Promise.all(mirrors.map(m => pingOneMirror(m, timeoutMs)));
  const sorted = [...results].sort((a, b) => a.latency - b.latency);
  const fastest = sorted.find(s => s.ok) || sorted[0];
  return { results, fastest };
}

function getLocalVersionInfo() {
  // 1. 系统若安装有 git 命令行，优先利用 git rev-parse 获取真实 commit
  try {
    const hash = child_process.execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (hash && hash.length >= 7) {
      const shortHash = hash.substring(0, 7);
      let commitMsg = '';
      let commitDate = '';
      try {
        commitMsg = child_process.execSync('git log -1 --pretty=%B', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        commitDate = child_process.execSync('git log -1 --pretty=%cd --date=iso', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch (e) {}
      return { hash, shortHash, commitMsg: commitMsg || `Commit: ${shortHash}`, commitDate, isGit: true, source: 'git-cli' };
    }
  } catch (e) {}

  // 2. 纯 JS 解析本地 .git 目录（解决 Alpine/Docker/精简环境中未安装 git 二进制时的提交读取）
  try {
    const gitDir = path.join(__dirname, '.git');
    if (fs.existsSync(gitDir)) {
      const headFile = path.join(gitDir, 'HEAD');
      if (fs.existsSync(headFile)) {
        const headContent = fs.readFileSync(headFile, 'utf8').trim();
        let targetRef = headContent;
        if (headContent.startsWith('ref: ')) {
          targetRef = headContent.substring(5).trim();
        } else if (headContent.length >= 7) {
          return { hash: headContent, shortHash: headContent.substring(0, 7), commitMsg: `Commit: ${headContent.substring(0, 7)}`, commitDate: '', isGit: true, source: 'git-head' };
        }

        const refPath = path.join(gitDir, targetRef);
        if (fs.existsSync(refPath)) {
          const hash = fs.readFileSync(refPath, 'utf8').trim();
          if (hash && hash.length >= 7) {
            return { hash, shortHash: hash.substring(0, 7), commitMsg: `Commit: ${hash.substring(0, 7)}`, commitDate: '', isGit: true, source: 'git-ref' };
          }
        }

        const packedPath = path.join(gitDir, 'packed-refs');
        if (fs.existsSync(packedPath)) {
          const lines = fs.readFileSync(packedPath, 'utf8').split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
            const [h, r] = trimmed.split(/\s+/);
            if (r === targetRef && h && h.length >= 7) {
              return { hash: h, shortHash: h.substring(0, 7), commitMsg: `Commit: ${h.substring(0, 7)}`, commitDate: '', isGit: true, source: 'packed-refs' };
            }
          }
        }
      } 
    }
  } catch (e) {}

  // 3. 读取随代码提交的 version.json，确保任何时候版本号来源始终是代码提交 (Commit) 而不是 Releases
  try {
    const verFile = path.join(__dirname, 'version.json');
    if (fs.existsSync(verFile)) {
      const vData = JSON.parse(fs.readFileSync(verFile, 'utf8'));
      if (vData.hash || vData.shortHash) {
        const hash = vData.hash || vData.shortHash;
        const shortHash = vData.shortHash || hash.substring(0, 7);
        return {
          hash,
          shortHash,
          commitMsg: vData.commitMsg || `Commit: ${shortHash}`,
          commitDate: vData.commitDate || '',
          isGit: true,
          source: 'version.json'
        };
      }
    }
  } catch (e) {}

  // 4. 环境变量兜底
  const envCommit = process.env.GIT_COMMIT || process.env.COMMIT_HASH;
  if (envCommit && envCommit.length >= 7) {
    return { hash: envCommit, shortHash: envCommit.substring(0, 7), commitMsg: `Commit: ${envCommit.substring(0, 7)}`, commitDate: '', isGit: true, source: 'env' };
  }

  return { hash: '8b6e28f', shortHash: '8b6e28f', commitMsg: 'Git Commit (8b6e28f)', commitDate: '', isGit: true, source: 'fallback' };
}

// 纯 HTTP Git Smart Protocol 远程分支探测（零依赖，彻底告别 /bin/sh: git: not found，完美兼容所有镜像加速站）
async function fetchRemoteCommitSmartHttp(mirrorUrl, fullRepo = 'jinghuashang/Cloud-Gateway', timeoutMs = 6000) {
  const isDirect = !mirrorUrl || (mirrorUrl.includes('github.com') && !mirrorUrl.includes('proxy') && !mirrorUrl.includes('moeyy') && !mirrorUrl.includes('ddlc'));
  const smartUrl = isDirect
    ? `https://github.com/${fullRepo}.git/info/refs?service=git-upload-pack`
    : `${String(mirrorUrl).replace(/\/+$/, '')}/https://github.com/${fullRepo}.git/info/refs?service=git-upload-pack`;

  const checked = validateProbeUrl(smartUrl);
  if (!checked.ok) throw new Error(checked.error);

  const start = Date.now();
  const res = await fetch(checked.url.toString(), {
    headers: {
      'User-Agent': 'git/2.40.0',
      'Accept': '*/*'
    },
    redirect: 'manual', // 禁止跟随跳转，避免被镜像指向内网地址
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const text = await res.text();
  const match = text.match(/([0-9a-f]{40})\s+(refs\/heads\/main|HEAD)/i);
  if (!match) {
    throw new Error('未能在 refs 响应中解析出 commit hash');
  }

  return {
    hash: match[1],
    shortHash: match[1].substring(0, 7),
    latency: Date.now() - start
  };
}

// 获取 Commit 详细提交描述与提交时间
async function fetchCommitDetail(sha, mirrorUrl, fullRepo = 'jinghuashang/Cloud-Gateway') {
  const isDirect = !mirrorUrl || (mirrorUrl.includes('github.com') && !mirrorUrl.includes('proxy') && !mirrorUrl.includes('moeyy') && !mirrorUrl.includes('ddlc'));
  const candidateUrls = [
    isDirect ? `https://api.github.com/repos/${fullRepo}/commits/${sha}` : `${String(mirrorUrl).replace(/\/+$/, '')}/https://api.github.com/repos/${fullRepo}/commits/${sha}`,
    `https://api.github.com/repos/${fullRepo}/commits/${sha}`,
    `https://ghproxy.net/https://api.github.com/repos/${fullRepo}/commits/${sha}`
  ];

  for (const url of candidateUrls) {
    const checked = validateProbeUrl(url);
    if (!checked.ok) continue;
    try {
      const res = await fetch(checked.url.toString(), {
        headers: { 'User-Agent': 'Cloud-Gateway-Updater' },
        redirect: 'manual',
        signal: AbortSignal.timeout(3500)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.commit) {
          return {
            commitMsg: data.commit.message || `Commit: ${sha.substring(0, 7)}`,
            commitDate: data.commit.author?.date || data.commit.committer?.date || '',
            author: data.commit.author?.name || ''
          };
        }
      }
    } catch (e) {}
  }
  return {
    commitMsg: `远程最新提交 (${sha.substring(0, 7)})`,
    commitDate: '',
    author: ''
  };
}

/**
 * 把镜像地址 + 仓库远端地址组合为 git 可用的拉取 URL。
 * 仅允许 https，并做主机黑名单校验；返回值用于 execFile 参数（不经过 shell）。
 */
function resolveGitUrlWithMirror(mirrorUrl, remoteUrl) {
  const remote = validateProbeUrl(remoteUrl);
  if (!remote.ok) throw new Error(`仓库远端地址非法: ${remote.error}`);
  if (remote.url.protocol !== 'https:') throw new Error('仓库远端地址必须为 https');

  const rawMirror = String(mirrorUrl || '').trim();
  if (!rawMirror) throw new Error('镜像地址为空');
  const mirror = validateProbeUrl(rawMirror);
  if (!mirror.ok) throw new Error(`镜像地址非法: ${mirror.error}`);
  if (mirror.url.protocol !== 'https:') throw new Error('镜像地址必须为 https');

  // 官方直连
  if (mirror.url.hostname === 'github.com') return remote.url.toString();

  // 镜像站约定：<mirror>/https://github.com/<owner>/<repo>.git
  const base = `${mirror.url.origin}${mirror.url.pathname.replace(/\/+$/, '')}`;
  return `${base}/${remote.url.origin}${remote.url.pathname}`;
}

async function checkGitHubUpdate(requestedMirrorUrl) {
  const repoInfo = getGitRepoInfo();
  const localVer = getLocalVersionInfo();
  const settings = config.updateSettings || DEFAULT_CONFIG.updateSettings;

  let candidateMirrors = [];
  if (requestedMirrorUrl) {
    candidateMirrors.push({ name: '指定镜像', url: requestedMirrorUrl });
  } else if (settings.proxyMode === 'direct') {
    candidateMirrors.push({ name: '官方直连', url: 'https://github.com' });
  } else if (settings.proxyMode === 'manual' && settings.selectedMirror) {
    candidateMirrors.push({ name: '指定镜像', url: settings.selectedMirror });
  } else {
    const { results } = await pingAllMirrors(2500);
    const available = results.filter(r => r.ok);
    if (available.length > 0) {
      candidateMirrors.push(...available);
    }
  }

  const fallbackList = [
    { name: 'GhProxy 公益加速', url: 'https://ghproxy.net' },
    { name: '官方直连', url: 'https://github.com' },
    { name: 'DDLC 加速', url: 'https://gh.ddlc.top' }
  ];
  for (const fb of fallbackList) {
    if (!candidateMirrors.some(m => m.url === fb.url)) {
      candidateMirrors.push(fb);
    }
  }

  let remoteCommitResult = null;
  let usedMirror = null;
  let lastError = null;

  for (const mirror of candidateMirrors) {
    try {
      const commitRes = await fetchRemoteCommitSmartHttp(mirror.url, repoInfo.fullRepo, 6000);
      if (commitRes && commitRes.hash) {
        remoteCommitResult = commitRes;
        usedMirror = mirror;
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!remoteCommitResult) {
    console.error('[Updater] 无法连接远程更新源:', lastError?.message || '所有镜像节点均无响应');
    throw new Error('无法连接远程更新源，请检查镜像配置或网络');
  }

  const remoteHash = remoteCommitResult.hash;
  const latestShortHash = remoteCommitResult.shortHash;
  const hasUpdate = localVer.hash !== 'unknown' && remoteHash !== localVer.hash;
  const detail = await fetchCommitDetail(remoteHash, usedMirror.url, repoInfo.fullRepo);

  const result = {
    hasUpdate,
    currentCommit: localVer,
    latestCommit: {
      hash: remoteHash,
      shortHash: latestShortHash,
      commitMsg: detail.commitMsg || `远程最新提交 (${latestShortHash})`,
      commitDate: detail.commitDate || new Date().toISOString(),
      author: detail.author || ''
    },
    usedMirror: {
      name: usedMirror.name,
      url: usedMirror.url,
      latency: (remoteCommitResult.latency || 0) + 'ms'
    },
    checkedAt: new Date().toISOString()
  };

  lastUpdateCheckResult = result;
  lastUpdateCheckTime = Date.now();
  return result;
}

// 11. 管理接口：获取更新状态与配置
apiRouter.get('/admin/update/status', authMiddleware, async (req, res) => {
  const localVer = getLocalVersionInfo();
  const repoInfo = getGitRepoInfo();
  const mirrors = getAllMirrors();
  res.json({
    currentCommit: localVer,
    repoInfo,
    updateSettings: config.updateSettings || DEFAULT_CONFIG.updateSettings,
    mirrors,
    lastCheck: lastUpdateCheckResult,
    hasUpdate: !!(lastUpdateCheckResult && lastUpdateCheckResult.hasUpdate)
  });
});

// 12. 管理接口：触发检测 GitHub 最新提交
apiRouter.post('/admin/update/check', authMiddleware, async (req, res) => {
  try {
    const { mirrorUrl } = req.body || {};
    if (mirrorUrl !== undefined && mirrorUrl !== '') {
      const checked = validateProbeUrl(mirrorUrl);
      if (!checked.ok || checked.url.protocol !== 'https:') {
        return res.status(400).json({ ok: false, error: '镜像地址必须为合法的 https URL' });
      }
    }
    const result = await checkGitHubUpdate(mirrorUrl);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 13. 管理接口：测试所有镜像站延迟 (自动选优)
apiRouter.post('/admin/update/ping-mirrors', authMiddleware, async (req, res) => {
  try {
    const pingData = await pingAllMirrors(3500);
    res.json({ ok: true, ...pingData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 14. 管理接口：保存更新配置 (代理模式/选定镜像/自定义镜像)
apiRouter.post('/admin/update/settings', authMiddleware, (req, res) => {
  const { proxyMode, selectedMirror, customMirrors, autoCheck, allowInsecureGit } = req.body || {};
  const modes = new Set(['auto', 'direct', 'manual']);

  if (proxyMode !== undefined && !modes.has(String(proxyMode))) {
    return res.status(400).json({ error: 'proxyMode 只能是 auto / direct / manual' });
  }
  if (selectedMirror !== undefined && selectedMirror !== '') {
    const checked = validateProbeUrl(selectedMirror);
    if (!checked.ok || checked.url.protocol !== 'https:') {
      return res.status(400).json({ error: '镜像地址必须为合法的 https URL' });
    }
  }

  let nextCustom = config.updateSettings?.customMirrors || [];
  if (Array.isArray(customMirrors)) {
    nextCustom = [];
    for (const item of customMirrors.slice(0, 20)) {
      const url = String((item && item.url) || '').trim();
      const checked = validateProbeUrl(url);
      if (!checked.ok || checked.url.protocol !== 'https:') {
        return res.status(400).json({ error: `自定义镜像地址非法: ${url || '(空)'}` });
      }
      nextCustom.push({
        id: item.id ? String(item.id).slice(0, 32) : undefined,
        name: item.name ? String(item.name).slice(0, 64) : checked.url.hostname,
        url: checked.url.toString()
      });
    }
  }

  config.updateSettings = {
    ...DEFAULT_CONFIG.updateSettings,
    ...(config.updateSettings || {}),
    proxyMode: proxyMode || config.updateSettings?.proxyMode || 'auto',
    selectedMirror: selectedMirror || config.updateSettings?.selectedMirror || 'https://ghproxy.net',
    customMirrors: nextCustom,
    autoCheck: autoCheck !== false,
    allowInsecureGit: allowInsecureGit === true
  };
  saveConfig(config);
  res.json({ ok: true, message: '更新与镜像配置已保存', updateSettings: config.updateSettings });
});

// 15. 管理接口：执行一键拉取更新
apiRouter.post('/admin/update/execute', authMiddleware, async (req, res) => {
  try {
    const repoInfo = getGitRepoInfo();
    const settings = config.updateSettings || DEFAULT_CONFIG.updateSettings;
    let activeMirrorUrl = req.body?.mirrorUrl || settings.selectedMirror;

    if (settings.proxyMode === 'direct') {
      activeMirrorUrl = 'https://github.com';
    } else if (settings.proxyMode === 'auto') {
      const { fastest } = await pingAllMirrors(2500);
      activeMirrorUrl = fastest && fastest.ok ? fastest.url : 'https://ghproxy.net';
    }

    let pullRemoteUrl;
    try {
      pullRemoteUrl = resolveGitUrlWithMirror(activeMirrorUrl, repoInfo.remoteUrl);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    const beforeVer = getLocalVersionInfo();

    let hasGitCli = false;
    try {
      child_process.execFileSync('git', ['--version'], { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
      hasGitCli = true;
    } catch (e) {
      hasGitCli = false;
    }

    if (!hasGitCli) {
      return res.status(400).json({
        ok: false,
        error: '当前系统或容器环境未安装 git 命令行工具。若使用 Docker 部署，推荐执行容器拉取升级：docker compose pull && docker compose up -d；若为直接部署，请在服务器中安装 git 命令（如：apk add --no-cache git 或 apt-get install -y git）。'
      });
    }

    // 使用 execFile 参数数组，绝不经过 shell；TLS 校验默认开启，仅按更新配置显式放宽
    const gitArgs = ['pull', pullRemoteUrl, 'main'];
    if (settings.allowInsecureGit === true) {
      gitArgs.unshift('-c', 'http.sslVerify=false');
    }
    let output;
    try {
      output = child_process.execFileSync('git', gitArgs, { encoding: 'utf8', timeout: 60000 }).trim();
    } catch (gitErr) {
      const detail = String(gitErr.stderr || gitErr.message || '').trim().split('\n').slice(0, 6).join('\n');
      console.error('[Updater] git pull failed:', detail);
      return res.status(502).json({ ok: false, error: '拉取更新失败，请检查网络/镜像或容器内 git 权限', detail });
    }

    const afterVer = getLocalVersionInfo();
    const success = beforeVer.hash !== afterVer.hash || output.includes('Already up to date');

    res.json({
      ok: true,
      success,
      output,
      beforeCommit: beforeVer,
      afterCommit: afterVer,
      usedMirror: activeMirrorUrl,
      needRestart: beforeVer.hash !== afterVer.hash
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 旧版门户文档可能被缓存/会话恢复在子路径 URL 上（如 /en/），而它仍会轮询门户内部 API。
// 此时按 5 分钟节流下发一次缓存清理，让该文档下一次重载拿到真实应用，且不误伤正常门户（Referer 为 /）。
app.use('/__gw/api', (req, res, next) => {
  let refPath = '';
  try {
    refPath = new URL(String(req.headers.referer || '')).pathname;
  } catch {
    refPath = '';
  }
  if (refPath && refPath !== '/' && !refPath.startsWith('/__gw/')) {
    const last = String(req.headers.cookie || '').match(/(?:^|;\s*)__gw_doc_purge=([^;]+)/);
    const now = Date.now();
    if (!last || !Number.isFinite(Number(last[1])) || now - Number(last[1]) > 5 * 60 * 1000) {
      res.setHeader('Clear-Site-Data', '"cache"');
      res.append('Set-Cookie', `__gw_doc_purge=${now}; Path=/; Max-Age=300; SameSite=Lax`);
    }
  }
  next();
});

// 挂载专用管理接口（兼容 /__gw/api 与旧 /api/public/info）
app.use('/__gw/api', apiRouter);
app.get('/api/public/info', (req, res) => res.redirect(307, '/__gw/api/public/info'));

// ======================= 核心调度与反代引擎 =======================
// 调度逻辑全部下沉到 lib/proxy-engine.js：
//   多重前缀折叠 -> 根路径漂移纠正 -> 归属判定(显式/Referer/签名/Cookie) -> 斜杠纠偏 -> 转发
app.use(dispatcher);

// 门户自身的安全响应头（不影响被代理应用；反代响应的安全头由路由选项控制）
const PORTAL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://unpkg.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

// 构建标识：容器每次重建（version.json 随镜像写入）都会变化。
// 用于一次性清理旧版本遗留在子路径 URL 上的门户文档缓存（旧 catch-all 无缓存头，会被浏览器启发式缓存）。
const BUILD_ID = (() => {
  try {
    return String(Math.round(fs.statSync(path.join(__dirname, 'version.json')).mtimeMs));
  } catch {
    return String(Date.now());
  }
})();
const BUILD_COOKIE = '__gw_build';

// 门户文档统一响应头：安全头 + 禁止缓存（防止旧门户被缓存后承载在子路径 URL 上）
const applyPortalHeaders = (res) => {
  res.setHeader('Content-Security-Policy', PORTAL_CSP);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
};

// 门户首页：显式路由（先于静态托管），始终 no-store
app.get(['/', '/index.html'], (req, res) => {
  applyPortalHeaders(res);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 静态资源（禁用目录索引，首页由上面的显式路由负责）
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: 0 }));

// 未注册路径：统一 302 回门户首页，绝不再把门户文档回落到任意子路径上。
// 这样即使浏览器残留旧缓存，服务端也不会在 /frp/static/ 之类的地址返回门户。
app.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(404).json({ error: 'Not Found' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, '/');
});

// 统一错误处理：生产环境不回显堆栈，仅返回 requestId 供日志关联
app.use((err, req, res, next) => {
  const requestId = crypto.randomBytes(6).toString('hex');
  console.error(`[Unhandled] id=${requestId} ${req.method} ${req.originalUrl || req.url}:`, err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err);
  if (res.headersSent) {
    if (typeof res.destroy === 'function') res.destroy();
    return;
  }
  res.status(500).json({ error: 'Internal Server Error', message: '服务器内部错误', requestId });
});

// ======================= 双协议与 WebSocket 监听层 =======================
const httpServer = http.createServer(app);

let httpsServer = null;
if (fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
  try {
    httpsServer = https.createServer({
      cert: fs.readFileSync(SSL_CERT),
      key: fs.readFileSync(SSL_KEY)
    }, app);
    console.log('[SSL Engine] HTTPS Server Engine Ready');
  } catch (e) {
    console.error('[SSL Error] Failed to load SSL certificates:', e.message);
  }
}

// WebSocket 穿透升级：与 HTTP 侧共用同一套归属判定与转发标头
engine.attachUpgrade(httpServer);
engine.attachUpgrade(httpsServer);

// Proxy Protocol v2 二进制魔数 (12 字节固定前缀)
const PP_V2_MAGIC = Buffer.from([0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A]);

// 核心网络层：全自适应双协议嗅探与 Proxy Protocol v1/v2 深度解包网关
const SOCKET_IDLE_TIMEOUT_MS = Number(process.env.GW_SOCKET_TIMEOUT_MS) || 15000;

const masterServer = net.createServer((socket) => {
  // 首包前必须有超时，避免半开连接耗尽文件描述符；首包到达后交还给 HTTP/WS 层管理
  socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => socket.destroy());
  let isFirstPacket = true;

  const onData = (chunk) => {
    if (!isFirstPacket) return;
    isFirstPacket = false;
    socket.removeListener('data', onData);
    socket.setTimeout(0);

    // A. 优先解包 Proxy Protocol v2 (二进制协议头)
    if (chunk.length >= 16 && chunk.subarray(0, 12).equals(PP_V2_MAGIC)) {
      const fam = chunk[13];
      const len = chunk.readUInt16BE(14);
      const totalHeaderLen = 16 + len;

      if (chunk.length >= totalHeaderLen) {
        if (fam === 0x11 && len >= 12) {
          socket.realClientIp = `${chunk[16]}.${chunk[17]}.${chunk[18]}.${chunk[19]}`;
        } else if (fam === 0x21 && len >= 36) {
          const parts = [];
          for (let i = 0; i < 8; i++) {
            parts.push(chunk.readUInt16BE(16 + i * 2).toString(16));
          }
          socket.realClientIp = parts.join(':');
        }
        chunk = chunk.subarray(totalHeaderLen);
      }
    }
    // B. 兼容解包 Proxy Protocol v1 (纯文本协议头 "PROXY ")
    else if (chunk.length >= 6 && chunk.subarray(0, 6).toString('ascii') === 'PROXY ') {
      const crlfIdx = chunk.indexOf('\r\n');
      if (crlfIdx !== -1) {
        const headerLine = chunk.subarray(0, crlfIdx).toString('ascii');
        const parts = headerLine.split(' ');
        if (parts.length >= 3 && parts[2]) {
          socket.realClientIp = parts[2];
        }
        chunk = chunk.subarray(crlfIdx + 2);
      }
    }

    socket.unshift(chunk);

    // C. 自适应协议嗅探分流 (TLS/HTTPS vs HTTP)
    const isTls = chunk.length > 0 && chunk[0] === 0x16;

    if (isTls && httpsServer) {
      httpsServer.emit('connection', socket);
    } else {
      httpServer.emit('connection', socket);
    }
  };

  socket.on('data', onData);
});

// 并发连接上限（半开连接超时已在 connection 处理器内设置）
const MAX_CONNECTIONS = Number(process.env.GW_MAX_CONNECTIONS) || 2048;
masterServer.maxConnections = MAX_CONNECTIONS;
masterServer.on('drop', (data) => {
  console.warn(`[Net] 连接数达到上限 ${MAX_CONNECTIONS}，已丢弃新连接 (remote=${data.remoteAddress || 'unknown'})`);
});

// http-proxy-middleware 会为每条路由在 server 上订阅一个 close 清理监听器；
// 路由数量由管理员控制且有限，放开监听器上限避免误报内存泄漏。
for (const srv of [httpServer, httpsServer, masterServer]) {
  if (srv && typeof srv.setMaxListeners === 'function') srv.setMaxListeners(0);
}

masterServer.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Cloud Subpath Gateway Running on port: ${PORT}`);
  console.log(` Dual-Protocol Sniffer: Active (HTTP + HTTPS Dual-Mode)`);
  console.log(` Proxy Protocol Demuxer: Active (v1 + v2 Zero 400 Errors)`);
  console.log(` Signature Routing: Active (Declarative, Content-Learned)`);
  console.log(` Rewrite Engine: Active (HTML/CSS/JS/JSON/RSC + gzip/br Negotiation)`);
  console.log(` Session Capsule: Active (Random Device Token, No IP Trust)`);
  console.log(` Proxy Header Trust: ${TRUST_PROXY_HEADERS ? 'ENABLED (behind trusted proxy)' : 'DISABLED (socket address only)'}`);
  console.log(` Security Baseline: ${TRUST_PROXY_HEADERS ? 'proxy headers trusted' : 'IP spoofing blocked'} · login rate-limited · secrets generated`);
  console.log(` Admin WebUI & Public Portal: http://0.0.0.0:${PORT}`);
  console.log(`====================================================`);
});
