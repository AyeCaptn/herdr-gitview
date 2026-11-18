import test from "node:test";
import assert from "node:assert/strict";
import { siblingSizes } from "../mods/gitview/pane-state.mjs";

test("captures both sides of the 65-percent slot before Neovim splits it", () => {
  assert.deepEqual(siblingSizes({ children: [
    { id: "agent", size: { weight: 1 } }, { id: "placeholder", size: { weight: 65 / 35 } },
  ] }, "placeholder"), [{ id: "agent", weight: 1 }, { id: "placeholder", weight: 65 / 35 }]);
});

test("nested review restores its siblings without resizing unrelated rows", () => {
  assert.deepEqual(siblingSizes({ children: [
    { id: "unrelated", size: { weight: 4 } },
    { children: [{ id: "agent" }, { id: "placeholder", size: { px: 800 } }] },
  ] }, "placeholder"), [{ id: "agent", weight: 1 }, { id: "placeholder", px: 800 }]);
});

test("a vanished placeholder cannot produce a resize plan", () => {
  assert.equal(siblingSizes({ children: [{ id: "agent" }] }, "placeholder"), null);
});

test("a unary sibling wrapper can collapse without invalidating the resize target", () => {
  assert.deepEqual(siblingSizes({ children: [
    { id: "old-root", size: { weight: 1 }, children: [{ id: "agent", size: { weight: 9 } }] },
    { id: "placeholder", size: { weight: 65 / 35 } },
  ] }, "placeholder"), [{ id: "agent", weight: 1 }, { id: "placeholder", weight: 65 / 35 }]);
});
