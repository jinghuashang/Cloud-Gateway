#!/bin/bash
# 链路与 Base Href 校验脚本
# 用法：GW_ADMIN_PASSWORD='你的管理员口令' ./scripts/verify.sh
set -e

BASE_URL="${GW_BASE_URL:-http://127.0.0.1:8088}"
ADMIN_PASSWORD="${GW_ADMIN_PASSWORD:-}"

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "请通过环境变量提供管理员口令（不再内置任何默认口令）：" >&2
  echo "  GW_ADMIN_PASSWORD='...' ./scripts/verify.sh" >&2
  exit 1
fi

echo "=== 1. 登录管理员接口 ==="
LOGIN_RES=$(curl -s -X POST "$BASE_URL/__gw/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$ADMIN_PASSWORD\"}")

TOKEN=$(node -e 'console.log(JSON.parse(process.argv[1]).token || "")' "$LOGIN_RES")
if [ -z "$TOKEN" ]; then
  echo "登录失败：$LOGIN_RES" >&2
  exit 1
fi
echo "Token 获取成功"

echo "=== 2. 读取路由列表 ==="
ROUTES_RES=$(curl -s "$BASE_URL/__gw/api/admin/routes" -H "Authorization: Bearer $TOKEN")
node -e 'const r = JSON.parse(process.argv[1]).routes || []; console.log("当前路由数:", r.length); r.forEach(x => console.log(" -", x.subpath, "->", x.target))' "$ROUTES_RES"

echo "=== 3. 门户首页 ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$BASE_URL/"

echo "=== 4. 安全响应头 ==="
curl -s -I "$BASE_URL/" | grep -iE "content-security-policy|x-frame-options|x-content-type-options" || echo "未检测到安全响应头"
