!(function () {
  "use strict";
  async function n(n, i = {}, o) {
    return window.__TAURI_INTERNALS__.invoke(n, i, o);
  }
  ("function" == typeof SuppressedError && SuppressedError,
    (window.alert = function (i) {
      n("plugin:dialog|message", { message: i.toString() });
    }),
    (window.confirm = async function (i) {
      return await n("plugin:dialog|confirm", { message: i.toString() });
    }));
})();
