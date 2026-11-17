-- unified.nvim renders read-only after snapshots; Herdr owns comment UI.
local M, state = {}, { seq = 0, pending = {}, outgoing = {}, buffers = {}, links = {} }
vim.g.mapleader = " "
vim.opt.swapfile = false
vim.opt.backup = false
vim.opt.writebackup = false
vim.opt.modeline = false
vim.opt.termguicolors = true
vim.opt.mouse = "a"
vim.opt.hidden = true
vim.cmd("filetype plugin indent on")
vim.cmd("syntax enable")

-- Herdr installs its plugin in a versioned app bundle, not in the user's
-- lazy.nvim tree. Load that installed plugin rather than copying its UI.
local data = vim.env.XDG_DATA_HOME or (vim.env.HOME .. "/.local/share")
vim.opt.runtimepath:prepend(data .. "/herdr-gitview/plugins/unified.nvim")
require("unified.config").setup({ auto_refresh = false, file_tree = { enabled = false } })
require("unified.virt_scroll").setup()
local unified = require("unified.diff")
local navigation = require("unified.navigation")
local roots = vim.fn.glob(data .. "/herdr-nvim/app/*/lua/herdr-nvim/init.lua", false, true)
table.sort(roots, function(a, b) return vim.uv.fs_stat(a).mtime.sec > vim.uv.fs_stat(b).mtime.sec end)
assert(roots[1], "herdr-nvim's installed comment plugin was not found")
vim.opt.runtimepath:prepend(vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(roots[1]))))
local hn = require("herdr-nvim")
local comments = require("herdr-nvim.comments")
local ui = require("herdr-nvim.ui")
hn.setup({ keymaps = false })
local raw = { add = comments.add, edit = comments.edit, delete = comments.delete, list = comments.list, get = comments.get }
local comment_list = ui.comment_list
ui.comment_list = function(handlers)
  comment_list(handlers)
  if vim.api.nvim_win_get_config(0).relative ~= "" then
    vim.wo.foldenable, vim.wo.foldmethod = false, "manual"
  end
end
local input = vim.ui.input
vim.ui.input = function(opts, callback)
  state.input_active = true
  input(opts, function(value)
    state.input_active = false
    callback(value)
    if state.deferred then
      local file = state.deferred
      state.deferred = nil
      vim.schedule(function() M.open(file) end)
    end
  end)
end

