import test from "node:test";
import assert from "node:assert/strict";
import {
  DEPLOY_ENVS,
  RUNTIME_ROLES,
  createRuntimeState,
} from "../src/lib/runtime-state.js";

test("createRuntimeState validates deployEnv and locks cloud mode to master", () => {
  assert.deepEqual(DEPLOY_ENVS, ["local", "cloud"]);
  assert.deepEqual(RUNTIME_ROLES, ["master", "host_executor"]);

  const cloud = createRuntimeState({ deployEnv: "cloud" });
  assert.equal(cloud.deployEnv, "cloud");
  assert.equal(cloud.role, "master");
  assert.equal(cloud.isMaster(), true);
  assert.equal(cloud.isHostExecutor(), false);
  assert.throws(
    () => cloud.setRole("host_executor"),
    /cannot switch to host_executor in cloud deployEnv/i
  );
  assert.equal(cloud.canAccessRoute("/api/sessions", "GET").allowed, true);
  assert.equal(cloud.canAccessRoute("/api/providers", "POST").allowed, true);
});

test("local mode toggles between master and host_executor and locks master routes in host_executor", () => {
  const local = createRuntimeState({ deployEnv: "local" });
  assert.equal(local.deployEnv, "local");
  assert.equal(local.role, "master");
  assert.equal(local.canAccessRoute("/api/sessions", "GET").allowed, true);

  const switched = local.setRole("host_executor", {
    cloudOrigin: "https://cloud.twinklebot.test",
  });
  assert.equal(switched.role, "host_executor");
  assert.equal(local.isHostExecutor(), true);
  assert.equal(local.cloudOrigin, "https://cloud.twinklebot.test");

  // Locked master routes return 409
  for (const [pathname, method] of [
    ["/api/sessions", "GET"],
    ["/api/settings", "POST"],
    ["/api/providers", "GET"],
    ["/api/custom-skills", "GET"],
    ["/api/schedules", "POST"],
    ["/api/vault", "GET"],
    ["/api/usage", "GET"],
    ["/api/billing/gcp", "GET"],
    ["/api/computer/provision", "POST"],
    ["/api/computer/update", "POST"],
  ]) {
    const check = local.canAccessRoute(pathname, method);
    assert.equal(check.allowed, false, `expected locked: ${method} ${pathname}`);
    assert.equal(check.status, 409);
  }

  // Host executor + role + diagnostics + static UI remain accessible
  for (const [pathname, method] of [
    ["/api/system/role", "GET"],
    ["/api/system/role", "POST"],
    ["/api/system/diagnostics", "GET"],
    ["/api/computer/host-info", "GET"],
    ["/api/host/execute", "POST"],
    ["/api/host/approvals/call_1", "POST"],
    ["/api/files/meta", "GET"],
    ["/api/workspace/file", "GET"],
    ["/", "GET"],
    ["/dist/app.js", "GET"],
  ]) {
    const check = local.canAccessRoute(pathname, method);
    assert.equal(check.allowed, true, `expected allowed: ${method} ${pathname}`);
  }

  local.setRole("master");
  assert.equal(local.isMaster(), true);
  assert.equal(local.cloudOrigin, "");
  assert.equal(local.canAccessRoute("/api/sessions", "GET").allowed, true);
});
