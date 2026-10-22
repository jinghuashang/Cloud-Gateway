'use strict';

/**
 * ============================================================================
 * Cloud Gateway · 二级目录响应重写引擎 (Subpath Response Rewriter)
 * ============================================================================
 * 纯函数模块：不持有路由状态，策略全部由调用方通过 ctx / options 注入。
 *
 * 社区二级目录反代疑难杂症的对应处理：
 *   1. 上游压缩被强制降级（Accept-Encoding: identity）导致带宽浪费与 CDN 失配
 *      -> 解码 -> 重写 -> 按客户端能力重新压缩，并拒绝转发 Node 解不开的编码。
 *   2. 只处理 href/src/action，遗漏 CSS url()/@import、srcset、<meta refresh>、
 *      内联 style、SVG xlink:href -> 统一补全。
 *   3. Set-Cookie 未剥离 Domain（浏览器直接丢弃 Cookie）与 Path=/ 串味到同域
 *      其他子路径应用 -> 统一剥离 Domain，可选重写 Path 并修正 SameSite/Secure 组合。
 *   4. 跳转标头只重写 Location 且遗漏协议相对地址 -> Location / Refresh / Link
 *      三类标头统一收敛，并带自跳转环路保护。
 *   5. 全量 no-store 让 /_next/static 等不可变资源每次都重新下载
 *      -> 静态资源保留上游强缓存（仅摘除已失效的 ETag/Last-Modified）。
 * ============================================================================
 */

const zlib = require('zlib');
const { promisify } = require('util');

const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const inflateRawAsync = promisify(zlib.inflateRaw);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/** 允许对响应体做文本重写的最大体积（超过后原样透传，避免大响应把内存打爆） */
const MAX_REWRITE_BYTES = (() => {
  const raw = parseInt(process.env.GW_MAX_REWRITE_BYTES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 16 * 1024 * 1024;
})();

/** 静态资源后缀：命中后允许保留上游强缓存 */
const STATIC_ASSET_RE =
  /\.(?:m?js|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|wasm|mp4|webm|mp3|ogg|pdf|zip)$/i;

/** 根绝对路径的第一段可执行字符集（拒绝 %、空格等异常字符，避免污染路由索引） */
const SEGMENT_RE = /^[A-Za-z0-9._~-]{1,32}$/;

// ======================= 压缩与编码协商 =======================

function parseAcceptEncoding(header) {
  const map = new Map();
  if (!header) return map;
  for (const part of String(header).split(',')) {
    const tokens = part.trim().split(';');
    const name = (tokens[0] || '').trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of tokens.slice(1)) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (m) q = Math.min(Math.max(parseFloat(m[1]) || 0, 0), 1);
    }
    map.set(name, Math.max(map.get(name) || 0, q));
  }
  return map;
}

/**
 * 挑选回给客户端的压缩算法：客户端不支持则返回 null（identity 透传）。
 * 同权重时优先 gzip（CPU 成本低于 brotli）。
 */
function pickResponseEncoding(acceptEncodingHeader) {
  const weights = parseAcceptEncoding(acceptEncodingHeader);
  const wildcard = weights.has('*') ? weights.get('*') : 0;
  const candidates = [
    ['gzip', weights.has('gzip') ? weights.get('gzip') : wildcard],
    ['br', weights.has('br') ? weights.get('br') : wildcard],
    ['deflate', weights.has('deflate') ? weights.get('deflate') : wildcard]
  ].sort((a, b) => b[1] - a[1]);
  const [name, q] = candidates[0];
  return q > 0 ? name : null;
}

/** 转发给上游的 Accept-Encoding：只暴露 Node 能解码的编码（zstd 等一律不外传） */
function upstreamRequestEncoding() {
  return 'gzip, deflate, br';
}

function normalizeEncoding(contentEncoding) {
  return String(contentEncoding || '').trim().toLowerCase().split(',')[0].trim();
}

function createEncoder(encoding) {
  if (encoding === 'gzip') return zlib.createGzip();
  if (encoding === 'br') return zlib.createBrotliCompress();
  if (encoding === 'deflate') return zlib.createDeflate();
  return null;
}

