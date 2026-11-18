// Where gitview's panes and panel are, from the app's live lists and the
// shown layout (no shared state of gitview's). Shared by the mods (linked;
// install copies it).

import { focused, layout, panes, shared, spaces, terminals } from "herdr";
import { isOwnTab, machineOf } from "./shared.js";
import { repoContext } from "./repo-context.js";

// The tab's diff pane, if it has one.
export function diffPane(tab) {
  const terminal = shared("gitview.reviewSessions")?.[tab]?.terminal;
  return panes().find((p) => p.tab === tab && (p.mod === "gitview-diff" || terminal && p.terminal === terminal)) ?? null;
}

// The diff panes the Changes panel opened, in every tab (not the ones in
// cmd-g's gitview tabs, which belong to their own list).
export function panelDiffPanes() {
  const reviews = new Set(Object.values(shared("gitview.reviewSessions") ?? {}).map((s) => s.terminal));
  return panes().filter((p) => (p.mod === "gitview-diff" || p.terminal && reviews.has(p.terminal)) && !isOwnTab(p.tab));
}

// The panes herdr-nvim shows in the tab: its nvim's (a terminal labelled
// herdr-nvim.sidebar=<tab>), or its preview in nvim's place (a herdr-nvim
// mod pane). Closing them keeps nvim running (its daemon keeps buffers,
// unsaved edits and the cursor; herdr-nvim's RECIPE).
export function herdrNvimPanes(tab) {
  const nvims = new Set(terminals().filter((t) => t.state === "live" && t.labels?.["herdr-nvim.sidebar"] === tab).map((t) => t.address));
  return panes().filter((p) => p.tab === tab && ((p.terminal && nvims.has(p.terminal)) || (!p.terminal && p.mod === "herdr-nvim")));
}

// The layout path to the block whose mod is `name` (not a floating one).
function slotPath(node, name, trail = []) {
  if (!node) return null;
  const here = [...trail, node];
  if (node.content?.mod === name) return here;
  for (const child of node.children ?? []) {
    const found = slotPath(child, name, here);
    if (found) return found;
  }
  return null;
}

// The side panel holding gitview (the layout's `changes` slot), as the tab
// bar's Changes button sees it: {stack, slot, panel, shown}. Null when the
// layout has no gitview block.
export function panelState() {
  const path = slotPath(layout(), "gitview");
  if (!path) return null;
  const at = path.findLastIndex((n) => n.type === "stack");
  const stack = at >= 0 ? path[at] : null;
  const slot = path[path.length - 1];
  const panel = at > 0 ? path[at - 1] : slot;
  const visible = path.every((n) => !n.hidden);
  return {
    stack: stack?.id ?? null,
    slot: slot.id,
    panel: panel.id,
    shown: visible && (!stack || stack.active === slot.id),
  };
}

// Whether a pane copy in that tab is on screen: while its tab shows.
export function onScreen(tab) {
  return Boolean(tab) && focused()?.tab === tab;
}

// The active tab's working terminal, retained while a review or overlay has
// focus. Its selected OpenCode session / foreground cwd beats the shell's
// inherited cwd; never take another tab's folder from the space fallback.
export function location(keep) {
  const f = focused();
  const space = spaces().find((s) => s.active);
  const ctx = repoContext({ focus: f, space, panes: panes(), terminals: terminals(), keep,
    source: shared("gitview.source"),
    reviews: Object.values(shared("gitview.reviewSessions") ?? {}).map(s => s.terminal),
  });
  return { ...ctx, on: machineOf(ctx.terminal) ?? space?.machine ?? null };
}
