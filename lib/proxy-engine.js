'use strict';

/**
 * ============================================================================
 * Cloud Gateway · 二级目录反代引擎 (Subpath Proxy Engine)
 * ============================================================================
 * 职责边界：
 *   1. 路由运行时 (RouteRuntime)：单条二级目录路由的选项归一化、根路径白名单
 *      自学习、响应体/响应头重写编排。
 *   2. 调度层：显式子路径 -> Referer 归属 -> 声明式/自学习签名 -> 会话 Cookie
 *      的四级归属判定，取代此前写死在调度函数里的 800 行特征路径 if-else。
 *   3. WebSocket 升级：与 HTTP 共用同一套归属判定与转发标头，避免两套逻辑漂移。
 *
 * 归属判定的设计取舍：路径证据优先、歧义不猜测。多个应用都声明同一个根路径
 * （例如 /api）时不硬指给某一方，而是交回 Referer / 会话 Cookie 判定，
 * 避免社区里常见的"同域多服务互相踩踏"。
 * ============================================================================
 */

const httpProxy = require('http-proxy');
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const rewriter = require('./text-rewriter');

/** 固定公网主机名（可选）：设置后上游看到的 X-Forwarded-Host 不再取决于客户端 Host 头 */
const PUBLIC_HOST = String(process.env.GW_PUBLIC_HOST || '').trim();

/** 客户端可伪造、必须由网关清除后重写的请求头 */
const CLIENT_UNTRUSTED_HEADERS = [
  'x-original-uri', 'x-rewrite-url', 'x-authenticated-user', 'x-remote-user',
  'x-real-ip', 'remote-host', 'x-forwarded-for', 'x-forwarded-proto',
  'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-prefix'
];

/** 从 Cookie 头中读取指定 Cookie 值 */
function readCookieValue(cookieHeader, name) {
  if (!cookieHeader) return '';
  const match = String(cookieHeader).match(new RegExp(`(?:^|;\\s*)${rewriter.escapeRegExp(name)}=([^;]*)`));
  return match ? match[1] : '';
}

/**
 * 确保请求携带网关签发的随机胶囊设备令牌。
 * 首次访问时生成（响应期回写 Cookie），此后以该令牌而非 IP 作为胶囊键。
 */
function ensureCapsuleId(req) {
  if (req.__gwCapsuleId) return req.__gwCapsuleId;
  const existing = readCookieValue(req.headers['cookie'], CAPSULE_COOKIE).trim();
  if (/^[A-Za-z0-9._~-]{8,64}$/.test(existing)) {
    req.__gwCapsuleId = existing;
    return existing;
  }
  const id = crypto.randomBytes(24).toString('base64url');
  req.__gwCapsuleId = id;
  req.__gwCapsuleNeedsCookie = true;
  return id;
}

// ======================= 应用画像（内置 + 配置可扩展） =======================
// 画像 = 某个应用在二级目录下所需的一组补丁（签名路径、漂移路径、深度补全白名单、
// 会话胶囊、垫片开关等）。历史版本把这些写死在调度函数里；现在它们是按名字注册的
// 数据：内置画像保证既有部署行为不变，config.profiles 可新增/覆盖/按子路径绑定。
//
// 绑定优先级（由 RouteRuntime 解析）：
//   1. options.profile = '<name>'  -> 精确指定（'none' 表示不使用任何画像）
//   2. config.profiles['<subpath>'] -> 配置里按子路径覆盖内置绑定
//   3. 内置子路径绑定表            -> 兼容历史行为
const UMAMI_DEEP_ROOTS = ['admin', 'websites', 'dashboard', 'reports', 'settings', 'login', 'api', '_next'];

const BUILTIN_PROFILES = {
  umami: {
    label: 'Umami (Next.js App Router)',
    signatures: [
      '/_next', '/api/admin', '/api/users', '/api/me', '/api/config',
      '/api/auth/verify', '/api/auth/subscription', '/api/auth/sso',
      '/api/websites', '/api/send', '/api/reports', '/api/teams', '/api/dashboard',
      '/api/realtime', '/api/record', '/api/share', '/api/2fa', '/api/batch', '/api/heartbeat'
    ],
    drift: ['admin', 'websites', 'dashboard', 'reports', 'settings', 'login'],
    deepRoots: UMAMI_DEEP_ROOTS,
    deepByDefault: true,
    shimAlways: true,
    noBase: true,
    jsPatches: 'umami'
  },
  orp: {
    label: 'Umami 兼容别名 (仅深度补全)',
    deepRoots: UMAMI_DEEP_ROOTS,
    deepByDefault: true
  },
  v2raya: {
    label: 'v2rayA',
    signatures: [
      '/api/outbounds', '/api/touch', '/api/routing', '/api/inbounds', '/api/subscribe',
      '/api/message', '/api/v2ray', '/api/version', '/api/account', '/api/connection',
      '/api/customPac', '/api/dnsList', '/api/domainsExcluded', '/api/gfwList',
      '/api/remoteGFWListVersion', '/api/sharingAddress', '/api/siteDatFiles'
    ],
    storageIsolation: true
  },
  entari: {
    label: 'Entari',
    signatures: [
      '/api/llm-chat', '/api/plugin-workshop', '/api/extensions', '/api/menus',
      '/api/health', '/api/marketplace', '/extension',
      '/api/auth/login', '/api/auth/check'
    ],
    sessionCapsule: {
      cookie: 'webui_sid',
      paths: ['/page']
    }
  },
  kuma: {
    label: 'Uptime Kuma',
    signatures: ['/socket.io']
  },
  frp: {
    label: 'FRP 控制台',
    signatures: ['/api/proxy', '/api/serverinfo'],
    // frp 0.67 dashboard 的 UI 根是 /static/，HTML 内资源为相对路径，必须以 /<子路径>/static/ 作为 base
    staticBase: true
  },
  newapi: {
    label: 'New API',
    signatures: ['/api/status', '/api/notice', '/api/user/self', '/api/channel', '/api/token']
  },
  synctv: {
    label: 'SyncTV',
    syncTvRouter: true
  }
};

/** 历史子路径 -> 内置画像名（保证老配置零改动继续工作） */
const BUILTIN_SUBPATH_PROFILES = {
  '/um': 'umami',
  '/orp': 'orp',
  '/v2': 'v2raya',
  '/en': 'entari',
  '/kuma': 'kuma',
  '/frp': 'frp',
  '/newapi': 'newapi',
  '/live': 'synctv'
};

const PROFILE_FLAGS = [
  'deepByDefault', 'noBase', 'shimAlways', 'storageIsolation', 'staticBase', 'syncTvRouter'
];
const PROFILE_LIST_KEYS = ['signatures', 'drift', 'deepRoots'];

/** 子路径允许的字符集：单个路径段/多段，禁止引号、尖括号、空白、反斜杠、编码字符与点段 */
const SUBPATH_RE = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const SEGMENT_LIST_RE = /^[A-Za-z0-9._~-]{1,32}$/;
const SIGNATURE_RE = /^\/[A-Za-z0-9._~/-]*$/;
const PROFILE_VALUE_RE = /^[A-Za-z0-9._~-]{1,32}$/;
const REFERRER_POLICY_VALUES = new Set([
  'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin',
  'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url', 'keep'
]);

