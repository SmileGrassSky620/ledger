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

// 一笔账分别折算成人民币、马币是多少（分）。用这笔账自己记下的汇率
function cnyOf(e) { return e.currency === 'CNY' ? e.cents : convertedOf(e); }
function myrOf(e) { return e.currency === 'MYR' ? e.cents : convertedOf(e); }

// 本月汇总：两种货币的账合并在一起，同时用人民币和马币显示
function renderSummary(list) {
  let outCny = 0, outMyr = 0, inCny = 0, inMyr = 0;
  for (const e of list) {
    if (e.type === 'out') { outCny += cnyOf(e); outMyr += myrOf(e); }
    else { inCny += cnyOf(e); inMyr += myrOf(e); }
  }
  $('summary').innerHTML = `
    <div class="sum-card">
      <div class="sum-head"><span>本月支出</span><span>人民币 + 马币合计</span></div>
      <div class="sum-big">${money(outCny, 'CNY')}</div>
      <div class="sum-conv">≈ ${money(outMyr, 'MYR')}</div>
      <div class="sum-row">
        <span>收入 <b>${money(inCny, 'CNY')}</b><small>≈ ${money(inMyr, 'MYR')}</small></span>
        <span>结余 <b>${money(inCny - outCny, 'CNY')}</b><small>≈ ${money(inMyr - outMyr, 'MYR')}</small></span>
      </div>
    </div>`;
}

// 支出分类：也合并两种货币，按人民币排序，同时显示马币
function renderBreakdown(list) {
  const box = $('breakdown');
  const outs = list.filter(e => e.type === 'out');
  if (outs.length === 0) { box.hidden = true; return; }
  box.hidden = false;

  const cats = {};   // { 餐饮: { cny, myr } }
  for (const e of outs) {
    cats[e.category] ??= { cny: 0, myr: 0 };
    cats[e.category].cny += cnyOf(e);
    cats[e.category].myr += myrOf(e);
  }
  const rows = Object.entries(cats).sort((a, b) => b[1].cny - a[1].cny);
  const max = rows[0][1].cny || 1;
  box.innerHTML = '<h3>支出分类</h3>' + rows.map(([cat, v]) => `
    <div class="bar-row">
      <span>${esc(cat)}</span>
      <div class="bar"><i style="width:${(v.cny / max * 100).toFixed(1)}%"></i></div>
      <span class="bar-val">${money(v.cny, 'CNY')}<small>≈ ${money(v.myr, 'MYR')}</small></span>
    </div>`).join('');
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
  $('aiHint').hidden = true;
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

// ============================================================
//  AI 识别付款截图（DeepSeek V4.1 Flash，API 里叫 deepseek-flash）
//  流程：选图片 → 压缩 → 转成 base64 → 发给 DeepSeek → 拿回 JSON → 填进表单
//  注意：只填表单，不自动保存；账户还是要你自己点
// ============================================================
const AI_KEY_STORE = 'ledger.ai.key';   // 单独存，不会被导出到备份里
const AI_URL = 'https://api.deepseek.com/chat/completions';
const AI_MODEL = 'deepseek-flash';

function getAiKey() {
  try { return localStorage.getItem(AI_KEY_STORE) || ''; } catch { return ''; }
}

// 把图片缩到最长边 1280 像素再发送：上传更快、更省钱，识别效果基本不受影响
async function compressImage(file, maxSide = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('图片打不开'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);   // "data:image/jpeg;base64,...."
  } finally {
    URL.revokeObjectURL(url);
  }
}

function buildPrompt() {
  return `你是记账助手。看这张付款或收款截图（可能来自支付宝、微信、银行App、Touch 'n Go、GrabPay、信用卡消费短信、购物小票等），提取这一笔交易。
只输出一个 JSON 对象，不要输出任何其他文字：
{"type":"out 或 in","amount":正数金额(不带符号和货币),"currency":"MYR 或 CNY","category":"从下面的分类里选一个","note":"商家名或简短说明，不超过15个字","date":"YYYY-MM-DD，看不出日期就填 null","card":"截图明确显示用的是 Visa 或信用卡就填 visa，否则填 null"}
支出分类：${CATEGORIES.out.join('、')}
收入分类：${CATEGORIES.in.join('、')}
货币判断：RM、MYR、马币 → MYR；¥、￥、元、CNY、RMB → CNY。
今天是 ${toDateStr(new Date())}。如果截图里有多笔交易，只取最主要、金额最明显的那一笔。
如果图里根本不是一笔交易，输出 {"error":"简短原因"}。`;
}

