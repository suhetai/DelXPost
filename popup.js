const DEFAULTS = {
  keyword: 'http://ccs0919.pixnet.net',
  intervalSec: 2,
  batchSize: 200,
  pauseMin: 10,
  maxTotal: 0,
  username: 'g_oi21',
  autoReload: true,
  maxEmptyReloads: 2,
  startDate: '2010-01-01',
  endDate: '',
  windowDays: 30
};
const FIELDS = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);

async function load() {
  const { settings, stats, dateCursor } = await chrome.storage.local.get(['settings', 'stats', 'dateCursor']);
  const s = { ...DEFAULTS, ...(settings || {}) };
  FIELDS.forEach((f) => {
    if ($(f).type === 'checkbox') $(f).checked = !!s[f];
    else $(f).value = s[f];
  });
  $('cursor').value = Number(dateCursor || 0) + 1;
  showStats(stats);
}

function readForm() {
  const s = {};
  FIELDS.forEach((f) => {
    const el = $(f);
    if (el.type === 'checkbox') s[f] = el.checked;
    else if (el.type === 'number') s[f] = Number(el.value) || 0;
    else s[f] = el.value.trim();
  });
  if (s.intervalSec < 0.5) s.intervalSec = 0.5;
  if (s.batchSize < 1) s.batchSize = 1;
  if (s.windowDays < 1) s.windowDays = 30;
  return s;
}

async function save(extra = {}) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings || {}), ...readForm(), ...extra } });
}

function showStats(st) {
  if (!st) return ($('status').textContent = '尚未运行');
  let txt = `状态：${st.status}\n累计删除：${st.total}　本批：${st.batch}　跳过：${st.skipped || 0}`;
  if (st.resumeAt && st.resumeAt > Date.now()) {
    const sec = Math.ceil((st.resumeAt - Date.now()) / 1000);
    txt += `\n恢复倒计时：${Math.floor(sec / 60)}分${sec % 60}秒`;
  }
  $('status').textContent = txt;
}

async function send(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
    return true;
  } catch (e) {
    $('status').textContent = '无法连接页面脚本：请先打开 x.com 页面（并刷新一次）后重试。';
    return false;
  }
}

FIELDS.forEach((f) => $(f).addEventListener('change', () => save()));
$('cursor').addEventListener('change', async () => {
  await chrome.storage.local.set({ dateCursor: Math.max(0, (Number($('cursor').value) || 1) - 1) });
});

$('search').onclick = async () => {
  await save({ useDateRange: false });
  const s = readForm();
  const kw = s.keyword.replace(/^https?:\/\//, '');
  const q = (s.username ? `from:${s.username.replace(/^@/, '')} ` : '') + `"${kw}"`;
  chrome.tabs.create({ url: `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live` });
};

$('start').onclick = async () => {
  await save({ useDateRange: false });
  await send('start');
};

$('startDate_btn').onclick = async () => {
  await save({ useDateRange: true });
  await chrome.storage.local.set({ dateCursor: Math.max(0, (Number($('cursor').value) || 1) - 1) });
  await send('startDateMode');
};

$('stop').onclick = () => send('stop');
$('reset').onclick = async () => {
  await chrome.storage.local.set({
    stats: { total: 0, batch: 0, skipped: 0, status: '计数已清零', resumeAt: 0 },
    dateCursor: 0
  });
  $('cursor').value = 1;
};

chrome.storage.onChanged.addListener((changes) => {
  if (changes.stats) showStats(changes.stats.newValue);
  if (changes.dateCursor) $('cursor').value = Number(changes.dateCursor.newValue || 0) + 1;
});
setInterval(async () => showStats((await chrome.storage.local.get('stats')).stats), 1000);

load();
