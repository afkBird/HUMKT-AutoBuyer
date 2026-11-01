// @ts-nocheck
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');

const API_BASE = 'https://www.humkt.com/api/v1';
const PRODUCT_ID = 30275;
const RATE_WINDOW_MS = 60_000;
const MAX_PRICE_REQUESTS_PER_WINDOW = 285;
const MAX_ORDER_REQUESTS_PER_WINDOW = 100;

const token = workerData.token;
const settings = workerData.settings;

let state = { ...workerData.initialState };
let dailySpentCents = Number(workerData.dailySpentCents || 0);
let dailySpendDate = localDateKey();
let stopRequested = false;
let requestSequence = 0;
let activeController = null;
let activeRequestKind = 'read';
let readyLogKey = '';
let rateTimestamps = [];
let orderTimestamps = [];

const pendingAcks = new Map();
const sleepWaiters = new Set();

function localDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emit(type, payload = {}) {
  if (parentPort) parentPort.postMessage({ type, ...payload });
}

function log(level, message) {
  emit('log', { level, message: String(message) });
}

function sleep(ms) {
  if (stopRequested) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sleepWaiters.delete(finish);
      resolve();
    };

    timer = setTimeout(finish, Math.max(0, ms));
    sleepWaiters.add(finish);
  });
}

function wakeAllSleeps() {
  for (const wake of [...sleepWaiters]) wake();
}

function requestMain(type, payload = {}, timeoutMs = 5000) {
  const requestId = `${Date.now()}-${++requestSequence}`;

  return new Promise((resolve, reject) => {
    const pending = { resolve, reject, timer: null };

    pending.timer = setTimeout(() => {
      pendingAcks.delete(requestId);
      reject(new Error('主进程确认超时，已取消后续操作。'));
    }, timeoutMs);

    pendingAcks.set(requestId, pending);
    emit(type, { ...payload, requestId });
  });
}

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'stop') {
    stopRequested = true;

    // Stop polling immediately, but do not abort an order POST already sent.
    if (activeController && activeRequestKind !== 'order') {
      activeController.abort();
    }

    wakeAllSleeps();
    return;
  }

  if (message.type === 'ack' && message.requestId && pendingAcks.has(message.requestId)) {
    const pending = pendingAcks.get(message.requestId);
    clearTimeout(pending.timer);
    pendingAcks.delete(message.requestId);

    if (message.ok) pending.resolve(message);
    else pending.reject(new Error(message.error || '主进程保存状态失败。'));
  }
});

function toCents(value) {
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

function getRetryAfter(response, json) {
  const raw = response.headers.get('retry-after');
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 15 * 60_000);
  const fallback = Number(json?.retry_after || json?.retryAfter || 60);
  return Math.min(Math.max(fallback, 1) * 1000, 15 * 60_000);
}

async function fetchJson(endpoint, options = {}, timeoutMs = 10_000, requestKind = 'read') {
  const controller = new AbortController();
  activeController = controller;
  activeRequestKind = requestKind;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    const text = await response.text();
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error(`API 返回非 JSON（HTTP ${response.status}）。`); }

    return { response, json };
  } finally {
    clearTimeout(timeout);
    if (activeController === controller) {
      activeController = null;
      activeRequestKind = 'read';
    }
  }
}

async function waitForRateSlot() {
  while (!stopRequested) {
    const now = Date.now();
    rateTimestamps = rateTimestamps.filter((t) => now - t < RATE_WINDOW_MS);

    if (rateTimestamps.length < MAX_PRICE_REQUESTS_PER_WINDOW) {
      rateTimestamps.push(now);
      return true;
    }

    const waitMs = Math.max(100, rateTimestamps[0] + RATE_WINDOW_MS - now + 25);
    emit('snapshot', { type: 'snapshot', status: '限流窗口等待', rateWaitMs: waitMs });
    await sleep(waitMs);
  }

  return false;
}

async function persistState() {
  await requestMain('persist-state', { state: { ...state } });
}

