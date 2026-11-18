import test from "node:test";
import assert from "node:assert/strict";
import { repoContext, terminalDirectory } from "../mods/gitview/repo-context.js";

const shell = { address: "t1", cwd: "/repos/engie-tsdb", foreground: { pid: 42, name: "opencode", cwd: "/repos/jao-scraper" } };
const pane = { pane: "p1", terminal: "t1", tab: "tab1", cwd: "/repos/engie-tsdb" };
const space = { id: "space1", folder: "/repos/engie-tsdb", tabs: [{ id: "tab1", active: true }] };
const input = { focus: { pane: "p1", terminal: "t1", tab: "tab1" }, space, panes: [pane], terminals: [shell] };

test("foreground directory wins over an inherited shell directory", () => {
  assert.equal(terminalDirectory(shell), "/repos/jao-scraper");
});

test("selected session wins over the OpenCode process directory", () => {
  assert.equal(terminalDirectory({ ...shell, labels: { "gitview.opencode.pid": "42", "gitview.opencode.cwd": "/repos/selected-session" } }), "/repos/selected-session");
});

test("session metadata from a previous OpenCode process is ignored", () => {
  assert.equal(terminalDirectory({ ...shell, labels: { "gitview.opencode.pid": "41", "gitview.opencode.cwd": "/repos/old-session" } }), "/repos/jao-scraper");
});

test("after OpenCode exits the shell's live folder wins", () => {
  assert.equal(terminalDirectory({ ...shell, foreground: { name: "zsh", pid: 42, cwd: "/repos/shell" }, labels: { "gitview.opencode.pid": "42", "gitview.opencode.cwd": "/repos/old-session" } }), "/repos/shell");
});

test("focused working pane determines the repo, not the space folder", () => {
  assert.equal(repoContext(input).cwd, "/repos/jao-scraper");
});

test("prefix source survives the overlay losing pane focus", () => {
  assert.equal(repoContext({ ...input, focus: { tab: "tab1", pane: null, terminal: null }, source: { tab: "tab1", terminal: "t1", token: 1 } }).terminal, "t1");
});

test("review focus preserves the originating terminal", () => {
  const keep = repoContext(input);
  assert.equal(repoContext({ ...input, focus: { tab: "tab1", pane: "review", terminal: "t-review" },
    panes: [...input.panes, { pane: "review", tab: "tab1", terminal: "t-review" }],
    terminals: [...input.terminals, { address: "t-review", cwd: "/wrong" }], reviews: ["t-review"], keep }).cwd, "/repos/jao-scraper");
});

test("switching tabs cannot retain the previous tab's repository", () => {
  const keep = repoContext(input);
  assert.equal(repoContext({ ...input, focus: { tab: "tab2", pane: null }, keep,
    panes: [...input.panes, { pane: "p2", terminal: "t2", tab: "tab2" }],
    terminals: [...input.terminals, { address: "t2", cwd: "/repos/other" }] }).cwd, "/repos/other");
});

test("another tab's prefix source is ignored", () => {
  assert.equal(repoContext({ ...input, source: { tab: "different-tab", terminal: "t2", token: 1 } }).cwd, "/repos/jao-scraper");
});

test("new prefix source overrides the earlier selection in the same tab", () => {
  assert.equal(repoContext({ ...input, focus: { tab: "tab1", pane: null }, keep: { ...repoContext(input), sourceToken: 1 },
    source: { tab: "tab1", terminal: "t2", token: 2 },
    panes: [...input.panes, { pane: "p2", terminal: "t2", tab: "tab1" }],
    terminals: [...input.terminals, { address: "t2", cwd: "/repos/other" }] }).cwd, "/repos/other");
});

test("missing working terminal does not fall back to an unrelated space folder", () => {
  assert.equal(repoContext({ ...input, panes: [], terminals: [] }).cwd, null);
});

test("Neovim's daemon folder cannot replace the originating repo", () => {
  assert.equal(repoContext({ ...input, focus: { tab: "tab1", pane: "nvim", terminal: "tn" },
    panes: [...input.panes, { pane: "nvim", tab: "tab1", terminal: "tn" }],
    terminals: [...input.terminals, { address: "tn", cwd: "/daemon", labels: { "herdr-nvim.sidebar": "tab1" } }],
  }).cwd, "/repos/jao-scraper");
});

test("session changes are observed even while the Changes panel retains focus", () => {
  assert.equal(repoContext({ ...input, focus: { tab: "tab1", pane: null, terminal: null }, keep: repoContext(input),
    terminals: [{ ...shell, labels: { "gitview.opencode.pid": "42", "gitview.opencode.cwd": "/repos/switched" } }],
  }).cwd, "/repos/switched");
});
