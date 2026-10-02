import { test } from "node:test";
import assert from "node:assert/strict";
import { isId, makeTokenChecker, makeRateLimiter, MAX_ID_LEN } from "../relay/validate.mjs";

test("isId: accepts real ids, rejects junk", () => {
  assert.equal(isId("node-a1b2c3"), true);
  assert.equal(isId("conv1kx9:node-77"), true); // channel form
  assert.equal(isId("with space ok"), true); // names may contain spaces
  assert.equal(isId(""), false);
  assert.equal(isId(123), false);
  assert.equal(isId(null), false);
  assert.equal(isId("x".repeat(MAX_ID_LEN + 1)), false);
  assert.equal(isId("evil\x00null"), false);
  assert.equal(isId("line\nbreak"), false);
});

test("tokenChecker: constant-time equality semantics", () => {
  const check = makeTokenChecker("s3cret-token");
  assert.equal(check("s3cret-token"), true);
  assert.equal(check("s3cret-tokeN"), false);
  assert.equal(check("s3cret"), false); // different length
  assert.equal(check(""), false);
  assert.equal(check(undefined), false);
});

test("rateLimiter: trips over the cap, resets after the window", () => {
  let clock = 0;
  const limited = makeRateLimiter(5, 1000, () => clock);
  for (let i = 0; i < 5; i++) assert.equal(limited(), false, `msg ${i + 1} allowed`);
  assert.equal(limited(), true, "6th message trips");
  clock += 1001; // window rolls over
  assert.equal(limited(), false, "fresh window allows again");
});