function snapshot(data) {
  const now = Date.now();
  rateTimestamps = rateTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
  emit('snapshot', {
    type: 'snapshot',
    status: '监听中',
    productId: PRODUCT_ID,
    stock: data.stock,
    price: centsToMoney(data.priceCents),
    latencyMs: data.latencyMs,
    requestsPerMinute: rateTimestamps.length,
    armed: state.armed,
    unknownOrderLock: state.unknownOrderLock,
    autoBuyEnabled: Boolean(settings.autoBuyEnabled),
    updatedAt: new Date().toISOString()
  });
}

async function getProductDetails() {
  while (!stopRequested) {
    const { response, json } = await fetchJson(`/products/${PRODUCT_ID}`, { method: 'GET' }, 12_000);

    if (response.status === 429) {
      const waitMs = getRetryAfter(response, json);
      log('warning', `商品详情接口触发限流，遵循 Retry-After 等待 ${Math.ceil(waitMs / 1000)} 秒。`);
      await sleep(waitMs);
      continue;
    }

    if (!response.ok || json.code !== 1) {
      throw new Error(json.message || `商品详情查询失败（HTTP ${response.status}）。`);
    }

    return json.data;
  }

  throw new Error('监听已停止。');
}

async function getPrice() {
  const hasRateSlot = await waitForRateSlot();
  if (!hasRateSlot || stopRequested) return null;

  const started = Date.now();
  const { response, json } = await fetchJson(`/prices?ids=${PRODUCT_ID}`, { method: 'GET' }, 10_000);
  const latencyMs = Date.now() - started;

  if (response.status === 429) {
    const waitMs = getRetryAfter(response, json);
    log('warning', `查价接口触发限流，遵循 Retry-After 等待 ${Math.ceil(waitMs / 1000)} 秒。`);
    await sleep(waitMs);
    return null;
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`API 认证或账户权限错误：${json.message || json.error || response.status}`);
  }

  if (!response.ok || json.code !== 1) {
    throw new Error(json.message || `查价失败（HTTP ${response.status}）。`);
  }

  const item = Array.isArray(json.data)
    ? json.data.find((row) => Number(row.id) === PRODUCT_ID)
    : null;

  if (!item) {
    throw new Error(`商品 ${PRODUCT_ID} 未出现在查价结果中，可能已下架或暂不可见。`);
  }

  return {
    stock: Math.max(0, Number(item.in_stock || 0)),
    priceCents: toCents(item.price),
    minQty: Math.max(1, Number(item.min_qty || 1)),
    maxQty: Math.max(0, Number(item.max_qty || 0)),
    latencyMs
  };
}

function validatePurchase(data, product) {
  const requestedLimit = Number(settings.quantity);
  const maxPriceCents = toCents(settings.maxUnitPrice);
  const dailyBudgetCents = toCents(settings.dailyBudget);

  if (!settings.autoBuyEnabled) return { ok: false, reason: '自动购买关闭' };
  if (state.unknownOrderLock) return { ok: false, reason: '存在结果未知的订单，自动购买已锁定' };
  if (apiBool(product.maintenance)) return { ok: false, reason: '商品维护中' };

  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
    return { ok: false, reason: '购买数量上限必须为 1–200 的整数' };
  }

  if (data.priceCents <= 0) return { ok: false, reason: '商品价格无效' };
  if (data.priceCents > maxPriceCents) {
    return { ok: false, reason: `当前单价 ¥${centsToMoney(data.priceCents)} 超过上限 ¥${centsToMoney(maxPriceCents)}` };
  }

  const minQty = Math.max(1, Number(data.minQty || 1), Number(product.min_qty || 1));
  const platformMaxCandidates = [
    Number(data.maxQty || 0),
    Number(product.max_qty || 0)
  ].filter((value) => Number.isInteger(value) && value > 0);

  const platformMax = platformMaxCandidates.length
    ? Math.min(...platformMaxCandidates)
    : Number.POSITIVE_INFINITY;

  const quantity = Math.min(
    requestedLimit,
    Math.max(0, Number(data.stock || 0)),
    platformMax
  );

  if (quantity < minQty) {
    return {
      ok: false,
      reason: `可购买数量 ${quantity}，低于商品最低购买量 ${minQty}；已按库存和平台限购核算`
    };
  }

  if (dailySpendDate !== localDateKey()) {
    dailySpendDate = localDateKey();
    dailySpentCents = 0;
  }

  const estimated = data.priceCents * quantity;
  if (dailySpentCents + estimated > dailyBudgetCents) {
    return {
      ok: false,
      reason: `预计金额 ¥${centsToMoney(estimated)} 将超过今日剩余预算`
    };
  }

  return { ok: true, estimatedAmountCents: estimated, quantity, requestedLimit };
}

