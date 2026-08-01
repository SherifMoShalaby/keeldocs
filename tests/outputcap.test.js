import test from "node:test";
import assert from "node:assert/strict";
import { outputCapFor, capRule } from "../src/facts.js";

const MB = 1048576;

// The ratio E8 measured for the only provider that ever exceeded the old
// constant: ts-imports emits 46.9MB from 23.2MB of declared input at 1M LOC.
// Every assertion about "legitimate output fits" is anchored to this number
// rather than to a hopeful one.
const MEASURED_RATIO = 2.02;

test("the floor is the old constant, so nothing that passes today can fail tomorrow", () => {
  assert.equal(outputCapFor(0), 5 * MB, "a provider whose input cannot be sized keeps exactly ADR-002's cap");
  assert.equal(outputCapFor(1), 5 * MB);
  assert.equal(outputCapFor(0.8 * MB), 5 * MB, "6x 0.8MB is under the floor - the floor wins");
});

test("past the floor the cap tracks the input, which is the whole point", () => {
  assert.equal(outputCapFor(5 * MB), 30 * MB);
  assert.equal(outputCapFor(23.24 * MB), 6 * 23.24 * MB);
  assert.ok(outputCapFor(23.24 * MB) / MB > 139 && outputCapFor(23.24 * MB) / MB < 140,
    "the 1M-LOC case: 23.2MB of TypeScript buys ~139MB, and ts-imports needs 46.9MB of it");
});

test("the ceiling exists because memory does, and it is where the wall now is", () => {
  assert.equal(outputCapFor(1024 * MB), 256 * MB);
  // capturing 46.9MB cost ~94MB RSS and parsing it ~50MB more, so ~3x output;
  // 256MB of output is ~750MB of RSS against R10's 2GB budget
  assert.equal(outputCapFor(100 * MB), 256 * MB);
  const knee = (256 / 6) * MB;
  assert.ok(outputCapFor(knee - MB) < 256 * MB && outputCapFor(knee + MB) === 256 * MB,
    "the wall is at ~42.7MB of declared input; if a constant changes, this test is how you find out");
});

test("the cap never shrinks as the input grows", () => {
  let prev = 0;
  for (let mbIn = 0; mbIn <= 80; mbIn += 0.5) {
    const cap = outputCapFor(mbIn * MB);
    assert.ok(cap >= prev, `cap fell between ${mbIn - 0.5}MB and ${mbIn}MB of input`);
    prev = cap;
  }
});

test("output proportional to input is allowed at every size the ratio governs", () => {
  for (const mbIn of [1, 5, 10, 23.24, 42]) {
    assert.ok(outputCapFor(mbIn * MB) >= MEASURED_RATIO * mbIn * MB,
      `a provider behaving like ts-imports (${MEASURED_RATIO}x) would be killed at ${mbIn}MB of input`);
  }
});

test("a runaway is still killed - the mechanism was not weakened, only rescaled", () => {
  for (const mbIn of [0.1, 1, 5, 23.24, 42]) {
    assert.ok(outputCapFor(mbIn * MB) < 100 * mbIn * MB || mbIn < 0.5,
      `a provider emitting 100x its input escapes at ${mbIn}MB`);
  }
  // and beyond the knee the ceiling binds hard, which is the stated residual
  assert.ok(outputCapFor(200 * MB) < MEASURED_RATIO * 200 * MB,
    "past ~42.7MB of input even a well-behaved provider hits the ceiling - this is the known wall, not a surprise");
});

test("the failure message names the rule that actually bound, never a plausible one", () => {
  assert.match(capRule(0), /floor/);
  assert.match(capRule(100), /floor/);
  assert.ok(!/6x/.test(capRule(100)),
    "claiming the ratio when the floor bound would be an explanation that is not true");
  assert.match(capRule(23.24 * MB), /6x its 23\.2MB of declared input/);
  assert.match(capRule(200 * MB), /ceiling/);
  assert.match(capRule(200 * MB), /42\.7MB of input/, "and it says where the wall is");
});
