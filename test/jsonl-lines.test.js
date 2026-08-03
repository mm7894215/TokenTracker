"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { physicalJsonlRecords } = require("../src/lib/jsonl-lines");

async function collectLines(chunks) {
  const lines = [];
  for await (const record of physicalJsonlRecords(chunks.map((chunk) => Buffer.from(chunk)))) {
    lines.push(record.line);
  }
  return lines;
}

test("physicalJsonlRecords splits LF records", async () => {
  const lines = await collectLines(["first\nsecond\nthird\n"]);

  assert.deepEqual(lines, ["first", "second", "third"]);
});

test("physicalJsonlRecords strips CR from CRLF records, including split CRLF chunks", async () => {
  const lines = await collectLines(["first\r", "\nsecond\r", "\nthird\r\n"]);

  assert.deepEqual(lines, ["first", "second", "third"]);
});

test("physicalJsonlRecords preserves legal U+2028 and U+2029 characters", async () => {
  const first = '{"text":"before\u2028after"}';
  const second = '{"text":"before\u2029after"}';
  const lines = await collectLines([`${first}\n${second}\n`]);

  assert.deepEqual(lines, [first, second]);
});

test("physicalJsonlRecords preserves bare carriage returns", async () => {
  const lines = await collectLines(["first\rsecond\nfinal\r"]);

  assert.deepEqual(lines, ["first\rsecond", "final\r"]);
});

test("physicalJsonlRecords reports exact CRLF and unterminated byte spans", async () => {
  const records = [];
  for await (const record of physicalJsonlRecords([Buffer.from("first\r\nlast")])) {
    records.push(record);
  }

  assert.deepEqual(records, [
    { line: "first", utf8Valid: true, physicalBytes: 7, terminated: true },
    { line: "last", utf8Valid: true, physicalBytes: 4, terminated: false },
  ]);
});

test("physicalJsonlRecords closes its input when the consumer stops early", async () => {
  let returned = false;
  const input = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { value: Buffer.from("first\nsecond\n"), done: false };
        },
        async return() {
          returned = true;
          return { done: true };
        },
      };
    },
  };

  for await (const _record of physicalJsonlRecords(input)) break;

  assert.equal(returned, true);
});

test("physicalJsonlRecords closes an unterminated input as soon as its byte limit is exceeded", async () => {
  let pulled = 0;
  let returned = false;
  const chunks = ["1234", "5678", "9abcdef"].map((chunk) => Buffer.from(chunk));
  const input = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const value = chunks[pulled];
          pulled += 1;
          return value === undefined ? { done: true } : { value, done: false };
        },
        async return() {
          returned = true;
          return { done: true };
        },
      };
    },
  };

  await assert.rejects(
    async () => {
      for await (const _record of physicalJsonlRecords(input, { maxPhysicalBytes: 8 })) {
        assert.fail("an unterminated over-budget record must not be yielded");
      }
    },
    (error) => error?.code === "PHYSICAL_JSONL_LIMIT_EXCEEDED",
  );
  assert.equal(pulled, 3);
  assert.equal(returned, true);
});

test("physicalJsonlRecords reassembles records split across chunks", async () => {
  const lines = await collectLines(['{"id":', "1}", '\n{"id"', ":2}\n"]);

  assert.deepEqual(lines, ['{"id":1}', '{"id":2}']);
});

test("physicalJsonlRecords yields a final unterminated record", async () => {
  const lines = await collectLines(["complete\nunter", "minated"]);

  assert.deepEqual(lines, ["complete", "unterminated"]);
});

test("physicalJsonlRecords preserves empty physical records", async () => {
  const lines = await collectLines(["\n", "\nvalue\n\n"]);

  assert.deepEqual(lines, ["", "", "value", ""]);
});

test("physicalJsonlRecords handles a large record split across many chunks", async () => {
  const record = `{"payload":"${"x".repeat(2 * 1024 * 1024)}"}`;
  const chunks = [];
  for (let offset = 0; offset < record.length; offset += 127) {
    chunks.push(record.slice(offset, offset + 127));
  }
  chunks.push("\n");

  const lines = await collectLines(chunks);

  assert.equal(chunks.length > 10_000, true);
  assert.deepEqual(lines, [record]);
});

test("physicalJsonlRecords counts multibyte UTF-8 exactly", async () => {
  const content = Buffer.from('{"text":"中\u2028文"}\r\n');
  const records = [];
  for await (const record of physicalJsonlRecords([content], {
    maxPhysicalBytes: content.length,
  })) {
    records.push(record);
  }

  assert.deepEqual(records, [{
    line: '{"text":"中\u2028文"}',
    utf8Valid: true,
    physicalBytes: content.length,
    terminated: true,
  }]);
  await assert.rejects(
    async () => {
      for await (const _record of physicalJsonlRecords([content], {
        maxPhysicalBytes: content.length - 1,
      })) {
        assert.fail("an over-budget multibyte record must not be yielded");
      }
    },
    (error) => error?.code === "PHYSICAL_JSONL_LIMIT_EXCEEDED",
  );
});

test("physicalJsonlRecords preserves invalid UTF-8 record spans in record mode", async () => {
  const invalid = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  const input = Buffer.concat([Buffer.from("first\n"), invalid, Buffer.from("\nlast\n")]);
  const records = [];

  for await (const record of physicalJsonlRecords([input], { invalidUtf8: "record" })) {
    records.push(record);
  }

  assert.deepEqual(records, [
    { line: "first", utf8Valid: true, physicalBytes: 6, terminated: true },
    { line: null, utf8Valid: false, physicalBytes: invalid.length + 1, terminated: true },
    { line: "last", utf8Valid: true, physicalBytes: 5, terminated: true },
  ]);
  assert.equal(records.reduce((sum, record) => sum + record.physicalBytes, 0), input.length);
});

test("physicalJsonlRecords rejects invalid UTF-8 by default", async () => {
  const invalid = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]);

  await assert.rejects(async () => {
    for await (const _record of physicalJsonlRecords([invalid])) {
      assert.fail("invalid UTF-8 must not be yielded");
    }
  }, TypeError);
});

test("physicalJsonlRecords propagates errors thrown into a final record yield", async () => {
  const iterator = physicalJsonlRecords([Buffer.from("last")], { invalidUtf8: "record" });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { line: "last", utf8Valid: true, physicalBytes: 4, terminated: false },
  });
  await assert.rejects(iterator.throw(new Error("consumer failed")), /consumer failed/);
});

test("physicalJsonlRecords rejects unsupported UTF-8 policies", async () => {
  await assert.rejects(async () => {
    for await (const _record of physicalJsonlRecords([], { invalidUtf8: "skip" })) {}
  }, TypeError);
});
