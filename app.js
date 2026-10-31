// ============================================================
//  记账本 PWA —— 主程序
//  数据结构：每一笔账是一个对象，全部放在一个数组里，存进 localStorage
//  {
//    id: "唯一编号",
//    type: "out" | "in",          支出 / 收入
//    cents: 1250,                 金额，用"分"存整数，避免 0.1+0.2 这种浮点误差
//    currency: "MYR" | "CNY",
//    category: "餐饮",
//    note: "备注",
//    date: "2026-11-01",
//    createdAt: 时间戳,
//    rate: 1.67,                  记账当时的汇率：1 马币 = 多少人民币
//    account: "balance" | "visa"  从哪个账户支出 / 存入哪个账户
//  }
// ============================================================

const STORE_KEY = 'ledger.entries.v1';
const META_KEY = 'ledger.meta.v1';
const BACKUP_REMIND_DAYS = 7;

const CATEGORIES = {
  out: ['餐饮', '交通', '购物', '日用', '学习', '娱乐', '住房', '话费', '医疗', '其他'],
  in:  ['生活费', '兼职', '奖学金', '红包', '其他'],
};
const SYMBOL = { MYR: 'RM', CNY: '¥' };

// 固定汇率：1 马币 = 1.67 人民币（想改的话改这里，或在设置里手动改）
const DEFAULT_RATE = 1.67;

// ===== 两个账户 =====
// weekly：每周固定时间"增加"一笔钱（weekday: 0=周日，hour: 12=中午12点）
// monthly：每月固定日期把可用额度"刷新"成固定金额
const ACCOUNTS = [
  { id: 'balance', name: '余额',        currency: 'CNY', refill: { type: 'weekly',  weekday: 0, hour: 12, cents: 50000 } },
  { id: 'visa',    name: 'Visa 信用卡', currency: 'CNY', refill: { type: 'monthly', day: 26, cents: 100000 } },
];
const accountById = (id) => ACCOUNTS.find(a => a.id === id);

// ---------- 读写存储 ----------
function loadEntries() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function saveEntries() {
  localStorage.setItem(STORE_KEY, JSON.stringify(entries));
}
function loadMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; }
  catch { return {}; }
}
function saveMeta() {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

let entries = loadEntries();
let meta = loadMeta();               // { lastBackup, lastCurrency, rate, accounts: { balance: {cents, time} } }
let viewMonth = toMonthKey(new Date()); // 当前查看的月份，形如 "2026-11"

// 请求浏览器"持久化存储"，降低数据被系统清理的概率
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist();
}

// ---------- 小工具函数 ----------
const $ = (id) => document.getElementById(id);

