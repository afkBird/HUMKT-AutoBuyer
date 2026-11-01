'use strict';

const $ = (id) => document.getElementById(id);
let running = false;
let toastTimer = null;

function toast(message) {
  const node = $('toast');
  node.textContent = String(message);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

function setConnection(connected, text) {
  const pill = $('connectionPill');
  pill.className = `pill ${connected ? 'connected' : 'neutral'}`;
  pill.innerHTML = `<span class="dot"></span>${text}`;
}

function setRunning(value) {
  running = Boolean(value);
  $('startBtn').disabled = running;
  $('stopBtn').disabled = !running;
  ['maxUnitPrice','quantity','dailyBudget','pollInterval','autoBuyEnabled','riskAccepted','saveSettingsBtn'].forEach((id) => { $(id).disabled = running; });
  $('monitorStatus').textContent = running ? '正在监听' : '尚未启动';
  $('statusDot').className = `status-dot ${running ? 'running' : 'idle'}`;
  if (!running) $('statusDetail').textContent = '保存 Token 并测试 API 后即可开始监听。';
}

function addLog(item, prepend = false) {
  const body = $('logBody');
  const empty = body.querySelector('.empty-row');
  if (empty) empty.remove();
  const row = document.createElement('tr');
  const date = item.at || item.created_at || new Date().toISOString();
  const time = new Date(date).toLocaleTimeString('zh-CN', { hour12: false });
  const level = item.level || 'info';
  const label = ({ success: '成功', warning: '警告', error: '错误', info: '信息' })[level] || level;
  const timeCell = document.createElement('td');
  timeCell.textContent = time;
  const levelCell = document.createElement('td');
  levelCell.textContent = label;
  levelCell.className = `level-${level}`;
  const messageCell = document.createElement('td');
  messageCell.textContent = item.message || '';
  row.append(timeCell, levelCell, messageCell);
  if (prepend) body.prepend(row); else body.append(row);
  while (body.children.length > 150) body.removeChild(body.lastElementChild);
  const wrap = body.closest('.log-table-wrap');
  if (wrap && !prepend) wrap.scrollTop = wrap.scrollHeight;
}

function renderSnapshot(data) {
  if (data.stock !== undefined) $('stockValue').textContent = String(data.stock);
  if (data.price !== undefined) $('priceValue').textContent = `¥${data.price}`;
  if (data.latencyMs !== undefined) $('latencyValue').textContent = `${data.latencyMs}ms`;
  if (data.requestsPerMinute !== undefined) $('rateValue').textContent = `${data.requestsPerMinute} 次/分钟`;
  if (data.status) $('statusDetail').textContent = data.status;
  if (data.armed !== undefined) $('armedStatus').textContent = data.armed ? '等待符合条件补货' : '未触发';
  if (data.unknownOrderLock !== undefined) $('unknownLockBox').hidden = !data.unknownOrderLock;
  if (data.autoBuyEnabled !== undefined) { $('autoBuyStatus').textContent = data.autoBuyEnabled ? '开启' : '关闭'; $('autoBuyStatus').className = data.autoBuyEnabled ? 'level-success' : 'text-warn'; }
  if (data.stock !== undefined) $('stockHint').textContent = data.stock > 0 ? '当前有库存' : '当前缺货';
}

function collectSettings() {
  return {
    productId: 30275,
    pollIntervalMs: Number($('pollInterval').value),
    maxUnitPrice: $('maxUnitPrice').value.trim(),
    quantity: Number($('quantity').value),
    dailyBudget: $('dailyBudget').value.trim(),
    autoBuyEnabled: $('autoBuyEnabled').checked,
    riskAccepted: $('riskAccepted').checked
  };
}

function applySettings(settings) {
  $('pollInterval').value = String(settings.pollIntervalMs || 250);
  $('maxUnitPrice').value = settings.maxUnitPrice || '';
  $('quantity').value = String(settings.quantity || 1);
  $('dailyBudget').value = settings.dailyBudget || '';
  $('autoBuyEnabled').checked = Boolean(settings.autoBuyEnabled);
  $('riskAccepted').checked = Boolean(settings.riskAccepted);
  $('autoBuyStatus').textContent = settings.autoBuyEnabled ? '开启' : '关闭';
  $('autoBuyStatus').className = settings.autoBuyEnabled ? 'level-success' : 'text-warn';
}

async function saveSettings(showMessage = true) {
  const settings = collectSettings();
  const saved = await window.humkt.saveSettings(settings);
  applySettings(saved);
  if (showMessage) toast('购买规则已保存。');
  return saved;
}

async function initialize() {
  try {
    const data = await window.humkt.getInitialData();
    applySettings(data.settings);
    setRunning(data.running);
    if (data.tokenSaved) {
      $('tokenState').textContent = '已加密保存';
      $('tokenState').className = 'tiny-state level-success';
      setConnection(false, 'Token 已保存');
    }
    $('dailySpent').textContent = `¥${data.dailySpent || '0.00'}`;
    if (data.state?.unknownOrderLock) $('unknownLockBox').hidden = false;
    if (data.events?.length) data.events.forEach((item) => addLog(item));
    if (data.orders?.length) {
      const latest = data.orders[0];
      addLog({ level: 'info', created_at: latest.created_at, message: `历史订单：${latest.trx || latest.order_id || '订单'}，数量 ${latest.quantity}，金额 ¥${(Number(latest.amount_cents || 0) / 100).toFixed(2)}，状态 ${latest.status || '未知'}。` });
    }
  } catch (error) {
    toast(`初始化失败：${error.message}`);
  }
}

$('saveTokenBtn').addEventListener('click', async () => {
  try {
    const token = $('apiToken').value.trim();
    if (!token) throw new Error('请先粘贴 API Token。');
    await window.humkt.saveToken(token);
    $('apiToken').value = '';
    $('tokenState').textContent = '已加密保存';
    $('tokenState').className = 'tiny-state level-success';
    setConnection(false, 'Token 已保存');
    toast('Token 已加密保存，输入框已清空。');
  } catch (error) { toast(error.message); }
});

$('testApiBtn').addEventListener('click', async () => {
  $('testApiBtn').disabled = true;
  $('apiTestResult').textContent = '正在测试…';
  try {
    const result = await window.humkt.testApi();
    $('productName').textContent = result.product.name;
    $('stockValue').textContent = String(result.product.in_stock);
    $('priceValue').textContent = `¥${result.product.price}`;
    $('apiTestResult').textContent = `连接成功 · 余额 ¥${result.balance}`;
    setConnection(true, 'API 已连接');
    $('unknownLockBox').hidden = true;
    toast(`API 测试成功：${result.product.name}`);
    addLog({ level: 'success', message: `API 测试成功：${result.product.name}，库存 ${result.product.in_stock}，余额 ¥${result.balance}。` });
  } catch (error) {
    $('apiTestResult').textContent = `测试失败：${error.message}`;
    setConnection(false, 'API 测试失败');
    toast(error.message);
    addLog({ level: 'error', message: `API 测试失败：${error.message}` });
  } finally { $('testApiBtn').disabled = false; }
});

$('saveSettingsBtn').addEventListener('click', async () => {
  try { await saveSettings(); }
  catch (error) { toast(error.message); }
});

$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  try {
    await saveSettings(false);
    await window.humkt.startMonitor();
    setRunning(true);
    setConnection(true, '监听已启动');
    toast('监听已启动。');
  } catch (error) {
    $('startBtn').disabled = false;
    toast(error.message);
    addLog({ level: 'error', message: `启动失败：${error.message}` });
  }
});