async function submitOrder(data, product) {
  if (stopRequested) return;

  const check = validatePurchase(data, product);
  if (!check.ok) {
    if (readyLogKey !== check.reason) {
      log('info', `补货条件已出现，但暂不下单：${check.reason}。`);
      readyLogKey = check.reason;
    }
    return;
  }

  const now = Date.now();
  orderTimestamps = orderTimestamps.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);

  if (orderTimestamps.length >= MAX_ORDER_REQUESTS_PER_WINDOW) {
    if (readyLogKey !== 'order-rate-cap') {
      log('warning', `本地下单安全阈值 ${MAX_ORDER_REQUESTS_PER_WINDOW}/分钟已达到，当前补货事件暂不提交。`);
      readyLogKey = 'order-rate-cap';
    }
    return;
  }

  orderTimestamps.push(now);
  readyLogKey = '';

  const attemptKey = randomUUID();

  try {
    await requestMain('persist-attempt', {
      attemptKey,
      quantity: check.quantity,
      estimatedAmountCents: check.estimatedAmountCents
    });
  } catch (error) {
    log('error', `无法持久化下单锁，已取消下单：${error.message}`);
    return;
  }

  // If shutdown arrived before the HTTP POST was sent, cancel safely.
  if (stopRequested) {
    state.unknownOrderLock = false;
    state.armed = false;
    emit('order-rejected', {
      attemptKey,
      status: 'cancelled-before-submit',
      message: '程序正在退出；订单请求尚未发送，本次提交已安全取消。',
      rearm: false,
      level: 'info'
    });
    return;
  }

  state.unknownOrderLock = true;
  state.armed = false;

  log('warning', `检测到符合条件的补货，正在提交一次订单：设置上限 ${check.requestedLimit}，实际数量 ${check.quantity}，查价估算 ¥${centsToMoney(check.estimatedAmountCents)}。`);

  try {
    const body = new URLSearchParams({ id: String(PRODUCT_ID), qty: String(check.quantity) });

    const { response, json } = await fetchJson('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    }, 15_000, 'order');

    if (response.status === 429) {
      const waitMs = getRetryAfter(response, json);
      state.unknownOrderLock = false;
      state.armed = true;
      await persistState();

      emit('order-rejected', {
        attemptKey,
        status: 'rate-limited',
        message: `下单接口限流，未创建订单。等待 ${Math.ceil(waitMs / 1000)} 秒后继续监听。`,
        rearm: true,
        level: 'warning'
      });

      await sleep(waitMs);
      return;
    }

    if ([401, 402, 403, 404, 422].includes(response.status) || (response.ok && json.code === 0)) {
      const message = json.message || json.error || `HTTP ${response.status}`;
      state.unknownOrderLock = false;
      state.armed = false;
      await persistState();

      emit('order-rejected', {
        attemptKey,
        status: 'rejected',
        message,
        rearm: false,
        level: 'error'
      });

      settings.autoBuyEnabled = false;
      emit('auto-buy-paused', {
        message: `自动购买已暂停：${message}。请检查账户、余额、商品状态或购买规则。`
      });
      log('error', '自动购买已暂停。当前补货事件不会自动重试。');
      return;
    }

    if (!response.ok || json.code !== 1 || !json.data) {
      throw new Error(`下单返回无法确认的结果（HTTP ${response.status}）：${json.message || '无错误说明'}`);
    }

    const order = json.data;
    const amountCents = toCents(order.total_amount);

    state.unknownOrderLock = false;
    state.armed = false;
    dailySpentCents += amountCents || check.estimatedAmountCents;

    const configuredDailyBudget = toCents(settings.dailyBudget);
    if (configuredDailyBudget > 0 && dailySpentCents > configuredDailyBudget) {
      settings.autoBuyEnabled = false;
      emit('auto-buy-paused', {
        message: '实际扣款已超过本地预算估算值，自动购买已暂停。请核对订单金额。'
      });
    }

    emit('order-success', {
      attemptKey,
      quantity: check.quantity,
      estimatedAmountCents: check.estimatedAmountCents,
      amountCents: amountCents || check.estimatedAmountCents,
      order: {
        trx: order.trx || '',
        order_id: order.order_id || order.id || '',
        qty: Number(order.qty || check.quantity),
        total_amount: order.total_amount,
        status: order.status || 'unknown',
        snapshot_name: order.snapshot_name || ''
      }
    });

    await persistState();
    log('success', `订单成功：${order.trx || order.order_id || order.id || '已创建'}。`);
  } catch (error) {
    state.unknownOrderLock = true;
    state.armed = false;

    try { await persistState(); } catch {}

    emit('order-unknown', {
      attemptKey,
      message: `${error.message}。由于商品下单没有持久幂等保障，禁止自动重发；请先到 HUMKT「我的订单」核对。`
    });
  }
}

