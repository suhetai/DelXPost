const DEFAULTS = {
  keyword: 'http://ccs0919.pixnet.net',
  intervalSec: 2,
  batchSize: 200,
  pauseMin: 10,
  maxTotal: 0,
  username: 'g_oi21',
  searchTerms: '痞客邦',
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
  const terms = s.searchTerms || s.keyword.replace(/^https?:\/\//, '');
  const q = (s.username ? `from:${s.username.replace(/^@/, '')} ` : '') + terms;
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

// ---------- 批量查询粉丝数 ----------
function parseIds(text) {
  const ids = [];
  for (let t of text.split(/[\s,，、]+/)) {
    t = t.trim().replace(/^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i, '').split(/[/?#]/)[0].replace(/^@/, '');
    if (/^[A-Za-z0-9_]{1,15}$/.test(t) && !ids.some((x) => x.toLowerCase() === t.toLowerCase())) ids.push(t);
  }
  return ids;
}

function renderFollowers(q) {
  const table = $('followerTable');
  table.textContent = '';
  if (!q) return;
  $('queryFollowers').disabled = !!q.running;
  $('queryFollowers').textContent = q.running ? '查询中…' : '查询粉丝数';
  const head = table.insertRow();
  ['账号', '名称', '粉丝数'].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  });
  for (const r of q.results) {
    const tr = table.insertRow();
    tr.insertCell().textContent = '@' + r.id;
    tr.insertCell().textContent = r.name || '';
    const c = tr.insertCell();
    if (r.status === 'ok') {
      c.className = 'num';
      c.textContent = r.followers.toLocaleString('en-US');
    } else if (r.status === 'error') {
      c.className = 'err';
      c.textContent = r.error;
    } else {
      c.textContent = r.status === 'loading' ? '查询中…' : '等待';
    }
  }
}

$('followerIds').addEventListener('change', () => chrome.storage.local.set({ followerIds: $('followerIds').value }));

$('queryFollowers').onclick = async () => {
  const text = $('followerIds').value;
  await chrome.storage.local.set({ followerIds: text });
  const ids = parseIds(text);
  if (!ids.length) {
    renderFollowers({ results: [] });
    $('followerTable').textContent = '请填写至少一个有效的账号 ID';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'queryFollowers', ids });
  if (res && !res.ok) $('followerTable').textContent = res.error;
};

chrome.storage.onChanged.addListener((changes) => {
  if (changes.followerQuery) renderFollowers(changes.followerQuery.newValue);
});

chrome.storage.local.get(['followerIds', 'followerQuery']).then(({ followerIds, followerQuery }) => {
  if (followerIds) $('followerIds').value = followerIds;
  renderFollowers(followerQuery);
});

load();
