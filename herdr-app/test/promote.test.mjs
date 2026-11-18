import test from "node:test";
import assert from "node:assert/strict";
import { promoteReview } from "../mods/gitview/promote.js";

const request = { space: "space", sourceTab: "agent-tab", scope: "branch", view: { root: "/repo", path: "selected.py", line: 42, on: null } };

function fixture({ readyError, closeError } = {}) {
  const calls = [];
  const host = {
    command: async (name, args) => { calls.push([name, args]); return { tab: "review-tab" }; },
    prepare: (tab, view) => calls.push(["selection", tab, view]),
    sidebar: async args => calls.push(["sidebar", JSON.parse(args.at(-1))]),
    waitReady: async tab => { calls.push(["ready", tab]); if (readyError) throw readyError; },
    closeSource: async tab => { calls.push(["close-source", tab]); if (closeError) throw closeError; },
    cancel: tab => calls.push(["cancel", tab]),
  };
  return { calls, host };
}

test("moves the selected file and branch scope before closing the original review", async () => {
  const f = fixture();
  await promoteReview(request, f.host);
  assert.deepEqual(f.calls, [
    ["tab.new", { name: "gitview", space: "space", mod: "gitview-diff", props: { space: "space", own: true } }],
    ["selection", "review-tab", request.view],
    ["sidebar", { cwd: "/repo", on: null, space: "space", tab: "review-tab", own: true, scope: "branch" }],
    ["ready", "review-tab"],
    ["close-source", "agent-tab"],
  ]);
});

test("failed destination readiness keeps the original and removes only the newly created tab", async () => {
  const f = fixture({ readyError: new Error("not ready") });
  await promoteReview(request, f.host).catch(() => {});
  assert.deepEqual(f.calls.filter(call => ["close-source", "tab.close", "tab.select", "cancel"].includes(call[0])), [
    ["tab.close", { id: "review-tab", confirmed: true }], ["cancel", "review-tab"], ["tab.select", { id: "agent-tab" }],
  ]);
});

test("a failure closing the source does not destroy the ready destination", async () => {
  const f = fixture({ closeError: new Error("source unavailable") });
  await promoteReview(request, f.host).catch(() => {});
  assert.deepEqual(f.calls.filter(call => call[0] === "tab.close"), []);
});
