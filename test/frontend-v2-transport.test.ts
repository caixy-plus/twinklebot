import test from "node:test";
import assert from "node:assert/strict";
import { readWebDistJs, readWebSourceTs } from "./helpers/react-test-helpers.js";

test("public/app.js routes all /api requests through apiFetch/apiUrl with epoch & auth guard", () => {
  const distJs = readWebDistJs();
  const webSrc = readWebSourceTs();

  // Must define centralized transport helpers in source TS/TSX
  assert.match(webSrc, /function apiUrl\(/);
  assert.match(webSrc, /async function apiFetch\(/);
  assert.match(webSrc, /function connectRealtimeTransport\(/);
  assert.match(webSrc, /accountEpoch/);
  assert.match(webSrc, /host_rpc_request/);
  assert.match(webSrc, /host_rpc_response/);

  // Zero raw unprefixed fetch("/api/ or fetch(`/api/ outside apiFetch in both source and minified bundle
  for (const [label, src] of [
    ["dist bundle", distJs],
    ["src/web TS/TSX", webSrc],
  ] as const) {
    const rawApiFetches = src.match(/\bfetch\(\s*["'`]\/api\//g) || [];
    assert.equal(
      rawApiFetches.length,
      0,
      `unexpected raw fetch calls in ${label}: ${rawApiFetches.join(", ")}`
    );
    assert.equal(
      /\bnew EventSource\(\s*["'`]\/api\/events["'`]\s*\)/.test(src),
      false,
      `unexpected raw EventSource in ${label}`
    );
  }
});
