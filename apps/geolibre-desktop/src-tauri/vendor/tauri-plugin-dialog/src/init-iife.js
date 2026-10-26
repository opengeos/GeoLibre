!(function () {
  "use strict";
  async function n(n, e = {}, i) {
    return window.__TAURI_INTERNALS__.invoke(n, e, i);
  }
  ("function" == typeof SuppressedError && SuppressedError,
    (window.alert = function (e) {
      n("plugin:dialog|message", { message: e.toString() });
    }),
    (window.confirm = async function (e) {
      return (
        "Ok" === (await n("plugin:dialog|message", { message: e.toString(), buttons: "OkCancel" }))
      );
    }));
})();
