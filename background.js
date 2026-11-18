// 批量查询粉丝数：在一个后台标签页里依次打开每个账号主页，
// 由 hook.js 截取 X 自己的 UserByScreenName 返回数据，读取精确的 followers_count。

const PAGE_TIMEOUT_MS = 20000; // 每个账号最多等待多久
const GAP_MS = 1500;           // 两个账号之间的间隔

let pending = null; // { tabId, id, resolve }
let running = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function screenNameFromUrl(url) {
  try {
    const v = new URL(url, 'https://x.com').searchParams.get('variables');
    return (JSON.parse(v).screen_name || '').toLowerCase();
  } catch (_) {
    return '';
  }
}

// 在返回数据里递归查找指定账号的粉丝数（严格：要求账号名匹配）
function findUser(json, want) {
  let found = null;
  (function walk(o) {
    if (!o || typeof o !== 'object' || found) return;
    const legacy = o.legacy;
    if (legacy && typeof legacy.followers_count === 'number') {
      const sn = (o.core?.screen_name || legacy.screen_name || '').toLowerCase();
      if (sn === want) {
        found = { followers: legacy.followers_count, name: o.core?.name || legacy.name || '' };
        return;
      }
    }
    for (const k in o) walk(o[k]);
  })(json);
  return found;
}

// 宽松查找：这个请求本来就是查该账号的，只要找到任何粉丝数字段就用
const FOLLOWER_KEYS = ['followers_count', 'followersCount', 'normal_followers_count'];
function findFollowersAnywhere(json) {
  let found = null;
  let name = '';
  (function walk(o) {
    if (!o || typeof o !== 'object' || found) return;
    if (!name && typeof o.name === 'string' && (o.screen_name || o.screenName)) name = o.name;
    for (const key of FOLLOWER_KEYS) {
      const v = o[key];
      if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
        found = Number(v);
        if (!name && typeof o.name === 'string') name = o.name;
        return;
      }
    }
    for (const k in o) walk(o[k]);
  })(json);
  return found === null ? null : { followers: found, name };
}

// 把 "1,052" / "1.2K" / "3.4万" 转成数字；带缩写的标记为近似值
function parseCount(text) {
  const t = (text || '').replace(/[,，\s]/g, '');
  const m = t.match(/([\d.]+)(K|M|B|千|万|萬|亿|億)?/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, '千': 1e3, '万': 1e4, '萬': 1e4, '亿': 1e8, '億': 1e8 };
  const unit = (m[2] || '').toLowerCase();
  return { followers: Math.round(parseFloat(m[1]) * (mult[unit] || 1)), approx: !!unit };
}

// 记录最近几次截到的原始数据，方便排查（弹窗里可复制）
async function saveDebug(id, url, data) {
  try {
    const { followerDebug = [] } = await chrome.storage.local.get('followerDebug');
    followerDebug.push({ id, url: String(url).slice(0, 300), data: JSON.stringify(data).slice(0, 6000) });
    await chrome.storage.local.set({ followerDebug: followerDebug.slice(-6) });
  } catch (_) { /* ignore */ }
}

// 兜底：从页面上读取显示的粉丝数
async function tryDom() {
  const p = pending;
  if (!p || p.tabId == null) return;
  let r;
  try {
    r = await chrome.tabs.sendMessage(p.tabId, { type: 'readFollowersDom', id: p.id });
  } catch (_) {
    return;
  }
  if (pending !== p || !r) return;
  if (r.text) {
    const c = parseCount(r.text);
    if (c) p.resolve({ status: 'ok', followers: c.followers, approx: c.approx, name: r.name || p.name || '' });
  } else if (r.notFound) {
    p.resolve({ status: 'error', error: '账号不存在或已被封' });
  }
}

function handleUserData(msg, sender) {
  if (!pending || sender.tab?.id !== pending.tabId) return;
  const p = pending;
  const want = p.id.toLowerCase();
  const urlMatches = screenNameFromUrl(msg.url) === want;
  if (urlMatches) saveDebug(p.id, msg.url, msg.data);

  const user = findUser(msg.data, want) || (urlMatches ? findFollowersAnywhere(msg.data) : null);
  if (user) {
    p.resolve({ status: 'ok', ...user });
    return;
  }
  if (!urlMatches) return;

  const r = msg.data?.data?.user?.result;
  if (r?.__typename === 'UserUnavailable') {
    p.resolve({ status: 'error', error: r.reason || '账号不可用' });
    return;
  }
  // 数据格式无法识别：稍后从页面读取显示的数字
  setTimeout(tryDom, 3000);
}

async function saveQuery(q) {
  await chrome.storage.local.set({ followerQuery: q });
}

// 登记等待某个账号的数据；tabId 可以稍后再填
function waitForUser(id, tabId) {
  return new Promise((resolve) => {
    pending = { tabId, id, resolve };
    setTimeout(tryDom, 10000);
    setTimeout(tryDom, PAGE_TIMEOUT_MS - 2000);
    setTimeout(() => resolve({ status: 'error', error: '超时，未获取到数据（请确认已登录 x.com）' }), PAGE_TIMEOUT_MS);
  });
}

async function runQuery(ids) {
  if (running) return;
  running = true;
  const q = {
    running: true,
    startedAt: Date.now(),
    results: ids.map((id) => ({ id, status: 'waiting' }))
  };
  await saveQuery(q);

  let tabId = null;
  try {
    for (let i = 0; i < ids.length; i++) {
      q.results[i].status = 'loading';
      await saveQuery(q);

      const url = `https://x.com/${encodeURIComponent(ids[i])}`;
      const p = waitForUser(ids[i], tabId);
      if (tabId === null) {
        tabId = (await chrome.tabs.create({ url, active: false })).id;
        pending.tabId = tabId;
      } else {
        await chrome.tabs.update(tabId, { url });
      }
      const r = await p;
      pending = null;

      q.results[i] = { id: ids[i], ...r };
      await saveQuery(q);
      if (i < ids.length - 1) await sleep(GAP_MS);
    }
  } catch (e) {
    q.error = String(e?.message || e);
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
    q.running = false;
    q.finishedAt = Date.now();
    q.results.forEach((r) => {
      if (r.status === 'waiting' || r.status === 'loading') { r.status = 'error'; r.error = '已中断'; }
    });
    await saveQuery(q);
    running = false;
    pending = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'userData') {
    handleUserData(msg, sender);
  } else if (msg.type === 'queryFollowers') {
    if (running) {
      sendResponse({ ok: false, error: '正在查询中' });
    } else {
      runQuery(msg.ids);
      sendResponse({ ok: true });
    }
  }
});

// Service worker 被浏览器回收重启后，把上次未完成的查询标记为中断
chrome.storage.local.get('followerQuery').then(({ followerQuery: q }) => {
  if (q && q.running && !running) {
    q.running = false;
    q.results.forEach((r) => {
      if (r.status === 'waiting' || r.status === 'loading') { r.status = 'error'; r.error = '已中断，请重新查询'; }
    });
    chrome.storage.local.set({ followerQuery: q });
  }
});