/** 画像输入归一化：只接受已知字段，配置写错也不会影响代理主流程 */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const profile = {};
  if (typeof raw.label === 'string' && raw.label.trim()) profile.label = raw.label.trim().slice(0, 64);
  for (const key of PROFILE_LIST_KEYS) {
    if (!Array.isArray(raw[key])) continue;
    const list = raw[key]
      .map((v) => String(v).trim())
      .filter((v) => {
        if (!v || v.includes('..') || v.includes('//')) return false;
        // drift/deepRoots 是单个路径段；signatures 是根前缀（以 / 开头）
        if (key === 'deepRoots' || key === 'drift') return !v.includes('/') && SEGMENT_LIST_RE.test(v);
        return SIGNATURE_RE.test(v);
      });
    if (list.length) profile[key] = [...new Set(list)];
  }
  for (const flag of PROFILE_FLAGS) {
    if (raw[flag] === true) profile[flag] = true;
  }
  if (raw.jsPatches === 'umami') profile.jsPatches = 'umami';
  if (raw.sessionCapsule && typeof raw.sessionCapsule === 'object' && raw.sessionCapsule.cookie) {
    const cookie = String(raw.sessionCapsule.cookie).trim();
    // Cookie 名会被拼进 RegExp 与 Set-Cookie 头，必须严格限定为 RFC 6265 token
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(cookie)) return profile;
    const paths = Array.isArray(raw.sessionCapsule.paths)
      ? raw.sessionCapsule.paths.map((p) => String(p).trim()).filter((p) => p.startsWith('/') && p.length <= 64)
      : [];
    profile.sessionCapsule = {
      cookie,
      paths: paths.length ? paths : ['/page']
    };
  }
  return profile;
}

const NORMALIZED_BUILTINS = Object.fromEntries(
  Object.entries(BUILTIN_PROFILES).map(([name, profile]) => [name, normalizeProfile(profile)])
);

/**
 * 解析某条路由最终生效的画像。
 * @returns {{ name: string, profile: object, unknown?: string }}
 */
function resolveProfile({ requested, subpath, configProfiles }) {
  const custom = configProfiles && typeof configProfiles === 'object' ? configProfiles : {};
  const hasCustom = (key) => Object.prototype.hasOwnProperty.call(custom, key);

  if (typeof requested === 'string' && requested.trim()) {
    const name = requested.trim();
    if (name === 'none') return { name: 'none', profile: {} };
    if (hasCustom(name)) return { name, profile: normalizeProfile(custom[name]) };
    if (Object.prototype.hasOwnProperty.call(NORMALIZED_BUILTINS, name)) {
      return { name, profile: NORMALIZED_BUILTINS[name] };
    }
    return { name: 'none', profile: {}, unknown: name };
  }

  if (hasCustom(subpath)) return { name: subpath, profile: normalizeProfile(custom[subpath]) };
  const builtinName = BUILTIN_SUBPATH_PROFILES[subpath];
  if (builtinName && NORMALIZED_BUILTINS[builtinName]) {
    return { name: builtinName, profile: NORMALIZED_BUILTINS[builtinName] };
  }
  return { name: 'none', profile: {} };
}

/** 供管理接口展示：内置画像、子路径绑定表、配置自定义画像（含被哪些路由引用） */
function describeProfiles(configProfiles, routes) {
  const custom = configProfiles && typeof configProfiles === 'object' ? configProfiles : {};
  const usage = new Map();
  for (const route of routes || []) {
    const subpath = sanitizeSubpath(route.subpath);
    const resolved = resolveProfile({ requested: (route.options || {}).profile, subpath, configProfiles: custom });
    if (!resolved.name || resolved.name === 'none') continue;
    if (!usage.has(resolved.name)) usage.set(resolved.name, []);
    usage.get(resolved.name).push(subpath || '?');
  }

  const customEntries = Object.entries(custom).map(([name, raw]) => {
    const profile = normalizeProfile(raw);
    return {
      name,
      label: profile.label || name,
      boundBySubpath: name.startsWith('/'),
      usedBy: usage.get(name) || [],
      summary: profileSummary(profile),
      fields: profile
    };
  });

  return {
    builtins: Object.entries(NORMALIZED_BUILTINS).map(([name, profile]) => ({
      name,
      label: profile.label || name,
      subpaths: Object.entries(BUILTIN_SUBPATH_PROFILES).filter(([, v]) => v === name).map(([k]) => k),
      usedBy: usage.get(name) || [],
      summary: profileSummary(profile),
      fields: profile
    })),
    custom: customEntries
  };
}

const PROFILE_NAME_RE = /^[A-Za-z0-9._/-]{1,48}$/;

/**
 * 管理接口写入画像前的校验与归一化。
 * @returns {{ ok: boolean, error?: string, name?: string, profile?: object }}
 */
function sanitizeProfileInput(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '画像内容必须是对象' };
  const name = String(raw.name || '').trim();
  if (!name) return { ok: false, error: '画像名不能为空' };
  if (!PROFILE_NAME_RE.test(name) || name.includes('//')) {
    return { ok: false, error: '画像名只能包含字母/数字/点/下划线/短横线/斜杠（1-48 位，斜杠仅用于按子路径绑定）' };
  }
  if (name === 'none' || name === 'auto') return { ok: false, error: `"${name}" 是保留名，请换一个` };
  if (name.includes('/') && !name.startsWith('/')) return { ok: false, error: '按子路径绑定的画像名必须以 / 开头' };

  const profile = normalizeProfile(raw);
  const substantial = Object.keys(profile).filter((key) => key !== 'label');
  if (!substantial.length) {
    return { ok: false, error: '画像至少需要一项配置（签名路径 / 漂移路径 / 深度补全根 / 开关 / 补丁）' };
  }
  if (!profile.label) profile.label = name;
  return { ok: true, name, profile };
}

function profileSummary(profile) {
  const flags = [];
  if (profile.deepByDefault) flags.push('深度补全默认开启');
  if (profile.shimAlways) flags.push('强制注入垫片');
  if (profile.noBase) flags.push('不注入 base');
  if (profile.storageIsolation) flags.push('localStorage 隔离');
  if (profile.staticBase) flags.push('静态目录 base');
  if (profile.syncTvRouter) flags.push('SyncTV 路由补丁');
  if (profile.jsPatches) flags.push(`JS 补丁:${profile.jsPatches}`);
  if (profile.sessionCapsule) flags.push(`会话胶囊:${profile.sessionCapsule.cookie}`);
  const counts = [
    profile.signatures ? `签名 ${profile.signatures.length}` : '',
    profile.drift ? `漂移 ${profile.drift.length}` : '',
    profile.deepRoots ? `深度根 ${profile.deepRoots.length}` : ''
  ].filter(Boolean);
  return [...counts, ...flags].join(' · ');
}

/** 深度字面量补全的基础白名单（与历史行为一致，自学习会在其上继续扩张） */
const DEFAULT_DEEP_ROOTS = UMAMI_DEEP_ROOTS;

const DEFAULT_OPTIONS = {
  autoSlash: true,
  injectBase: true,
  rewriteHtml: true,
  rewriteLocation: true,
  rewriteCookie: false,
  rewriteCss: true,
  stripFrameGuards: true,
  relaxIframeSandbox: true,
  autoLearn: true,
  cacheAssets: true,
  forceAjaxHeader: true,
  cookieSameSite: 'Lax',
  ws: true,
  changeOrigin: true
};

const MAX_LEARNED_ROOTS = 64;
const CAPSULE_CACHE_LIMIT = 512;
const CAPSULE_TTL_MS = 10 * 60 * 1000;
const CAPSULE_COOKIE = '__gw_capsule_id';



/**
 * 归一化并校验二级目录路径。
 * 非法字符（引号/尖括号/空白/反斜杠/编码）或点段一律返回 ''，由调用方按"无此路由"处理。
 */
function sanitizeSubpath(sp) {
  if (!sp) return '';
  let cleaned = String(sp).trim();
  if (!cleaned.startsWith('/')) cleaned = '/' + cleaned;
  while (cleaned.endsWith('/') && cleaned.length > 1) cleaned = cleaned.slice(0, -1);
  if (cleaned.length < 2 || cleaned.length > 64) return '';
  if (!SUBPATH_RE.test(cleaned)) return '';
  if (cleaned.includes('..') || cleaned.includes('//')) return '';
  return cleaned;
}

