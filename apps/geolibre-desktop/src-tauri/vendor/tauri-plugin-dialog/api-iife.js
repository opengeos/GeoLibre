if ("__TAURI__" in window) {
  var __TAURI_PLUGIN_DIALOG__ = (function (n) {
    "use strict";
    async function e(n, e = {}, t) {
      return window.__TAURI_INTERNALS__.invoke(n, e, t);
    }
    function t(n) {
      if (void 0 !== n)
        return "string" == typeof n
          ? n
          : "ok" in n && "cancel" in n
            ? { OkCancelCustom: [n.ok, n.cancel] }
            : "yes" in n && "no" in n && "cancel" in n
              ? { YesNoCancelCustom: [n.yes, n.no, n.cancel] }
              : "ok" in n
                ? { OkCustom: n.ok }
                : void 0;
    }
    async function o(n, o) {
      return await e("plugin:dialog|message", {
        message: n,
        title: o?.title,
        kind: o?.kind,
        buttons: t(o?.buttons),
      });
    }
    return (
      "function" == typeof SuppressedError && SuppressedError,
      (n.ask = async function (n, e) {
        const t = "string" == typeof e ? { title: e } : e,
          i = t?.okLabel || t?.cancelLabel,
          a = t?.okLabel ?? "Yes";
        return (
          (await o(n, {
            title: t?.title,
            kind: t?.kind,
            buttons: i ? { ok: a, cancel: t.cancelLabel ?? "No" } : "YesNo",
          })) === a
        );
      }),
      (n.confirm = async function (n, e) {
        const t = "string" == typeof e ? { title: e } : e,
          i = t?.okLabel || t?.cancelLabel,
          a = t?.okLabel ?? "Ok";
        return (
          (await o(n, {
            title: t?.title,
            kind: t?.kind,
            buttons: i ? { ok: a, cancel: t.cancelLabel ?? "Cancel" } : "OkCancel",
          })) === a
        );
      }),
      (n.message = async function (n, e) {
        const t = "string" == typeof e ? { title: e } : e;
        return (t && !t.buttons && t.okLabel && (t.buttons = { ok: t.okLabel }), o(n, t));
      }),
      (n.open = async function (n = {}) {
        return (
          "object" == typeof n && Object.freeze(n), await e("plugin:dialog|open", { options: n })
        );
      }),
      (n.save = async function (n = {}) {
        return (
          "object" == typeof n && Object.freeze(n), await e("plugin:dialog|save", { options: n })
        );
      }),
      n
    );
  })({});
  Object.defineProperty(window.__TAURI__, "dialog", { value: __TAURI_PLUGIN_DIALOG__ });
}