function pad(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toMonthKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return toMonthKey(new Date(y, m - 1 + delta, 1));
}
function money(cents, cur) {
  const v = (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${SYMBOL[cur]} ${v}`;
}
// ---------- 汇率换算 ----------
// 设置里手动改过就用手动的，否则用固定的 1.67
function currentRate() {
  return (meta.rate && meta.rate.source === 'manual' && meta.rate.value) || DEFAULT_RATE;
}
function otherCur(cur) { return cur === 'MYR' ? 'CNY' : 'MYR'; }
// 把一笔金额换成另一种货币（结果仍然是"分"）
function convert(cents, cur, rate) {
  return Math.round(cur === 'MYR' ? cents * rate : cents / rate);
}
// 一笔账换算后的金额；老记录没存汇率就用当前汇率
function convertedOf(e) {
  return convert(e.cents, e.currency, e.rate || currentRate());
}

// ============================================================
//  账户余额计算
//  思路：不直接存"现在还剩多少"，而是存一个"校准点"（某个时刻有多少钱），
//  然后 = 校准点金额 + 之后自动到账的钱 − 之后的支出 + 之后的收入。
//  好处：删掉/补记一笔账，余额会自动算对。
// ============================================================

// 一笔账"发生的时间"：用它的日期 + 记录时的时分秒（补记昨天的账时也算在昨天）
function effTime(e) {
  const c = new Date(e.createdAt);
  if (toDateStr(c) === e.date) return e.createdAt;   // 当天记的账，就是记录的那一刻
  const [y, m, d] = e.date.split('-').map(Number);
  return new Date(y, m - 1, d, c.getHours(), c.getMinutes(), c.getSeconds(), c.getMilliseconds()).getTime();
}
// 把一笔账换算成账户的货币（账户是人民币，马币消费按汇率换算后扣）
function amountInAccount(e, acc) {
  return e.currency === acc.currency ? e.cents : convertedOf(e);
}
// 时间点 after 之后的下一个"每周到账"时刻
function nextWeekly(after, r) {
  const d = new Date(after);
  d.setHours(r.hour, 0, 0, 0);
  d.setDate(d.getDate() + ((r.weekday - d.getDay() + 7) % 7));
  if (d.getTime() <= after) d.setDate(d.getDate() + 7);
  return d.getTime();
}
// now 之前最近一次"每月刷新"的时刻（当天 0 点）
function lastMonthly(now, r) {
  const d = new Date(now);
  let t = new Date(d.getFullYear(), d.getMonth(), r.day).getTime();
  if (t > now) t = new Date(d.getFullYear(), d.getMonth() - 1, r.day).getTime();
  return t;
}
function nextMonthly(now, r) {
  const d = new Date(now);
  let t = new Date(d.getFullYear(), d.getMonth(), r.day).getTime();
  if (t <= now) t = new Date(d.getFullYear(), d.getMonth() + 1, r.day).getTime();
  return t;
}

// 算出一个账户现在还有多少钱
function accountState(acc, now = Date.now()) {
  const anchor = meta.accounts && meta.accounts[acc.id];
  const r = acc.refill;
  let base, start;

  if (r.type === 'monthly') {
    // 信用卡：最近一次 26 号刷新之后，从 1000 开始扣；如果刷新后手动校准过，就从校准值开始
    const R = lastMonthly(now, r);
    if (!anchor || anchor.time < R) { base = r.cents; start = R; }
    else { base = anchor.cents; start = anchor.time; }
  } else {
    // 余额：必须先告诉 App 现在有多少钱，之后每周日中午自动 +500
    if (!anchor) return { set: false, next: nextWeekly(now, r) };
    base = anchor.cents; start = anchor.time;
    for (let t = nextWeekly(start, r); t <= now; t = nextWeekly(t, r)) base += r.cents;
  }

  for (const e of entries) {
    if (e.account !== acc.id) continue;
    const t = effTime(e);
    if (t <= start || t > now) continue;   // 校准点之前的账已经算在校准值里了
    const amt = amountInAccount(e, acc);
    base += e.type === 'out' ? -amt : amt;
  }
  return { set: true, cents: base, next: r.type === 'monthly' ? nextMonthly(now, r) : nextWeekly(now, r) };
}

// 手动校准某个账户："现在这个账户里有 X 元"
function calibrateAccount(acc) {
  const st = accountState(acc);
  const cur = st.set ? (st.cents / 100).toFixed(2) : '';
  const input = prompt(`「${acc.name}」现在实际有多少钱？（${acc.currency === 'CNY' ? '人民币' : '马币'}）`, cur);
  if (input === null) return;
  const v = input.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(v)) { toast('金额格式不对'); return; }
  meta.accounts ??= {};
  meta.accounts[acc.id] = { cents: Math.round(Number(v) * 100), time: Date.now() };
  saveMeta(); render(); toast(`已把「${acc.name}」设为 ${money(Math.round(Number(v) * 100), acc.currency)}`);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
// 防止备注里的 < > 被当成 HTML 执行
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 1800);
}

// ============================================================
//  渲染：根据数据把页面画出来
// ============================================================
function render() {
  const [y, m] = viewMonth.split('-');
  $('monthLabel').textContent = `${y}年${Number(m)}月`;

  const monthEntries = entries
    .filter(e => e.date.startsWith(viewMonth))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  renderAccounts();
  renderSummary(monthEntries);
  renderBreakdown(monthEntries);
  renderList(monthEntries);
  renderBanner();
}

// 时间戳 → "周日 12:00" 或 "11月26日"
function fmtRefill(acc, t) {
  const d = new Date(t);
  const amt = SYMBOL[acc.currency] + (acc.refill.cents / 100);
  return acc.refill.type === 'weekly'
    ? `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:00 +${amt}`
    : `${d.getMonth() + 1}/${d.getDate()} 恢复为 ${amt}`;
}

function renderAccounts() {
  $('accounts').innerHTML = ACCOUNTS.map(acc => {
    const st = accountState(acc);
    const other = otherCur(acc.currency);
    const body = st.set
      ? `<div class="acct-big ${st.cents < 0 ? 'neg' : ''}">${money(st.cents, acc.currency)}</div>
         <div class="acct-conv">≈ ${money(convert(st.cents, acc.currency, currentRate()), other)}</div>`
      : `<div class="acct-big unset">点我设置</div><div class="acct-conv">先填现在有多少钱</div>`;
    return `
      <button class="acct-card" data-acct="${acc.id}">
        <div class="acct-name">${acc.name}</div>
        ${body}
        <div class="acct-next">下次：${fmtRefill(acc, st.next)}</div>
      </button>`;
  }).join('');
}

function renderSummary(list) {
  // 本月用到的货币；一笔都没有时默认显示马币
  const curs = ['MYR', 'CNY'].filter(c => list.some(e => e.currency === c));
  if (curs.length === 0) curs.push(meta.lastCurrency || 'MYR');

  $('summary').innerHTML = curs.map(cur => {
    let out = 0, inc = 0, outConv = 0;
    for (const e of list) {
      if (e.currency !== cur) continue;
      if (e.type === 'out') { out += e.cents; outConv += convertedOf(e); }
      else inc += e.cents;
    }
    return `
      <div class="sum-card">
        <div class="sum-head"><span>本月支出</span><span>${cur === 'MYR' ? '马币' : '人民币'}</span></div>
        <div class="sum-big">${money(out, cur)}</div>
        <div class="sum-conv">≈ ${money(outConv, otherCur(cur))}</div>
        <div class="sum-row">
          <span>收入 <b>${money(inc, cur)}</b></span>
          <span>结余 <b>${money(inc - out, cur)}</b></span>
        </div>
      </div>`;
  }).join('');
}

function renderBreakdown(list) {
  const box = $('breakdown');
  const outs = list.filter(e => e.type === 'out');
  if (outs.length === 0) { box.hidden = true; return; }
  box.hidden = false;

  // 按货币分组，每组里再按分类求和
  const byCur = {};
  for (const e of outs) {
    byCur[e.currency] ??= {};
    byCur[e.currency][e.category] = (byCur[e.currency][e.category] || 0) + e.cents;
  }

  let html = '<h3>支出分类</h3>';
  for (const [cur, cats] of Object.entries(byCur)) {
    const rows = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    const max = rows[0][1];
    if (Object.keys(byCur).length > 1) html += `<div class="muted small">${cur === 'MYR' ? '马币' : '人民币'}</div>`;
    html += rows.map(([cat, cents]) => `
      <div class="bar-row">
        <span>${esc(cat)}</span>
        <div class="bar"><i style="width:${(cents / max * 100).toFixed(1)}%"></i></div>
        <span class="bar-val">${money(cents, cur)}</span>
      </div>`).join('');
  }
  box.innerHTML = html;
}

function renderList(list) {
  const box = $('list');
  if (list.length === 0) {
    box.innerHTML = `<div class="empty">这个月还没有记录<br>点下面的「＋ 记一笔」开始吧</div>`;
    return;
  }
  // 按日期分组
  const groups = {};
  for (const e of list) (groups[e.date] ??= []).push(e);

  const week = ['日', '一', '二', '三', '四', '五', '六'];
  box.innerHTML = Object.entries(groups).map(([date, items]) => {
    const d = new Date(date + 'T00:00:00');
    return `
      <div class="day-group">
        <div class="day-head"><span>${d.getMonth() + 1}月${d.getDate()}日 周${week[d.getDay()]}</span></div>
        <div class="day-items">
          ${items.map(e => `
            <button class="item" data-id="${e.id}">
              <span class="cat">${esc(e.category.slice(0, 1))}</span>
              <span class="mid">
                <div>${esc(e.category)}</div>
                ${(() => {
                  const acc = accountById(e.account);
                  const parts = [acc ? `<span class="tag tag-${acc.id}">${acc.name}</span>` : '', e.note ? esc(e.note) : ''].filter(Boolean);
                  return parts.length ? `<small>${parts.join(' ')}</small>` : '';
                })()}
              </span>
              <span class="amts">
                <span class="amt ${e.type}">${e.type === 'out' ? '−' : '+'}${money(e.cents, e.currency)}</span>
                <small>≈ ${money(convertedOf(e), otherCur(e.currency))}</small>
              </span>
            </button>`).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderBanner() {
  const days = meta.lastBackup ? (Date.now() - meta.lastBackup) / 86400000 : Infinity;
  const need = entries.length > 0 && days >= BACKUP_REMIND_DAYS;
  $('backupBanner').hidden = !need;
  if (need) {
    $('backupBannerText').textContent = meta.lastBackup
      ? `已经 ${Math.floor(days)} 天没备份了` : '还没有备份过数据';
  }
}

// ============================================================
//  记一笔：表单
// ============================================================
const form = { type: 'out', currency: 'MYR', category: '餐饮', account: null };

function openForm() {
  form.type = 'out';
  form.account = null;   // 故意不预选，每次都要自己点，防止记混
  form.currency = meta.lastCurrency || 'MYR';
  form.category = CATEGORIES.out[0];
  $('amountInput').value = '';
  $('noteInput').value = '';
  $('dateInput').value = toDateStr(new Date());
  $('formError').hidden = true;
  syncForm();
  $('formBackdrop').hidden = false;
  setTimeout(() => $('amountInput').focus(), 50);
}
function closeForm() { $('formBackdrop').hidden = true; }

// 把 form 对象的状态同步到按钮的高亮上
function syncForm() {
  setSegment('typeSeg', form.type);
  setSegment('curSeg', form.currency);
  const cats = CATEGORIES[form.type];
  if (!cats.includes(form.category)) form.category = cats[0];
  $('categoryChips').innerHTML = cats.map(c =>
    `<button type="button" data-value="${c}" class="${c === form.category ? 'active' : ''}">${c}</button>`).join('');

  // 账户选项：每个按钮上显示这个账户现在还有多少钱
  $('acctLabel').textContent = form.type === 'out' ? '从哪里支出？' : '存到哪里？';
  $('acctSeg').innerHTML = ACCOUNTS.map(acc => {
    const st = accountState(acc);
    return `<button type="button" data-value="${acc.id}" class="${form.account === acc.id ? 'active' : ''}">
      <b>${acc.name}</b><small>${st.set ? '剩 ' + money(st.cents, acc.currency) : '未设置'}</small></button>`;
  }).join('');
  syncConvertHint();
}
$('amountInput').addEventListener('input', syncConvertHint);
// 输入金额时，实时显示另一种货币大约是多少
function syncConvertHint() {
  const hint = $('convertHint');
  if (!hint) return;
  const raw = $('amountInput').value.trim().replace(/,/g, '');
  const n = Number(raw);
  if (!raw || !(n > 0)) { hint.textContent = ''; return; }
  const cents = Math.round(n * 100);
  hint.textContent = `≈ ${money(convert(cents, form.currency, currentRate()), otherCur(form.currency))}`;
}

function setSegment(id, value) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('active', b.dataset.value === value);
}

$('typeSeg').addEventListener('click', e => {
  if (!e.target.dataset.value) return;
  form.type = e.target.dataset.value; syncForm();
});
$('curSeg').addEventListener('click', e => {
  if (!e.target.dataset.value) return;
  form.currency = e.target.dataset.value; syncForm();
});
$('categoryChips').addEventListener('click', e => {
  if (!e.target.dataset.value) return;
  form.category = e.target.dataset.value; syncForm();
});
$('acctSeg').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  form.account = btn.dataset.value; $('formError').hidden = true; syncForm();
});
$('accounts').addEventListener('click', e => {
  const card = e.target.closest('.acct-card');
  if (card) calibrateAccount(accountById(card.dataset.acct));
});

