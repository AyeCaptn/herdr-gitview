// Prefer the selected OpenCode location, then its actual foreground process,
// never a different terminal's inherited shell directory.
export function terminalDirectory(terminal, fallback = null) {
  const foreground = terminal?.foreground;
  const labels = terminal?.labels ?? {};
  if (foreground?.name?.split("/").pop() === "opencode" &&
      String(foreground.pid) === labels["gitview.opencode.pid"] && labels["gitview.opencode.cwd"]) {
    return labels["gitview.opencode.cwd"];
  }
  return foreground?.cwd || terminal?.cwd || fallback;
}

export function repoContext({ focus, space, panes, terminals, source, keep, reviews = [] }) {
  const tab = focus?.tab ?? space?.tabs?.find(t => t.active)?.id ?? null;
  const candidates = panes.filter(p => p.tab === tab && p.terminal && !reviews.includes(p.terminal) &&
    !terminals.find(t => t.address === p.terminal)?.labels?.["herdr-nvim.sidebar"]);
  const focused = candidates.find(p => p.pane === focus?.pane || p.terminal === focus?.terminal);
  const requested = source?.tab === tab && source.token !== keep?.sourceToken
    ? candidates.find(p => p.terminal === source.terminal) : null;
  const previous = keep?.tab === tab ? candidates.find(p => p.terminal === keep.terminal) : null;
  const pane = focused ?? requested ?? previous ?? candidates.find(p =>
    terminals.find(t => t.address === p.terminal)?.foreground?.name === "opencode") ?? candidates[0];
  const terminal = terminals.find(t => t.address === pane?.terminal);
  return {
    cwd: terminalDirectory(terminal, pane?.cwd ?? null),
    space: space?.id ?? focus?.space ?? null,
    tab,
    terminal: pane?.terminal ?? null,
    sourceToken: source?.tab === tab ? source.token : null,
  };
}
