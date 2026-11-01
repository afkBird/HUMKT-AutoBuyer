// @ts-nocheck
'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } = require('electron');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const SQLFactory = require('sql.js');

const PRODUCT_ID = 30275;
const API_BASE = 'https://www.humkt.com/api/v1';
const DEFAULT_SETTINGS = Object.freeze({
  productId: PRODUCT_ID,
  pollIntervalMs: 250,
  maxUnitPrice: '',
  quantity: 1,
  dailyBudget: '',
  autoBuyEnabled: false,
  riskAccepted: false
});

let mainWindow = null;
let monitorWorker = null;
let database = null;
let databasePath = '';
let userDataPath = '';
let settingsPath = '';
let tokenPath = '';
let isQuitting = false;

function nowIso() {
  return new Date().toISOString();
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function moneyToCents(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 0;
  const [whole, fraction = ''] = s.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

function centsToMoney(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function apiBool(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function ensureDirectories() {
  userDataPath = app.getPath('userData');
  fs.mkdirSync(userDataPath, { recursive: true });
  databasePath = path.join(userDataPath, 'humkt-state.sqlite');
  settingsPath = path.join(userDataPath, 'settings.json');
  tokenPath = path.join(userDataPath, 'token.dpapi');
}

function getWasmPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'sql-wasm.wasm');
  return path.resolve(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
}

function saveDatabase() {
  if (!database) return;
  const bytes = database.export();
  fs.writeFileSync(databasePath, Buffer.from(bytes));
}

function dbRun(sql, params = []) {
  database.run(sql, params);
  saveDatabase();
}

function dbGet(sql, params = []) {
  const statement = database.prepare(sql);
  statement.bind(params);
  let result = null;
  if (statement.step()) result = statement.getAsObject();
  statement.free();
  return result;
}

function dbAll(sql, params = []) {
  const statement = database.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

async function initializeDatabase() {
  const SQL = await SQLFactory({ locateFile: () => getWasmPath() });
  if (fs.existsSync(databasePath)) {
    const bytes = fs.readFileSync(databasePath);
    database = new SQL.Database(new Uint8Array(bytes));
  } else {
    database = new SQL.Database();
  }

  database.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS monitor_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      initialized INTEGER NOT NULL DEFAULT 0,
      last_stock INTEGER NOT NULL DEFAULT -1,
      armed INTEGER NOT NULL DEFAULT 0,
      unknown_order_lock INTEGER NOT NULL DEFAULT 0,
      last_price_cents INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    INSERT OR IGNORE INTO monitor_state (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      attempt_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      quantity INTEGER NOT NULL,
      estimated_amount_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trx TEXT,
      order_id TEXT,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT,
      created_at TEXT NOT NULL,
      raw_json TEXT
    );
    CREATE TABLE IF NOT EXISTS daily_spend (
      spend_date TEXT PRIMARY KEY,
      amount_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  `);
  saveDatabase();
}

function appendEvent(level, message) {
  const safeMessage = String(message ?? '').slice(0, 1000);
  dbRun('INSERT INTO events (created_at, level, message) VALUES (?, ?, ?)', [nowIso(), level, safeMessage]);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:event', { type: 'log', level, message: safeMessage, at: nowIso() });
  }
}

function loadSettings() {
  try {
    if (!fs.existsSync(settingsPath)) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...parsed, productId: PRODUCT_ID };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function validateSettings(input) {
  const allowedIntervals = new Set([210, 250, 300, 500, 1000]);
  const pollIntervalMs = Number(input.pollIntervalMs);
  const quantity = Number(input.quantity);
  const maxUnitPrice = String(input.maxUnitPrice ?? '').trim();
  const dailyBudget = String(input.dailyBudget ?? '').trim();
  const autoBuyEnabled = Boolean(input.autoBuyEnabled);
  const riskAccepted = Boolean(input.riskAccepted);

  if (!allowedIntervals.has(pollIntervalMs)) throw new Error('监听间隔无效。');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new Error('购买数量必须为 1–50 的整数。');
  if (maxUnitPrice && moneyToCents(maxUnitPrice) <= 0) throw new Error('最高单价格式无效。');
  if (dailyBudget && moneyToCents(dailyBudget) <= 0) throw new Error('每日预算格式无效。');
  if (autoBuyEnabled) {
    if (moneyToCents(maxUnitPrice) <= 0) throw new Error('开启自动购买前必须填写最高单价。');
    if (moneyToCents(dailyBudget) <= 0) throw new Error('开启自动购买前必须填写每日预算。');
    if (!riskAccepted) throw new Error('请先确认官方下单接口不支持服务端最高价保护。');
  }

  return {
    productId: PRODUCT_ID,
    pollIntervalMs,
    maxUnitPrice,
    quantity,
    dailyBudget,
    autoBuyEnabled,
    riskAccepted
  };
}

function saveSettings(input) {
  const settings = validateSettings(input);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  return settings;
}

function readToken() {
  if (!fs.existsSync(tokenPath)) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法解密已保存的 Token。');
  const encrypted = fs.readFileSync(tokenPath);
  return safeStorage.decryptString(encrypted).trim();
}

function saveToken(token) {
  const clean = String(token ?? '').trim();
  if (!clean) throw new Error('API Token 不能为空。');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，不能安全保存 Token。');
  const encrypted = safeStorage.encryptString(clean);
  fs.writeFileSync(tokenPath, encrypted, { mode: 0o600 });
}

async function apiGet(token, endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000)
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`API 返回非 JSON 内容（HTTP ${response.status}）。`); }
  if (!response.ok || json.code !== 1) {
    const message = json.message || json.error || `HTTP ${response.status}`;
    throw new Error(`${message}（HTTP ${response.status}）`);
  }
  return json.data;
}

async function testApiWithToken(token) {
  const [balanceData, product] = await Promise.all([
    apiGet(token, '/balance'),
    apiGet(token, `/products/${PRODUCT_ID}`)
  ]);
  if (apiBool(product.is_group)) throw new Error('商品 30275 是产品组，不能直接购买。请确认商品 ID。');
  if (apiBool(product.is_selectable)) throw new Error('商品 30275 实际标记为自选商品，与当前普通商品模式不符，已阻止自动购买。');
  return {
    balance: String(balanceData.balance ?? '未知'),
    product: {
      id: Number(product.id),
      name: String(product.name ?? `商品 ${PRODUCT_ID}`),
      price: String(product.price ?? '未知'),
      in_stock: Number(product.in_stock ?? 0),
      min_qty: Number(product.min_qty ?? 1),
      max_qty: Number(product.max_qty ?? 0),
      maintenance: apiBool(product.maintenance),
      is_selectable: apiBool(product.is_selectable),
      is_group: apiBool(product.is_group)
    }
  };
}

function getMonitorState() {
  const row = dbGet('SELECT * FROM monitor_state WHERE id = 1') || {};
  return {
    initialized: Number(row.initialized || 0) === 1,
    lastStock: Number(row.last_stock ?? -1),
    armed: Number(row.armed || 0) === 1,
    unknownOrderLock: Number(row.unknown_order_lock || 0) === 1,
    lastPriceCents: Number(row.last_price_cents || 0)
  };
}

function getDailySpend() {
  const row = dbGet('SELECT amount_cents FROM daily_spend WHERE spend_date = ?', [todayKey()]);
  return Number(row?.amount_cents || 0);
}

function getInitialData() {
  const settings = loadSettings();
  const state = getMonitorState();
  const events = dbAll('SELECT created_at, level, message FROM events ORDER BY id DESC LIMIT 80').reverse();
  const orders = dbAll('SELECT trx, order_id, quantity, amount_cents, status, created_at FROM orders ORDER BY id DESC LIMIT 20');
  return {
    settings,
    tokenSaved: fs.existsSync(tokenPath),
    running: Boolean(monitorWorker),
    state,
    dailySpent: centsToMoney(getDailySpend()),
    events,
    orders
  };
}

function sendToRenderer(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:event', payload);
}

function updateMonitorState(state) {
  dbRun(`UPDATE monitor_state
    SET initialized=?, last_stock=?, armed=?, unknown_order_lock=?, last_price_cents=?, updated_at=?
    WHERE id=1`, [
      state.initialized ? 1 : 0,
      Number(state.lastStock ?? -1),
      state.armed ? 1 : 0,
      state.unknownOrderLock ? 1 : 0,
      Number(state.lastPriceCents || 0),
      nowIso()
    ]);
}

function handleWorkerMessage(message) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'ack':
      if (monitorWorker) monitorWorker.postMessage(message);
      break;
    case 'log':
      appendEvent(message.level || 'info', message.message || '');
      break;
    case 'snapshot':
      sendToRenderer(message);
      break;
    case 'persist-state':
      updateMonitorState(message.state || {});
      if (message.requestId && monitorWorker) monitorWorker.postMessage({ type: 'ack', requestId: message.requestId, ok: true });
      break;
    case 'persist-attempt':
      try {
        dbRun(`INSERT OR IGNORE INTO attempts
          (attempt_key, created_at, status, detail, quantity, estimated_amount_cents)
          VALUES (?, ?, 'submitting', 'Order request is about to be sent', ?, ?)`, [
          message.attemptKey, nowIso(), Number(message.quantity), Number(message.estimatedAmountCents)
        ]);
        dbRun('UPDATE monitor_state SET unknown_order_lock=1, armed=0, updated_at=? WHERE id=1', [nowIso()]);
        if (monitorWorker) monitorWorker.postMessage({ type: 'ack', requestId: message.requestId, ok: true });
      } catch (error) {
        if (monitorWorker) monitorWorker.postMessage({ type: 'ack', requestId: message.requestId, ok: false, error: error.message });
      }
      break;
    case 'order-success': {
      const order = message.order || {};
      const amountCents = Number(message.amountCents ?? message.estimatedAmountCents ?? 0);
      dbRun('UPDATE attempts SET status=?, detail=? WHERE attempt_key=?', ['success', `trx=${order.trx || ''}`, message.attemptKey]);
      dbRun(`INSERT INTO orders (trx, order_id, product_id, quantity, amount_cents, status, created_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        String(order.trx || ''), String(order.order_id || ''), PRODUCT_ID,
        Number(order.qty || message.quantity || 1), amountCents,
        String(order.status || 'unknown'), nowIso(), JSON.stringify(order)
      ]);
      dbRun('UPDATE monitor_state SET unknown_order_lock=0, armed=0, updated_at=? WHERE id=1', [nowIso()]);
      dbRun(`INSERT INTO daily_spend (spend_date, amount_cents) VALUES (?, ?)
        ON CONFLICT(spend_date) DO UPDATE SET amount_cents = amount_cents + excluded.amount_cents`, [todayKey(), amountCents]);
      appendEvent('success', `下单成功：订单 ${order.trx || order.order_id || '已创建'}，金额 ¥${centsToMoney(amountCents)}，数量 ${order.qty || message.quantity || 1}。`);
      sendToRenderer({ type: 'order-success', order, amount: centsToMoney(amountCents), dailySpent: centsToMoney(getDailySpend()) });
      break;
    }
    case 'order-rejected':
      dbRun('UPDATE attempts SET status=?, detail=? WHERE attempt_key=?', [message.status || 'rejected', String(message.message || '').slice(0, 500), message.attemptKey]);
      dbRun('UPDATE monitor_state SET unknown_order_lock=0, armed=?, updated_at=? WHERE id=1', [message.rearm ? 1 : 0, nowIso()]);
      appendEvent(message.level || 'warning', `订单未创建：${message.message || 'API 拒绝请求'}`);
      sendToRenderer({ type: 'order-rejected', message: message.message || 'API 拒绝请求' });
      break;
    case 'order-unknown':
      dbRun('UPDATE attempts SET status=?, detail=? WHERE attempt_key=?', ['unknown', String(message.message || '结果未知').slice(0, 500), message.attemptKey]);
      dbRun('UPDATE monitor_state SET unknown_order_lock=1, armed=0, updated_at=? WHERE id=1', [nowIso()]);
      appendEvent('error', `订单结果未知，已锁定自动购买：${message.message || '请先核对 HUMKT 我的订单'}`);
      sendToRenderer({ type: 'unknown-order-lock', message: message.message || '请先核对 HUMKT 我的订单' });
      break;
    case 'auto-buy-paused': {
      const currentSettings = loadSettings();
      currentSettings.autoBuyEnabled = false;
      saveSettings(currentSettings);
      appendEvent('warning', message.message || '自动购买已暂停。');
      sendToRenderer({ type: 'auto-buy-paused', message: message.message || '自动购买已暂停。' });
      break;
    }
    case 'fatal':
      appendEvent('error', message.message || '监听线程发生致命错误。');
      sendToRenderer({ type: 'fatal', message: message.message || '监听线程发生致命错误。' });
      break;
    case 'status':
      sendToRenderer(message);
      break;
    default:
      break;
  }
}

function startWorker() {
  if (monitorWorker) return { ok: true, alreadyRunning: true };
  const token = readToken();
  if (!token) throw new Error('请先保存 HUMKT API Token。');
  const settings = loadSettings();
  if (settings.autoBuyEnabled) {
    if (!settings.riskAccepted) throw new Error('自动购买风险确认未完成。');
    if (moneyToCents(settings.maxUnitPrice) <= 0 || moneyToCents(settings.dailyBudget) <= 0) {
      throw new Error('自动购买需要设置最高单价和每日预算。');
    }
  }
  const workerPath = app.isPackaged ? path.join(process.resourcesPath, 'worker.js') : path.join(__dirname, 'worker.js');
  monitorWorker = new Worker(workerPath, {
    workerData: {
      token,
      settings,
      initialState: getMonitorState(),
      dailySpentCents: getDailySpend()
    }
  });
  monitorWorker.on('message', handleWorkerMessage);
  monitorWorker.on('error', (error) => {
    appendEvent('error', `监听线程异常：${error.message}`);
    sendToRenderer({ type: 'fatal', message: error.message });
  });
  monitorWorker.on('exit', (code) => {
    appendEvent(code === 0 ? 'info' : 'warning', `监听线程已退出（代码 ${code}）。`);
    monitorWorker = null;
    sendToRenderer({ type: 'running', running: false });
  });
  appendEvent('info', `监听已启动：商品 ${PRODUCT_ID}，轮询目标 ${settings.pollIntervalMs}ms，自动购买 ${settings.autoBuyEnabled ? '开启' : '关闭'}。`);
  sendToRenderer({ type: 'running', running: true });
  return { ok: true };
}

async function stopWorker() {
  if (!monitorWorker) return { ok: true };
  const current = monitorWorker;
  current.postMessage({ type: 'stop' });
  await Promise.race([
    new Promise((resolve) => current.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2500))
  ]);
  if (monitorWorker === current) {
    await current.terminate();
    monitorWorker = null;
  }
  appendEvent('info', '已停止监听。');
  sendToRenderer({ type: 'running', running: false });
  return { ok: true };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b1020',
    title: 'HUMKT Auto Buyer V3.0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://www.humkt.com/api-docs') shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendEvent('error', `界面渲染进程退出：${details.reason}。`);
  });
  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerIpc() {
  ipcMain.handle('app:get-initial-data', () => getInitialData());
  ipcMain.handle('token:save', (_event, token) => {
    saveToken(token);
    appendEvent('success', 'API Token 已通过 Windows 安全存储加密保存。');
    return { ok: true };
  });
  ipcMain.handle('api:test', async () => {
    const token = readToken();
    if (!token) throw new Error('尚未保存 API Token。');
    const result = await testApiWithToken(token);
    appendEvent('success', `API 测试成功：${result.product.name}，当前库存 ${result.product.in_stock}，余额 ¥${result.balance}。`);
    return result;
  });
  ipcMain.handle('settings:save', (_event, input) => {
    const settings = saveSettings(input);
    appendEvent('info', '购买规则已保存。');
    return settings;
  });
  ipcMain.handle('monitor:start', async () => {
    const token = readToken();
    if (!token) throw new Error('请先保存 API Token。');
    await testApiWithToken(token);
    return startWorker();
  });
  ipcMain.handle('monitor:stop', () => stopWorker());
  ipcMain.handle('order:unlock-unknown', async () => {
    const state = getMonitorState();
    if (!state.unknownOrderLock) return { ok: true, unlocked: false };
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '核对未知订单',
      message: '请先登录 HUMKT 网站，在「我的订单」中确认上一次下单是否成功。',
      detail: '只有确认没有产生订单、没有扣款后，才可以解除未知订单锁。解除后程序不会对当前已有库存自动补单；需要等下一次缺货再补货。',
      buttons: ['取消', '我已核对，解除锁定'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (answer.response !== 1) return { ok: true, unlocked: false };
    dbRun("UPDATE attempts SET status='manual-reviewed' WHERE status='unknown'");
    dbRun('UPDATE monitor_state SET unknown_order_lock=0, armed=0, updated_at=? WHERE id=1', [nowIso()]);
    appendEvent('warning', '未知订单锁已人工解除；程序将等待下一次缺货→补货周期。');
    return { ok: true, unlocked: true };
  });
}

app.setAppUserModelId('com.humkt.autobuyer');
app.whenReady().then(async () => {
  try {
    ensureDirectories();
    await initializeDatabase();
    registerIpc();
    await createWindow();
    appendEvent('info', 'HUMKT Auto Buyer V3.0 已启动。自动购买默认关闭。');
  } catch (error) {
    dialog.showErrorBox('HUMKT Auto Buyer 启动失败', error.stack || error.message);
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (monitorWorker) monitorWorker.terminate();
  if (database) saveDatabase();
});

app.on('window-all-closed', () => {
  if (!isQuitting) app.quit();
});
