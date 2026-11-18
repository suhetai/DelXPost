// 运行在插件隔离环境，把 hook.js 截到的数据转发给 background。
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__xtc !== 'userData') return;
  try {
    chrome.runtime.sendMessage({ type: 'userData', url: e.data.url, data: e.data.data });
  } catch (_) { /* 插件重新加载后旧页面会失效，忽略 */ }
});

// 兜底：从个人主页上读取显示的粉丝数（可能是缩写，如 1.2K）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'readFollowersDom') return;
  const id = (msg.id || '').toLowerCase();
  let text = '';
  for (const a of document.querySelectorAll('a[href*="/followers"], a[href*="/verified_followers"]')) {
    const href = (a.getAttribute('href') || '').toLowerCase();
    if (href === `/${id}/verified_followers` || href === `/${id}/followers`) {
      const m = a.innerText.match(/[\d.,]+\s*(K|M|B|千|万|萬|亿|億)?/i);
      if (m) { text = m[0]; break; }
    }
  }
  const nameEl = document.querySelector('[data-testid="UserName"] span');
  const notFound = !text && !!document.querySelector('[data-testid="emptyState"]');
  sendResponse({ text, name: nameEl ? nameEl.innerText : '', notFound });
});