$('entryForm').addEventListener('submit', e => {
  e.preventDefault();
  const raw = $('amountInput').value.trim().replace(/,/g, '');
  // 只允许"数字，最多两位小数"
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) {
    $('formError').textContent = '请输入正确的金额，比如 12.50';
    $('formError').hidden = false;
    return;
  }
  if (!form.account) {
    $('formError').textContent = form.type === 'out' ? '请选择从「余额」还是「Visa 信用卡」支出' : '请选择存到哪个账户';
    $('formError').hidden = false;
    return;
  }
  const date = $('dateInput').value || toDateStr(new Date());
  entries.push({
    id: uid(),
    type: form.type,
    cents: Math.round(Number(raw) * 100),
    currency: form.currency,
    category: form.category,
    note: $('noteInput').value.trim(),
    date,
    createdAt: Date.now(),
    rate: currentRate(),   // 记下当时的汇率
    account: form.account,
  });
  saveEntries();
  meta.lastCurrency = form.currency; saveMeta();
  viewMonth = date.slice(0, 7); // 跳到这笔账所在的月份
  closeForm();
  render();
  toast('已保存');
});

// 点一条记录 → 删除
$('list').addEventListener('click', e => {
  const btn = e.target.closest('.item');
  if (!btn) return;
  const entry = entries.find(x => x.id === btn.dataset.id);
  if (!entry) return;
  const acc = accountById(entry.account);
  if (confirm(`删除这笔记录？\n${entry.category} ${money(entry.cents, entry.currency)}${acc ? '（' + acc.name + '）' : ''}\n删除后账户余额会自动加回来`)) {
    entries = entries.filter(x => x.id !== entry.id);
    saveEntries(); render(); toast('已删除');
  }
});

