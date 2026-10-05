import assert from "node:assert/strict";
import test from "node:test";
import { decodeFile } from "../src/decode.js";

const PIXELS = Uint8ClampedArray.of(127, 64, 31, 255);

function taggedFile(transfer) {
  const bytes = Uint8Array.of(
    0, 0, 0, 19, 99, 111, 108, 114, 110, 99, 108, 120,
    0, 9, 0, transfer, 0, 9, 128
  );
  const file = new Blob([bytes], { type: "image/avif" });
  const slice = file.slice.bind(file);
  let reads = 0;
  file.slice = (...args) => {
    reads++;
    return slice(...args);
  };
  return { file, reads: () => reads };
}

function mockBrowser(t, decoder) {
  for (const key of ["window", "document", "createImageBitmap"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  globalThis.window = decoder ? { ImageDecoder: decoder } : {};
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: PIXELS.slice() })
      })
    })
  };
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
}

function imageDecoder({ supported = true, fail = false, transfer = "pq" } = {}) {
  return class {
    static async isTypeSupported() { return supported; }
    completed = Promise.resolve();
    async decode() {
      if (fail) throw new Error("Codec unavailable");
      return {
        image: {
          format: "I444P10",
          visibleRect: { width: 1, height: 1 },
          colorSpace: { primaries: "bt2020", transfer, matrix: "bt2020-ncl", fullRange: true },
          allocationSize: () => 6,
          async copyTo(buffer) {
            new Uint16Array(buffer.buffer).set([100, 200, 300]);
            return [{ offset: 0, stride: 2 }, { offset: 2, stride: 2 }, { offset: 4, stride: 2 }];
          },
          close() {}
        }
      };
    }
    close() {}
  };
}

for (const [cicp, transfer] of [[16, "pq"], [18, "hlg"], [13, "iec61966-2-1"]]) {
  test(`canvas fallback preserves original ${transfer} tags without changing SDR pixels`, async (t) => {
    mockBrowser(t);
    const fixture = taggedFile(cicp);
    const source = await decodeFile(fixture.file);
    assert.equal(source.displayTransfer, transfer);
    assert.equal(source.colorSpace.transfer, "iec61966-2-1");
    assert.equal(source.accurate, false);
    assert.deepEqual(source.data, PIXELS);
    assert.equal(fixture.reads(), 1);
  });
}

for (const options of [{ supported: false }, { fail: true }]) {
  test(`WebCodecs ${options.fail ? "failure" : "unsupported codec"} keeps native HDR metadata`, async (t) => {
    mockBrowser(t, imageDecoder(options));
    const fixture = taggedFile(16);
    const source = await decodeFile(fixture.file);
    assert.equal(source.displayTransfer, "pq");
    assert.equal(source.colorSpace.transfer, "iec61966-2-1");
    assert.equal(source.decoder, "canvas");
    assert.deepEqual(source.data, PIXELS);
    assert.equal(fixture.reads(), 1);
  });
}

test("WebCodecs still returns untouched planar samples and reads tags once", async (t) => {
  mockBrowser(t, imageDecoder());
  const fixture = taggedFile(16);
  const source = await decodeFile(fixture.file);
  assert.equal(source.displayTransfer, "pq");
  assert.equal(source.colorSpace.transfer, "pq");
  assert.equal(source.accurate, true);
  assert.equal(source.bitDepth, 10);
  assert.deepEqual(source.y.data, Uint16Array.of(100));
  assert.deepEqual(source.u.data, Uint16Array.of(200));
  assert.deepEqual(source.v.data, Uint16Array.of(300));
  assert.equal(fixture.reads(), 1);
});

test("WebCodecs transfer metadata identifies HDR without container tags", async (t) => {
  mockBrowser(t, imageDecoder({ transfer: "hlg" }));
  const source = await decodeFile(new Blob([Uint8Array.of(0)], { type: "image/avif" }));
  assert.equal(source.displayTransfer, "hlg");
  assert.equal(source.colorSpace.transfer, "hlg");
});

test("untagged canvas fallback leaves native HDR status unidentified", async (t) => {
  mockBrowser(t);
  const source = await decodeFile(new Blob([Uint8Array.of(0)], { type: "image/png" }));
  assert.equal(source.displayTransfer, null);
  assert.equal(source.colorSpace.transfer, "iec61966-2-1");
  assert.deepEqual(source.data, PIXELS);
});