function firstSegmentOf(pathValue) {
  return rewriter.firstSegment(pathValue);
}

function normalizeOptions(raw) {
  return { ...DEFAULT_OPTIONS, ...(raw || {}) };
}

/** 允许通过管理接口写入的选项键（白名单，避免历史脏字段落盘） */
const OPTION_KEYS = [
  'autoSlash', 'injectBase', 'rewriteHtml', 'rewriteCss', 'rewriteLocation',
  'rewriteCookie', 'autoPrefixSubpath', 'stripFrameGuards', 'relaxIframeSandbox',
  'autoLearn', 'cacheAssets', 'ws', 'changeOrigin', 'cookieSameSite',
  'forceAjaxHeader', 'referrerPolicy', 'deepPaths', 'signaturePaths', 'driftPaths',
  'profile', 'insecureTLS', 'rewriteOrigin', 'rewriteFetchSite'
];

const PATH_LIST_KEYS = new Set(['deepPaths', 'signaturePaths', 'driftPaths']);
const SAME_SITE_VALUES = new Set(['Lax', 'Strict', 'None', 'keep']);

/**
 * 归一化管理接口传入的 options：只保留已知键，未知/历史字段一律丢弃；
 * 路径类字段做字符集与点段校验，避免配置值被拼进正则/HTML/路由索引。
 * @param {object} raw  本次提交的选项
 * @param {object} base 需要保留的既有选项
 */
function sanitizeOptionsInput(raw, base = {}) {
  const out = { ...base };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of OPTION_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (PATH_LIST_KEYS.has(key)) {
      if (!Array.isArray(value)) continue;
      const list = value
        .map((v) => String(v).trim())
        .filter((v) => {
          if (!v) return false;
          if (key === 'deepPaths' || key === 'driftPaths') {
            return !v.includes('/') && SEGMENT_LIST_RE.test(v) && !v.includes('..');
          }
          return SIGNATURE_RE.test(v) && !v.includes('..') && !v.includes('//');
        });
      out[key] = [...new Set(list)];
      continue;
    }
    if (key === 'cookieSameSite') {
      const sameSite = String(value);
      if (SAME_SITE_VALUES.has(sameSite)) out[key] = sameSite;
      continue;
    }
    if (key === 'profile') {
      const name = String(value).trim();
      if (!name || name === 'auto') {
        delete out.profile; // 空 / auto = 按子路径自动绑定内置画像
      } else if (name === 'none' || PROFILE_VALUE_RE.test(name)) {
        out.profile = name; // 'none' 表示显式不启用任何画像
      }
      continue;
    }
    if (key === 'referrerPolicy') {
      const policy = String(value);
      if (REFERRER_POLICY_VALUES.has(policy)) out[key] = policy;
      continue;
    }
    out[key] = !!value;
  }
  return out;
}

// ======================= 单条路由运行时 =======================

class RouteRuntime {
  /**
   * @param {object} route 配置中的路由对象
   * @param {object} deps  引擎依赖 { getClientRealIp, log, onRootLearned }
   */
  constructor(route, deps) {
    this.route = route;
    this.deps = deps;
    this.subpath = sanitizeSubpath(route.subpath);
    this.target = String(route.target || '').trim();
    this.options = normalizeOptions(route.options);

    const resolvedProfile = resolveProfile({
      requested: this.options.profile,
      subpath: this.subpath,
      configProfiles: deps.configProfiles()
    });
    this.profileName = resolvedProfile.name;
    this.profile = resolvedProfile.profile;
    if (resolvedProfile.unknown) {
      deps.log(`[Profile] ${this.subpath} 指定的画像 "${resolvedProfile.unknown}" 不存在，已按通用模式运行`);
    }

    let targetUrl = null;
    try {
      targetUrl = new URL(this.target);
    } catch (err) {
      targetUrl = null;
    }
    this.targetUrl = targetUrl;
    this.targetHost = targetUrl ? targetUrl.host : '';

    this.deepEnabled = this.options.autoPrefixSubpath === true
      || (this.options.autoPrefixSubpath !== false && this.profile.deepByDefault === true);

    this.deepRoots = new Set(DEFAULT_DEEP_ROOTS);
    for (const seg of this.profile.deepRoots || []) this.deepRoots.add(seg);
    for (const seg of this.options.deepPaths || []) this.deepRoots.add(seg);

    this.signaturePaths = new Set();
    for (const prefix of this.profile.signatures || []) this.signaturePaths.add(sanitizeSignature(prefix));
    for (const prefix of this.options.signaturePaths || []) this.signaturePaths.add(sanitizeSignature(prefix));

    this.driftPaths = new Set();
    for (const seg of this.profile.drift || []) this.driftPaths.add(seg);
    for (const seg of this.options.driftPaths || []) this.driftPaths.add(seg);

    /** 自学习根路径命中表：segment -> 命中次数（用于容量淘汰） */
    this.learnedRoots = new Map();
    this.middleware = null;
  }

  /**
   * 会话胶囊（沙箱 iframe 丢失 Cookie 场景）
   * 以网关签发的随机设备令牌为键，绝不以客户端可伪造的 IP/头为凭据。
   */
  captureCapsule(capsuleId, cookieValue) {
    if (!this.profile.sessionCapsule || !cookieValue || !capsuleId) return;
    const key = `${this.subpath}|${capsuleId}`;
    const map = this.deps.capsuleMap;
    map.delete(key);
    map.set(key, { value: cookieValue, expiresAt: Date.now() + CAPSULE_TTL_MS });
    while (map.size > CAPSULE_CACHE_LIMIT) map.delete(map.keys().next().value);
  }

