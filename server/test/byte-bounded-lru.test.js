const assert = require("node:assert/strict");
const test = require("node:test");

const { ByteBoundedLru } = require("../dist/byte-bounded-lru");

test("evicts least-recently-used values to stay within its byte budget", () => {
  const cache = new ByteBoundedLru(10, (value) => value.length);
  cache.set("a", "1234");
  cache.set("b", "5678");
  assert.equal(cache.get("a"), "1234");

  cache.set("c", "9012");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "1234");
  assert.equal(cache.get("c"), "9012");
  assert.equal(cache.bytes, 8);
});

test("does not retain one value larger than the complete cache budget", () => {
  const cache = new ByteBoundedLru(5, (value) => value.length);
  cache.set("small", "1234");
  cache.set("large", "123456");

  assert.equal(cache.get("large"), undefined);
  assert.equal(cache.get("small"), "1234");
  assert.equal(cache.bytes, 4);
});

test("refresh accounts for values mutated in place", () => {
  const cache = new ByteBoundedLru(7, (value) => value.text.length);
  const first = { text: "123" };
  cache.set("first", first);
  cache.set("second", { text: "456" });
  first.text = "12345";
  cache.refresh("first");

  assert.equal(cache.get("second"), undefined);
  assert.equal(cache.get("first"), first);
  assert.equal(cache.bytes, 5);
});