-- Keep Herdr's callout/rail styling, but fit long comments in the diff pane.
local callout = ui._callout
ui._callout = function(text)
  local width = vim.o.columns
  for _, win in ipairs(state.win and { state.win } or {}) do
    if vim.api.nvim_win_is_valid(win) then
      width = math.min(width, vim.api.nvim_win_get_width(win) - vim.fn.getwininfo(win)[1].textoff)
    end
  end
  width = math.max(8, width - vim.fn.strdisplaywidth("╭─ 💬 ") - 1)
  local out, line, used = {}, "", 0
  for _, char in ipairs(vim.fn.split(text, "\\zs")) do
    local size = vim.fn.strdisplaywidth(char)
    if used + size > width or char == "\n" then
      out[#out + 1] = callout(line)[1]
      line, used = "", 0
    end
    if char ~= "\n" then line, used = line .. char, used + size end
  end
  out[#out + 1] = callout(line)[1]
  return out
end

local function deliver()
  if state.inflight or not state.outgoing[1] then return end
  local seq = state.outgoing[1]
  state.inflight, state.sent_version, state.delivered = seq, state.version, false
  local command = "gitview.review-event:" .. state.snapshot.session .. ":" .. seq
  vim.system({ "herdr-app", "do", command }, { text = true }, function(r)
    vim.schedule(function()
      if state.inflight ~= seq then return end
      if r.code ~= 0 then
        state.inflight = nil
        vim.notify("Could not sync the diff comment; r retries: " .. (r.stderr or r.stdout), vim.log.levels.ERROR)
      else
        state.delivered = true
        if state.version > state.sent_version then state.inflight = nil; deliver() end
      end
    end)
  end)
end

local function emit(op, payload, snapshot)
  snapshot = snapshot or state.snapshot
  state.seq = state.seq + 1
  local seq = state.seq
  local event = vim.tbl_extend("force", payload or {}, { op = op, session = snapshot.session, view = snapshot.view })
  vim.fn.writefile({ vim.json.encode(event) }, state.file .. ".event-" .. seq)
  if op == "note" or op == "delete" then state.pending[seq] = true end
  state.outgoing[#state.outgoing + 1] = seq
  deliver()
end

local function note(id)
  local c = raw.get(id)
  local meta = c and state.buffers[c.bufnr]
  if not meta then return nil end
  return {
    id = state.links[id], side = meta.side, start = c.start_line, ["end"] = c.end_line,
    cols = c.cols, text = c.text,
    snippet = table.concat(vim.tbl_map(function(line) return (meta.side == "old" and "-" or "+") .. line end,
      comments.snippet(id) or {}), "\n") .. "\n",
  }, meta.snapshot
end

local function sync_note(id)
  if state.hydrating then return end
  local n, snapshot = note(id)
  if n then emit("note", { note = n }, snapshot) end
end

-- Match the receiver's JavaScript String.trim(), including Unicode spaces.
local comment_whitespace = vim.fn.list2str({
  9, 10, 11, 12, 13, 32, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
})
local function blank_comment(text)
  if vim.fn.trim(text, comment_whitespace) ~= "" then return false end
  vim.notify("Comment cannot be blank", vim.log.levels.WARN)
  return true
end

comments.add = function(buf, span, text)
  if blank_comment(text) then return nil end
  local meta = state.buffers[buf]
  if not meta or meta.empty then
    vim.notify("Comments attach to code in the after snapshot; deleted lines are display-only", vim.log.levels.WARN)
    return nil
  end
  local id = raw.add(buf, span, text)
  state.links[id] = state.snapshot.session .. "-comment-" .. id
  sync_note(id)
  return id
end
comments.edit = function(id, text)
  if blank_comment(text) then return false end
  local ok = raw.edit(id, text)
  if ok then sync_note(id) end
  return ok
end
comments.delete = function(id)
  local c = raw.get(id)
  local meta = c and state.buffers[c.bufnr]
  if not state.hydrating and meta then emit("delete", { id = state.links[id] }, meta.snapshot) end
  state.links[id] = nil
  return raw.delete(id)
end
local function source_comment(c)
  local meta = c and state.buffers[c.bufnr]
  if meta then
    c.file = meta.snapshot.view.root .. "/" .. meta.snapshot.view.path
    c.side = meta.side
  end
  return c
end
comments.get = function(id) return source_comment(raw.get(id)) end
comments.list = function()
  local list = raw.list()
  for _, c in ipairs(list) do source_comment(c) end
  return list
end
-- Sending stays in gitview's existing confirmation/agent picker and includes
-- comments on other files, not just those currently loaded in these windows.
hn.send_all = function() emit("send") end

local function blend(a, b, amount)
  local out = "#"
  for i = 2, 6, 2 do
    local x, y = tonumber(a:sub(i, i + 1), 16), tonumber(b:sub(i, i + 1), 16)
    out = out .. ("%02x"):format(math.floor(x * (1 - amount) + y * amount))
  end
  return out
end

local function colors(t)
  for name, style in pairs({
    Normal = { fg = t.foreground, bg = t.background }, NormalNC = { fg = t.foreground, bg = t.background },
    LineNr = { fg = t.dim }, CursorLineNr = { fg = t.accent }, CursorLine = { bg = t.raised },
    SignColumn = { bg = t.background }, WinSeparator = { fg = t.border, bg = t.background },
    WinBar = { fg = t.foreground, bg = t.surface }, WinBarNC = { fg = t.muted, bg = t.surface },
    StatusLine = { fg = t.muted, bg = t.surface }, StatusLineNC = { fg = t.dim, bg = t.surface },
    DiffAdd = { bg = blend(t.background, t.ansi2, 0.16) },
    DiffDelete = { fg = t.ansi1, bg = blend(t.background, t.ansi1, 0.16) },
    DiffChange = { bg = blend(t.background, t.ansi1, 0.12) },
    DiffText = { bg = blend(t.background, t.ansi1, 0.34) },
    DiffTextAdd = { bg = blend(t.background, t.ansi2, 0.34) },
    Comment = { fg = t.dim }, String = { fg = t.ansi2 }, Statement = { fg = t.ansi5 },
    Function = { fg = t.ansi4 }, Identifier = { fg = t.ansi1 }, Type = { fg = t.ansi3 },
    Folded = { fg = t.dim, bg = t.surface },
  }) do vim.api.nvim_set_hl(0, name, style) end
end

local function setup_buffer(buf)
  local function map(mode, key, fn) vim.keymap.set(mode, key, fn, { buffer = buf, silent = true }) end
  map("n", "<leader>ac", hn.comment_line)
  map("x", "<leader>ac", hn.comment_selection)
  map("n", "<leader>al", hn.list_comments)
  map("n", "<leader>as", hn.send_all)
  map("n", "<leader>aS", hn.send_all)
  map("n", "a", hn.comment_line)
  map("x", "a", hn.comment_selection)
  map("n", "J", function() emit("next") end)
  map("n", "K", function() emit("prev") end)
  map("n", "p", hn.send_all)
  map("n", "r", function()
    if state.outgoing[1] and not state.inflight then deliver() else emit("reload") end
  end)
  map("n", "q", function() emit("files") end)
  map("n", "]c", navigation.next_hunk)
  map("n", "[c", navigation.previous_hunk)
  map("n", "]h", navigation.next_hunk)
  map("n", "[h", navigation.previous_hunk)
  for key, direction in pairs({ h = "left", j = "down", k = "up", l = "right" }) do
    map("n", "<C-" .. key .. ">", function()
      local before = vim.api.nvim_get_current_win()
      vim.cmd.wincmd(key)
      if before == vim.api.nvim_get_current_win() then emit("pane-go", { direction = direction }) end
    end)
  end
end

local function lines(text)
  if text == "" then return { "" } end
  local out = vim.split(text, "\n", { plain = true })
  if out[#out] == "" then table.remove(out) end
  return out
end

function M.fold(line)
  for _, range in ipairs(state.ranges or {}) do
    if line >= range[1] and line <= range[2] then return 0 end
  end
  return 1
end

function M.open(file)
  state.file = file
  local snapshot = vim.json.decode(table.concat(vim.fn.readfile(file), "\n"), { luanil = { object = true } })
  state.seq = math.max(state.seq, snapshot.ack)
  state.version = snapshot.version
  for seq in pairs(state.pending) do if seq <= snapshot.ack then state.pending[seq] = nil end end
  while state.outgoing[1] and state.outgoing[1] <= snapshot.ack do table.remove(state.outgoing, 1) end
  if state.inflight and (state.inflight <= snapshot.ack or state.delivered and snapshot.version > state.sent_version) then
    state.inflight = nil
  end
  deliver()
  if next(state.pending) then return true end -- Don't replace local comments with an older reply.
  -- Existing Herdr input/list popups keep their state until closed.
  if state.snapshot and (state.input_active or vim.api.nvim_win_get_config(0).relative ~= "") then
    state.deferred = file
    return true
  end
  local previous = state.snapshot
  local same = previous and previous.identity == snapshot.identity
  local old_cursor = same and vim.api.nvim_win_get_cursor(0) or nil
  state.hydrating = true
  for _, c in ipairs(raw.list()) do hn.delete_comment(c) end
  state.hydrating = false
  state.snapshot = snapshot
  colors(snapshot.palette)
  if not state.win or not vim.api.nvim_win_is_valid(state.win) then
    vim.cmd("silent! only")
    state.win = vim.api.nvim_get_current_win()
    state.buf = vim.api.nvim_create_buf(false, true)
    setup_buffer(state.buf)
  end
  local buf = state.buf
  local before, after = snapshot.sides[1], snapshot.sides[2]
  local deleted = snapshot.view and snapshot.view.kind == "deleted"
  state.buffers[buf] = { side = "new", snapshot = snapshot, empty = after.text == "" }
  vim.api.nvim_win_set_buf(state.win, buf)
  vim.api.nvim_set_current_win(state.win)
  vim.wo.diff = false
  vim.bo[buf].readonly, vim.bo[buf].modifiable = false, true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines(after.message or after.text))
  vim.bo[buf].modifiable, vim.bo[buf].readonly, vim.bo[buf].modified = false, true, false
  vim.bo[buf].filetype = snapshot.view and (vim.filetype.match({ filename = snapshot.view.path }) or "") or ""
  local patch = vim.text.diff(before.text, after.text, { result_type = "unified", ctxlen = 3 })
  local hunks = unified.parse_diff(patch)
  state.ranges = {}
  for _, hunk in ipairs(hunks) do
    state.ranges[#state.ranges + 1] = { math.max(1, hunk.new_start), math.max(1, hunk.new_start + hunk.new_count - 1) }
  end
  if deleted then
    unified.display_deleted_file(buf, before.text:gsub("\n$", ""))
    state.ranges = { { 1, vim.api.nvim_buf_line_count(buf) } }
    require("unified.hunk_store").set(buf, { 1 })
  else
    unified.display_inline_diff(buf, hunks)
    local count = vim.api.nvim_buf_line_count(buf)
    local starts = require("unified.hunk_store").get(buf)
    for i, line in ipairs(starts) do starts[i] = math.max(1, math.min(count, line)) end
    require("unified.hunk_store").set(buf, starts)
  end
  vim.wo.number, vim.wo.relativenumber = true, false
  vim.wo.signcolumn, vim.wo.foldcolumn = "yes:2", "1"
  vim.wo.wrap, vim.wo.cursorline = false, true
  vim.wo.foldmethod, vim.wo.foldexpr, vim.wo.foldlevel = "expr", "v:lua.GitviewReview.fold(v:lnum)", 0
  local title = snapshot.view and snapshot.view.path .. " · " .. snapshot.view.scope or "No file selected"
  vim.wo.winbar = (" " .. title .. " · unified.nvim · read-only"):gsub("%%", "%%%%")
  for _, n in ipairs(snapshot.notes) do
    local limit = vim.api.nvim_buf_line_count(buf)
    if n.side ~= "old" and not deleted and n.start <= limit then
      local last, cols = math.min(n["end"], limit), n.cols
      if cols and (n["end"] > limit or
        cols[1] > #vim.api.nvim_buf_get_lines(buf, n.start - 1, n.start, false)[1] or
        cols[2] > #vim.api.nvim_buf_get_lines(buf, last - 1, last, false)[1]) then
        cols = nil -- The snapshot changed: keep the comment without an invalid byte span.
      end
      local id = raw.add(buf, { start_line = n.start, end_line = last, cols = cols }, n.text)
      state.links[id] = n.id
      ui.decorate(id)
      state.ranges[#state.ranges + 1] = { math.max(1, n.start - 1), n["end"] + 1 }
    end
  end
  local line = old_cursor and old_cursor[1] or snapshot.view and snapshot.view.line
  if not line then line = require("unified.hunk_store").get(buf)[1] or 1 end
  local count = vim.api.nvim_buf_line_count(buf)
  vim.api.nvim_win_set_cursor(state.win, { math.max(1, math.min(count, line)), old_cursor and old_cursor[2] or 0 })
  vim.cmd("normal! zx")
  vim.cmd("normal! zv")
  vim.o.statusline = " unified.nvim · ]c/[c hunk · Space ac comment · Space al comments · J/K file · p send · q files %=%l/%L "
  return true
end

vim.api.nvim_create_autocmd("WinClosed", {
  group = vim.api.nvim_create_augroup("GitviewReview", { clear = true }),
  callback = function()
    if state.deferred then
      local file = state.deferred
      state.deferred = nil
      vim.schedule(function() M.open(file) end)
    end
  end,
})
vim.api.nvim_create_autocmd("VimResized", {
  group = "GitviewReview",
  callback = function()
    if state.file then M.open(state.file) end
  end,
})
return M
