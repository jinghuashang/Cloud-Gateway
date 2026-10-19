'use strict';

/**
 * ============================================================================
 * Cloud Gateway · 路由诊断 (Route Doctor)
 * ============================================================================
 * 通过网关自身链路探测某个已启用路由的上游，并把"线上会发生什么"直接算出来：
 *   1. 上游可达性 / 状态码 / 延迟 / 内容类型；
 *   2. 响应体干跑重写报告——调用方注入的 inspect() 就是线上那条真实规则链，
 *      因此诊断结论与线上行为一致，不存在"诊断说没事、线上却白屏"的偏差；
 *   3. 响应头体检：Location 自跳转、Set-Cookie 的 Domain/Path/SameSite、
 *      CSP/X-Frame-Options、缓存语义；
 *   4. 技术栈嗅探（Next.js / Vite / webpack / React Router / Vue Router /
 *      Socket.IO / Service Worker / RSC）；
 *   5. 可执行建议清单（中文人话，直接指出该开哪个开关）。
 * 只读：不写配置、不写自学习状态、不改写任何线上内容。
 * ============================================================================
 */

const http = require('http');
const https = require('https');
const rewriter = require('./text-rewriter');

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 6000;

const STACK_SIGNATURES = [
  { id: 'nextjs-rsc', label: 'Next.js App Router (RSC)', re: /self\.__next_f|__next_f\.push|text\/x-component/i },
  { id: 'nextjs', label: 'Next.js', re: /\/_next\/|__NEXT_DATA__|next\/dist/i },
  { id: 'vite', label: 'Vite', re: /\/@vite\/client|__vite_legacy_assets|type="module"[^>]*\/assets\//i },
  { id: 'webpack', label: 'webpack 运行时', re: /__webpack_require__|webpackJsonp/i },
  { id: 'react-router', label: 'React Router', re: /createBrowserRouter|basename:\s*["']|react-router/i },
  { id: 'vue-router', label: 'Vue Router', re: /createWebHistory|createWebHashHistory|vue-router/i },
  { id: 'socketio', label: 'Socket.IO', re: /\/socket\.io\/|socket\.io\.js/i },
  { id: 'service-worker', label: 'Service Worker', re: /serviceWorker\s*\.\s*register|navigator\.serviceWorker/i },
  { id: 'sveltekit', label: 'SvelteKit', re: /__sveltekit_|\/_app\/immutable\//i },
  { id: 'nuxt', label: 'Nuxt', re: /__NUXT__|\/_nuxt\//i }
];

function stripSubpath(pathname, subpath) {
  if (!subpath) return pathname;
  if (pathname === subpath) return '/';
  if (pathname.startsWith(subpath + '/')) return pathname.slice(subpath.length);
  return pathname;
}

/** 探测上游：只取够诊断用的前 1MiB，明文编码便于分析 */
function fetchUpstream(url, { headers, timeoutMs = DEFAULT_TIMEOUT_MS, limitBytes = MAX_BODY_BYTES, insecureTLS = false } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error('target 地址无法解析'));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('仅支持 http/https 上游'));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: insecureTLS !== true
    }, (res) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      res.on('data', (chunk) => {
        if (size >= limitBytes) {
          truncated = true;
          return;
        }
        const remain = limitBytes - size;
        const slice = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
        chunks.push(slice);
        size += slice.length;
        if (slice.length < chunk.length) truncated = true;
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks, size),
        truncated
      }));
      res.on('error', reject);
    });

    req.on('timeout', () => req.destroy(new Error(`上游 ${timeoutMs}ms 未响应`)));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function parseCookies(rawSetCookie) {
  if (!rawSetCookie) return [];
  const list = Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie];
  return list.map((raw) => {
    const parts = String(raw).split(';');
    const name = parts[0].split('=')[0].trim();
    const attrs = {};
    for (const part of parts.slice(1)) {
      const idx = part.indexOf('=');
      const key = (idx === -1 ? part : part.slice(0, idx)).trim().toLowerCase();
      const value = idx === -1 ? '' : part.slice(idx + 1).trim();
      attrs[key] = value;
    }
    return {
      name,
      domain: attrs.domain || null,
      path: attrs.path || null,
      sameSite: attrs.samesite || null,
      secure: Object.prototype.hasOwnProperty.call(attrs, 'secure'),
      httpOnly: Object.prototype.hasOwnProperty.call(attrs, 'httponly')
    };
  });
}

function detectStack(body, headers) {
  const detected = [];
  for (const sig of STACK_SIGNATURES) {
    if (headers && /x-nextjs/i.test(Object.keys(headers).join(',') + ' ') && sig.id.startsWith('nextjs')) {
      detected.push(sig.label);
      continue;
    }
    if (sig.re.test(body)) detected.push(sig.label);
  }
  return [...new Set(detected)];
}

