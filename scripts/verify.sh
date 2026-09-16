#!/bin/bash
set -e

echo "=== 1. 登录管理员接口 ==="
LOGIN_RES=$(curl -s -X POST http://127.0.0.1:8088/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"admin123456"}')

TOKEN=$(node -e 'console.log(JSON.parse(process.argv[1]).token)' "$LOGIN_RES")
echo "Token 获取成功"

echo "=== 2. 获取并启用 /am 路由 ==="
ROUTES_RES=$(curl -s http://127.0.0.1:8088/api/admin/routes -H "Authorization: Bearer $TOKEN")
AM_ID=$(node -e 'const r = JSON.parse(process.argv[1]).routes.find(x => x.subpath === "/am"); console.log(r ? r.id : "")' "$ROUTES_RES")

if [ -n "$AM_ID" ]; then
  echo "更新现有路由 $AM_ID"
  curl -s -X PUT "http://127.0.0.1:8088/api/admin/routes/$AM_ID" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{
      "name": "AM 管理平台",
      "category": "系统运维",
      "subpath": "/am",
      "target": "http://127.0.0.1:6099",
      "icon": "shield-check",
      "description": "AM 统一核心控制台与监控平台",
      "enabled": true,
      "order": 1,
      "options": {
        "autoSlash": true,
        "injectBase": true,
        "rewriteHtml": true,
        "rewriteLocation": true,
        "rewriteCookie": true,
        "ws": true
      }
    }' > /dev/null
fi

echo "=== 3. 再次测试斜杠重定向 (GET /am) ==="
curl -i -s http://127.0.0.1:8088/am | head -n 10

echo "=== 4. 测试请求 /am/ 并检查 HTML ==="
AM_HTML=$(curl -s -k http://127.0.0.1:8088/am/)
echo "AM 页面响应长度: ${#AM_HTML}"
echo "AM 页面前 20 行:"
echo "$AM_HTML" | head -n 20

echo "=== 5. 检查 Base Href 注入与路径重写 ==="
echo "$AM_HTML" | grep -i '<base href="/am/">' || echo "Base Href 检查结果未匹配"
echo "含 /am/ 的资源引用数: $(echo "$AM_HTML" | grep -o '/am/' | wc -l)"

echo "=== 6. 测试自定义域名链路 (Host: cloud.example.com) ==="
curl -i -s -H "Host: cloud.example.com" http://127.0.0.1:8088/am | head -n 10