// ============================================================
//  备份：导出 / 导入
// ============================================================
// iPhone 上优先用"分享面板"，可以直接存到「文件」或 iCloud 云盘
async function deliverFile(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false; // 用户点了取消
    }
  }
  // 电脑浏览器：直接下载
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

async function exportJson() {
  const data = JSON.stringify({ app: 'ledger', version: 2, exportedAt: new Date().toISOString(),
    accounts: meta.accounts || {}, entries }, null, 2);
  const ok = await deliverFile(`记账备份-${toDateStr(new Date())}.json`, data, 'application/json');
  if (ok) {
    meta.lastBackup = Date.now(); saveMeta();
    render(); updateBackupInfo(); toast('备份完成');
  }
}

async function exportCsv() {
  const head = '日期,类型,账户,分类,金额,货币,马币金额,人民币金额,汇率(1马币=?人民币),备注';
  const rows = [...entries].sort((a, b) => a.date.localeCompare(b.date)).map(e => {
    const myr = e.currency === 'MYR' ? e.cents : convertedOf(e);
    const cny = e.currency === 'CNY' ? e.cents : convertedOf(e);
    const acc = accountById(e.account);
    return [e.date, e.type === 'out' ? '支出' : '收入', acc ? acc.name : '', e.category, (e.cents / 100).toFixed(2), e.currency,
      (myr / 100).toFixed(2), (cny / 100).toFixed(2), (e.rate || currentRate()).toFixed(4),
      `"${(e.note || '').replace(/"/g, '""')}"`].join(',');
  });
  // 开头的 ﻿ 让 Excel 正确识别中文
  await deliverFile(`记账-${toDateStr(new Date())}.csv`, '﻿' + [head, ...rows].join('\n'), 'text/csv');
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(list)) throw new Error('格式不对');
    const valid = list.filter(e => e && e.id && Number.isInteger(e.cents) && e.date && SYMBOL[e.currency]);
    // 按 id 合并：已有的跳过，所以重复导入同一个备份也不会重复记账
    const have = new Set(entries.map(e => e.id));
    const fresh = valid.filter(e => !have.has(e.id));
    entries.push(...fresh);
    // 账户校准点：本机没有设置过才用备份里的
    if (data.accounts) {
      meta.accounts ??= {};
      for (const [id, a] of Object.entries(data.accounts)) {
        if (accountById(id) && !meta.accounts[id] && Number.isInteger(a.cents)) meta.accounts[id] = a;
      }
      saveMeta();
    }
    saveEntries(); render();
    toast(`恢复了 ${fresh.length} 条记录`);
  } catch {
    alert('这个文件不是有效的记账备份');
  }
}