async function run() {
  emit('status', { running: true, status: '正在验证商品信息…' });
  log('info', `正在验证商品 ${PRODUCT_ID} 的商品详情与类型。`);

  const product = await getProductDetails();
  if (stopRequested) return;

  if (apiBool(product.is_group)) {
    throw new Error(`商品 ${PRODUCT_ID} 是产品组，不能直接购买。`);
  }
  if (apiBool(product.is_selectable)) {
    throw new Error(`商品 ${PRODUCT_ID} 被 API 标记为自选商品，已阻止普通商品下单。`);
  }
  if (apiBool(product.maintenance)) {
    log('warning', '商品当前处于维护状态；继续监听，但不会下单。');
  }

  log('success', `商品验证通过：${product.name || PRODUCT_ID}；普通商品；初始价格 ¥${product.price ?? '未知'}。`);
  emit('status', { running: true, status: '监听中' });

  let nextStartAt = Date.now();
  let errorBackoffMs = 1000;

  while (!stopRequested) {
    const wait = Math.max(0, nextStartAt - Date.now());
    if (wait > 0) await sleep(wait);
    if (stopRequested) break;

    try {
      const data = await getPrice();
      if (stopRequested) break;

      if (!data) {
        nextStartAt = Date.now() + 1000;
        continue;
      }

      errorBackoffMs = 1000;
      const previousStock = Number(state.lastStock ?? -1);

      if (!state.initialized) {
        state.initialized = true;
        state.lastStock = data.stock;
        state.armed = data.stock === 0;
        state.lastPriceCents = data.priceCents;
        await persistState();

        log('info', `已记录首次库存基线：${data.stock}。首次启动不会因当前有货而直接购买。`);
      } else {
        if (data.stock === 0) {
          if (previousStock > 0) log('info', '商品已缺货，进入补货等待状态。');
          state.armed = true;
        } else if (previousStock === 0 && data.stock > 0) {
          state.armed = true;
          log('success', `检测到补货：库存从 0 恢复至 ${data.stock}。`);
        }

        if (data.stock !== previousStock || data.priceCents !== state.lastPriceCents) {
          state.lastStock = data.stock;
          state.lastPriceCents = data.priceCents;
          await persistState();
        }
      }

      snapshot(data);
      if (state.armed && data.stock > 0) {
        await submitOrder(data, product);
      }

      const target = Number(settings.pollIntervalMs || 250);
      nextStartAt = Math.max(nextStartAt + target, Date.now());
    } catch (error) {
      if (stopRequested) break;

      log('warning', `监听请求异常：${error.message}。${error.message.includes('认证或账户权限') ? '已停止监听。' : `将在 ${errorBackoffMs}ms 后重试。`}`);

      if (error.message.includes('认证或账户权限')) throw error;

      await sleep(errorBackoffMs);
      errorBackoffMs = Math.min(errorBackoffMs * 2, 15_000);
      nextStartAt = Date.now();
    }
  }

  emit('status', { running: false, status: '已停止' });
  log('info', '监听工作线程已安全停止。');
}

run().catch((error) => {
  if (!stopRequested) emit('fatal', { message: error.stack || error.message });
}).finally(() => {
  emit('status', { running: false, status: '已停止' });

  for (const pending of pendingAcks.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('监听线程已关闭。'));
  }
  pendingAcks.clear();
  wakeAllSleeps();

  try { parentPort.close(); } catch {}
});
