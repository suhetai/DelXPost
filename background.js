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

// 在返回数据里递归查找指定账号的粉丝数
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

function handleUserData(msg, sender) {
  if (!pending || sender.tab?.id !== pending.tabId) return;
  const want = pending.id.toLowerCase();
  const user = findUser(msg.data, want);
  if (user) {
    pending.resolve({ status: 'ok', ...user });
    return;
  }
  // 是这个账号的请求，但没有用户数据 => 不存在 / 被封 / 受限
  if (screenNameFromUrl(msg.url) === want) {
    const r = msg.data?.data?.user?.result;
    const reason = r?.__typename === 'UserUnavailable' ? (r.reason || '账号不可用') : '账号不存在或已被封';
    pending.resolve({ status: 'error', error: reason });
  }
}

async function saveQuery(q) {
  await chrome.storage.local.set({ followerQuery: q });
}

// 登记等待某个账号的数据；tabId 可以稍后再填
function waitForUser(id, tabId) {
  return new Promise((resolve) => {
    pending = { tabId, id, resolve };
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