async function callDeepSeek(dataUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);   // 最多等 60 秒
  let res;
  try {
    res = await fetch(AI_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAiKey()}` },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt() },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
        temperature: 0,
      }),
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? '等太久了，请再试一次' : '连不上 DeepSeek，请检查网络');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new Error('API Key 不对，请在设置里重新粘贴');
  if (res.status === 402) throw new Error('DeepSeek 账户余额不足，请去开放平台充值');
  if (res.status === 429) throw new Error('请求太频繁，等一下再试');
  if (!res.ok) throw new Error(`识别失败（错误码 ${res.status}）`);

  const data = await res.json();
  const text = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
  const match = text.match(/\{[\s\S]*\}/);   // 从回复里抠出 JSON
  if (!match) throw new Error('AI 没看懂这张图');
  return JSON.parse(match[0]);
}

// 把 AI 的结果填进表单
function applyAiResult(r) {
  if (r.error) throw new Error('这张图好像不是付款记录：' + r.error);
  const amount = Number(r.amount);
  if (!(amount > 0)) throw new Error('没认出金额，请手动填写');

  form.type = r.type === 'in' ? 'in' : 'out';
  if (SYMBOL[r.currency]) form.currency = r.currency;
  const cats = CATEGORIES[form.type];
  form.category = cats.includes(r.category) ? r.category : cats[cats.length - 1];
  $('amountInput').value = amount.toFixed(2);
  if (r.note) $('noteInput').value = String(r.note).slice(0, 40);
  // 日期：格式对、而且不是未来的日期才用
  if (/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') && r.date <= toDateStr(new Date())) $('dateInput').value = r.date;
  form.account = null;   // 账户还是让你自己选
  syncForm();

  let msg = '✅ 已识别，检查一下，然后选账户、点保存';
  if (r.card === 'visa') msg += '（截图里看起来用的是 Visa 卡）';
  showAiHint(msg, false);
}

function showAiHint(msg, isErr) {
  const h = $('aiHint');
  h.textContent = msg;
  h.classList.toggle('err', isErr);
  h.hidden = false;
}

async function scanReceipt(file) {
  const btn = $('aiScanBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 识别中…（大约几秒）';
  $('aiHint').hidden = true;
  try {
    const dataUrl = await compressImage(file);
    applyAiResult(await callDeepSeek(dataUrl));
  } catch (err) {
    showAiHint(err.message || '识别失败', true);
  } finally {
    btn.disabled = false;
    btn.textContent = '📷 识别付款截图（AI 自动填写）';
  }
}

$('aiScanBtn').onclick = () => {
  if (!getAiKey()) {
    toast('先在设置里填 DeepSeek API Key');
    closeForm(); updateBackupInfo(); updateRateInfo(); updateAiKeyInfo();
    $('settingsBackdrop').hidden = false;
    return;
  }
  $('aiFile').click();
};
$('aiFile').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) scanReceipt(f);
};

function updateAiKeyInfo() {
  const k = getAiKey();
  $('aiKeyInput').value = '';
  $('aiKeyInfo').textContent = k ? `已保存：${k.slice(0, 5)}…${k.slice(-4)}（要换就粘贴新的再保存）` : '还没有设置';
}
$('saveAiKey').onclick = () => {
  const k = $('aiKeyInput').value.trim();
  try {
    if (k) localStorage.setItem(AI_KEY_STORE, k);
    else localStorage.removeItem(AI_KEY_STORE);
  } catch {}
  updateAiKeyInfo();
  toast(k ? 'Key 已保存' : 'Key 已清除');
};

// ---------- 绑定按钮 ----------
$('saveRate').onclick = saveManualRate;
$('openForm').onclick = openForm;
$('cancelForm').onclick = closeForm;
$('formBackdrop').addEventListener('click', e => { if (e.target.id === 'formBackdrop') closeForm(); });

$('openSettings').onclick = () => { updateBackupInfo(); updateRateInfo(); updateAiKeyInfo(); $('settingsBackdrop').hidden = false; };
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
  window.addEventListener('load', async () => {
    // updateViaCache: 'none' → 每次都去网上检查 sw.js 有没有新版本
    const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    // 每次从后台切回 App 时，也检查一下更新
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update();
    });
  });
  // 新版本接管后自动刷新一次页面，马上用上新版
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;   // 第一次安装不用刷新
    reloaded = true;
    location.reload();
  });
}

render();
