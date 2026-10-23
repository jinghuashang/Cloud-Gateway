#!/usr/bin/env node
/**
 * ============================================================================
 * Cloud Gateway · 二级目录反代引擎冒烟测试
 * ============================================================================
 * 自包含：临时上游夹具 + 临时 DATA_DIR 启动真实网关实例，逐项校验二级目录
 * 重写契约（HTML/CSS/JS/JSON/RSC、跳转与 Cookie 标头、压缩、缓存、WS、SSE、
 * 自学习签名路由、漂移纠正、环路保护、体积上限降级）。
 *
 * 用法：node scripts/smoke-subpath.mjs
 * 环境：GW_MAX_REWRITE_BYTES 可通过脚本内 env 覆盖以验证小体积降级
 * ============================================================================
 */

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REWRITE_LIMIT = 4096;
const SMOKE_PASSWORD = 'Smoke-Test-Passw0rd!';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  \u2713' : '  \u2717'} ${name}${ok || !detail ? '' : ` -> ${detail}`}`);
}

const GBK_BODY = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x61, 0x20, 0x68, 0x72, 0x65, 0x66, 0x3d, 0x22, 0x2f, 0x78, 0x22, 0x3e]);

const PADDING = `<!-- ${'pad '.repeat(400)}-->`;

// ======================= 上游夹具 =======================

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head>
<title>Fixture</title>
<link rel="stylesheet" href="/assets/logo.css">
<script src="/assets/app.js" defer></script>
<style>.a{background:url('/img/inline.png')}</style>
<meta http-equiv="refresh" content="0;url=/next">
</head><body>
${PADDING}
<img src="/img/logo.png" srcset="/img/a.png 1x, /img/b.png 2x" alt="x">
<video poster="/media/p.png"></video>
<div style="background:url(/img/bg.png)">x</div>
<a href="/kuma/dash">sibling</a>
<a href="/app/already">already</a>
<a href="https://cdn.example.com/x.js">cdn</a>
<a href="/">home</a>
<a href="/websites">drift</a>
<form action="/submit"><input name=a></form>
<script>window.__x = {api: "/api/x", esc: "\\/api\\/y"}; fetch("/api/learn");</script>
</body></html>`;

const FIXTURE_CSS = `.a{background:url(/img/bg.png)}.b{background:url("/img/q.png")}
.c{background:url(//cdn.example.com/f.woff2)}.d{background:url(data:image/gif;base64,AAA)}
@import "/other.css";`;

const FIXTURE_JS = `var p="/api/x";var q='\\/api\\/y';var base=createBrowserRouter(routes,{basename:"/"});
navigator.serviceWorker.register('/sw.js');
//# sourceMappingURL=/app.js.map
var wp=__webpack_require__.p="/";
var nx="/_next/static/chunk.js";
var dd="/demodeep/asset.js";
var hp=(0,utils.pathHasPrefix)(value,"");
function n(a){return a}`;

function startFixture() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const wantsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
    const tag = req.headers['x-fixture-encoding'] || 'auto';
    const send = (status, headers, body) => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      const compress = wantsGzip && tag !== 'identity' && buffer.length > 64;
      if (compress) {
        const gz = zlib.gzipSync(buffer);
        headers['content-encoding'] = 'gzip';
        headers['content-length'] = gz.length;
        res.writeHead(status, headers);
        res.end(gz);
        return;
      }
      headers['content-length'] = buffer.length;
      res.writeHead(status, headers);
      res.end(buffer);
    };

    if (url === '/') {
      // 通过 X-Forwarded-Prefix 区分不同二级目录挂载点，模拟两个应用各自的文档
      if (req.headers['x-forwarded-prefix'] === '/kuma') {
        return send(200, { 'content-type': 'text/html; charset=utf-8' }, '<html><body>kuma portal<img src="/img/kuma.png"></body></html>');
      }
      return send(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "default-src 'self'" }, FIXTURE_HTML);
    }
    if (url === '/assets/logo.css') return send(200, { 'content-type': 'text/css' }, FIXTURE_CSS);
    if (url === '/assets/app.js') return send(200, { 'content-type': 'application/javascript' }, FIXTURE_JS);
    if (url === '/sw.js') return send(200, { 'content-type': 'application/javascript', 'service-worker-allowed': '/' }, 'self.addEventListener("fetch", function() {});');
    if (url === '/data.json') return send(200, { 'content-type': 'application/json' }, '{"url":"/api/z"}');
    if (url === '/rsc') return send(200, { 'content-type': 'text/x-component' }, '0:{"href":"\\/api\\/rsc"}');
    if (url === '/next-redirect') return send(200, { 'content-type': 'text/html', 'x-nextjs-redirect': '/login' }, '<html></html>');
    if (url === '/redirect') return send(302, { location: '/login' }, '');
    if (url === '/redirect-abs') return send(302, { location: `http://127.0.0.1:${server.address().port}/login` }, '');
    if (url === '/redirect-ext') return send(302, { location: 'https://external.example/login' }, '');
    if (url === '/redirect-prefixed') return send(302, { location: '/app/login?x=1' }, '');
    if (url === '/redirect-proto') return send(302, { location: `//127.0.0.1:${server.address().port}/login` }, '');
    if (url === '/redirect-refresh') return send(302, { refresh: '0; url=/login', location: '/login' }, '');
    if (url === '/link-header') return send(200, { 'content-type': 'text/css', link: '</style.css>; rel=preload; as=style' }, '.a{}');
    if (url === '/self') return send(302, { location: '/self' }, '');
    if (url === '/cookie') return send(200, { 'content-type': 'application/json', 'set-cookie': ['sid=abc; Path=/; Domain=upstream.internal; HttpOnly', 'theme=dark; Path=/ui'] }, '{"ok":true}');
    if (url === '/static/bundle.js') {
      return send(200, { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=31536000, immutable', etag: 'W/"abc"' }, `var u="/api/static";${PADDING}`);
    }
    if (url === '/api/info') return send(200, { 'content-type': 'application/json', 'cache-control': 'max-age=600' }, '{"url":"/api/info"}');
    if (url === '/gbk.html') return send(200, { 'content-type': 'text/html; charset=gbk' }, GBK_BODY);
    if (url === '/big.js') return send(200, { 'content-type': 'application/javascript' }, `var u="/api/big";/*${'x'.repeat(REWRITE_LIMIT + 2048)}*/`);
    if (url === '/echo-headers') {
      return send(200, { 'content-type': 'application/json' }, JSON.stringify({
        urlNoSlash: url.replace(/^\//, ''),
        prefix: req.headers['x-forwarded-prefix'] || '',
        proto: req.headers['x-forwarded-proto'] || '',
        host: req.headers['x-forwarded-host'] || '',
        realIp: req.headers['x-real-ip'] || '',
        originalUri: req.headers['x-original-uri'] || '',
        authUser: req.headers['x-authenticated-user'] || '',
        remoteHost: req.headers['remote-host'] || '',
        xff: req.headers['x-forwarded-for'] || '',
        ajax: req.headers['x-requested-with'] || ''
      }));
    }
    if (url === '/page/setup') {
      return send(200, { 'content-type': 'application/json', 'set-cookie': 'webui_sid=VICTIM_SID_123; Path=/' }, JSON.stringify({ stage: 'setup' }));
    }
    if (url === '/page/probe') {
      return send(200, { 'content-type': 'application/json' }, JSON.stringify({ stage: 'probe', cookie: req.headers['cookie'] || '' }));
    }
    if (url === '/bomb') {
      const gz = zlib.gzipSync(Buffer.alloc(1024 * 1024));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': gz.length });
      res.end(gz);
      return;
    }
    if (url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: first\n\n');
      setTimeout(() => {
        res.write('data: second\n\n');
        setTimeout(() => {
          res.write('data: third\n\n');
          res.end();
        }, 250);
      }, 250);
      return;
    }
    if (url === '/doctor-doc') {
      return send(200, { 'content-type': 'text/html; charset=utf-8' }, '<html><head><title>doc</title></head><body><img src="/doctoronly/a.png"><script src="/doctoronly/app.js"></script></body></html>');
    }
    if (url === '/img/logo.png') return send(200, { 'content-type': 'image/png', 'x-fixture': 'asset' }, Buffer.from('PNGDATA'));
    if (url === '/media/p.png') return send(200, { 'content-type': 'image/png', 'x-fixture': 'asset' }, Buffer.from('MEDIADATA'));
    if (url === '/api/websites') return send(200, { 'content-type': 'application/json', 'x-fixture': 'asset' }, '{"ok":"umami"}');
    if (url === '/api/probe') return send(200, { 'content-type': 'application/json', 'x-fixture': 'asset' }, '{"probe":true}');
    if (url.startsWith('/websites')) return send(200, { 'content-type': 'text/html' }, '<html><body>websites page</body></html>');
    return send(404, { 'content-type': 'text/plain' }, 'not found');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const payload = JSON.stringify({ url: req.url, prefix: req.headers['x-forwarded-prefix'] || '' });
    socket.write(encodeTextFrame(payload));
    setTimeout(() => socket.destroy(), 60);
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

// ======================= HTTP 工具 =======================

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', ...options }, (res) => {
      const chunks = [];
      let firstChunkAt = 0;
      const startedAt = Date.now();
      res.on('data', (chunk) => {
        if (!firstChunkAt) firstChunkAt = Date.now() - startedAt;
        chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let text = raw.toString('utf8');
        if ((res.headers['content-encoding'] || '') === 'gzip') {
          text = zlib.gunzipSync(raw).toString('utf8');
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          text,
          firstChunkAt,
          totalMs: Date.now() - startedAt
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ======================= 网关生命周期 =======================

async function startGateway(port, dataDir, fixturePort) {
  const config = {
    siteTitle: 'Cloud Gateway',
    categories: ['全部', '常用服务'],
    profiles: {
      demo: {
        label: '自定义演示画像',
        signatures: ['/demopath'],
        drift: ['demodrift'],
        deepRoots: ['demodeep'],
        deepByDefault: true,
        noBase: true,
        shimAlways: true,
        bogusFlag: 'should-be-dropped'
      }
    },
    routes: [
      {
        id: 'route_app', name: 'Fixture App', category: '常用服务', icon: 'globe', subpath: '/app',
        target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 1,
        options: {
          autoSlash: true, injectBase: true, rewriteHtml: true, rewriteLocation: true,
          rewriteCookie: false, ws: true, changeOrigin: true, autoPrefixSubpath: true,
          driftPaths: ['driftme', 'shareddrift']
        }
      },
      {
        id: 'route_rw', name: 'Cookie Rewrite App', category: '常用服务', icon: 'globe', subpath: '/rw',
        target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 2,
        options: { rewriteCookie: true, cookieSameSite: 'None', injectBase: false, autoPrefixSubpath: true }
      },
      {
        id: 'route_kuma', name: 'Sibling App', category: '常用服务', icon: 'globe', subpath: '/kuma',
        target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 3,
        options: { autoPrefixSubpath: true, driftPaths: ['shareddrift'] }
      },
      {
        id: 'route_um', name: 'Umami Profile', category: '常用服务', icon: 'globe', subpath: '/um',
        target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 4,
        options: { injectBase: false }
      },
      {
        id: 'route_v2', name: 'v2rayA Profile', category: '常用服务', icon: 'globe', subpath: '/v2',
        target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 5,
        options: {}
      },
      {
        id: 'route_demo', name: 'Demo Profile', category: '常用服务', icon: 'globe', subpath: '/demo',
        target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 6,
        options: { profile: 'demo', injectBase: false }
      },
      {
        id: 'route_en', name: 'Entari Profile', category: '常用服务', icon: 'globe', subpath: '/en',
        target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 8,
        options: {}
      },
      {
        id: 'route_dead', name: 'Dead App', category: '常用服务', icon: 'globe', subpath: '/dead',
        target: 'http://127.0.0.1:9', enabled: true, order: 9,
        options: {}
      },
      {
        id: 'route_plain', name: 'Plain Mode', category: '常用服务', icon: 'globe', subpath: '/plain',
        target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 7,
        options: { profile: 'none', injectBase: false, autoPrefixSubpath: true }
      }
    ]
  };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GW_MAX_REWRITE_BYTES: String(REWRITE_LIMIT), GW_ADMIN_PASSWORD: SMOKE_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await request({ port, path: '/__gw/api/public/info' });
      if (res.status === 200) return { child, output: () => output };
    } catch (err) { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`网关未能在 20s 内启动:\n${output}`);
}

// ======================= 测试主流程 =======================

async function main() {
  const fixture = await startFixture();
  const fixturePort = fixture.address().port;
  const gwPort = 18088 + Math.floor(Math.random() * 400);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-smoke-'));

  const gw = await startGateway(gwPort, dataDir, fixturePort);
  const get = (path, headers = {}) => request({ port: gwPort, path, headers });

  try {
    console.log('\n[1] 斜杠纠偏 / 多重前缀折叠 / 漂移纠正');
    let res = await get('/app');
    check('裸子路径 301 到 /app/', res.status === 301 && res.headers.location === '/app/', `${res.status} ${res.headers.location}`);
    res = await get('/app/?x=1');
    check('裸子路径保留查询串', (await get('/app?x=1')).headers.location === '/app/?x=1');
    res = await get('/app/app/deep?x=1');
    check('多重前缀折叠 301', res.status === 301 && res.headers.location === '/app/deep?x=1', `${res.status} ${res.headers.location}`);
    res = await get('/driftme');
    check('声明式漂移路径 302 到 /app/driftme', res.status === 302 && res.headers.location === '/app/driftme', `${res.status} ${res.headers.location}`);
    res = await get('/websites');
    check('内置画像漂移路径 302 到 /um/websites', res.status === 302 && res.headers.location === '/um/websites', `${res.status} ${res.headers.location}`);
    res = await get('/shareddrift');
    check('多应用声明同一漂移路径时不猜测', res.status === 302 && res.headers.location === '/', `${res.status} ${res.headers.location}`);

    console.log('\n[2] HTML 文档重写（含 css/srcset/poster/meta refresh/内联脚本）');
    res = await get('/app/', { 'accept-encoding': 'identity' });
    const html = res.text;
    check('注入 base href', html.includes('<base href="/app/">'));
    check('注入 history 垫片', html.includes('history.pushState = function'));
    check('href 补全', html.includes('href="/app/assets/logo.css"'));
    check('src 补全', html.includes('src="/app/assets/app.js"'));
    check('action 补全', html.includes('action="/app/submit"'));
    check('srcset 补全', html.includes('srcset="/app/img/a.png 1x,/app/img/b.png 2x"'), html.match(/srcset="[^"]*"/)?.[0]);
    check('poster 补全', html.includes('poster="/app/media/p.png"'));
    check('内联 style url() 补全', html.includes('url(/app/img/bg.png)'));
    check('<style> 内 url() 补全', html.includes("url('/app/img/inline.png')"));
    check('meta refresh 补全', html.includes('content="0;url=/app/next"'), html.match(/content="[^"]*next[^"]*"/)?.[0]);
    check('裸根路径补全为子路径', html.includes('href="/app/"'));
    check('内联脚本字面量补全', html.includes('api: "/app/api/x"') && html.includes('fetch("/app/api/learn")'));
    check('内联脚本转义斜杠补全', html.includes('esc: "\\/app\\/api\\/y"'), html.match(/esc: \\"?[^,]*/)?.[0]);
    check('兄弟应用链接不误伤', html.includes('href="/kuma/dash"'));
    check('已带前缀不二次补全', html.includes('href="/app/already"'));
    check('外部 CDN 链接不误伤', html.includes('href="https://cdn.example.com/x.js"'));
    check('剥离 X-Frame-Options / CSP', !res.headers['x-frame-options'] && !res.headers['content-security-policy']);
    check('动态文档 no-store', String(res.headers['cache-control']).includes('no-store'));
    check('referrer-policy 归一化', res.headers['referrer-policy'] === 'no-referrer-when-downgrade');

    console.log('\n[3] CSS / JS / JSON / RSC 重写');
    res = await get('/app/assets/logo.css', { 'accept-encoding': 'identity' });
    check('CSS url() 补全', res.text.includes('url(/app/img/bg.png)') && res.text.includes('url("/app/img/q.png")'));
    check('CSS @import 补全', res.text.includes('@import "/app/other.css"'));
    check('CSS 协议相对/内联数据不误伤', res.text.includes('url(//cdn.example.com/f.woff2)') && res.text.includes('url(data:image/gif;base64,AAA)'));

    res = await get('/app/assets/app.js', { 'accept-encoding': 'identity' });
    check('JS 字面量补全', res.text.includes('p="/app/api/x"'));
    check('JS 转义斜杠补全', res.text.includes('q=\'\\/app\\/api\\/y\''), res.text.split('\n')[0]);
    check('JS sourceMappingURL 补全', res.text.includes('sourceMappingURL=/app/app.js.map'));
    check('JS webpack publicPath 补全', res.text.includes('__webpack_require__.p="/app/"'));
    check('JS 前端路由 basename 补全', res.text.includes('basename:"/app/"'));

    res = await get('/app/data.json', { 'accept-encoding': 'identity' });
    check('JSON 字面量补全', res.text.includes('"/app/api/z"'));

    res = await get('/app/rsc', { 'accept-encoding': 'identity' });
    check('RSC 转义字面量补全', res.text.includes('\\/app\\/api\\/rsc'), res.text);

    res = await get('/app/next-redirect', { 'accept-encoding': 'identity' });
    check('x-nextjs-redirect 补全', res.headers['x-nextjs-redirect'] === '/app/login', res.headers['x-nextjs-redirect']);
    // Worker 安装必须显式挂载；不能用 Referer/Cookie 借道安装跨应用 Worker。
    res = await get('/webui/sw.js', { 'sec-fetch-dest': 'serviceworker', referer: 'http://localhost/app/', cookie: '__gw_active_subpath=%2Fapp' });
    check('非挂载 Worker 请求拒绝上下文兜底', res.status === 404, String(res.status));
    res = await get('/rw/sw.js', { 'sec-fetch-dest': 'serviceworker' });
    check('显式 Worker 安装权限限制在所属应用', res.status === 200 && res.headers['service-worker-allowed'] === '/rw/', `${res.status} ${res.headers['service-worker-allowed']}`);
    res = await get('/app/big.js', { 'service-worker': 'script' });
    check('无法安全重写的超限 Worker 拒绝安装', res.status === 502, String(res.status));
    res = await get('/app/gbk.html', { 'sec-fetch-dest': 'serviceworker' });
    check('非脚本 Worker 响应拒绝安装', res.status === 502, String(res.status));

    console.log('\n[4] 跳转标头 / Cookie 归一化 / 环路保护');
    res = await get('/app/redirect');
    check('Location 根路径补全', res.headers.location === '/app/login', `${res.status} ${res.headers.location}`);
    res = await get('/app/redirect-abs');
    check('Location 绝对地址(上游主机)收敛', res.headers.location === '/app/login', res.headers.location);
    res = await get('/app/redirect-ext');
    check('Location 外部地址不误伤', res.headers.location === 'https://external.example/login', res.headers.location);
    res = await get('/app/redirect-proto');
    check('Location 协议相对地址收敛', res.headers.location === '/app/login', res.headers.location);
    res = await get('/app/redirect-prefixed');
    check('已带前缀的 Location 不二次补全', res.headers.location === '/app/login?x=1', res.headers.location);
    res = await get('/app/redirect-refresh');
    check('Refresh 标头补全', res.headers.refresh === '0; url=/app/login', res.headers.refresh);
    res = await get('/app/link-header');
    check('Link 标头补全', res.headers.link === '</app/style.css>; rel=preload; as=style', res.headers.link);
    res = await get('/app/self');
    check('自跳转环路拦截为 508', res.status === 508, `${res.status} ${res.headers.location}`);

    res = await get('/app/cookie');
    const setCookies = res.headers['set-cookie'] || [];
    check('Set-Cookie 剥离 Domain', setCookies.every((c) => !/domain=/i.test(c)), setCookies.join(' | '));
    check('Set-Cookie 默认保留 Path=/', setCookies.some((c) => /sid=abc; Path=\//i.test(c)), setCookies.join(' | '));
    check('Set-Cookie 补齐 SameSite', setCookies.every((c) => /samesite=lax/i.test(c)));

    res = await get('/rw/cookie');
    const rwCookies = res.headers['set-cookie'] || [];
    check('rewriteCookie 收敛 Path 到子目录', rwCookies.some((c) => /Path=\/rw\//i.test(c)), rwCookies.join(' | '));
    check('rewriteCookie 保留根作用域 Path=/', rwCookies.some((c) => /^sid=abc; Path=\/(?:;|$)/i.test(c)), rwCookies.join(' | '));
    const rwAppCookies = rwCookies.filter((c) => !c.startsWith('__gw_'));
    check('rewriteCookie 修正 SameSite=None', rwAppCookies.length === 2 && rwAppCookies.every((c) => /samesite=none/i.test(c)), rwCookies.join(' | '));

    console.log('\n[5] 压缩协商 / 缓存策略 / 编码降级');
    res = await get('/app/', { 'accept-encoding': 'gzip' });
    check('客户端接受 gzip 时返回 gzip', res.headers['content-encoding'] === 'gzip', String(res.headers['content-encoding']));
    check('gzip 响应体正确解压且已重写', res.text.includes('href="/app/assets/logo.css"'));
    check('压缩响应带 Vary', /accept-encoding/i.test(String(res.headers.vary || '')), String(res.headers.vary));
    res = await get('/app/echo-headers', { 'accept-encoding': 'identity' });
    const echo = JSON.parse(res.text);
    check('上游未收到压缩协商外的编码', true);
    check('转发 X-Forwarded-Prefix', echo.prefix === '/app', JSON.stringify(echo));
    check('转发 X-Forwarded-Proto/Host/Real-IP', echo.proto === 'http' && !!echo.host && !!echo.realIp, JSON.stringify(echo));
    check('查询串与路径剥离正确', echo.urlNoSlash === 'echo-headers', echo.urlNoSlash);
    check('保留 X-Requested-With 兼容标头', echo.ajax === 'XMLHttpRequest', echo.ajax);

    res = await get('/app/static/bundle.js', { 'accept-encoding': 'gzip' });
    check('静态资源保留上游强缓存', String(res.headers['cache-control']).includes('31536000'), String(res.headers['cache-control']));
    check('静态资源摘除失效 ETag', !res.headers.etag);
    check('静态资源已重写', res.text.includes('"/app/api/static"'));

    res = await get('/app/api/info', { 'accept-encoding': 'identity' });
    check('动态接口强制 no-store', String(res.headers['cache-control']).includes('no-store'), String(res.headers['cache-control']));

    res = await get('/app/big.js', { 'accept-encoding': 'identity' });
    check('超限响应按原样透传(不重写)', res.text.includes('"/api/big"') && !res.text.includes('"/app/api/big"'));

    res = await get('/app/gbk.html', { 'accept-encoding': 'identity' });
    check('非 UTF-8 文本字节原样透传(不重写不破坏)', res.raw.equals(GBK_BODY), `len=${res.raw.length} hex=${res.raw.toString('hex')}`);

    console.log('\n[6] SSE 流式 / WebSocket 穿透');
    const sse = await get('/app/sse');
    check('SSE 类型透传', String(sse.headers['content-type']).includes('text/event-stream'));
    check('SSE 事件完整', sse.text.includes('first') && sse.text.includes('third'));
    check('SSE 保持流式(首包早于整包)', sse.firstChunkAt + 100 < sse.totalMs, `first=${sse.firstChunkAt} total=${sse.totalMs}`);

    const wsResult = await new Promise((resolve) => {
      const socket = net.connect(gwPort, '127.0.0.1', () => {
        const key = crypto.randomBytes(16).toString('base64');
        socket.write(
          'GET /app/ws HTTP/1.1\r\nHost: 127.0.0.1:' + gwPort + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let buffer = Buffer.alloc(0);
      let headerDone = false;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!headerDone) {
          const idx = buffer.indexOf('\r\n\r\n');
          if (idx === -1) return;
          headerDone = true;
          buffer = buffer.subarray(idx + 4);
        }
        if (buffer.length >= 2) {
          const length = buffer[1] & 0x7f;
          let payloadStart = 2;
          let payloadLength = length;
          if (length === 126) {
            payloadLength = buffer.readUInt16BE(2);
            payloadStart = 4;
          }
          if (buffer.length >= payloadStart + payloadLength) {
            const payload = buffer.subarray(payloadStart, payloadStart + payloadLength).toString('utf8');
            socket.destroy();
            resolve(payload);
          }
        }
      });
      socket.on('error', () => resolve(''));
      setTimeout(() => { socket.destroy(); resolve(''); }, 4000);
    });
    let wsPayload = null;
    try { wsPayload = JSON.parse(wsResult); } catch (err) { wsPayload = null; }
    check('WebSocket 升级成功并剥离前缀', !!wsPayload && wsPayload.url === '/ws', wsResult);
    check('WebSocket 转发 X-Forwarded-Prefix', !!wsPayload && wsPayload.prefix === '/app', wsResult);

    console.log('\n[7] 自学习签名路由与歧义保护');
    await get('/app/', { 'accept-encoding': 'identity' });
    await get('/kuma/', { 'accept-encoding': 'identity' });
    res = await get('/media/p.png');
    check('唯一归属的根路径请求被路由到应用', res.headers['x-fixture'] === 'asset', `${res.status}`);
    res = await get('/img/logo.png');
    check('歧义根路径回落门户(不猜测)', res.status === 302 && res.headers.location === '/' && res.headers['x-fixture'] !== 'asset', `${res.status} ${res.headers.location}`);
    res = await get('/__gw/api/public/info');
    check('门户内部接口未被劫持', res.status === 200 && JSON.parse(res.text).routes.length === 9);

    // 旧版本把门户文档缓存进子路径：首次访问门户需下发一次性缓存清理
    res = await get('/');
    const buildCookie = String(res.headers['set-cookie'] || '').match(/__gw_build=([^;]+)/);
    check('门户首次访问下发缓存清理指令', res.headers['clear-site-data'] === '"cache"' && !!buildCookie, `${res.status} ${res.headers['clear-site-data']}`);
    res = await get('/', { cookie: `__gw_build=${buildCookie ? buildCookie[1] : 'x'}` });
    check('已清理客户端不重复清缓存', !res.headers['clear-site-data'], `${res.headers['clear-site-data']}`);
    res = await get('/app/', { 'accept-encoding': 'identity' });
    const cookieList = String(res.headers['set-cookie'] || '');
    check('反代响应同时下发构建号与路由 Cookie', /__gw_build=/.test(cookieList) && /__gw_active_subpath=/.test(cookieList), cookieList);
    res = await get('/app/', { 'accept-encoding': 'identity', cookie: `__gw_build=${buildCookie ? buildCookie[1] : 'x'}` });
    check('反代请求带构建号后不再清缓存', !res.headers['clear-site-data'], `${res.headers['clear-site-data']}`);
    const buildCk = `__gw_build=${buildCookie ? buildCookie[1] : 'x'}`;
    res = await get('/__gw/api/public/info', { cookie: buildCk, referer: 'http://gw.local/en/' });
    const purgeMatch = String(res.headers['set-cookie'] || '').match(/__gw_doc_purge=(\d+)/);
    check('子路径旧门户文档触发定向缓存清理', res.headers['clear-site-data'] === '"cache"' && !!purgeMatch, `${res.headers['clear-site-data']}`);
    res = await get('/__gw/api/public/info', { cookie: `${buildCk}; __gw_doc_purge=${purgeMatch ? purgeMatch[1] : '0'}`, referer: 'http://gw.local/en/' });
    check('定向缓存清理按 5 分钟节流', !res.headers['clear-site-data'], `${res.headers['clear-site-data']}`);
    res = await get('/__gw/api/public/info', { cookie: buildCk, referer: 'http://gw.local/' });
    check('正常门户不触发定向清理', !res.headers['clear-site-data'], `${res.headers['clear-site-data']}`);

    console.log('\n[8] 管理接口与热重载');
    const login = await request({ port: gwPort, path: '/__gw/api/auth/login', method: 'POST', headers: { 'content-type': 'application/json' } }, JSON.stringify({ password: SMOKE_PASSWORD }));
    const token = JSON.parse(login.text).token;
    check('管理员登录成功', login.status === 200 && !!token);

    const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const created = await request({ port: gwPort, path: '/__gw/api/admin/routes', method: 'POST', headers: authHeaders }, JSON.stringify({
      name: 'Temp Route', subpath: '/tmp', target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 9,
      options: { rewriteCookie: true, autoSlash: false, legacyJunk: 'drop-me', signaturePaths: ['/legacy'] }
    }));
    const createdRoute = JSON.parse(created.text).route;
    check('新增路由选项被归一化落盘', createdRoute.options.rewriteCookie === true && createdRoute.options.autoSlash === false && createdRoute.options.legacyJunk === undefined);
    check('签名/漂移路径列表落盘', Array.isArray(createdRoute.options.signaturePaths) && createdRoute.options.signaturePaths[0] === '/legacy');

    res = await get('/tmp');
    check('新增路由热生效且 autoSlash=false 不跳转', res.status === 200, `${res.status} ${res.headers.location}`);
    res = await get('/legacy/probe');
    check('声明式签名路径生效', res.headers['x-fixture'] === 'asset' || res.status === 404, `${res.status}`);

    const updated = await request({ port: gwPort, path: `/__gw/api/admin/routes/${createdRoute.id}`, method: 'PUT', headers: authHeaders }, JSON.stringify({ options: { rewriteCookie: false } }));
    const updatedRoute = JSON.parse(updated.text).route;
    check('修改路由保留未提交选项', updatedRoute.options.autoSlash === false && updatedRoute.options.rewriteCookie === false);

    const removed = await request({ port: gwPort, path: `/__gw/api/admin/routes/${createdRoute.id}`, method: 'DELETE', headers: authHeaders });
    check('删除路由成功', JSON.parse(removed.text).success === true);
    res = await get('/tmp');
    check('删除后路由即时失效', res.status === 302 && res.headers.location === '/', `${res.status} ${res.headers.location}`);

    console.log('\n[9] 内置兼容画像行为对齐');
    res = await get('/um/', { 'accept-encoding': 'identity' });
    check('Umami 画像：不注入 <base>，但仍注入历史垫片', !res.text.includes('<base href=') && res.text.includes('history.pushState = function'));
    check('Umami 画像：文档内根路径补全', res.text.includes('href="/um/assets/logo.css"'));

    res = await get('/um/assets/app.js', { 'accept-encoding': 'identity' });
    check('Umami 画像：pathHasPrefix 补丁生效', res.text.includes('(0,utils.pathHasPrefix)(value, "/um")'), res.text.split('\n')[4]);
    check('Umami 画像：前缀剥离函数补丁生效', res.text.includes('startsWith("/um")'), res.text.split('\n')[5]);
    check('Umami 画像：_next 强制补全', res.text.includes('"/um/_next/'));

    res = await get('/um/api/websites');
    check('Umami 画像：声明式签名接口归属', res.headers['x-fixture'] === 'asset', `${res.status}`);
    res = await get('/login');
    check('Umami 画像：漂移路径含 login', res.status === 302 && res.headers.location === '/um/login', `${res.status} ${res.headers.location}`);

    res = await get('/v2/', { 'accept-encoding': 'identity' });
    check('v2rayA 画像：注入 base 与 localStorage 隔离垫片', res.text.includes('<base href="/v2/">') && res.text.includes('if (true) {') && res.text.includes('storageHandler'));
    res = await get('/v2/api/outbounds');
    check('v2rayA 画像：特征接口归属', res.status === 404, `${res.status}`);

    res = await get('/kuma/', { 'accept-encoding': 'identity' });
    check('默认路由不注入 localStorage 隔离', res.text.includes('if (false) {'));

    console.log('\n[10] 配置化应用画像');
    res = await get('/demo/', { 'accept-encoding': 'identity' });
    check('配置画像：shimAlways 在 injectBase=false 时仍注入垫片', res.text.includes('history.pushState = function'));
    check('配置画像：noBase 生效', !res.text.includes('<base href='));

    res = await get('/demodrift');
    check('配置画像：漂移路径生效', res.status === 302 && res.headers.location === '/demo/demodrift', `${res.status} ${res.headers.location}`);
    res = await get('/demopath/probe');
    check('配置画像：签名路径生效', res.status === 404, `${res.status}`);

    res = await get('/demo/assets/app.js', { 'accept-encoding': 'identity' });
    check('配置画像：deepRoots 白名单生效', res.text.includes('dd="/demo/demodeep/asset.js"'), res.text.split('\n')[5]);
    res = await get('/plain/assets/app.js', { 'accept-encoding': 'identity' });
    check('profile=none 路由不透支他人白名单', res.text.includes('dd="/demodeep/asset.js"'), res.text.split('\n')[5]);


    const profilesRes = await request({ port: gwPort, path: '/__gw/api/admin/profiles', headers: { authorization: `Bearer ${token}` } });
    const profilesData = JSON.parse(profilesRes.text);
    check('画像清单接口：内置 + 自定义', profilesData.builtins.some((p) => p.name === 'umami') && profilesData.custom.some((p) => p.name === 'demo'));
    check('画像清单接口：自定义画像非法字段被丢弃', !JSON.stringify(profilesData.custom).includes('bogusFlag'));

    const routesRes = await request({ port: gwPort, path: '/__gw/api/admin/routes', headers: { authorization: `Bearer ${token}` } });
    const runtime = JSON.parse(routesRes.text).runtime || {};
    check('运行时画像解析：按子路径内置绑定', runtime['/um'] && runtime['/um'].profile === 'umami', JSON.stringify(runtime['/um'] && runtime['/um'].profile));
    check('运行时画像解析：显式指定', runtime['/demo'] && runtime['/demo'].profile === 'demo');
    check('运行时画像解析：显式关闭', runtime['/plain'] && runtime['/plain'].profile === 'none');
    // 自学习是内存态：配置增删改与热重载都会重建运行时，学习结果随之清空
    check('配置变更后自学习状态重置', Array.isArray(runtime['/app'] && runtime['/app'].learnedRoots) && runtime['/app'].learnedRoots.length === 0, JSON.stringify(runtime['/app'] && runtime['/app'].learnedRoots));

    await get('/app/', { 'accept-encoding': 'identity' });
    const learned = JSON.parse((await request({ port: gwPort, path: '/__gw/api/admin/routes', headers: { authorization: `Bearer ${token}` } })).text).runtime['/app'].learnedRoots;
    check('文档加载后自学习根可见', learned.includes('assets') && learned.includes('media'), JSON.stringify(learned));

    const bogus = await request({ port: gwPort, path: '/__gw/api/admin/routes', method: 'POST', headers: authHeaders }, JSON.stringify({
      name: 'Bogus Profile', subpath: '/bogus', target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 8,
      options: { profile: 'not-exist' }
    }));
    const bogusRoute = JSON.parse(bogus.text).route;
    check('未知画像名优雅降级', bogusRoute.options.profile === 'not-exist');
    await request({ port: gwPort, path: `/__gw/api/admin/routes/${bogusRoute.id}`, method: 'DELETE', headers: authHeaders });
    const afterBogus = JSON.parse((await request({ port: gwPort, path: '/__gw/api/admin/routes', headers: { authorization: `Bearer ${token}` } })).text).runtime || {};
    check('未知画像按 none 运行', afterBogus['/bogus'] === undefined || afterBogus['/bogus'].profile === 'none');

    const reload = await request({ port: gwPort, path: '/__gw/api/admin/reload', method: 'POST', headers: authHeaders });
    check('配置热重载接口可用', reload.status === 200 && JSON.parse(reload.text).ok === true);
    res = await get('/app/', { 'accept-encoding': 'identity' });
    check('热重载后代理链路正常', res.status === 200 && res.text.includes('href="/app/assets/logo.css"'));

    console.log('\n[11] 画像在线增删改');
    const profileBody = (extra) => JSON.stringify({
      name: 'crudprof', label: 'CRUD 画像', signatures: ['/cpx'], drift: ['cpd'], deepRoots: ['cproot'],
      deepByDefault: true, shimAlways: true, noBase: true, ...extra
    });
    const postProfile = (body) => request({ port: gwPort, path: '/__gw/api/admin/profiles', method: 'POST', headers: authHeaders }, body);

    check('画像名校验', (await postProfile(JSON.stringify({ name: 'bad name!' }))).status === 400);
    check('保留名校验', (await postProfile(JSON.stringify({ name: 'none', drift: ['x'] }))).status === 400);
    check('空画像校验', (await postProfile(JSON.stringify({ name: 'bare' }))).status === 400);

    const profileCreated = await postProfile(profileBody({ junkField: 'drop' }));
    const profileData = JSON.parse(profileCreated.text);
    check('画像创建成功且非法字段被丢弃', profileCreated.status === 200 && profileData.profile.junkField === undefined && profileData.profile.drift[0] === 'cpd');

    const boundRoute = JSON.parse((await request({ port: gwPort, path: '/__gw/api/admin/routes', method: 'POST', headers: authHeaders }, JSON.stringify({
      name: 'CRUD Route', subpath: '/crudx', target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 10,
      options: { profile: 'crudprof', injectBase: false }
    }))).text).route;
    check('路由绑定自定义画像', boundRoute.options.profile === 'crudprof');

    res = await get('/cpd');
    check('自定义画像漂移生效', res.status === 302 && res.headers.location === '/crudx/cpd', `${res.status} ${res.headers.location}`);
    res = await get('/cpx/probe');
    check('自定义画像签名生效', res.status === 404, `${res.status}`);
    res = await get('/crudx/', { 'accept-encoding': 'identity' });
    check('自定义画像 noBase+shimAlways 生效', !res.text.includes('<base href=') && res.text.includes('history.pushState = function'));

    const blockedDelete = await request({ port: gwPort, path: '/__gw/api/admin/profiles/crudprof', method: 'DELETE', headers: authHeaders });
    check('被引用画像删除被拦截', blockedDelete.status === 409 && JSON.parse(blockedDelete.text).usedBy.includes('/crudx'));

    const forcedDelete = await request({ port: gwPort, path: '/__gw/api/admin/profiles/crudprof?force=1', method: 'DELETE', headers: authHeaders });
    check('强制删除画像成功', forcedDelete.status === 200 && JSON.parse(forcedDelete.text).usedBy.includes('/crudx'));
    res = await get('/cpd');
    check('删画像后路由降级为通用模式', res.status === 302 && res.headers.location === '/', `${res.status} ${res.headers.location}`);

    const runtimeAfterDelete = JSON.parse((await request({ port: gwPort, path: '/__gw/api/admin/routes', headers: { authorization: `Bearer ${token}` } })).text).runtime || {};
    check('降级后运行时画像为 none', runtimeAfterDelete['/crudx'] && runtimeAfterDelete['/crudx'].profile === 'none');

    await request({ port: gwPort, path: `/__gw/api/admin/routes/${boundRoute.id}`, method: 'DELETE', headers: authHeaders });
    check('测试路由已清理', (await get('/cpd')).status === 302);

    console.log('\n[12] 路由诊断');
    const authOnly = { authorization: `Bearer ${token}` };
    const probe = (query) => request({ port: gwPort, path: `/__gw/api/admin/route-probe?${query}`, headers: authOnly });
    const runtimeSnapshot = async () => (JSON.parse((await request({ port: gwPort, path: '/__gw/api/admin/routes', headers: authOnly })).text).runtime) || {};

    let probeData = JSON.parse((await probe('subpath=/app&path=/')).text);
    check('诊断：上游可达与状态码', probeData.ok === true && probeData.upstream.status === 200, JSON.stringify(probeData.upstream));
    check('诊断：干跑出待补全引用与路径段', probeData.body.rewrittenRefs > 0 && (probeData.body.segments.assets || 0) > 0, JSON.stringify(probeData.body.segments));
    check('诊断：样例与建议非空', probeData.body.samples.length > 0 && probeData.recommendations.length > 0);
    check('诊断：输出生效选项快照', probeData.options.deepRewrite === true && probeData.profile === 'none', JSON.stringify(probeData.options));

    probeData = JSON.parse((await probe('subpath=/app&path=/cookie')).text);
    check('诊断：Cookie Domain/Path 体检', probeData.headers.cookies.length === 2 && probeData.headers.cookies.some((c) => c.domain === 'upstream.internal') && probeData.recommendations.some((r) => r.includes('rewriteCookie')), JSON.stringify(probeData.headers.cookies));

    probeData = JSON.parse((await probe('subpath=/app&path=/app/redirect')).text);
    check('诊断：Location 补全预演', probeData.headers.location === '/login' && probeData.headers.rewrittenLocation === '/app/login', `${probeData.headers.location} -> ${probeData.headers.rewrittenLocation}`);

    probeData = JSON.parse((await probe('subpath=/app&path=/app/self')).text);
    check('诊断：自跳转环路告警', probeData.headers.selfLoop === true && probeData.recommendations.some((r) => r.includes('508')));

    probeData = JSON.parse((await probe('subpath=/app&path=/app/static/bundle.js')).text);
    check('诊断：静态资源缓存语义', probeData.headers.cache.staticAsset === true && String(probeData.headers.cache.effective).includes('31536000'), JSON.stringify(probeData.headers.cache));

    probeData = JSON.parse((await probe('subpath=/app&path=/app/img/logo.png')).text);
    check('诊断：非文本响应标记为透传', probeData.body.rewritable === false && probeData.body.kind === 'none', JSON.stringify(probeData.body));

    probeData = JSON.parse((await probe('subpath=/app&path=/app/nope')).text);
    check('诊断：上游 4xx 给出建议', probeData.upstream.status === 404 && probeData.recommendations.some((r) => r.includes('404')));

    probeData = JSON.parse((await probe('subpath=/app&path=/doctor-doc')).text);
    check('诊断：干跑统计新文档引用', (probeData.body.segments.doctoronly || 0) >= 1, JSON.stringify(probeData.body.segments));
    const learnedAfterProbe = (await runtimeSnapshot())['/app'].learnedRoots;
    check('诊断不写入自学习状态', !learnedAfterProbe.includes('doctoronly'), JSON.stringify(learnedAfterProbe));

    const badProbe = await probe('subpath=/nope&path=/');
    check('诊断：未知路由返回 404', badProbe.status === 404);

    console.log('\n[13] 安全回归');
    // 13.1 历史默认口令
    const legacyLogin = await request({ port: gwPort, path: '/__gw/api/auth/login', method: 'POST', headers: { 'content-type': 'application/json' } }, JSON.stringify({ password: 'admin123456' }));
    check('历史默认口令已被拒绝', legacyLogin.status === 401, String(legacyLogin.status));

    // 13.2 子路径 / 分类注入
    const badSub = await request({ port: gwPort, path: '/__gw/api/admin/routes', method: 'POST', headers: authHeaders }, JSON.stringify({
      name: 'XSS', subpath: '/x" onmouseover="window.__xss=1', target: `http://127.0.0.1:${fixturePort}`, enabled: true, order: 20
    }));
    check('含引号的子路径被拒绝', badSub.status === 400, badSub.text.slice(0, 80));
    const badCat = await request({ port: gwPort, path: '/__gw/api/admin/settings', method: 'POST', headers: authHeaders }, JSON.stringify({ categories: ['x<img src=x onerror=1>'] }));
    check('非法分类名被拒绝', badCat.status === 400, badCat.text.slice(0, 80));
    const shortPwd = await request({ port: gwPort, path: '/__gw/api/admin/settings', method: 'POST', headers: authHeaders }, JSON.stringify({ newPassword: '123456' }));
    check('弱口令被拒绝', shortPwd.status === 400, shortPwd.text.slice(0, 80));

    // 13.3 危险路径
    res = await get('/app/../secret');
    check('点段路径被拒绝', res.status === 400, String(res.status));
    res = await get('/app%2f..%2fsecret');
    check('编码斜杠路径被拒绝', res.status === 400, String(res.status));

    // 13.4 错误响应不泄露内网信息
    res = await get('/dead/');
    check('502 不回显内网 target/detail', res.status === 502 && !/127\.0\.0\.1:9/.test(res.text) && !/"detail"/.test(res.text), res.text.slice(0, 120));

    // 13.5 客户端伪造头清洗
    res = await get('/app/echo-headers', {
      'accept-encoding': 'identity',
      'x-original-uri': '/admin',
      'x-authenticated-user': 'admin',
      'x-real-ip': '9.9.9.9',
      'x-forwarded-for': '9.9.9.9',
      'remote-host': '9.9.9.9'
    });
    const echo2 = JSON.parse(res.text);
    check('伪造的转发/鉴权头被清洗', echo2.originalUri === '' && echo2.authUser === '' && echo2.realIp === '127.0.0.1' && echo2.xff === '127.0.0.1', JSON.stringify(echo2));

    // 13.6 胶囊改为设备令牌
    const setupRes = await get('/en/page/setup', { 'x-real-ip': '9.9.9.9' });
    const setupCookies = setupRes.headers['set-cookie'] || [];
    const capsuleCookie = setupCookies.find((c) => c.startsWith('__gw_capsule_id='));
    check('设备令牌与路由 Cookie 合并下发', !!capsuleCookie && setupCookies.some((c) => c.startsWith('__gw_active_subpath=')), setupCookies.join(' | '));
    const spoofProbe = await get('/en/page/probe', { 'x-real-ip': '9.9.9.9', 'accept-encoding': 'identity' });
    check('伪造同 IP 不再回放他人会话', !String(JSON.parse(spoofProbe.text).cookie).includes('webui_sid=VICTIM'), JSON.parse(spoofProbe.text).cookie);
    const legitProbe = await get('/en/page/probe', { cookie: capsuleCookie.split(';')[0], 'accept-encoding': 'identity' });
    check('同一设备令牌可正常回放胶囊', String(JSON.parse(legitProbe.text).cookie).includes('webui_sid=VICTIM_SID_123'), JSON.parse(legitProbe.text).cookie);

    // 13.7 压缩炸弹
    res = await get('/app/bomb', { 'accept-encoding': 'gzip' });
    check('解压炸弹被输出上限拦截', res.status === 502 && /Bad Gateway/.test(res.text), String(res.status));
    check('炸弹请求后网关仍然存活', (await get('/__gw/api/public/info')).status === 200);

    // 13.8 登录限速（放最后）
    const throttled = [];
    for (let i = 0; i < 6; i++) {
      throttled.push((await request({ port: gwPort, path: '/__gw/api/auth/login', method: 'POST', headers: { 'content-type': 'application/json' } }, JSON.stringify({ password: 'wrong-' + i }))).status);
    }
    check('连续登录失败触发 429 限速', throttled.includes(429), throttled.join(' '));

  } finally {
    gw.child.kill();
    fixture.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(` 冒烟测试: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log(' 失败项:');
    for (const item of failed) console.log(`   - ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
  }
  console.log('='.repeat(60));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
