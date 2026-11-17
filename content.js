// X Tweet Cleaner - content script
// 在 x.com 页面中查找包含关键字的推文，并通过模拟点击 "..." -> "删除" -> "确认" 来删除。

(() => {
  if (window.__xTweetCleanerLoaded) return;
  window.__xTweetCleanerLoaded = true;

  const DEFAULTS = {
    keyword: 'http://ccs0919.pixnet.net',
    username: 'g_oi21',
    searchTerms: '痞客邦', // 搜索用的词（不加引号），与删除匹配的关键字分开
    intervalSec: 2,       // 每删一条间隔（秒）
    batchSize: 200,       // 每批删除数量
    pauseMin: 10,         // 每批之后暂停（分钟）
    maxTotal: 0,          // 总共最多删除多少，0 = 不限
    maxEmptyScrolls: 8,   // 连续多少次滚动都没找到匹配推文，就认为本页已到底
    autoReload: true,     // 本页到底后自动刷新页面继续
    maxEmptyReloads: 2,   // 连续刷新多少次仍然一条都删不到，就认为当前搜索（时间段）已删完
    useDateRange: false,  // 是否按时间段分段搜索
    startDate: '2010-01-01',
    endDate: '',          // 空 = 今天
    windowDays: 30        // 每段多少天
  };

  // 各语言界面里菜单 "删除" 项的文字
  const DELETE_WORDS = ['Delete', '删除', '刪除', '削除', '삭제', 'Supprimer', 'Eliminar', 'Löschen', 'Excluir', 'Удалить'];
  // 搜索出错时的 "重试" 按钮文字
  const RETRY_WORDS = ['Retry', 'Try again', '重试', '重試', '再試行', '다시 시도'];

  const SESSION_FLAG = 'xTweetCleanerActive';
  const RELOAD_KEY = 'xTweetCleanerEmptyReloads';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let running = false;
  let skipped = new WeakSet();
  let stats = { total: 0, batch: 0, skipped: 0, status: '空闲', resumeAt: 0 };

  // ---------- 工具函数 ----------
  async function waitFor(fn, timeout = 5000, step = 100) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function normalize(s) {
    return (s || '').toLowerCase().replace(/https?:\/\//g, '').replace(/\s+/g, ' ').trim();
  }

  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULTS, ...(settings || {}) };
  }

  async function saveStats(patch) {
    Object.assign(stats, patch);
    renderPanel();
    try { await chrome.storage.local.set({ stats }); } catch (_) { /* 扩展被重新加载时可能失败 */ }
  }

  function pressEscape() {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
  }

  function getEmptyReloads() {
    return Number(sessionStorage.getItem(RELOAD_KEY) || 0);
  }

  // ---------- 时间段 ----------
  const fmtDate = (d) => d.toISOString().slice(0, 10);

  function buildWindows(s) {
    const start = new Date((s.startDate || '2006-03-21') + 'T00:00:00Z');
    const end = s.endDate ? new Date(s.endDate + 'T00:00:00Z') : new Date(Date.now() + 86400000);
    const step = Math.max(1, Number(s.windowDays) || 30) * 86400000;
    const list = [];
    for (let t = start.getTime(); t < end.getTime(); t += step) {
      list.push({ since: fmtDate(new Date(t)), until: fmtDate(new Date(Math.min(t + step, end.getTime()))) });
    }
    return list;
  }

  function buildSearchUrl(s, win) {
    const terms = (s.searchTerms || '').trim() || (s.keyword || '').trim().replace(/^https?:\/\//, '');
    let q = (s.username ? `from:${s.username.replace(/^@/, '')} ` : '') + terms;
    if (win) q += ` since:${win.since} until:${win.until}`;
    return `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
  }

  async function getCursor() {
    const { dateCursor } = await chrome.storage.local.get('dateCursor');
    return Number(dateCursor || 0);
  }

  // ---------- 查找匹配推文 ----------
  function tweetMatches(article, kw) {
    // 只看推文本身的正文（第一个 tweetText），不看引用推文
    const textEl = article.querySelector('[data-testid="tweetText"]');
    let text = textEl ? textEl.innerText : '';
    // 链接有时会被截断显示，把链接的 href / title 也加进去
    if (textEl) {
      textEl.querySelectorAll('a').forEach((a) => {
        text += ' ' + (a.title || '') + ' ' + (a.getAttribute('href') || '');
      });
    }
    return normalize(text).includes(kw);
  }

  function findCandidate(kw) {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const a of articles) {
      if (skipped.has(a)) continue;
      if (tweetMatches(a, kw)) return a;
    }
    return null;
  }

  function findRetryButton() {
    for (const b of document.querySelectorAll('main [role="button"], main button')) {
      const t = (b.innerText || '').trim();
      if (RETRY_WORDS.includes(t)) return b;
    }
    return null;
  }

  // ---------- 删除单条推文 ----------
  async function deleteTweet(article) {
    article.scrollIntoView({ block: 'center' });
    await sleep(300);

    const caret = article.querySelector('[data-testid="caret"]');
    if (!caret) return 'skip';
    caret.click();

    const menuItem = await waitFor(() => {
      const items = document.querySelectorAll('[role="menu"] [role="menuitem"]');
      for (const el of items) {
        const t = el.innerText.trim();
        if (DELETE_WORDS.some((w) => t === w || t.startsWith(w))) return el;
      }
      return null;
    }, 3000);

    if (!menuItem) {
      // 没有删除选项：不是自己的推文（例如转推），跳过
      pressEscape();
      await sleep(300);
      return 'skip';
    }
    menuItem.click();

    const confirmBtn = await waitFor(
      () => document.querySelector('[data-testid="confirmationSheetConfirm"]'),
      3000
    );
    if (!confirmBtn) {
      pressEscape();
      return 'error';
    }
    confirmBtn.click();

    // 等待推文从页面消失，确认删除成功
    const gone = await waitFor(() => !article.isConnected || !article.offsetParent, 6000);
    return gone ? 'ok' : 'error';
  }

  // ---------- 暂停（带倒计时） ----------
  async function pauseFor(ms, reason) {
    const resumeAt = Date.now() + ms;
    await saveStats({ resumeAt, status: reason });
    while (running && Date.now() < resumeAt) {
      renderPanel();
      await sleep(1000);
    }
    await saveStats({ resumeAt: 0 });
  }

  // 本页已经找不到匹配推文时：刷新 / 切换到下一个时间段 / 结束
  // 返回 true 表示页面即将跳转（不要调用 stop）
  async function onPageExhausted(s) {
    const reloads = getEmptyReloads();

    if (s.autoReload && reloads < s.maxEmptyReloads) {
      sessionStorage.setItem(RELOAD_KEY, String(reloads + 1));
      await saveStats({ status: `本页已无匹配，5 秒后刷新页面加载新结果 (${reloads + 1}/${s.maxEmptyReloads})` });
      await sleep(5000);
      if (!running) return false;
      location.reload();
      return true;
    }

    if (s.useDateRange) {
      const windows = buildWindows(s);
      const next = (await getCursor()) + 1;
      if (next < windows.length) {
        sessionStorage.setItem(RELOAD_KEY, '0');
        await chrome.storage.local.set({ dateCursor: next });
        const w = windows[next];
        await saveStats({ status: `切换到下一个时间段 ${w.since} ~ ${w.until} (${next + 1}/${windows.length})` });
        await sleep(3000);
        if (!running) return false;
        location.href = buildSearchUrl(s, w);
        return true;
      }
      await saveStats({ status: '所有时间段都已处理，已完成' });
      return false;
    }

    await saveStats({ status: '刷新多次仍没有匹配的推文，已完成（可换搜索条件后再开始）' });
    return false;
  }

  // ---------- 主循环 ----------
  async function run() {
    if (running) return;
    running = true;
    sessionStorage.setItem(SESSION_FLAG, '1');
    skipped = new WeakSet();

    const s = await getSettings();
    const kw = normalize(s.keyword);
    if (!kw) {
      await saveStats({ status: '关键字为空，已停止' });
      return stop();
    }

    const saved = (await chrome.storage.local.get('stats')).stats || {};
    stats = { total: saved.total || 0, batch: saved.batch || 0, skipped: 0, status: '运行中', resumeAt: 0 };

    // 如果是刷新页面后继续，且之前处于暂停期，则继续等待
    if (saved.resumeAt && saved.resumeAt > Date.now()) {
      await pauseFor(saved.resumeAt - Date.now(), '批次暂停中（刷新后继续）');
      if (!running) return stop();
      stats.batch = 0;
    }

    let statusPrefix = '运行中';
    if (s.useDateRange) {
      const windows = buildWindows(s);
      const w = windows[await getCursor()];
      if (w) statusPrefix = `运行中 [${w.since} ~ ${w.until}]`;
    }
    await saveStats({ status: statusPrefix });

    let emptyScrolls = 0;
    let consecutiveErrors = 0;
    let navigating = false;

    while (running) {
      if (s.maxTotal > 0 && stats.total >= s.maxTotal) {
        await saveStats({ status: `已达到总上限 ${s.maxTotal}，完成` });
        break;
      }

      if (stats.batch >= s.batchSize) {
        await pauseFor(s.pauseMin * 60 * 1000, `本批已删 ${stats.batch} 条，暂停中`);
        if (!running) break;
        await saveStats({ batch: 0, status: statusPrefix + '（新一批）' });
        // 暂停很久后页面数据可能过期，刷新一下再继续
        if (s.autoReload) {
          sessionStorage.setItem(RELOAD_KEY, '0');
          location.reload();
          navigating = true;
          break;
        }
      }

      const article = findCandidate(kw);
      if (!article) {
        // 搜索出错（常见于请求过多）时点击 "重试"
        const retry = findRetryButton();
        if (retry) {
          await saveStats({ status: '页面加载出错，点击重试…' });
          retry.click();
          await sleep(5000);
          continue;
        }
        emptyScrolls++;
        if (emptyScrolls > s.maxEmptyScrolls) {
          navigating = await onPageExhausted(s);
          break;
        }
        await saveStats({ status: `未找到匹配推文，向下滚动加载… (${emptyScrolls}/${s.maxEmptyScrolls})` });
        window.scrollBy(0, window.innerHeight * 2);
        await sleep(2500);
        continue;
      }
      emptyScrolls = 0;

      const result = await deleteTweet(article);
      if (result === 'ok') {
        consecutiveErrors = 0;
        sessionStorage.setItem(RELOAD_KEY, '0'); // 删到了，说明这个搜索还有内容
        await saveStats({ total: stats.total + 1, batch: stats.batch + 1, status: statusPrefix });
        await sleep(Math.max(0.5, s.intervalSec) * 1000);
      } else if (result === 'skip') {
        skipped.add(article);
        await saveStats({ skipped: stats.skipped + 1 });
      } else {
        consecutiveErrors++;
        skipped.add(article); // 本轮先跳过，避免卡在同一条
        await saveStats({ status: `删除失败 (${consecutiveErrors} 次连续)` });
        if (consecutiveErrors >= 5) {
          // 很可能被限流，暂停一段时间后刷新页面再继续
          consecutiveErrors = 0;
          await pauseFor(s.pauseMin * 60 * 1000, '连续失败，疑似限流，暂停中');
          if (!running) break;
          location.reload();
          navigating = true;
          break;
        } else {
          await sleep(3000);
        }
      }
    }

    if (navigating) {
      running = false; // 保留 SESSION_FLAG，页面加载后自动继续
    } else {
      stop();
    }
  }

  function stop() {
    running = false;
    sessionStorage.removeItem(SESSION_FLAG);
    sessionStorage.removeItem(RELOAD_KEY);
    if (!/完成|停止/.test(stats.status)) stats.status = '已停止';
    saveStats({ resumeAt: 0 });
  }

  // 按时间段模式：从第一个时间段开始，跳转到对应搜索页并自动开始
  async function startDateMode() {
    const s = await getSettings();
    const windows = buildWindows(s);
    if (!windows.length) {
      await saveStats({ status: '时间段设置无效（开始日期需早于结束日期）' });
      return;
    }
    const cursor = Math.min(await getCursor(), windows.length - 1);
    await chrome.storage.local.set({ dateCursor: cursor });
    sessionStorage.setItem(SESSION_FLAG, '1');
    sessionStorage.setItem(RELOAD_KEY, '0');
    const w = windows[cursor];
    await saveStats({ status: `打开时间段 ${w.since} ~ ${w.until} (${cursor + 1}/${windows.length})` });
    location.href = buildSearchUrl(s, w);
  }

  // ---------- 页面悬浮面板 ----------
  let panel;
  function renderPanel() {
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:2147483647;background:#111;color:#fff;' +
        'font:13px/1.5 system-ui,sans-serif;padding:10px 12px;border-radius:10px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.4);min-width:220px;max-width:300px;opacity:.92';
      panel.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px">🧹 X Tweet Cleaner</div>' +
        '<div data-k="body"></div>' +
        '<button data-k="btn" style="margin-top:6px;padding:3px 10px;border-radius:6px;border:0;cursor:pointer"></button>';
      panel.querySelector('[data-k="btn"]').onclick = () => (running ? stop() : run());
      document.documentElement.appendChild(panel);
    }
    let countdown = '';
    if (stats.resumeAt && stats.resumeAt > Date.now()) {
      const sec = Math.ceil((stats.resumeAt - Date.now()) / 1000);
      countdown = `<br>恢复倒计时：${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`;
    }
    panel.querySelector('[data-k="body"]').innerHTML =
      `状态：${stats.status}${countdown}<br>累计删除：${stats.total}　本批：${stats.batch}<br>跳过：${stats.skipped}`;
    const btn = panel.querySelector('[data-k="btn"]');
    btn.textContent = running ? '停止' : '开始';
    btn.style.background = running ? '#f4212e' : '#1d9bf0';
    btn.style.color = '#fff';
  }

  // ---------- 与 popup 通信 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'start') {
      sessionStorage.setItem(RELOAD_KEY, '0');
      run();
      sendResponse({ ok: true });
    } else if (msg.type === 'startDateMode') {
      stop();
      startDateMode();
      sendResponse({ ok: true });
    } else if (msg.type === 'stop') {
      stop();
      sendResponse({ ok: true });
    } else if (msg.type === 'ping') {
      sendResponse({ ok: true, running });
    }
  });

  // 同一个标签页刷新/跳转后自动继续
  if (sessionStorage.getItem(SESSION_FLAG) === '1') {
    (async () => {
      const saved = (await chrome.storage.local.get('stats')).stats;
      if (saved) Object.assign(stats, saved);
      await saveStats({ status: '页面加载中，稍后自动继续…' });
      setTimeout(run, 5000);
    })();
  }
})();
