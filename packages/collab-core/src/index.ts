// Transport-neutral core of the collaboration relay: the wire protocol, the
// permission decisions, and the payload validators, with no host API in sight.
// Both the Cloudflare Worker and the Node relay build on this, and
// `tests/collab-core-conformance.test.ts` pins the behaviour they must share.
//
// tsconfig.json narrows `lib` back to ES2022 (the repo base adds DOM) on
// purpose: this code has to compile for a Worker and for plain Node, so
// reaching for a browser global should be a type error, not a runtime crash.

export * from "./comment-validate";
export * from "./protocol";
export * from "./session";
