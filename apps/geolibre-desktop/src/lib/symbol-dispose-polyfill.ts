if (!Symbol.dispose) {
  Object.defineProperty(Symbol, "dispose", {
    configurable: true,
    value: Symbol.for("Symbol.dispose"),
  });
}

if (!Symbol.asyncDispose) {
  Object.defineProperty(Symbol, "asyncDispose", {
    configurable: true,
    value: Symbol.for("Symbol.asyncDispose"),
  });
}