$('stopBtn').addEventListener('click', async () => {
  $('stopBtn').disabled = true;
  try {
    await window.humkt.stopMonitor();
    setRunning(false);
    toast('监听已停止。');
  } catch (error) { toast(error.message); }
  finally { $('stopBtn').disabled = false; }
});

$('unlockBtn').addEventListener('click', async () => {
  try {
    const result = await window.humkt.unlockUnknownOrder();
    if (result.unlocked) {
      $('unknownLockBox').hidden = true;
      toast('未知订单锁已解除；程序将等待下一次缺货后补货。');
    }
  } catch (error) { toast(error.message); }
});

$('autoBuyEnabled').addEventListener('change', () => {
  $('autoBuyStatus').textContent = $('autoBuyEnabled').checked ? '待保存' : '关闭';
  $('autoBuyStatus').className = $('autoBuyEnabled').checked ? 'text-warn' : 'text-warn';
});

$('clearLogBtn').addEventListener('click', () => {
  $('logBody').innerHTML = '<tr><td colspan="3" class="empty-row">日志显示已清空（数据库历史记录保留）</td></tr>';
});

window.humkt.onEvent((event) => {
  if (event.type === 'log') addLog(event);
  if (event.type === 'snapshot') renderSnapshot(event);
  if (event.type === 'running') setRunning(event.running);
  if (event.type === 'status') {
    setRunning(event.running);
    if (event.status) $('statusDetail').textContent = event.status;
  }
  if (event.type === 'fatal') {
    setRunning(false);
    setConnection(false, '监听异常');
    toast(`监听异常：${event.message}`);
  }
  if (event.type === 'order-success') {
    $('dailySpent').textContent = `¥${event.dailySpent || '0.00'}`;
    toast(`下单成功：${event.order?.trx || event.order?.order_id || ''}`);
  }
  if (event.type === 'auto-buy-paused') {
    $('autoBuyEnabled').checked = false;
    $('autoBuyStatus').textContent = '已暂停';
    $('autoBuyStatus').className = 'text-warn';
    toast(event.message || '自动购买已暂停。');
  }
  if (event.type === 'unknown-order-lock') {
    $('unknownLockBox').hidden = false;
    toast('订单结果未知，自动购买已锁定。');
  }
  if (event.type === 'order-rejected') toast(`订单未创建：${event.message}`);
});

initialize();