function redirectIsSelf(location, probePath) {
  try {
    const base = 'http://gateway.local';
    const current = new URL(probePath, base);
    const next = new URL(location, current);
    return next.pathname === current.pathname && next.search === current.search;
  } catch (err) {
    return false;
  }
}

/**
 * 诊断一条路由。
 * @param {object} params
 * @param {string} params.subpath     路由子路径（如 /app）
 * @param {string} params.target      上游地址
 * @param {string} params.probePath   探测路径（网关侧路径，默认 /）
 * @param {object} params.options     该路由的归一化选项
 * @param {string} params.profileName 生效画像名
 * @param {Function} params.inspect   干跑重写：inspect(text, kind, ctx) -> 报告
 */
async function diagnose({ subpath, target, probePath = '/', options = {}, profileName = 'none', deepEnabled = null, insecureTLS = false, inspect }) {
  const normalizedProbe = String(probePath || '/').startsWith('/') ? String(probePath || '/') : `/${probePath}`;
  const upstreamPath = stripSubpath(normalizedProbe, subpath);
  const base = String(target || '').replace(/\/+$/, '');
  const url = base + upstreamPath;

  const startedAt = Date.now();
  const probe = await fetchUpstream(url, {
    insecureTLS: insecureTLS === true,
    headers: {
      'X-Forwarded-Prefix': subpath,
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'gateway.local',
      'X-Real-IP': '127.0.0.1',
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'identity',
      'User-Agent': 'Cloud-Gateway-Doctor/1.0'
    }
  });
  const latencyMs = Date.now() - startedAt;

  let targetHost = '';
  try {
    targetHost = new URL(base).host;
  } catch (err) {
    targetHost = '';
  }

  const contentType = String(probe.headers['content-type'] || '');
  const kind = rewriter.guessRewriteKind(contentType);
  const rewritable = kind !== 'none' && rewriter.isRewritableCharset(contentType);
  const text = rewritable ? probe.body.toString('utf8') : '';
  const recommendations = [];

  // ---------- 响应体干跑 ----------
  let bodyReport = {
    kind,
    bytes: probe.body.length,
    truncated: probe.truncated,
    rewritable,
    note: kind === 'none' ? '非文本响应，原样透传（SSE/二进制/流式）' : (rewritable ? '' : '非 UTF-8 文本，原样透传以免破坏编码')
  };
  if (rewritable && typeof inspect === 'function') {
    const report = inspect(text, kind, { path: upstreamPath, headers: probe.headers });
    if (!report || report.ok === false) {
      bodyReport.diagnosisUnavailable = (report && report.error) || '干跑诊断不可用';
    } else {
      bodyReport = {
        ...bodyReport,
        modified: report.modified,
        counts: report.counts,
        segments: report.segments,
        samples: (report.samples || []).slice(0, 12),
        rewrittenRefs: report.counts.rewritten || 0,
        blockedRefs: report.counts['skipped-policy'] || 0,
        prefixedRefs: report.counts['already-prefixed'] || 0,
        externalRefs: report.counts.external || 0
      };
    }
  }

  // ---------- 响应头体检 ----------
  const cookies = parseCookies(probe.headers['set-cookie']);
  const location = probe.headers.location || null;
  const isRedirect = probe.status >= 300 && probe.status < 400 && !!location;
  const rewrittenLocation = location
    ? (rewriter.rewriteRedirectTarget(location, { subpath, targetHost, requestHost: '' }) || location)
    : null;
  const cacheControl = probe.headers['cache-control'] || null;

  const headerReport = {
    location,
    rewrittenLocation,
    // 浏览器看到的是补全后的地址，因此环路判定必须用"网关侧路径 vs 补全后的 Location"
    selfLoop: !!(isRedirect && rewrittenLocation && redirectIsSelf(rewrittenLocation, normalizedProbe)),
    cookies,
    frameGuards: {
      contentSecurityPolicy: !!probe.headers['content-security-policy'],
      xFrameOptions: !!probe.headers['x-frame-options'],
      strippedByGateway: options.stripFrameGuards !== false
    },
    cache: {
      upstream: cacheControl,
      staticAsset: rewriter.isStaticAssetPath(upstreamPath),
      effective: rewriter.isStaticAssetPath(upstreamPath) && options.cacheAssets !== false
        ? (cacheControl || 'public, max-age=300（网关兜底）')
        : 'no-cache, no-store, must-revalidate'
    },
    contentEncoding: probe.headers['content-encoding'] || null
  };

  // ---------- 技术栈 ----------
  const stack = [...new Set([...detectStack(text, probe.headers), ...detectStack(Object.keys(probe.headers).join(' '), null)])];

  // ---------- 建议 ----------
  if (probe.status >= 400) {
    recommendations.push(`上游返回 ${probe.status}：请确认应用已启动、target 地址正确、且该路径在应用内确实存在。`);
  }
  if (headerReport.selfLoop) {
    recommendations.push(`上游把 ${normalizedProbe} 重定向回它自己（${location}）：浏览器会无限循环，网关已按 508 拦截；建议修正上游的 base_url / ROOT_URL 配置。`);
  } else if (isRedirect && rewrittenLocation !== location) {
    recommendations.push(`跳转地址 ${location} 已被补全为 ${rewrittenLocation}。`);
  } else if (isRedirect && options.rewriteLocation === false) {
    recommendations.push(`检测到跳转响应但 rewriteLocation 已关闭，Location 不会被补全，容易出现"跳到站点根目录 404"。`);
  }
  for (const cookie of cookies) {
    if (cookie.domain) {
      recommendations.push(`Cookie ${cookie.name} 带 Domain=${cookie.domain}：网关会剥离该属性，否则浏览器在网关域名上会直接丢弃它（典型症状是"登录后又掉线"）。`);
    }
    if (cookie.path === '/' && options.rewriteCookie !== true) {
      recommendations.push(`Cookie ${cookie.name} 的 Path=/ 会应用到整站：如需收敛到 ${subpath}/，请开启 rewriteCookie。`);
    }
    if (!cookie.sameSite) {
      recommendations.push(`Cookie ${cookie.name} 未声明 SameSite：网关会按 cookieSameSite（默认 Lax）补齐。`);
    }
  }
  if (headerReport.frameGuards.contentSecurityPolicy || headerReport.frameGuards.xFrameOptions) {
    recommendations.push(`上游返回了 ${[headerReport.frameGuards.contentSecurityPolicy ? 'CSP' : '', headerReport.frameGuards.xFrameOptions ? 'X-Frame-Options' : ''].filter(Boolean).join(' / ')}：网关默认剥离以便门户内嵌（如需保留请关闭 stripFrameGuards）。`);
  }
  if (bodyReport.rewrittenRefs > 0) {
    const segs = Object.entries(bodyReport.segments || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`).join('、');
    recommendations.push(`本页 ${bodyReport.rewrittenRefs} 处根绝对引用会被自动补全，涉及路径段：${segs || '（根路径）'}。`);
  }
  if (bodyReport.blockedRefs > 0) {
    recommendations.push(`有 ${bodyReport.blockedRefs} 处根绝对引用因白名单被跳过：建议开启 autoPrefixSubpath，或在 deepPaths 中追加对应路径段，或在应用内配置 base path 从源头消解。`);
  }
  if (bodyReport.prefixedRefs > 0) {
    recommendations.push(`有 ${bodyReport.prefixedRefs} 处引用已带 ${subpath} 前缀（应用可能已支持 X-Forwarded-Prefix 或已配置 base path），网关不会二次补全。`);
  }
  if (rewritable && bodyReport.rewrittenRefs === 0 && bodyReport.blockedRefs === 0) {
    recommendations.push('本页未发现需要补全的根绝对引用，该路径的链路看起来是干净的。');
  }
  if (headerReport.cache.staticAsset && !cacheControl) {
    recommendations.push('静态资源未设置 Cache-Control：网关会兜底 public, max-age=300；建议上游补上强缓存以减少回源。');
  }
  if (stack.some((s) => s.includes('Socket.IO')) && options.ws === false) {
    recommendations.push('检测到 Socket.IO，但该路由 ws 开关为关闭，实时通道会连不上。');
  }
  if (stack.some((s) => s.includes('Next.js')) && bodyReport.blockedRefs > 0) {
    recommendations.push('检测到 Next.js：若不便改代码，可在应用侧设置 basePath/assetPrefix，或依赖网关的深度补全（autoPrefixSubpath）。');
  }
  if (probe.truncated) {
    recommendations.push(`响应体超过 ${Math.round(MAX_BODY_BYTES / 1024)}KiB，诊断只分析了前一部分；线上超过 GW_MAX_REWRITE_BYTES 的响应会整体原样透传。`);
  }

  return {
    ok: true,
    subpath,
    probePath: normalizedProbe,
    upstreamPath,
    target,
    profile: profileName,
    options: {
      autoSlash: options.autoSlash !== false,
      injectBase: options.injectBase !== false,
      rewriteHtml: options.rewriteHtml !== false,
      rewriteCss: options.rewriteCss !== false,
      deepRewrite: deepEnabled === null ? options.autoPrefixSubpath === true : deepEnabled === true,
      rewriteLocation: options.rewriteLocation !== false,
      rewriteCookie: options.rewriteCookie === true,
      cacheAssets: options.cacheAssets !== false,
      stripFrameGuards: options.stripFrameGuards !== false,
      ws: options.ws !== false,
      changeOrigin: options.changeOrigin !== false
    },
    upstream: {
      url,
      status: probe.status,
      latencyMs,
      contentType,
      bodyBytes: probe.body.length,
      truncated: probe.truncated
    },
    body: bodyReport,
    headers: headerReport,
    stack,
    recommendations
  };
}

module.exports = { diagnose, fetchUpstream, parseCookies, STACK_SIGNATURES };