function updateBackupInfo() {
  $('backupInfo').textContent = `共 ${entries.length} 条记录 · 上次备份：` +
    (meta.lastBackup ? new Date(meta.lastBackup).toLocaleString('zh-CN') : '从未');
}

function updateRateInfo() {
  if (!$('rateInput')) return;
  if (document.activeElement !== $('rateInput')) $('rateInput').value = currentRate().toFixed(4);
  const r = meta.rate;
  $('rateInfo').textContent = (r && r.source === 'manual')
    ? '手动设置 · ' + new Date(r.updatedAt).toLocaleString('zh-CN')
    : `默认固定汇率 ${DEFAULT_RATE}`;
}

function saveManualRate() {
  const v = Number($('rateInput').value.trim());
  if (!(v > 0.1 && v < 10)) { toast('汇率看起来不对'); return; }
  meta.rate = { value: v, updatedAt: Date.now(), source: 'manual' };
  saveMeta(); updateRateInfo(); toast('已保存，之后的记账按这个汇率');
}

// ---------- 绑定按钮 ----------
$('saveRate').onclick = saveManualRate;
$('openForm').onclick = openForm;
$('cancelForm').onclick = closeForm;
$('formBackdrop').addEventListener('click', e => { if (e.target.id === 'formBackdrop') closeForm(); });

$('openSettings').onclick = () => { updateBackupInfo(); updateRateInfo(); $('settingsBackdrop').hidden = false; };
$('closeSettings').onclick = () => ($('settingsBackdrop').hidden = true);
$('settingsBackdrop').addEventListener('click', e => { if (e.target.id === 'settingsBackdrop') $('settingsBackdrop').hidden = true; });

$('exportJson').onclick = exportJson;
$('bannerBackupBtn').onclick = exportJson;
$('exportCsv').onclick = exportCsv;
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = e => {
  if (e.target.files[0]) importJson(e.target.files[0]);
  e.target.value = '';
};

$('prevMonth').onclick = () => { viewMonth = shiftMonth(viewMonth, -1); render(); };
$('nextMonth').onclick = () => { viewMonth = shiftMonth(viewMonth, 1); render(); };

// ---------- 注册 Service Worker（让它能离线打开） ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

render();
