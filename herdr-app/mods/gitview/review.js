// The file list owns the embedded Neovim pane and its read-only snapshots.
import { appHome, exec, focused, panes, readTextFile, run, setShared, shared, terminals, theme, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { appCli, gv, onArgs } from "./engine.js";
import { diffPane } from "./layout.js";
import { liveView, notesKey, notesOf, removeNotes, upsertNote, viewIn } from "./shared.js";

const REGISTRY = "gitview.reviewSessions";
const luaString = (s) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const vimString = (s) => `'${s.replaceAll("'", "''")}'`;

export function fileSides(v) {
  const [before, after] = v.commit ? [`parent:${v.commit}`, `commit:${v.commit}`]
    : v.section === "branch" ? [`base:${v.base.merge_base}`, "worktree"]
    : v.cached ? ["head", "index"] : ["index", "worktree"];
  return [
    { side: before, path: v.orig ?? v.path, empty: ["added", "untracked"].includes(v.kind) },
    { side: after, path: v.path, empty: v.kind === "deleted" },
  ];
}

async function loadSides(v) {
  return Promise.all(fileSides(v).map(async ({ side, path, empty }) => {
    if (empty) return { label: side, text: "" };
    const r = await gv(["file", "--repo", v.root, "--root", "--path", path, "--side", side,
      "--out", `${appHome()}/data/gitview-review/images`, ...onArgs(v.on)]);
    if (r.kind === "text") return { label: side, text: r.text };
    if (r.kind === "missing") return { label: side, text: "" };
    return { label: side, text: "", message: r.kind === "too_big" ? "File exceeds the preview size limit" : "Binary file" };
  }));
}

export class Reviews {
  constructor(owner) {
    this.owner = owner;
    this.sessions = new Map();
    this.starting = new Set();
    this.focusWanted = new Set();
    this.owned = new Set();
  }

  async ready(tab) {
    const s = shared(REGISTRY)?.[tab];
    if (!s?.terminal) return false;
    const result = await exec("nvim", ["--server", s.sock, "--remote-expr",
      "luaeval('GitviewReview ~= nil and GitviewReview.ready() and 1 or 0')"]);
    return result.code === 0 && result.stdout.trim() === "1";
  }

  async waitReady(tab, cx) {
    for (let i = 0; i < 40; i++) {
      if (await this.ready(tab)) return;
      await cx.sleep(250);
    }
    throw new Error("The new Neovim review did not become ready; the original review was kept");
  }

  record(s) {
    const { id, tab, file, sock, terminal, at, ack } = s;
    setShared(REGISTRY, { ...(shared(REGISTRY) ?? {}), [tab]: { id, tab, file, sock, terminal, at, ack } });
  }

  session(tab) {
    let s = this.sessions.get(tab);
    if (!s && shared(REGISTRY)?.[tab]) {
      s = { ...shared(REGISTRY)[tab], requested: null };
      this.sessions.set(tab, s);
    }
    if (s && tab === this.owner.tab()) this.owned.add(tab);
    return s;
  }

  look(cx) {
    const tab = this.owner.tab();
    if (!tab || !this.owner.place.shown()) return;
    const s = this.session(tab);
    if (s) s.ack = Math.max(s.ack ?? 0, shared(REGISTRY)?.[tab]?.ack ?? 0);
    const pane = diffPane(tab);
    if (!s && pane?.mod !== "gitview-diff") return;
    if (s?.terminal) {
      if (terminals().some((t) => t.address === s.terminal && t.state === "live")) s.seen = true;
      else if (s.seen || Date.now() - s.at > 10000) {
        if (!s.closing) {
          s.closing = true;
          this.owner.loads.run(cx, "close-review", async () => this.closeTab(tab), { quiet: true });
        }
        return;
      }
    }
    const v = liveView(viewIn(tab));
    const notes = v ? notesOf(notesKey(v.on, v.root)) : [];
    const key = JSON.stringify([viewIn(tab)?.seq ?? 0, notes, s?.ack ?? 0, theme().background]);
    if (this.starting.has(tab) || s?.requested === key) return;
    if (s) s.requested = key;
    this.starting.add(tab);
    this.owner.loads.latest(cx, `nvim-diff:${tab}`, async (cx) => {
      try { await this.sync(tab, cx); }
      finally { this.starting.delete(tab); }
    }, { quiet: true });
  }

  request(tab, cx, focus = false) {
    const s = this.session(tab);
    if (focus && !s) this.focusWanted.add(tab);
    else this.focusWanted.delete(tab);
    if (s) {
      s.requested = null;
      s.focus = focus;
      if (focus && s.terminal) run("pane.focus", { terminal: s.terminal });
    }
    this.look(cx);
  }

  async sync(tab, cx) {
    let s = this.session(tab);
    const placeholder = panes().find((p) => p.tab === tab && p.mod === "gitview-diff");
    if (!s && !placeholder) return;
    if (!s) {
      if (tab.includes("/")) throw new Error("Embedded diff review currently requires a local tab");
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const dir = `${appHome()}/data/gitview-review`;
      await fs.mkdir(dir, { recursive: true });
      s = { id, tab, file: `${dir}/${id}.json`, sock: `${dir}/${id}.sock`, at: Date.now(), version: 0, ack: 0 };
      this.sessions.set(tab, s);
      this.owned.add(tab);
    }
    if (this.focusWanted.delete(tab)) s.focus = true;
    const latest = await readTextFile(s.file);
    if (s.text === undefined || latest !== s.text) {
      s.text = latest;
      if (s.text) {
        s.snapshot = JSON.parse(s.text);
        s.version = s.snapshot.version;
        s.ack = Math.max(s.ack ?? 0, s.snapshot.ack ?? 0);
      }
    }
    const stored = viewIn(tab);
    const view = liveView(stored);
    const identity = JSON.stringify(view && [view.root, view.on, view.path, view.orig, view.section, view.commit, view.base, view.rev]);
    const sides = s.snapshot?.identity === identity ? s.snapshot.sides : view ? await loadSides(view) : [
      { label: "before", text: "" }, { label: "after", text: "" },
    ];
    // A newer selection will be loaded on the next look, not paired with old contents.
    if ((viewIn(tab)?.seq ?? 0) !== (view?.seq ?? 0) && view) return;
    const allNotes = view ? notesOf(notesKey(view.on, view.root)) : [];
    const notes = allNotes.filter((n) =>
      n.file === view.path && (n.section ?? (n.cached ? "staged" : "changes")) === view.section &&
      (n.commit ?? null) === (view.commit ?? null));
    const snapshot = { session: s.id, tab, view, sides, identity, notes, palette: theme(), ack: s.ack,
      version: (s.version ?? 0) + 1 };
    const requested = JSON.stringify([stored?.seq ?? 0, allNotes, snapshot.ack, snapshot.palette.background]);
    const text = JSON.stringify(snapshot);
    await writeTextFile(s.file, text, s.text ?? null);
    s.text = text;
    s.version = snapshot.version;
    s.snapshot = snapshot;
    if (!s.terminal) {
      const measured = await exec("node", [`${appHome()}/mods/gitview/pane-state.mjs`, tab, placeholder.pane]);
      if (measured.code !== 0) throw new Error(measured.stderr || "Cannot read the review pane's size");
      const sizes = JSON.parse(measured.stdout);
      const script = `${appHome()}/mods/gitview/review.lua`;
      const argv = ["nvim", "-u", "NONE", "-i", "NONE", "-n", "--noplugin", "--listen", s.sock,
        "--cmd", `lua GitviewReview = dofile(${luaString(script)})`,
        "-c", `lua GitviewReview.open(${luaString(s.file)})`];
      const made = await appCli(["do", "pane.split", JSON.stringify({ pane: placeholder.pane, direction: "right", argv })]);
      if (!made?.terminal) throw new Error(made?.error ?? "Neovim diff pane did not open");
      s.terminal = made.terminal;
      this.record(s);
      const closed = await appCli(["do", "pane.close", JSON.stringify({ pane: placeholder.pane })]);
      if (closed?.error || !closed) throw new Error(closed?.error ?? "Cannot replace the temporary diff pane");
      // Splitting halves the slot's weight; closing its old half redistributes
      // that weight to the other panes. Restore the complete sibling allocation.
      for (const size of sizes) {
        const resized = await appCli(["do", "layout.resize", JSON.stringify({ ...size,
          id: size.id === placeholder.pane ? made.pane : size.id,
        })]);
        if (!resized || resized.error) throw new Error(resized?.error ?? "Cannot restore the review width");
      }
      if (!s.focus && focused()?.tab === tab) this.owner.focusList(cx);
    } else {
      const r = await exec("nvim", ["--server", s.sock, "--remote-expr",
        `luaeval('GitviewReview.open(_A)', ${vimString(s.file)})`]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout);
    }
    if (s.focus && focused()?.tab === tab) {
      run("pane.focus", { terminal: s.terminal });
      s.focus = false;
    }
    s.requested = requested;
  }

  async receive(token, cx) {
    const [id, seq] = token.split(":");
    if (!/^[1-9][0-9]*$/.test(seq)) return;
    const descriptor = Object.values(shared(REGISTRY) ?? {}).find((s) => s.id === id);
    const s = [...this.sessions.values()].find((s) => s.id === id) ?? (descriptor && this.session(descriptor.tab));
    if (!s) return;
    s.ack = Math.max(s.ack ?? 0, descriptor?.ack ?? 0);
    if (Number(seq) <= s.ack) return this.sync(s.tab, cx);
    const path = `${s.file}.event-${seq}`;
    const event = JSON.parse(await readTextFile(path));
    await fs.unlink(path);
    if (event.session !== s.id) throw new Error("Invalid review session");
    if (event.op === "note") {
      const { view: v, note: n } = event;
      if (!v?.root || !v.path || !n || typeof n.text !== "string" || !n.text.trim() ||
          !Number.isInteger(n.start) || !Number.isInteger(n.end) || n.start < 1 || n.end < n.start ||
          !["old", "new"].includes(n.side) || typeof n.id !== "string" || typeof n.snippet !== "string") {
        throw new Error("Invalid diff comment");
      }
      upsertNote(notesKey(v.on, v.root), { ...n, file: v.path, section: v.section, commit: v.commit ?? null, cached: Boolean(v.cached) });
    } else if (event.op === "delete") {
      removeNotes(notesKey(event.view.on, event.view.root), [event.id]);
    } else if (this.owner.tab() === s.tab) {
      if (event.op === "next" || event.op === "prev") {
        const list = this.owner.list();
        const row = list?.stepFile(liveView(viewIn(s.tab)), event.op === "next" ? 1 : -1);
        if (row) this.owner.select(row, cx, { open: false, browse: false });
      } else if (event.op === "send") this.owner.send(cx);
      else if (event.op === "reload") { s.snapshot = null; this.owner.refresh(cx); }
      else if (event.op === "files") this.owner.focusList(cx);
      else if (event.op === "pane-go") {
        run("pane.focus", { terminal: s.terminal });
        run("pane.go", { direction: event.direction });
      }
    }
    s.ack = Math.max(s.ack ?? 0, Number(seq));
    s.requested = null;
    this.record(s);
    await this.sync(s.tab, cx);
  }

  async closeTab(tab) {
    const s = this.session(tab);
    if (!s) return;
    const registry = { ...(shared(REGISTRY) ?? {}) };
    delete registry[tab];
    setShared(REGISTRY, registry);
    this.sessions.delete(tab);
    this.owned.delete(tab);
    if (s.terminal) await exec("hc", ["kill", s.terminal]);
    for (const path of [s.file, s.sock]) await fs.unlink(path).catch((e) => { if (e.code !== "ENOENT") throw e; });
  }

  async close() {
    await Promise.all([...this.owned].map((tab) => this.closeTab(tab)));
  }
}
