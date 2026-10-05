import assert from "node:assert/strict";
import test from "node:test";
import { getSourceDisplayStatus, watchHdrDisplay } from "../src/display.js";

for (const transfer of ["pq", "hlg"]) {
  for (const available of [false, true]) {
    test(`${transfer} source on an ${available ? "HDR" : "SDR"} display`, () => {
      assert.deepEqual(getSourceDisplayStatus({ displayTransfer: transfer }, available), {
        label: available ? "HDR" : "SDR",
        active: available,
        key: available ? "DISPLAY_HDR" : "DISPLAY_SDR_SCREEN"
      });
    });
  }
}

for (const transfer of ["iec61966-2-1", "bt709"]) {
  test(`${transfer} source stays SDR on an HDR display`, () => {
    assert.deepEqual(getSourceDisplayStatus({ displayTransfer: transfer }, true), {
      label: "SDR",
      active: false,
      key: "DISPLAY_SDR_SOURCE"
    });
  });
}

test("unidentified tagging does not claim HDR or SDR output", () => {
  for (const available of [false, true]) {
    assert.deepEqual(getSourceDisplayStatus({ displayTransfer: null }, available), {
      label: "HDR ?",
      active: false,
      key: "DISPLAY_UNKNOWN"
    });
  }
});

test("native HDR status is independent of SDR conversion samples", () => {
  const source = {
    displayTransfer: "pq",
    colorSpace: { transfer: "iec61966-2-1" },
    accurate: false
  };
  assert.equal(getSourceDisplayStatus(source, true).active, true);
});

function mockDisplay() {
  const query = new EventTarget();
  query.matches = false;
  const target = new EventTarget();
  target.matchMedia = (media) => {
    assert.equal(media, "(dynamic-range: high)");
    return query;
  };
  return { query, target };
}

test("moving SDR -> HDR -> SDR updates without a resize or reload", () => {
  const { query, target } = mockDisplay();
  const changes = [];
  const stop = watchHdrDisplay((available) => changes.push(available), target);
  assert.deepEqual(changes, [false]);
  query.matches = true;
  query.dispatchEvent(new Event("change"));
  query.matches = false;
  query.dispatchEvent(new Event("change"));
  assert.deepEqual(changes, [false, true, false]);
  stop();
});

test("focus, pageshow and resize refresh capability without duplicate updates", () => {
  const { query, target } = mockDisplay();
  const changes = [];
  const stop = watchHdrDisplay((available) => changes.push(available), target);
  for (const event of ["focus", "pageshow", "resize"]) {
    query.matches = !query.matches;
    target.dispatchEvent(new Event(event));
    target.dispatchEvent(new Event(event));
  }
  assert.deepEqual(changes, [false, true, false, true]);
  stop();
});

test("stopping the watcher removes every listener", () => {
  const { query, target } = mockDisplay();
  const changes = [];
  const stop = watchHdrDisplay((available) => changes.push(available), target);
  stop();
  query.matches = true;
  query.dispatchEvent(new Event("change"));
  for (const event of ["focus", "pageshow", "resize"]) target.dispatchEvent(new Event(event));
  assert.deepEqual(changes, [false]);
});
