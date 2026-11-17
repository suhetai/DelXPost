const DEFAULTS = {
  keyword: 'http://ccs0919.pixnet.net',
  intervalSec: 2,
  batchSize: 200,
  pauseMin: 10,
  maxTotal: 0,
  username: 'g_oi21'
};
const FIELDS = ['keyword', 'intervalSec', 'batchSize', 'pauseMin', 'maxTotal', 'username'];
const $ = (id) => document.getElementById(id);

async function load() {
  const { settings, stats } = await chrome.storage.local.get(['settings', 'stats']);
  const s = { ...DEFAULTS, ...(settings || {}) };
  FIELDS.forEach((f) => ($(f).value = s[f]));
  showStats(stats);
}

function readForm() {
  const s = {};
  FIELDS.forEach((f) => {
    const v = $(f).value.trim();
    s[f] = $(f).type === 'number' ? Number(v) || 0 : v;
  });
  if (s.intervalSec < 0.5) s.intervalSec = 0.5;
  if (s.batchSize < 1) s.batchSize = 1;
  return s;
}

async function save() {
  await chrome.storage.local.set({ settings: readForm() });
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

async function activeXTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(type) {
  const tab = await activeXTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
    return true;
  } catch (e) {
    $('status').textContent = '无法连接页面脚本：请确认当前标签页是 x.com，并刷新页面后重试。';
    return false;
  }
}

FIELDS.forEach((f) => $(f).addEventListener('change', save));

$('search').onclick = async () => {
  await save();
  const s = readForm();
  // 搜索时去掉 http://，X 搜索对网址片段匹配更好
  const kw = s.keyword.replace(/^https?:\/\//, '');
  const q = (s.username ? `from:${s.username} ` : '') + `"${kw}"`;
  chrome.tabs.create({ url: `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live` });
};

$('start').onclick = async () => {
  await save();
  await send('start');
};
$('stop').onclick = () => send('stop');
$('reset').onclick = async () => {
  await chrome.storage.local.set({ stats: { total: 0, batch: 0, skipped: 0, status: '计数已清零', resumeAt: 0 } });
};

chrome.storage.onChanged.addListener((changes) => {
  if (changes.stats) showStats(changes.stats.newValue);
});
setInterval(async () => showStats((await chrome.storage.local.get('stats')).stats), 1000);

load();
