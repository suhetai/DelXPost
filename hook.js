// 运行在页面自身环境（MAIN world），在 X 页面脚本之前注入。
// 截取 X 网页自己请求的 UserByScreenName 接口返回数据（含精确粉丝数），转发给插件。
(() => {
  if (window.__xtcHooked) return;
  window.__xtcHooked = true;

  const MATCH = 'UserByScreenName';

  function post(url, data) {
    try {
      window.postMessage({ __xtc: 'userData', url: String(url), data }, '*');
    } catch (_) { /* ignore */ }
  }

  // fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (url && url.includes(MATCH)) {
        res.clone().json().then((d) => post(url, d)).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    return res;
  };

  // XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xtcUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__xtcUrl && this.__xtcUrl.includes(MATCH)) {
      this.addEventListener('load', () => {
        try {
          const d = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          post(this.__xtcUrl, d);
        } catch (_) { /* ignore */ }
      });
    }
    return origSend.apply(this, args);
  };
})();