  readCapsule(capsuleId) {
    if (!this.profile.sessionCapsule || !capsuleId) return null;
    const entry = this.deps.capsuleMap.get(`${this.subpath}|${capsuleId}`);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.deps.capsuleMap.delete(`${this.subpath}|${capsuleId}`);
      return null;
    }
    return entry.value;
  }

  // ---------------- 根路径白名单 ----------------

  isReservedSegment(seg) {
    if (!seg || seg === '__gw' || seg.startsWith('__gw')) return true;
    return this.deps.isSiblingSegment(this.subpath, seg);
  }

  learnRoot(seg) {
    if (!this.options.autoLearn || !rewriter.SEGMENT_RE.test(seg)) return;
    if (this.isReservedSegment(seg)) return;
    if (this.deepRoots.has(seg)) return;

    const hits = this.learnedRoots.get(seg);
    if (hits) {
      this.learnedRoots.set(seg, hits + 1);
      return;
    }

    this.learnedRoots.set(seg, 1);
    while (this.learnedRoots.size > MAX_LEARNED_ROOTS) {
      let victim = null;
      let victimHits = Infinity;
      for (const [key, count] of this.learnedRoots) {
        if (count < victimHits) {
          victim = key;
          victimHits = count;
        }
      }
      if (!victim) break;
      this.learnedRoots.delete(victim);
    }
    this.deps.onRootChanged();
  }

  /** 深度字面量补全白名单（保守：仅已知/已学习的根路径） */
  shouldPrefixLiteral(seg) {
    if (this.isReservedSegment(seg)) return false;
    return this.deepRoots.has(seg) || this.learnedRoots.has(seg);
  }

  /** 文档类重写白名单（文档内的根绝对引用几乎都是本应用资源，仅排除兄弟应用与内部前缀） */
  shouldPrefixDocument(seg) {
    return !this.isReservedSegment(seg);
  }

  get knownSegments() {
    const all = new Set(this.learnedRoots.keys());
    for (const seg of this.deepRoots) all.add(seg);
    return all;
  }

  // ---------------- 上下文构造 ----------------

  buildContext({ allowRoot, scope, onLearn, onMatch }) {
    const shouldPrefix = scope === 'literal'
      ? (seg) => this.shouldPrefixLiteral(seg)
      : (seg) => this.shouldPrefixDocument(seg);
    return rewriter.createContext({
      subpath: this.subpath,
      options: this.options,
      shouldPrefix,
      onLearn,
      onMatch,
      allowRoot
    });
  }

  redirectContext(req) {
    return {
      subpath: this.subpath,
      targetHost: this.targetHost,
      requestHost: req.headers.host || '',
      prefixPath: (p) => {
        const seg = firstSegmentOf(p);
        return this.shouldPrefixDocument(seg) ? this.subpath + p : null;
      }
    };
  }

  // ---------------- 响应体重写编排 ----------------

  isKindEnabled(kind) {
    if (kind === 'document') return this.options.rewriteHtml !== false;
    if (kind === 'css') return this.options.rewriteCss !== false && this.options.rewriteHtml !== false;
    if (kind === 'script') return true; // 结构补全（前端路由 base / Worker / sourceMap）始终可用
    return false;
  }

  /**
   * 响应体重写编排
   * @param {string} text 原始文本
   * @param {'document'|'css'|'script'} kind 响应体类别
   * @param {object} req 请求对象
   * @param {object} [report] 诊断模式：收集决策事件，且不写入自学习状态、不真正改写
   * @returns {{ text: string, modified: boolean, report?: object }}
   */
  rewriteBody(text, kind, req, report) {
    if (!text) return { text, modified: false };

    let out = text;
    const collector = report ? createReportCollector(report) : null;
    const onMatch = collector ? collector.record : null;
    const learning = !report && kind !== 'script'
      ? (seg) => this.learnRoot(seg)
      : null;

    if (kind === 'document') {
      if (collector) collector.setPass('primary');
      out = rewriter.rewriteDocument(out, this.buildContext({ allowRoot: true, scope: 'document', onLearn: learning, onMatch }));
      if (this.deepEnabled) {
        if (collector) collector.setPass('literal');
        out = rewriter.rewriteLiterals(out, this.buildContext({ allowRoot: false, scope: 'literal', onMatch }));
      }
    } else if (kind === 'css') {
      if (collector) collector.setPass('primary');
      out = rewriter.rewriteCssUrls(out, this.buildContext({ allowRoot: true, scope: 'document', onLearn: learning, onMatch }));
    } else if (kind === 'script') {
      if (collector) collector.setPass('primary');
      out = rewriter.rewriteScriptStructure(out, this.buildContext({ allowRoot: false, scope: 'literal', onMatch }));
      if (this.deepEnabled) {
        if (collector) collector.setPass('literal');
        out = rewriter.rewriteLiterals(out, this.buildContext({ allowRoot: false, scope: 'literal', onMatch }));
      }
    }

    if (this.profile.jsPatches === 'umami' && (kind === 'script' || kind === 'document')) {
      out = this.applyUmamiPatches(out);
    }
    if (this.profile.syncTvRouter && kind === 'script') {
      out = this.applySyncTvRouter(out);
    }
    if (kind === 'document' && (this.options.injectBase || this.profile.shimAlways)) {
      out = this.injectShim(out, req);
    }

    return report
      ? { text: out, modified: out !== text, report: collector.finalize() }
      : { text: out, modified: out !== text };
  }

  /** Umami (Next.js App Router) 专属字节码补丁：pathHasPrefix 与 _next 静态资源前缀 */
  applyUmamiPatches(text) {
    const subpath = this.subpath;
    let out = text;
    out = out.replace(/(["'])\/_next\//g, `$1${subpath}/_next/`);
    out = out.replace(
      /\(0,\s*([a-zA-Z0-9_$]+)\.pathHasPrefix\)\(([a-zA-Z0-9_$]+),\s*["']["']\)/g,
      (match, obj, arg) => `(0,${obj}.pathHasPrefix)(${arg}, "${subpath}")`
    );
    out = out.replace(
      /function\s+n\(([a-zA-Z0-9_$]+)\)\s*\{\s*return\s+([a-zA-Z0-9_$]+)\s*\}/g,
      (match, a, b) => {
        if (a !== b) return match;
        return `function n(${a}){return (typeof ${a} === "string" && ${a}.startsWith("${subpath}")) ? (${a}.slice(${subpath.length}) || "/") : ${a}}`;
      }
    );
    return out;
  }

  /** SyncTV 专属：vm("/web") -> vm("/live/web") */
  applySyncTvRouter(text) {
    const sub = rewriter.escapeRegExp(this.subpath);
    const re = new RegExp(`\\b([A-Za-z0-9_$]+)\\s*\\(\\s*["']\\/(?!${sub.replace(/^\//, '')}\\/)(web)["']\\s*\\)`, 'g');
    return text.replace(re, (match, fn, seg) => `${fn}("${this.subpath}/${seg}")`);
  }

  /** 注入 <base> 与前端路由垫片（history.pushState 拦截 / localStorage 隔离 / 沙箱降级兜底） */
  injectShim(text, req) {
    const subpath = this.subpath;
    let effectiveBase = `${subpath}/`;
    if (this.profile.staticBase && req.path.includes('/static')) {
      effectiveBase = `${subpath}/static/`;
    }
    const baseTag = this.profile.noBase ? '' : `<base href="${effectiveBase}">\n`;
    const storageIsolation = this.profile.storageIsolation === true;

    const shim = `
  ${baseTag}<script>
    (function() {
      var SP = "${subpath}";
      var origPush = history.pushState;
      var origReplace = history.replaceState;
      history.pushState = function(state, title, url) {
        if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(SP + '/') && url !== SP) {
          url = SP + url;
        }
        return origPush.apply(this, [state, title, url]);
      };
      history.replaceState = function(state, title, url) {
        if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(SP + '/') && url !== SP) {
          url = SP + url;
        }
        return origReplace.apply(this, [state, title, url]);
      };

      // 子路径级 LocalStorage 沙箱隔离与污染清洗引擎
      try {
        if (${storageIsolation ? 'true' : 'false'}) {
          var rawStorage = window.localStorage;
          var prefix = "__gw_" + SP.replace(/[^a-zA-Z0-9_]/g, '_') + "_";
          var isJwt = function(val) {
            if (typeof val !== 'string') return false;
            var parts = val.split('.');
            if (parts.length !== 3) return false;
            try {
              var decoded = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
              JSON.parse(decoded);
              return true;
            } catch(e) {
              return false;
            }
          };

          var storageHandler = {
            get: function(target, prop, receiver) {
              if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
              if (prop === 'getItem') {
                return function(key) {
                  var val = target.getItem(prefix + key);
                  if (key === 'token' && val && !isJwt(val)) {
                    target.removeItem(prefix + key);
                    return null;
                  }
                  return val;
                };
              }
              if (prop === 'setItem') {
                return function(key, val) {
                  return target.setItem(prefix + key, String(val));
                };
              }
              if (prop === 'removeItem') {
                return function(key) {
                  return target.removeItem(prefix + key);
                };
              }
              if (prop === 'clear') {
                return function() {
                  var keysToRemove = [];
                  for (var i = 0; i < target.length; i++) {
                    var k = target.key(i);
                    if (k && k.indexOf(prefix) === 0) keysToRemove.push(k);
                  }
                  keysToRemove.forEach(function(k) { target.removeItem(k); });
                };
              }
              if (prop === 'key') {
                return function(idx) {
                  var count = 0;
                  for (var i = 0; i < target.length; i++) {
                    var k = target.key(i);
                    if (k && k.indexOf(prefix) === 0) {
                      if (count === idx) return k.slice(prefix.length);
                      count++;
                    }
                  }
                  return null;
                };
              }
              if (prop === 'length') {
                var count = 0;
                for (var i = 0; i < target.length; i++) {
                  var k = target.key(i);
                  if (k && k.indexOf(prefix) === 0) count++;
                }
                return count;
              }
              if (prop === 'hasOwnProperty') {
                return function(key) {
                  var has = target.hasOwnProperty(prefix + key) || target.getItem(prefix + key) !== null;
                  if (key === 'token' && has) {
                    var val = target.getItem(prefix + key);
                    if (!isJwt(val)) {
                      target.removeItem(prefix + key);
                      return false;
                    }
                  }
                  return has;
                };
              }

              if (prop in Storage.prototype) {
                var val = Reflect.get(target, prop, receiver);
                if (typeof val === 'function') return val.bind(target);
                return val;
              }

              var val = target.getItem(prefix + String(prop));
              if (prop === 'token' && val && !isJwt(val)) {
                target.removeItem(prefix + String(prop));
                return undefined;
              }
              return val !== null ? val : undefined;
            },
            set: function(target, prop, value) {
              if (typeof prop === 'symbol' || prop in Storage.prototype) {
                return Reflect.set(target, prop, value);
              }
              target.setItem(prefix + String(prop), String(value));
              return true;
            },
            deleteProperty: function(target, prop) {
              target.removeItem(prefix + String(prop));
              return true;
            },
            has: function(target, prop) {
              if (typeof prop === 'symbol' || prop in Storage.prototype) {
                return Reflect.has(target, prop);
              }
              var has = target.getItem(prefix + String(prop)) !== null;
              if (prop === 'token' && has) {
                var val = target.getItem(prefix + String(prop));
                if (!isJwt(val)) {
                  target.removeItem(prefix + String(prop));
                  return false;
                }
              }
              return has;
            }
          };

          var proxiedStorage = new Proxy(rawStorage, storageHandler);
          Object.defineProperty(window, 'localStorage', {
            value: proxiedStorage,
            configurable: true,
            enumerable: true,
            writable: true
          });
        } else {
          window.localStorage.getItem('__gw_test__');
        }
      } catch (e) {
        var memStorage = {};
        Object.defineProperty(window, 'localStorage', {
          value: {
            getItem: function(k) { return memStorage[k] || null; },
            setItem: function(k, v) { memStorage[k] = String(v); },
            removeItem: function(k) { delete memStorage[k]; },
            clear: function() { memStorage = {}; }
          },
          configurable: true
        });
      }
    })();
  </script>`;

    if (/<head[^>]*>/i.test(text)) return text.replace(/(<head[^>]*>)/i, `$1\n${shim}`);
    if (/<html[^>]*>/i.test(text)) return text.replace(/(<html[^>]*>)/i, `$1\n<head>${shim}</head>`);
    return shim + text;
  }
}

function sanitizeSignature(prefix) {
  if (!prefix) return '';
  let cleaned = String(prefix).trim();
  if (!cleaned.startsWith('/')) cleaned = '/' + cleaned;
  while (cleaned.length > 1 && cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

/**
 * 诊断模式的决策收集器：统计各类决策次数、被改写根路径段与样例。
 * 与真实链路共用同一套规则（rewriteBody），因此诊断结论 = 线上行为。
 * 注意：同一份文本会经历"文档属性 pass"与"字面量 pass"两轮，
 * 第二轮看到的已补全引用是网关自己写的，不算上游的自带前缀，故不予计入。
 */
function createReportCollector(report) {
  const MAX_SAMPLES = 40;
  const state = { pass: 'primary' };
  return {
    setPass(pass) {
      state.pass = pass;
    },
    record(event) {
      if (event.action === 'already-prefixed' && state.pass !== 'primary') return;
      report.counts[event.action] = (report.counts[event.action] || 0) + 1;
      if (event.action === 'rewritten' && event.seg) {
        report.segments[event.seg] = (report.segments[event.seg] || 0) + 1;
      }
      if ((event.action === 'rewritten' || event.action === 'skipped-policy') && report.samples.length < MAX_SAMPLES) {
        report.samples.push(event);
      }
    },
    finalize() {
      return report;
    }
  };
}

function prefixMatchesPath(prefix, pathname) {
  if (!prefix) return false;
  if (prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

// ======================= 引擎 =======================

function createProxyEngine({ getClientRealIp, log }) {
  const state = {
    runtimes: new Map(), // subpath -> RouteRuntime
    signatureIndex: new Map(), // firstSegment -> Map<subpath, prefix>
    signatureDirty: false,
    capsuleMap: new Map(),
    configProfiles: {},
    wsProxy: null
  };

  const logger = typeof log === 'function' ? log : () => {};
  const deps = {
    getClientRealIp,
    log: logger,
    capsuleMap: state.capsuleMap,
    configProfiles: () => state.configProfiles,
    isSiblingSegment(currentSubpath, seg) {
      for (const [subpath] of state.runtimes) {
        if (subpath === currentSubpath) continue;
        if (sanitizeSignature(subpath) === '/' + seg) return true;
      }
      return false;
    },
    onRootChanged() {
      state.signatureDirty = true;
    }
  };

  function rebuildSignatureIndex() {
    state.signatureIndex.clear();
    for (const [subpath, runtime] of state.runtimes) {
      const prefixes = new Set(runtime.signaturePaths);
      for (const seg of runtime.learnedRoots.keys()) prefixes.add('/' + seg);
      for (const prefix of prefixes) {
        const seg = firstSegmentOf(prefix);
        if (!seg) continue;
        let bucket = state.signatureIndex.get(seg);
        if (!bucket) {
          bucket = new Map();
          state.signatureIndex.set(seg, bucket);
        }
        bucket.set(subpath, prefix);
      }
    }
    state.signatureDirty = false;
  }

  function ensureSignatureIndex() {
    if (state.signatureDirty) rebuildSignatureIndex();
  }

  function refreshProxies(routes, configProfiles) {
    state.configProfiles = configProfiles && typeof configProfiles === 'object' ? configProfiles : {};
    state.runtimes.clear();
    for (const route of routes || []) {
      const subpath = sanitizeSubpath(route.subpath);
      if (!subpath || !route.target) continue;
      try {
        const runtime = new RouteRuntime(route, deps);
        runtime.middleware = buildProxyMiddleware(runtime);
        state.runtimes.set(subpath, runtime);
        logger(`[Router Loaded] ${subpath} -> ${route.target} (${route.name}) · profile: ${runtime.profileName}`);
      } catch (err) {
        logger(`[Router Error] Failed to register ${subpath}: ${err.message}`);
      }
    }
    rebuildSignatureIndex();
  }

  /** 供管理接口展示每条路由的运行时状态（画像、自学习签名等） */
  function describeRoutes() {
    const out = {};
    for (const [subpath, runtime] of state.runtimes) {
      out[subpath] = {
        profile: runtime.profileName,
        deepEnabled: runtime.deepEnabled,
        learnedRoots: [...runtime.learnedRoots.keys()],
        signaturePaths: [...runtime.signaturePaths],
        driftPaths: [...runtime.driftPaths]
      };
    }
    return out;
  }

  /**
   * 诊断模式：用与真实链路完全相同的规则干跑一次响应体，返回决策报告。
   * 不写入自学习状态、不改写任何线上内容。
   */
  function inspectBody(subpath, text, kind, { path: reqPath = '/', headers = {} } = {}) {
    const runtime = state.runtimes.get(sanitizeSubpath(subpath));
    if (!runtime) return { ok: false, error: `子路径 ${subpath} 未启用或无对应路由` };

    const report = { counts: {}, segments: {}, samples: [] };
    const fakeReq = { path: reqPath, url: reqPath, headers: headers || {}, socket: {} };
    const result = runtime.rewriteBody(text, kind, fakeReq, report);
    return { ok: true, kind, deepEnabled: runtime.deepEnabled, modified: result.modified, ...result.report };
  }

  /** 收集与运行时无关的请求归属证据 */
  function refererSubpath(req) {
    const referer = req.headers['referer'];
    if (!referer) return null;
    try {
      const refUrl = new URL(referer);
      for (const [subpath] of state.runtimes) {
        if (refUrl.pathname === subpath || refUrl.pathname.startsWith(subpath + '/')) return subpath;
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  function cookieSubpath(req) {
    const cookie = req.headers['cookie'];
    if (!cookie) return null;
    const match = cookie.match(/__gw_active_subpath=([^;]+)/);
    if (!match || !match[1]) return null;
    try {
      const subpath = decodeURIComponent(match[1]);
      return state.runtimes.has(subpath) ? subpath : null;
    } catch (err) {
      return null;
    }
  }

  /** 声明式签名 + 自学习签名归属；歧义时不猜测 */
  function signatureSubpath(pathname) {
    ensureSignatureIndex();
    const seg = firstSegmentOf(pathname);
    if (!seg) return null;
    const bucket = state.signatureIndex.get(seg);
    if (!bucket) return null;
    const hits = new Set();
    for (const [subpath, prefix] of bucket.entries()) {
      if (prefixMatchesPath(prefix, pathname)) hits.add(subpath);
    }
    if (hits.size === 1) return hits.values().next().value;
    if (hits.size > 1) {
      logger(`[Signature] ${pathname} 命中多个应用 (${[...hits].join(', ')})，交由 Referer/Cookie 判定`);
    }
    return null;
  }

  /**
   * 归属判定（HTTP 与 WebSocket 共用）
   * @returns {{ runtime: RouteRuntime, exact: boolean }|null}
   */
  function resolveRoute(req, pathname) {
    // 1. 显式子路径（最长前缀优先）
    let matched = null;
    for (const [subpath, runtime] of state.runtimes) {
      if (pathname === subpath || pathname.startsWith(subpath + '/')) {
        if (!matched || subpath.length > matched.runtime.subpath.length) matched = { runtime, exact: true };
      }
    }
    if (matched) return matched;

    if (pathname === '/' || pathname.startsWith('/__gw')) return null;

    // 2. Referer 归属（严格上下文，优先级高于任何全局特征）
    const refererOwner = refererSubpath(req);
    if (refererOwner) {
      const runtime = state.runtimes.get(refererOwner);
      if (runtime) return { runtime, exact: false };
    }

    // 3. 声明式签名 / 自学习签名
    const signatureOwner = signatureSubpath(pathname);
    if (signatureOwner) {
      const runtime = state.runtimes.get(signatureOwner);
      if (runtime) return { runtime, exact: false };
    }

    // 4. 会话 Cookie 兜底
    const cookieOwner = cookieSubpath(req);
    if (cookieOwner) return { runtime: state.runtimes.get(cookieOwner), exact: false };

    return null;
  }

  /**
   * 根路径漂移纠正：/websites -> 302 /um/websites
   * 只在该根路径的归属唯一（或在候选内被 Referer/Cookie 明确指向）时才纠正。
   */
  function resolveDrift(pathname, req) {
    const seg = firstSegmentOf(pathname);
    if (!seg || !rewriter.SEGMENT_RE.test(seg)) return null;

    const candidates = [];
    for (const [subpath, runtime] of state.runtimes) {
      if (runtime.driftPaths.has(seg)) candidates.push(subpath);
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const refererOwner = refererSubpath(req);
    if (refererOwner && candidates.includes(refererOwner)) return refererOwner;
    const cookieOwner = cookieSubpath(req);
    if (cookieOwner && candidates.includes(cookieOwner)) return cookieOwner;
    return null;
  }

  /** 多重二级目录折叠：/kuma/kuma/x -> /kuma/x（客户端路由/上游重定向反复叠加时自愈） */
  function foldDuplicateSubpath(pathname) {
    for (const [subpath] of state.runtimes) {
      const doubled = subpath + subpath;
      if (pathname === doubled || pathname.startsWith(doubled + '/')) {
        let cleaned = pathname;
        while (cleaned.startsWith(doubled)) cleaned = subpath + cleaned.slice(doubled.length);
        return cleaned;
      }
    }
    return null;
  }

  function stripSubpath(pathname, subpath) {
    if (pathname === subpath) return '/';
    if (pathname.startsWith(subpath + '/')) {
      const rest = pathname.slice(subpath.length);
      return rest.startsWith('/') ? rest : '/' + rest;
    }
    return pathname;
  }

  // ======================= 代理中间件 =======================

  function buildProxyMiddleware(runtime) {
    const { subpath, target, options } = runtime;

    return createProxyMiddleware({
      target,
      changeOrigin: options.changeOrigin !== false,
      ws: false, // 统一由 upgrade 处理器精准分发，禁用 http-proxy-middleware 的隐式全局监听
      secure: options.insecureTLS !== true, // 默认校验上游证书；自签场景需按路由显式 insecureTLS:true
      selfHandleResponse: true,
      pathRewrite: (pathname) => stripSubpath(pathname, subpath),
      on: {
        proxyReq(proxyReq, req) {
          const realIp = getClientRealIp(req);

          // 先清除客户端可伪造的转发类/鉴权类头，再写入网关自己的值
          for (const header of CLIENT_UNTRUSTED_HEADERS) {
            proxyReq.removeHeader(header);
          }

          proxyReq.setHeader('X-Real-IP', realIp);
          proxyReq.setHeader('REMOTE-HOST', realIp);
          proxyReq.setHeader('X-Forwarded-For', realIp);

          const proto = req.socket && req.socket.encrypted ? 'https' : 'http';
          const publicHost = PUBLIC_HOST || req.headers.host || '';
          proxyReq.setHeader('X-Forwarded-Prefix', subpath);
          proxyReq.setHeader('X-Forwarded-Proto', proto);
          proxyReq.setHeader('X-Forwarded-Host', publicHost);
          if (publicHost.includes(':')) {
            proxyReq.setHeader('X-Forwarded-Port', publicHost.split(':').pop());
          }

          if (options.forceAjaxHeader !== false) {
            proxyReq.setHeader('X-Requested-With', 'XMLHttpRequest');
          }

          // Origin / Sec-Fetch-Site 默认保持客户端原值（避免系统性绕过上游 CSRF/CSWSH 校验）；
          // 仅在上游确实需要"同源伪装"时按路由显式开启。
          if (options.rewriteOrigin === true && req.headers['origin'] && runtime.targetUrl) {
            proxyReq.setHeader('Origin', `${runtime.targetUrl.protocol}//${runtime.targetUrl.host}`);
          }
          if (options.rewriteFetchSite === true) {
            proxyReq.setHeader('Sec-Fetch-Site', 'same-origin');
          }

          // 编码协商：客户端不接受压缩时保持 identity；接受时只暴露可解码编码，
          // 保证响应体重写不会被 zstd 之类的编码挡住
          const clientEncoding = rewriter.pickResponseEncoding(req.headers['accept-encoding']);
          proxyReq.setHeader('Accept-Encoding', clientEncoding
            ? rewriter.upstreamRequestEncoding()
            : 'identity');

          // 沙箱 iframe 丢失 Cookie 的会话胶囊补齐（键 = 网关签发的随机设备令牌）
          const capsule = runtime.profile.sessionCapsule;
          if (capsule) {
            const relative = stripSubpath((req.url || '/').split('?')[0], subpath);
            const hit = capsule.paths.some((p) => relative.startsWith(p));
            if (hit) {
              const capsuleId = ensureCapsuleId(req);
              const current = String(proxyReq.getHeader('cookie') || '');
              if (!current.includes(capsule.cookie + '=')) {
                const cached = runtime.readCapsule(capsuleId);
                if (cached) {
                  proxyReq.setHeader('cookie', current ? `${current}; ${capsule.cookie}=${cached}` : `${capsule.cookie}=${cached}`);
                }
              }
            }
          }
        },

        proxyRes(proxyRes, req, res) {
          handleProxyResponse(runtime, proxyRes, req, res);
        },

        error(err, req, res) {
          const requestId = crypto.randomBytes(6).toString('hex');
          logger(`[Proxy Error] id=${requestId} ${subpath} -> ${target}: ${err.message}`);
          if (res && typeof res.status === 'function' && !res.headersSent) {
            res.status(502).json({
              error: 'Bad Gateway',
              message: '上游应用暂时不可用，请稍后重试或联系管理员',
              requestId
            });
          } else if (res && typeof res.destroy === 'function') {
            res.destroy();
          }
        }
      }
    });
  }

  function handleProxyResponse(runtime, proxyRes, req, res) {
    const { options, subpath } = runtime;
    const headers = proxyRes.headers;
    const reqPath = (req.url || '/').split('?')[0];
    const secure = !!(req.socket && req.socket.encrypted) || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

    // ---------- 1. 跳转标头统一收敛 ----------
    const redirectCtx = runtime.redirectContext(req);
    if (options.rewriteLocation !== false) {
      if (headers.location) {
        const next = rewriter.rewriteRedirectTarget(headers.location, redirectCtx);
        if (next) headers.location = next;
      }
      if (headers.refresh) {
        const next = rewriter.rewriteRefreshHeader(headers.refresh, redirectCtx);
        if (next !== headers.refresh) headers.refresh = next;
      }
      if (headers.link) {
        const next = rewriter.rewriteLinkHeader(headers.link, redirectCtx);
        if (next !== headers.link) headers.link = next;
      }
    }
    if (headers['x-nextjs-redirect']) {
      const next = rewriter.rewriteRedirectTarget(headers['x-nextjs-redirect'], redirectCtx);
      if (next) headers['x-nextjs-redirect'] = next;
    }

    // ---------- 2. 自跳转环路保护 ----------
    const status = proxyRes.statusCode;
    const isRedirect = status >= 300 && status < 400 && !!headers.location;
    // 注意：http-proxy-middleware 会改写 req.url，环路判定必须使用网关侧的原始地址
    const gatewayUrl = req.originalUrl || req.url;
    if (isRedirect && (req.method === 'GET' || req.method === 'HEAD') && isSelfRedirect(headers.location, gatewayUrl)) {
      logger(`[Loop Guard] ${subpath}${req.url} 上游返回自跳转 (${headers.location})，已拦截避免浏览器死循环`);
      res.writeHead(508, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`上游应用 ${subpath} 将请求重定向到了它自己，网关已拦截以避免无限重定向循环。`);
      return;
    }

    // ---------- 3. Set-Cookie 归一化 ----------
    let hadUpstreamSetCookie = false;
    if (headers['set-cookie']) {
      const raw = headers['set-cookie'];
      const list = Array.isArray(raw) ? raw : [raw];
      const capsule = runtime.profile.sessionCapsule;
      const capsuleCookieRe = capsule
        ? new RegExp(`(?:^|;\\s*)${rewriter.escapeRegExp(capsule.cookie)}=([^;]+)`)
        : null;
      if (capsuleCookieRe) {
        for (const cookie of list) {
          const match = String(cookie).match(capsuleCookieRe);
          if (match && match[1]) runtime.captureCapsule(ensureCapsuleId(req), match[1]);
        }
      }
      headers['set-cookie'] = list.map((cookie) => rewriter.rewriteSetCookie(cookie, {
        subpath,
        options,
        secure
      }));
      hadUpstreamSetCookie = true;
    }

    // 网关自用 Cookie（路由提示 + 胶囊设备令牌）与上游 Set-Cookie 合并，
    // 避免被 res.writeHead(headers) 覆盖；它们不参与"带 Cookie 不得缓存"的判定。
    const gatewayCookies = [];
    if (res.locals && res.locals.__gwRoutingCookie) gatewayCookies.push(res.locals.__gwRoutingCookie);
    // 构建号 Cookie（一次性清理旧文档缓存）也必须随反代响应下发，否则每次请求都会触发清缓存
    if (res.locals && res.locals.__gwBuildCookie) gatewayCookies.push(res.locals.__gwBuildCookie);
    if (req.__gwCapsuleNeedsCookie && req.__gwCapsuleId) {
      gatewayCookies.push(`${CAPSULE_COOKIE}=${req.__gwCapsuleId}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    }
    if (gatewayCookies.length) {
      const existing = headers['set-cookie'];
      const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
      headers['set-cookie'] = [...list, ...gatewayCookies];
    }

    // ---------- 4. 文本重写 / 原样透传 ----------
    const contentType = headers['content-type'] || '';
    const kind = rewriter.guessRewriteKind(contentType);
    const declaredLength = headers['content-length'] ? parseInt(headers['content-length'], 10) : NaN;
    const oversized = Number.isFinite(declaredLength) && declaredLength > rewriter.MAX_REWRITE_BYTES;
    const textLike = kind !== 'none' && rewriter.isRewritableCharset(contentType);

    if (!textLike || oversized) {
      if (kind !== 'none') {
        applyTextHeaderPolicy(headers, runtime, {
          modified: false,
          path: reqPath,
          method: req.method,
          statusCode: status,
          hasSetCookie: hadUpstreamSetCookie
        });
      }
      res.writeHead(status, headers);
      proxyRes.pipe(res);
      return;
    }

    const clientEncoding = rewriter.pickResponseEncoding(req.headers['accept-encoding']);
    const upstreamEncoding = rewriter.normalizeEncoding(headers['content-encoding']);

    collectBody(proxyRes, rewriter.MAX_REWRITE_BYTES)
      .then(async (rawBuffer) => {
        const decoded = await rewriter.decodeBuffer(rawBuffer, upstreamEncoding);
        const text = decoded.toString('utf8');
        const result = runtime.rewriteBody(text, kind, req);
        const policy = {
          path: reqPath,
          method: req.method,
          statusCode: status,
          hasSetCookie: hadUpstreamSetCookie
        };

        if (!result.modified) {
          // 未改写：字节原样回传，避免无谓的重复压缩与缓存破坏
          const nextHeaders = { ...headers };
          applyTextHeaderPolicy(nextHeaders, runtime, { ...policy, modified: false });
          if ((clientEncoding || '') === (upstreamEncoding || '')) {
            res.writeHead(status, nextHeaders);
            res.end(rawBuffer);
            return;
          }
          sendBody(res, status, nextHeaders, decoded, clientEncoding);
          return;
        }

        const outBuffer = Buffer.from(result.text, 'utf8');
        const nextHeaders = { ...headers };
        delete nextHeaders['content-encoding'];
        delete nextHeaders['content-length'];
        delete nextHeaders['transfer-encoding'];
        applyTextHeaderPolicy(nextHeaders, runtime, { ...policy, modified: true });
        sendBody(res, status, nextHeaders, outBuffer, clientEncoding);
      })
      .catch((err) => {
        const requestId = crypto.randomBytes(6).toString('hex');
        logger(`[Rewrite Error] id=${requestId} ${subpath}${req.url}: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({
          error: 'Bad Gateway',
          message: '响应体重写失败，请联系管理员',
          requestId
        }));
      });
  }

  /** 文本类响应的统一标头策略：缓存、安全头、referrer-policy */
  function applyTextHeaderPolicy(headers, runtime, { modified, path, method, statusCode, hasSetCookie }) {
    const { options } = runtime;
    rewriter.applySecurityHeaderPolicy(headers, options);
    if (options.referrerPolicy !== 'keep') {
      headers['referrer-policy'] = options.referrerPolicy || 'no-referrer-when-downgrade';
    }
    if (options.cacheAssets === false) {
      // 显式关闭资源缓存：无论是否发生改写都禁止缓存
      delete headers.etag;
      delete headers['last-modified'];
      headers['cache-control'] = 'no-cache, no-store, must-revalidate';
      headers.pragma = 'no-cache';
      headers.expires = '0';
      return headers;
    }
    return rewriter.applyCachePolicy(headers, {
      modified,
      staticAsset: rewriter.isStaticAssetPath(path),
      upstreamCacheControl: headers['cache-control'],
      method,
      statusCode,
      hasSetCookie
    });
  }

  /** 按客户端能力输出响应体：不足 1KB 或客户端不支持压缩时走 identity */
  function sendBody(res, status, headers, buffer, clientEncoding) {
    const encoder = buffer.length >= 1024 ? rewriter.createEncoder(clientEncoding) : null;
    if (!encoder) {
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      headers['content-length'] = buffer.length;
      res.writeHead(status, headers);
      res.end(buffer);
      return;
    }
    headers['content-encoding'] = clientEncoding;
    if (!/accept-encoding/i.test(String(headers.vary || ''))) {
      headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding';
    }
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    res.writeHead(status, headers);
    encoder.on('error', () => res.destroy());
    encoder.pipe(res);
    encoder.end(buffer);
  }

  function collectBody(stream, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          stream.destroy();
          reject(new Error(`response body exceeds rewrite limit (${limit} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks, size)));
      stream.on('error', reject);
    });
  }

  function isSelfRedirect(location, requestUrl) {
    try {
      const base = 'http://gateway.local';
      const current = new URL(requestUrl || '/', base);
      const next = new URL(location, current);
      if (!next.pathname && !next.search) return false;
      return next.pathname === current.pathname && next.search === current.search;
    } catch (err) {
      return false;
    }
  }

  // ======================= WebSocket 升级 =======================

  function ensureWsProxy() {
    if (state.wsProxy) return state.wsProxy;
    state.wsProxy = httpProxy.createProxyServer({
      ws: true,
      changeOrigin: true,
      secure: false
    });
    state.wsProxy.on('error', (err) => {
      logger(`[WS Proxy Error] ${err.message}`);
    });
    return state.wsProxy;
  }

  function handleUpgrade(req, socket, head) {
    const rawUrl = req.url || '/';
    const queryIndex = rawUrl.indexOf('?');
    const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    const rawQuery = queryIndex === -1 ? '' : rawUrl.slice(queryIndex);

    // 与 HTTP 侧一致：先拒绝危险路径，再做归属判定（避免 WHATWG 规范化与 HTTP 原始路径产生分歧）
    if (isUnsafePath(rawPath)) {
      socket.destroy();
      return;
    }

    let pathname = '/';
    try {
      pathname = new URL(rawUrl, 'http://localhost').pathname;
    } catch (err) {
      socket.destroy();
      return;
    }

    const resolved = resolveRoute(req, pathname);
    if (!resolved || resolved.runtime.options.ws === false) {
      socket.destroy();
      return;
    }

    const runtime = resolved.runtime;
    const subpath = runtime.subpath;
    const realIp = getClientRealIp(req);
    for (const header of CLIENT_UNTRUSTED_HEADERS) {
      delete req.headers[header];
    }
    req.headers['x-real-ip'] = realIp;
    req.headers['x-forwarded-for'] = realIp;
    req.headers['remote-host'] = realIp;
    req.headers['x-forwarded-prefix'] = subpath;
    req.headers['x-forwarded-host'] = PUBLIC_HOST || req.headers.host || '';
    req.headers['x-forwarded-proto'] = req.socket && req.socket.encrypted ? 'https' : 'http';
    if (runtime.options.rewriteOrigin === true && runtime.targetUrl) {
      req.headers['origin'] = `${runtime.targetUrl.protocol}//${runtime.targetUrl.host}`;
    }
    // 与 HTTP 侧一致：剥离二级目录后再升级到上游
    req.url = stripSubpath(rawPath, subpath) + rawQuery;

    logger(`[WS Upgrade] ${pathname} -> ${runtime.route.name}`);
    ensureWsProxy().ws(req, socket, head, {
      target: runtime.target,
      changeOrigin: runtime.options.changeOrigin !== false,
      secure: runtime.options.insecureTLS !== true
    }, (err) => {
      logger(`[WS Forward Error] ${runtime.route.name}: ${err.message}`);
      try {
        socket.destroy();
      } catch (e) { /* noop */ }
    });
  }

  /** 危险路径：点段、编码斜杠/点/空字节（可用 GW_ALLOW_ENCODED_SLASH=true 放行编码斜杠） */
  const UNSAFE_SEGMENT_RE = /(^|\/)\.\.(\/|$)|%00|%5c/i;
  const UNSAFE_ENCODED_RE = /%2e|%2f/i;
  const ALLOW_ENCODED_SLASH = String(process.env.GW_ALLOW_ENCODED_SLASH || '').toLowerCase() === 'true';

  function isUnsafePath(pathname) {
    if (UNSAFE_SEGMENT_RE.test(pathname)) return true;
    if (!ALLOW_ENCODED_SLASH && UNSAFE_ENCODED_RE.test(pathname)) return true;
    return false;
  }

  /**
   * 调度中间件：安全校验 -> 多重前缀折叠 -> 根路径漂移纠正 -> 四级归属判定 -> 斜杠纠偏 -> 转发
   * @param {object} hooks { onRequest(req), isSystemPath(pathname) }
   */
  function createDispatcher(hooks = {}) {
    const isSystemPath = hooks.isSystemPath || ((pathname) => pathname.startsWith('/__gw'));

    return function dispatchMiddleware(req, res, next) {
      if (hooks.onRequest) hooks.onRequest(req);

      const pathname = req.path;
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

      if (isSystemPath(pathname)) return next();

      // 0. 拒绝点段/编码斜杠等危险路径，避免网关与上游规范化差异造成穿越与缓存键混淆
      if (isUnsafePath(pathname)) {
        return res.status(400).json({ error: 'Bad Request', message: '请求路径包含非法路径段' });
      }

      // 1. 多重二级目录折叠：/kuma/kuma/x -> 301 /kuma/x
      const folded = foldDuplicateSubpath(pathname);
      if (folded) return res.redirect(301, folded + query);

      // 2. 根路径漂移纠正：/websites -> 302 /um/websites
      const drift = resolveDrift(pathname, req);
      if (drift) return res.redirect(302, drift + pathname + query);

      // 3. 归属判定与转发
      const resolved = resolveRoute(req, pathname);
      if (resolved) {
        const { runtime, exact } = resolved;
        if (exact && pathname === runtime.subpath && runtime.options.autoSlash !== false) {
          return res.redirect(301, runtime.subpath + '/' + query);
        }
        // 路由提示 Cookie 与上游 Set-Cookie 在响应期合并，避免被 writeHead 覆盖
        const routingSecure = req.socket && req.socket.encrypted ? '; Secure' : '';
        res.locals.__gwRoutingCookie = `__gw_active_subpath=${encodeURIComponent(runtime.subpath)}; Path=/; SameSite=Lax; HttpOnly${routingSecure}`;
        if (typeof runtime.middleware !== 'function') {
          logger(`[Router] ${runtime.subpath} 代理中间件未就绪，交由门户兜底`);
          return next();
        }
        return runtime.middleware(req, res, next);
      }

      return next();
    };
  }

  return {
    refreshProxies,
    describeRoutes,
    inspectBody,
    createDispatcher,
    attachUpgrade(server) {
      if (!server) return;
      server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));
    }
  };
}

module.exports = {
  createProxyEngine,
  sanitizeSubpath,
  sanitizeOptionsInput,
  describeProfiles,
  normalizeProfile,
  sanitizeProfileInput,
  BUILTIN_PROFILES,
  BUILTIN_SUBPATH_PROFILES,
  DEFAULT_OPTIONS
};
