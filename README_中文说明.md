# HUMKT Auto Buyer V3.0（Electron + TypeScript）

目标商品：`30275`（普通商品；程序仍会在启动时以官方 API 再次校验 `is_selectable`、`is_group` 和 `maintenance`）。

## 本版本架构

- Electron 桌面窗口与 `worker_threads` 监听线程隔离；网络请求不会占用界面线程。
- TypeScript 编译主进程、预加载脚本和监听 Worker；界面使用本地 HTML/CSS/JavaScript。
- SQLite WASM 持久化监听状态、订单尝试、订单记录和每日支出；无需安装原生 SQLite DLL。
- API Token 只在主进程中处理，使用 Electron `safeStorage` 加密后保存在 Windows 用户数据目录；渲染进程不会读取 Token 明文。
- 自动购买默认关闭，开启前需要勾选风险确认。
- 首次读取库存只建立基线；只有观察到库存从 0 恢复到大于 0 才触发本轮补货。
- 每次下单前先把“正在提交”锁写入 SQLite；超时或程序中断会保持未知订单锁，必须人工核验，禁止盲目重发。

## HUMKT 官方 API 规则

官方文档：<https://www.humkt.com/api-docs>

- API 基础地址：`https://www.humkt.com/api/v1`
- 认证：`Authorization: Bearer <token>`
- 查价：`GET /prices?ids=30275`
- 下单：`POST /orders`，表单字段 `id=30275&qty=N`
- 未单独列出的查询接口：每 Token、每接口每分钟 300 次。
- `POST /orders`：每分钟 120 次。
- 同一 IP 所有接口合计每分钟约 900 次。
- 超限返回 429 和 `Retry-After`，程序按服务器要求退避。
- 商品订单没有持久化幂等。请求超时后先到 HUMKT「我的订单」核对，不可自动重发。
- 商品下单接口没有服务器端 `max_price` 参数；本地最高价检查不能保证查价与成交之间的价格不变。
- 每日预算统计本软件本地记录的成功订单，不会自动统计你在 HUMKT 网页或其他工具中手动下的订单；请把其它渠道支出一并纳入预算。

默认轮询间隔 250ms，理论约 240 次/分钟；可选 210ms（本地滑动窗口最多 285 次/60 秒）、300ms、500ms、1000ms。实际频率受网络响应时间和服务器限流影响。不得使用多个 Token 或 IP 绕过限流。

## 获取 Token

登录 HUMKT，在个人资料页生成 API Token。把 Token 粘贴到程序后点击「加密保存」，再点击「测试 API」。不要把 Token 发给任何人，也不要提交到 GitHub 仓库。

## 云端生成 Windows EXE（本机无需 Node.js / SDK）

1. 在 GitHub 创建一个**私有空仓库**。
2. 解压本项目 ZIP，把所有文件（包括隐藏的 `.github` 目录）上传到仓库根目录。
3. 打开仓库的 **Actions** 页面，选择 `Build HUMKT Auto Buyer for Windows`。
4. 点击 **Run workflow**，等待 Windows runner 完成构建。
5. 在该次 workflow run 页面下载 artifact：`HUMKT-AutoBuyer-V3.0-Windows-x64`。
6. 解压 artifact，使用 `HUMKT-AutoBuyer-3.0.0-Portable-x64.exe`，或运行 NSIS 安装程序。

本地 Windows 不需要安装 Node.js、npm、.NET 或 SDK。当前容器不能运行 Windows GUI，也没有使用真实 Token 测试 API/下单。必须等 GitHub Actions 构建通过后，才可确认 Windows 打包步骤成功。首次运行请保持自动购买关闭，先验证 API 与监听。

## 可选本地开发

需要 Node.js 24：

```powershell
npm install
npm start
npm run dist:win
```

## 工程结构

```text
HUMKT_AutoBuyer_V3/
  .github/workflows/build-windows.yml
  scripts/copy-assets.js
  src/main.ts
  src/preload.ts
  src/worker.ts
  src/renderer/index.html
  src/renderer/styles.css
  src/renderer/renderer.js
  package.json
  tsconfig.json
  README_中文说明.md
  SECURITY.md
```

## 故障排查

- 启动失败：程序会弹出 Electron 主进程错误框；数据库位于 `%APPDATA%/humkt-auto-buyer/humkt-state.sqlite`。
- Token 错误：重新生成 Token 后在程序内替换。
- HTTP 429：程序遵循 `Retry-After`。
- 未知订单锁：登录 HUMKT「我的订单」确认是否成功；确认没有订单及扣款后，才能点击「已核对订单，解除锁定」。
- 自动购买不会因首次启动时库存大于 0 而触发；必须先观察到缺货，再观察到补货。