/** 解码已缓冲的响应体（兼容部分上游发出的 raw deflate），并强制解压输出上限防止压缩炸弹 */
async function decodeBuffer(buffer, contentEncoding) {
  const enc = normalizeEncoding(contentEncoding);
  if (!enc || enc === 'identity') return buffer;
  if (enc === 'gzip' || enc === 'x-gzip') return gunzipAsync(buffer, { maxOutputLength: MAX_REWRITE_BYTES });
  if (enc === 'br') return brotliDecompressAsync(buffer, { maxOutputLength: MAX_REWRITE_BYTES });
  if (enc === 'deflate') {
    try {
      return await inflateAsync(buffer, { maxOutputLength: MAX_REWRITE_BYTES });
    } catch (err) {
      return inflateRawAsync(buffer, { maxOutputLength: MAX_REWRITE_BYTES });
    }
  }
  throw new Error(`unsupported content-encoding: ${enc}`);
}

// ======================= 响应体类型判别 =======================

/**
 * 判别响应体是否属于需要重写的文本类型。
 * @returns {'document'|'css'|'script'|'none'}
 */
function guessRewriteKind(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/event-stream')) return 'none'; // SSE 必须保持流式
  if (ct.includes('text/html') || ct.includes('xhtml') || ct.includes('image/svg+xml')) return 'document';
  if (ct.includes('text/css')) return 'css';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'script';
  if (ct.includes('text/x-component')) return 'script';
  if (ct.includes('json')) return 'script';
  return 'none';
}

/** 非 UTF-8 编码的文本直接放弃重写，避免把 GBK 等页面改成乱码 */
function isRewritableCharset(contentType) {
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(String(contentType || ''));
  if (!m) return true;
  const cs = m[1].toLowerCase();
  return cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii';
}

function isStaticAssetPath(pathname) {
  return STATIC_ASSET_RE.test(String(pathname || '').split('?')[0]);
}

