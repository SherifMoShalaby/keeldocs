import test from "node:test";
import assert from "node:assert/strict";
import { minimalRootPlan, STAGE } from "../src/minroot.js";
import { sandboxState } from "../src/facts.js";

test("the plan masks the host and keeps only what a runtime needs", () => {
  const { masks, keeps } = minimalRootPlan(["/home/nonexistent-keeldocs-probe"]);
  // an allowlist implemented by masking: the system dirs survive, nothing else
  for (const sys of ["/usr", "/etc", "/proc", "/dev", "/lib"]) {
    assert.ok(!masks.includes(sys), `${sys} must stay - an interpreter cannot start without it`);
  }
  if (process.platform === "linux") {
    for (const priv of ["/home", "/root", "/tmp", "/var"]) {
      assert.ok(masks.includes(priv), `${priv} carries user data and must be masked`);
    }
  }
  assert.ok(!masks.includes(STAGE), "the staging mount is handled by the wrapper, not the mask list");
  assert.deepEqual(masks, [...masks].sort(), "deterministic ordering");
  assert.deepEqual(keeps, [...keeps].sort());
  assert.ok(!keeps.includes("/home/nonexistent-keeldocs-probe"),
    "a keep that does not exist is dropped rather than passed to mount");
});

test("keeps never nest, and a path already visible is not re-exposed", () => {
  const { keeps } = minimalRootPlan(["/usr", "/usr/lib"]);
  assert.ok(!keeps.includes("/usr"), "/usr is not masked, so it needs no keep");
  for (const a of keeps) {
    for (const b of keeps) {
      if (a !== b) assert.ok(!a.startsWith(b + "/"), `${a} is already covered by ${b}`);
    }
  }
});

test("the sandbox reports which root it actually got, and why if it degraded", () => {
  const s = sandboxState();
  assert.ok(["minimal", "host"].includes(s.root));
  if (s.root === "host") {
    assert.equal(typeof s.rootReason, "string",
      "a weaker sandbox must SAY so - silent degradation is the failure mode");
    assert.ok(s.rootReason.length > 0);
  } else {
    assert.equal(s.tier, "rofs", "the minimal root rides the rofs tier");
    assert.equal(s.rootReason, undefined);
  }
});