function firstSegment(pathValue) {
  const clean = String(pathValue || '').replace(/^\/+/, '');
  const cut = clean.search(/[/?#]/);
  return cut === -1 ? clean : clean.slice(0, cut);
}

// ======================= 重写上下文 =======================

/**
 * ctx 约定（由 proxy-engine 构造）：
 *   subpath       '/um'
 *   subPrefix     'um'
 *   options       归一化后的路由选项
 *   prefixPath(p) 根绝对路径 -> 带二级目录的路径（不满足白名单时返回 null）
 *   forcePath(p)  结构性同源引用 -> 强制补全（仅排除内部前缀）
 *   onLearn(seg)  学习回调（文档/CSS 类响应）
 *   onMatch(evt)  决策上报回调（诊断/干跑模式）：{ path, seg, action }
 *   allowRoot     是否允许把裸 '/' 重写为 '/um/'
 */
function createContext({ subpath, options, shouldPrefix, onLearn, onMatch, allowRoot = false }) {
  const subPrefix = subpath.replace(/^\/+/, '');

  /** 统一决策入口：返回 { action, seg, result }，动作语义即"诊断报告"的取值域 */
  function decide(rawPath, force) {
    if (typeof rawPath !== 'string' || rawPath[0] !== '/') return { action: 'skipped-shape', seg: '', result: null };
    if (rawPath[1] === '/') return { action: 'external', seg: '', result: null }; // 协议相对地址保持原样
    if (rawPath === subpath || rawPath.startsWith(subpath + '/')) return { action: 'already-prefixed', seg: '', result: null };
    if (rawPath === '/') {
      return allowRoot
        ? { action: 'rewritten', seg: '', result: subpath + '/' }
        : { action: 'skipped-root', seg: '', result: null };
    }
    const seg = firstSegment(rawPath.slice(1));
    if (!seg) return { action: 'skipped-shape', seg: '', result: null };
    if (onLearn) onLearn(seg);
    if (!force && !shouldPrefix(seg)) return { action: 'skipped-policy', seg, result: null };
    return { action: 'rewritten', seg, result: subpath + rawPath };
  }

  function run(rawPath, force) {
    const decision = decide(rawPath, force);
    if (onMatch) onMatch({ path: rawPath, seg: decision.seg, action: decision.action });
    return decision.result;
  }

  return {
    subpath,
    subPrefix,
    options: options || {},
    allowRoot,
    learn: onLearn,
    prefixPath: (rawPath) => run(rawPath, false),
    forcePath: (rawPath) => run(rawPath, true)
  };
}

// ======================= 文档类重写 (HTML / SVG) =======================

/** HTML/SVG 中承载 URL 的属性（含 xlink:href） */
const URL_ATTR_RE =
  /((?:\s|xlink:)(?:href|src|action|poster|formaction|data-src|data-href|data-url|data-image|data-original)\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi;

const SRCSET_RE = /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi;

const META_REFRESH_RE = /(<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*)(["'])([^"']*)\2/gi;

function rewriteSrcset(value, ctx) {
  return value
    .split(',')
    .map((rawPart) => {
      const part = rawPart.trim();
      if (!part) return rawPart;
      const [url, ...descriptors] = part.split(/\s+/);
      const next = ctx.prefixPath(url);
      return next ? [next, ...descriptors].join(' ') : part;
    })
    .join(',');
}

function rewriteDocument(text, ctx) {
  let out = text;

  out = out.replace(URL_ATTR_RE, (match, lead, quote, rest) => {
    const next = ctx.prefixPath('/' + rest);
    return next ? `${lead}${quote}${next}${quote}` : match;
  });

  out = out.replace(SRCSET_RE, (match, lead, quote, value) => {
    const next = rewriteSrcset(value, ctx);
    return next === value ? match : `${lead}${quote}${next}${quote}`;
  });

  out = out.replace(META_REFRESH_RE, (match, lead, quote, value) => {
    const next = value.replace(/(url\s*=\s*["']?)(\/(?!\/)[^"';]*)/gi, (m, head, url) => {
      const prefixed = ctx.prefixPath(url);
      return prefixed ? head + prefixed : m;
    });
    return next === value ? match : `${lead}${quote}${next}${quote}`;
  });

  // 内联 <style>、style="" 以及 CSS 文本统一走 url()/@import 规则
  out = rewriteCssUrls(out, ctx);

  // 深度字面量补全（Next.js RSC payload、内联脚本中的裸路径等）由调用方按需追加
  return out;
}

// ======================= CSS 重写 =======================

const CSS_URL_RE = /(url\(\s*)(["']?)\/(?!\/)([^"')]*)\2(\s*\))/gi;
const CSS_IMPORT_RE = /(@import\s+)(["'])\/(?!\/)([^"']*)\2/gi;

function rewriteCssUrls(text, ctx) {
  let out = text.replace(CSS_URL_RE, (match, lead, quote, rest, tail) => {
    const next = ctx.prefixPath('/' + rest.trim());
    return next ? `${lead}${quote}${next}${quote}${tail}` : match;
  });
  out = out.replace(CSS_IMPORT_RE, (match, lead, quote, rest) => {
    const next = ctx.prefixPath('/' + rest);
    return next ? `${lead}${quote}${next}${quote}` : match;
  });
  return out;
}

// ======================= JS / JSON / RSC 字面量重写 =======================

const LITERAL_RE = /(["'`])\/(?!\/)([^"'`<>\n\r\\]*)/g;
const ESCAPED_LITERAL_RE = /(["'`])\\\/(?!\/)([A-Za-z0-9._~-][^\\"'`<>\n\r\s?#]*)/g;
const SOURCE_MAP_RE = /(\/\/[#@]\s*sourceMappingURL=)(\/(?!\/)[^\s"'`]*)/g;
const WORKER_REGISTER_RE =
  /((?:serviceWorker\s*\.\s*register|new\s+Worker|importScripts)\s*\(\s*)(["'])\/(?!\/)([^"']*)\2/g;
const WEBPACK_PUBLIC_PATH_RE = /(__webpack_require__\s*\.\s*p\s*=\s*)(["'])\/?\2/g;
const ROUTER_BASENAME_RE = /basename:\s*(["'])\/(?!\/)([^"']*)\1/g;
const ROUTER_BASENAME_VAR_RE = /basename:\s*([A-Za-z0-9_$]+)\s*=\s*["']\/["']/g;
const ROUTER_HISTORY_RE = /history:\s*([A-Za-z0-9_$]+)\s*\(\s*["']\/["']\s*\)/g;
const SANDBOX_RE = /sandbox:\s*["']allow-scripts\s+allow-forms["']/g;

/**
 * 深度字面量补全："/api/x"、'\/api\/x'、`/assets/x` 形式统一补全。
 * 白名单由 ctx.prefixPath -> shouldPrefix 决定，避免误伤外部 CDN 与非路径字符串。
 */
function rewriteLiterals(text, ctx) {
  let out = text.replace(LITERAL_RE, (match, quote, rest) => {
    const next = ctx.prefixPath('/' + rest);
    return next ? `${quote}${next}` : match;
  });

  out = out.replace(ESCAPED_LITERAL_RE, (match, quote, seg) => {
    const next = ctx.prefixPath('/' + seg);
    if (!next) return match;
    return `${quote}\\/${next.slice(1).replace(/\//g, '\\/')}`;
  });

  return out;
}

/** JS 专属的结构性补全（前端路由 base、Worker 注册、webpack publicPath、源码映射） */
function rewriteScriptStructure(text, ctx) {
  let out = text;

  out = out.replace(SOURCE_MAP_RE, (match, lead, url) => {
    const next = ctx.forcePath(url);
    return next ? lead + next : match;
  });

  out = out.replace(WORKER_REGISTER_RE, (match, lead, quote, rest) => {
    const next = ctx.forcePath('/' + rest);
    return next ? `${lead}${quote}${next}${quote}` : match;
  });

  out = out.replace(WEBPACK_PUBLIC_PATH_RE, (match, lead, quote) => `${lead}${quote}${ctx.subpath}/${quote}`);

  out = out.replace(ROUTER_BASENAME_RE, (match, quote, rest) => {
    if (rest.startsWith(ctx.subPrefix + '/') || rest === ctx.subPrefix) return match;
    return `basename:${quote}${ctx.subpath}/${rest}${quote}`;
  });

  out = out.replace(ROUTER_BASENAME_VAR_RE, (match, varName) => `basename:${varName}="${ctx.subpath}/"`);

  out = out.replace(ROUTER_HISTORY_RE, (match, fn) => `history:${fn}("${ctx.subpath}/")`);

  if (ctx.options.relaxIframeSandbox !== false) {
    out = out.replace(SANDBOX_RE, 'sandbox:"allow-scripts allow-forms allow-same-origin"');
  }

  return out;
}

// ======================= 响应头重写 =======================

/**
 * 跳转地址统一收敛：
 *   - 根相对 /x        -> /um/x
 *   - 协议相对 //host/x -> 同网关/同上游主机时转成 /um/x，其余保持
 *   - 绝对地址 http(s)://host/x -> 主机属于网关或上游时转成 /um/x
 * @returns {string|null} null 表示无需改动
 */
function rewriteRedirectTarget(target, ctx) {
  const value = String(target || '').trim();
  if (!value) return null;

  const { subpath, targetHost, requestHost } = ctx;
  const sameHosts = new Set();
  if (targetHost) sameHosts.add(targetHost);
  if (requestHost) sameHosts.add(requestHost.split(':')[0]);

  // 已知前缀判定必须剥离查询/hash，避免 /app?x=1 被二次补全为 /app/app?x=1
  const applyPrefix = (value) => {
    const cut = value.search(/[?#]/);
    const pathPart = cut === -1 ? value : value.slice(0, cut);
    const tail = cut === -1 ? '' : value.slice(cut);
    if (pathPart === subpath || pathPart.startsWith(subpath + '/')) return value;
    if (pathPart === '/') return subpath + '/' + tail;
    return subpath + value;
  };

  if (value.startsWith('//')) {
    try {
      const parsed = new URL('http:' + value);
      if (!sameHosts.has(parsed.host) && !sameHosts.has(parsed.hostname)) return null;
      return applyPrefix(parsed.pathname) + parsed.search + parsed.hash;
    } catch (err) {
      return null;
    }
  }

  if (value.startsWith('/')) {
    return applyPrefix(value);
  }

  try {
    const parsed = new URL(value);
    if (!sameHosts.has(parsed.host) && !sameHosts.has(parsed.hostname)) return null;
    return applyPrefix(parsed.pathname) + parsed.search + parsed.hash;
  } catch (err) {
    return null;
  }
}

/** Refresh: 5; url=/x -> 同步补全 url 部分 */
function rewriteRefreshHeader(header, ctx) {
  return String(header).replace(/(url\s*=\s*)(\S+)/gi, (match, lead, url) => {
    const next = rewriteRedirectTarget(url, ctx);
    return next ? lead + next : match;
  });
}

/** Link: </a.css>; rel=preload -> 补全尖括号内的根绝对路径 */
function rewriteLinkHeader(header, ctx) {
  return String(header).replace(/<(\/(?!\/)[^>]*)>/g, (match, url) => {
    const next = ctx.prefixPath ? ctx.prefixPath(url) : null;
    return next ? `<${next}>` : match;
  });
}

/**
 * Set-Cookie 归一化：
 *   1. 剥离 Domain（转发域上不存在该 Domain，浏览器会直接丢弃 Cookie -> 会话丢失）
 *   2. 可选把非根 Path 收敛到子路径，避免同域其他应用读取/覆盖同名 Cookie；
 *      根作用域 Path=/ 始终保留（应用常用根级 /api/*，收敛会造成会话丢失）
 *   3. 修正 SameSite 与 Secure 组合（SameSite=None 必须搭配 Secure）
 */
function rewriteSetCookie(cookie, ctx) {
  const { subpath, options, secure } = ctx;
  let out = String(cookie);

  out = out.replace(/;\s*Domain=[^;]*/gi, '');

  const cookieName = (out.split('=')[0] || '').trim();
  const hostLocked = /^__(?:Host|Secure)-/i.test(cookieName);

  if (options.rewriteCookie && !hostLocked) {
    out = out.replace(/(;\s*Path=)([^;]*)/i, (match, lead, rawPath) => {
      const pathValue = rawPath.trim();
      if (!pathValue) return match;
      const normalized = pathValue.startsWith('/') ? pathValue : '/' + pathValue;
      if (normalized === subpath || normalized.startsWith(subpath + '/')) return match;
      // 根作用域保持原样：大量应用把接口挂在根级 /api/*，把 Path=/ 收敛到子路径会让这些请求丢失会话
      if (normalized === '/') return match;
      return `${lead}${subpath}${normalized}`;
    });
  }

  const sameSite = options.cookieSameSite === undefined ? 'Lax' : options.cookieSameSite;
  if (sameSite && sameSite !== 'keep' && !/;\s*SameSite=/i.test(out)) {
    out += `; SameSite=${sameSite}`;
  }
  if (/;\s*SameSite=None/i.test(out) && secure && !/;\s*Secure/i.test(out)) {
    out += '; Secure';
  }
  return out;
}

/** 剥离阻碍 iframe 嵌入的安全标头（网关聚合门户的默认行为，可通过选项关闭） */
function applySecurityHeaderPolicy(headers, options) {
  if (options.stripFrameGuards === false) return headers;
  delete headers['x-frame-options'];
  delete headers['content-security-policy'];
  delete headers['content-security-policy-report-only'];
  return headers;
}

/**
 * 缓存策略：
 *   - 未改写 -> 原样保留上游标头（但携带 Set-Cookie 时强制 private/no-store）
 *   - 已改写的静态资源 -> 保留上游强缓存（摘除 ETag/Last-Modified，因为校验器指向旧内容）
 *   - 其余动态内容 -> no-store，避免网关把带会话的 HTML/接口缓存给其他访问者
 */
function applyCachePolicy(headers, { modified, staticAsset, upstreamCacheControl, method, statusCode, hasSetCookie }) {
  const hasCookie = hasSetCookie === true;

  if (!modified) {
    // 复用一段"带 Set-Cookie 的响应不得进入共享缓存"的基线
    if (hasCookie && !/no-store|private/i.test(String(headers['cache-control'] || ''))) {
      headers['cache-control'] = 'private, no-store, must-revalidate';
      headers.pragma = 'no-cache';
      headers.expires = '0';
      delete headers.etag;
      delete headers['last-modified'];
    }
    return headers;
  }

  delete headers.etag;
  delete headers['last-modified'];

  const upstreamCC = String(upstreamCacheControl || '');
  const dynamicUpstream = /no-store|no-cache|private/i.test(upstreamCC);
  const cacheable =
    staticAsset &&
    !hasCookie &&
    !dynamicUpstream &&
    method === 'GET' &&
    statusCode >= 200 &&
    statusCode < 300;

  if (cacheable) {
    if (!headers['cache-control']) headers['cache-control'] = 'public, max-age=300';
    return headers;
  }

  headers['cache-control'] = 'no-cache, no-store, must-revalidate';
  headers.pragma = 'no-cache';
  headers.expires = '0';
  return headers;
}

/** 转义正则元字符（用于把配置值拼进 RegExp 的场景） */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  MAX_REWRITE_BYTES,
  SEGMENT_RE,
  pickResponseEncoding,
  upstreamRequestEncoding,
  normalizeEncoding,
  createEncoder,
  decodeBuffer,
  guessRewriteKind,
  isRewritableCharset,
  isStaticAssetPath,
  firstSegment,
  createContext,
  rewriteDocument,
  rewriteCssUrls,
  rewriteLiterals,
  rewriteScriptStructure,
  rewriteRedirectTarget,
  rewriteRefreshHeader,
  rewriteLinkHeader,
  rewriteSetCookie,
  escapeRegExp,
  applySecurityHeaderPolicy,
  applyCachePolicy
};
