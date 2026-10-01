import { h, mmss, fmtDate, set } from "../../core/dom";
import { api, post, lockApp, errText, ApiError } from "../../core/api";
import { caps, every, go, registerWiper } from "../../core/state";

interface Result { id: string; title: string; edited: string }
interface Block { id: string; type: string; text: string; hasChildren: boolean; checked?: boolean; language?: string }
interface BNode { b: Block; kids: BNode[] | null; open: boolean; busy: boolean }
interface Page { id: string; title: string; props: Array<{ name: string; value: string }>; nodes: BNode[]; next: string | null; isRow: boolean }
interface Col { name: string; type: string; editable: boolean; options?: string[] }
interface Row { id: string; title: string; edited: string; cells: Array<{ name: string; value: string }> }
interface DS { id: string; title: string; columns: Col[]; rows: Row[]; next: string | null; q: string }
type Where = { t: "page" | "ds"; id: string };

// In-memory only. Wiped when Notion is locked, expires, or the page is closed.
const S = { kind: "pages" as "pages" | "databases", q: "", results: [] as Result[], next: null as string | null, loaded: false, page: null as Page | null, ds: null as DS | null, stack: [] as Where[], pick: null as { title: string; sources: Array<{ id: string; name: string }> } | null };
const wipe = () => { Object.assign(S, { kind: "pages", q: "", results: [], next: null, loaded: false, page: null, ds: null, stack: [], pick: null }); };
registerWiper("notion", wipe);

const MAX_DEPTH = 3; // nested levels the UI will expand
const node = (b: Block): BNode => ({ b, kids: null, open: false, busy: false });
const here = (): Where | null => (S.page ? { t: "page", id: S.page.id } : S.ds ? { t: "ds", id: S.ds.id } : null);

export function mountNotion(root: HTMLElement) {
  const cap = caps.get("notion")!;
  const canWrite = cap.access === "write";
  const cd = h("span");
  const tick = () => { cd.textContent = mmss(cap.expAt - Date.now()); };
  tick(); every(tick, 1000);

  const pane = h("div", { cls: "pane" });
  const toastEl = h("div", { cls: "toast", role: "status" });
  const toast = (t: string) => { toastEl.textContent = t; setTimeout(() => { if (toastEl.textContent === t) toastEl.textContent = ""; }, 4000); };
  let loading = false, error = "";
  let form: "" | "append" | "create" | "newrow" | "editrow" = "";
  let rowCtx: { cols: Col[]; values: Record<string, unknown>; dsId: string } | null = null;
  // What was typed so far, kept so "← Edit" on the review screen does not lose it (memory only).
  let rowDraft: Record<string, unknown> = {};
  let textDraft = { title: "", text: "" };

  const search = h("input", { type: "search", placeholder: "Search…", "aria-label": "Search Notion", autocomplete: "off", maxlength: "200" });
  search.onkeydown = (e) => { if ((e as KeyboardEvent).key === "Enter") { S.q = (search as HTMLInputElement).value.trim(); toList(); void loadResults(false); } };

  set(root,
    h("div", { cls: "bar" },
      h("div", {}, h("strong", {}, "📝 Notion "), h("span", { cls: "badge" }, canWrite ? "read & write" : "read only"),
        h("div", { cls: "mut small" }, "Session ends in ", cd)),
      h("div", { cls: "row-r" }, h("button", { onclick: () => go({ n: "launcher" }) }, "Apps"),
        h("button", { cls: "done", onclick: async () => { await lockApp("notion"); go({ n: "launcher" }); } }, "DONE — lock Notion"))),
    toastEl, search, pane);

  const fail = (e: unknown) => { if (!(e instanceof ApiError && e.status === 401)) error = errText(e); };
  const toList = () => { S.page = null; S.ds = null; S.pick = null; S.results = []; S.next = null; S.loaded = false; form = ""; error = ""; };

  async function loadResults(more: boolean) {
    if (loading) return;
    loading = true; error = ""; draw();
    try {
      const r = await post("notion", "/notion/search", { kind: S.kind, ...(S.q ? { query: S.q } : {}), ...(more && S.next ? { cursor: S.next } : {}) });
      S.results = more ? [...S.results, ...r.results.filter((x: Result) => !S.results.some((y) => y.id === x.id))] : r.results; S.next = r.next; S.loaded = true;
    } catch (e) { fail(e); }
    loading = false;
    if (caps.has("notion")) draw();
  }

  const leave = (push: boolean) => { const cur = here(); if (push && cur) S.stack.push(cur); S.pick = null; form = ""; error = ""; };

  async function openPage(id: string, push = true) {
    leave(push); S.ds = null; loading = true; S.page = { id, title: "", props: [], nodes: [], next: null, isRow: false }; draw();
    try {
      const r = await api("notion", `/notion/pages/${id}`);
      S.page = { id, title: r.title ?? "", props: r.props ?? [], nodes: r.blocks.map(node), next: r.next, isRow: r.isRow === true };
    } catch (e) { fail(e); S.page = null; }
    loading = false;
    if (caps.has("notion")) draw();
  }

  async function openDataSource(id: string, push = true, q = "") {
    leave(push); S.page = null; loading = true; S.ds = { id, title: "", columns: [], rows: [], next: null, q }; draw();
    try {
      const [sch, rows] = await Promise.all([api("notion", `/notion/datasources/${id}`), api("notion", `/notion/datasources/${id}/rows` + (q ? "?q=" + encodeURIComponent(q) : ""))]);
      S.ds = { id, title: sch.title, columns: sch.columns, rows: rows.rows, next: rows.next, q };
    } catch (e) { fail(e); S.ds = null; }
    loading = false;
    if (caps.has("notion")) draw();
  }

  async function moreRows() {
    const d = S.ds; if (!d || !d.next || loading) return;
    loading = true; draw();
    try {
      const r = await api("notion", `/notion/datasources/${d.id}/rows?cursor=${encodeURIComponent(d.next)}` + (d.q ? "&q=" + encodeURIComponent(d.q) : ""));
      d.rows.push(...r.rows.filter((x: Row) => !d.rows.some((y) => y.id === x.id))); d.next = r.next;
    } catch (e) { fail(e); }
    loading = false;
    if (caps.has("notion")) draw();
  }

  // A `child_database` block carries a database id; Notion tables are "data sources" inside it.
  async function openDatabase(dbId: string) {
    error = "";
    try {
      const r = await api("notion", `/notion/databases/${dbId}`);
      if (r.sources.length === 1) return void openDataSource(r.sources[0].id);
      leave(true); S.page = null; S.ds = null; S.pick = { title: r.title, sources: r.sources };
    } catch (e) { fail(e); }
    draw();
  }

  async function moreBlocks() {
    const pg = S.page; if (!pg || !pg.next || loading) return;
    loading = true; draw();
    try {
      const r = await api("notion", `/notion/pages/${pg.id}?cursor=${encodeURIComponent(pg.next)}`);
      pg.nodes.push(...r.blocks.map(node)); pg.next = r.next;
    } catch (e) { fail(e); }
    loading = false;
    if (caps.has("notion")) draw();
  }

  async function expand(n: BNode) {
    if (n.open) { n.open = false; draw(); return; }
    n.open = true;
    if (!n.kids) {
      n.busy = true; draw();
      try { const r = await api("notion", `/notion/blocks/${n.b.id}/children`); n.kids = r.blocks.map(node); }
      catch (e) { fail(e); n.open = false; }
      n.busy = false;
    }
    if (caps.has("notion")) draw();
  }

  const back = () => {
    const prev = S.stack.pop();
    if (!prev) { S.page = null; S.ds = null; S.pick = null; form = ""; draw(); if (!S.loaded) void loadResults(false); return; }
    if (prev.t === "page") void openPage(prev.id, false); else void openDataSource(prev.id, false);
  };

  function blockEl(nodes: BNode[], i: number, depth: number): HTMLElement {
    const n = nodes[i], b = n.b;
    const cls = b.type === "heading_1" ? "h1" : b.type === "heading_2" ? "h2" : b.type === "heading_3" || b.type === "heading_4" ? "h3" : b.type === "quote" || b.type === "callout" ? "q" : b.type === "code" ? "code" : b.text.startsWith("[") && b.type !== "paragraph" ? "ph" : "";
    let prefix = "";
    if (b.type === "bulleted_list_item") prefix = "• ";
    else if (b.type === "numbered_list_item") { let k = 1; for (let j = i - 1; j >= 0 && nodes[j].b.type === "numbered_list_item"; j--) k++; prefix = k + ". "; }
    else if (b.type === "to_do") prefix = b.checked ? "☑ " : "☐ ";
    else if (b.type === "divider") prefix = "──────────";
    else if (b.type === "child_page") prefix = "📄 ";
    else if (b.type === "child_database") prefix = "🗂 ";
    // Text goes in as a text node only. Links and images from Notion are never rendered.
    const line = b.type === "code" ? h("pre", {}, b.text) : h("span", {}, prefix + b.text);
    const tools: Array<Node | string> = [];
    if (b.type === "child_page" && b.id) tools.push(h("button", { cls: "linkb", onclick: () => void openPage(b.id) }, "open"));
    else if (b.type === "child_database" && b.id) tools.push(h("button", { cls: "linkb", onclick: () => void openDatabase(b.id) }, "open database"));
    else if (b.hasChildren && b.id) {
      tools.push(depth < MAX_DEPTH ? h("button", { cls: "linkb", "aria-expanded": String(n.open), onclick: () => void expand(n) }, n.open ? "▾ hide" : "▸ show") : h("span", { cls: "mut small" }, " (nested deeper)"));
    }
    return h("div", { cls: "nb " + cls }, line, ...tools,
      n.busy ? h("span", { cls: "mut small" }, " loading…") : null,
      n.open && n.kids ? h("div", { cls: "nk" }, ...n.kids.map((_, j) => blockEl(n.kids!, j, depth + 1))) : null);
  }

  // ---------- text forms (append / new page) ----------
  function textForm(pg: Page): HTMLElement {
    const isCreate = form === "create";
    const title = h("input", { type: "text", maxlength: "300", placeholder: "Title of the new page", "aria-label": "New page title", autocomplete: "off", value: textDraft.title });
    const text = h("textarea", { rows: "8", maxlength: "20000", value: textDraft.text, "aria-label": "Text", placeholder: isCreate ? "Text of the new page (blank line = new paragraph). Optional." : "Text to add at the end of this page (blank line = new paragraph)." });
    const msg = h("p", { cls: "err", role: "alert" });
    const review = h("button", { cls: "pri" }, "Review");
    review.onclick = () => {
      const t = (text as HTMLTextAreaElement).value, ti = (title as HTMLInputElement).value.trim();
      textDraft = { title: ti, text: t };
      if (isCreate && !ti) { msg.textContent = "Enter a title."; return; }
      if (!isCreate && !t.trim()) { msg.textContent = "Enter some text."; return; }
      msg.textContent = "";
      const send = h("button", { cls: "pri" }, isCreate ? "Create page" : "Add text");
      const st = h("p", { cls: "err", role: "alert" });
      send.onclick = async () => {
        send.disabled = true; st.textContent = "";
        try {
          if (isCreate) { const r = await post("notion", "/notion/pages", { parentId: pg.id, title: ti, text: t }); toast("Page created"); form = ""; textDraft = { title: "", text: "" }; await openPage(r.id); }
          else { await post("notion", `/notion/blocks/${pg.id}/append`, { text: t }); toast("Text added"); form = ""; textDraft = { title: "", text: "" }; await openPage(pg.id, false); }
        } catch (e) { send.disabled = false; if (!(e instanceof ApiError && e.status === 401)) st.textContent = errText(e); }
      };
      set(wrap, h("h3", {}, "Review"), h("div", { cls: "review" },
        h("div", {}, h("strong", {}, isCreate ? "New page under: " : "Added at the end of: "), pg.title || "(untitled)"),
        isCreate ? h("div", {}, h("strong", {}, "Title: "), ti) : null, h("pre", { cls: "body" }, t)),
        h("p", { cls: "mut small" }, "There is no delete in this workspace. Remove it in Notion if needed."),
        st, h("div", { cls: "row-l" }, send, h("button", { onclick: () => { form = isCreate ? "create" : "append"; draw(); } }, "← Edit")));
    };
    const wrap = h("div", { cls: "review" }, h("h3", {}, isCreate ? "New page under this page" : "Add text to this page"), isCreate ? title : null, text, msg,
      h("div", { cls: "row-l" }, review, h("button", { onclick: () => { form = ""; textDraft = { title: "", text: "" }; draw(); } }, "Cancel")));
    return wrap;
  }

  // ---------- row form (new row / edit properties) ----------
  const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined || v === "" ? "(empty)" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

  function rowForm(): HTMLElement {
    const ctx = rowCtx!, editing = form === "editrow";
    const cols = ctx.cols.filter((c) => c.editable);
    const getters = new Map<string, () => unknown>();
    const fields = cols.map((c) => {
      const cur = rowDraft[c.name] !== undefined ? rowDraft[c.name] : ctx.values[c.name];
      let input: HTMLElement;
      if (c.type === "checkbox") { input = h("input", { type: "checkbox", checked: cur === true }); getters.set(c.name, () => (input as HTMLInputElement).checked); }
      else if (c.type === "select" || c.type === "status") {
        input = h("select", {}, ...(c.type === "select" ? [h("option", { value: "" }, "(none)")] : []), ...(c.options ?? []).map((o) => h("option", { value: o, ...(cur === o ? { selected: "" } : {}) }, o)));
        getters.set(c.name, () => (input as HTMLSelectElement).value);
      } else if (c.type === "multi_select") {
        const boxes = (c.options ?? []).map((o) => ({ o, el: h("input", { type: "checkbox", checked: Array.isArray(cur) && cur.includes(o) }) }));
        input = h("div", { cls: "sub-choices" }, ...boxes.map((b) => h("label", {}, b.el, " " + b.o)));
        getters.set(c.name, () => boxes.filter((b) => (b.el as HTMLInputElement).checked).map((b) => b.o));
      } else if (c.type === "rich_text") { input = h("textarea", { rows: "3", maxlength: "2000", value: String(cur ?? "") }); getters.set(c.name, () => (input as HTMLTextAreaElement).value); }
      else if (c.type === "date") { input = h("input", { type: "date", value: String(cur ?? "") }); getters.set(c.name, () => (input as HTMLInputElement).value || null); }
      else if (c.type === "number") {
        input = h("input", { type: "text", inputmode: "decimal", value: cur === null || cur === undefined ? "" : String(cur) });
        getters.set(c.name, () => { const t = (input as HTMLInputElement).value.trim(); if (!t) return null; const n = Number(t); if (!Number.isFinite(n)) throw new Error(`“${c.name}” must be a number.`); return n; });
      } else { input = h("input", { type: "text", maxlength: c.type === "title" ? "300" : "2000", value: String(cur ?? "") }); getters.set(c.name, () => { const t = (input as HTMLInputElement).value.trim(); return c.type === "title" ? t : t || null; }); }
      return h("label", { cls: "field" }, h("span", {}, `${c.name} (${c.type.replace("_", " ")})`), input);
    });
    const msg = h("p", { cls: "err", role: "alert" });
    const review = h("button", { cls: "pri" }, "Review");
    review.onclick = () => {
      const changes: Record<string, unknown> = {};
      try {
        for (const c of cols) {
          const v = getters.get(c.name)!();
          const old = ctx.values[c.name];
          const same = JSON.stringify(v) === JSON.stringify(old === undefined ? (c.type === "checkbox" ? false : c.type === "multi_select" ? [] : null) : old) || (v === null && (old === "" || old === undefined));
          if (editing ? !same : v !== null && v !== "" && !(c.type === "checkbox" && v === false) && !(Array.isArray(v) && !v.length)) changes[c.name] = v;
        }
      } catch (e) { msg.textContent = (e as Error).message; return; }
      const titleCol = cols.find((c) => c.type === "title");
      if (!editing && (!titleCol || !changes[titleCol.name])) { msg.textContent = "Enter a title."; return; }
      if (!Object.keys(changes).length) { msg.textContent = "Nothing changed."; return; }
      rowDraft = changes;
      msg.textContent = "";
      const go_ = h("button", { cls: "pri" }, editing ? "Save changes" : "Create row");
      const st = h("p", { cls: "err", role: "alert" });
      go_.onclick = async () => {
        go_.disabled = true; st.textContent = "";
        try {
          if (editing) { await post("notion", `/notion/rows/${S.page!.id}/update`, { values: changes }); toast("Saved"); form = ""; rowDraft = {}; await openPage(S.page!.id, false); }
          else { const r = await post("notion", `/notion/datasources/${ctx.dsId}/rows`, { values: changes }); toast("Row created"); form = ""; rowDraft = {}; await openPage(r.id); }
        } catch (e) { go_.disabled = false; if (!(e instanceof ApiError && e.status === 401)) st.textContent = errText(e); }
      };
      set(wrap, h("h3", {}, "Review"), h("div", { cls: "review" },
        ...Object.entries(changes).map(([k, v]) => h("div", {}, h("strong", {}, k + ": "), editing ? `${show(ctx.values[k])} → ${show(v)}` : show(v)))),
        h("p", { cls: "mut small" }, "There is no undo or delete in this workspace; correct it here or in Notion."),
        st, h("div", { cls: "row-l" }, go_, h("button", { onclick: () => { draw(); } }, "← Edit")));
    };
    const wrap = h("div", { cls: "review" }, h("h3", {}, editing ? "Edit properties" : "New row"), ...fields, msg,
      h("div", { cls: "row-l" }, review, h("button", { onclick: () => { form = ""; rowCtx = null; rowDraft = {}; draw(); } }, "Cancel")),
      ctx.cols.some((c) => !c.editable) ? h("p", { cls: "mut small" }, "Columns of other types (people, relations, formulas, files…) cannot be edited here.") : null);
    return wrap;
  }

  async function startRowForm(kind: "newrow" | "editrow") {
    error = ""; rowDraft = {}; loading = true; draw();
    try {
      if (kind === "editrow") { const r = await api("notion", `/notion/rows/${S.page!.id}`); rowCtx = { cols: r.columns, values: r.values, dsId: r.dataSourceId }; }
      else rowCtx = { cols: S.ds!.columns, values: {}, dsId: S.ds!.id };
      form = kind;
    } catch (e) { fail(e); }
    loading = false;
    if (caps.has("notion")) draw();
  }

  // ---------- views ----------
  function draw() {
    if (!caps.has("notion")) return;
    const errEl = error ? h("p", { cls: "err", role: "alert" }, error) : null;
    const pg = S.page, ds = S.ds;

    if (S.pick) {
      set(pane, h("div", { cls: "row-l wrap" }, h("button", { onclick: back }, "← Back")), h("h2", {}, S.pick.title || "Database"), h("p", { cls: "mut small" }, "This database has several tables. Choose one:"),
        ...S.pick.sources.map((s) => h("div", { cls: "msg", role: "button", tabindex: "0", onclick: () => void openDataSource(s.id, false) }, h("div", { cls: "sub" }, s.name || "(unnamed table)"))), errEl);
      return;
    }

    if (ds) {
      const cols = ds.columns.filter((c) => c.editable);
      const q = h("input", { type: "search", placeholder: "Search rows by title…", "aria-label": "Search rows", value: ds.q, maxlength: "200", autocomplete: "off" });
      q.onkeydown = (e) => { if ((e as KeyboardEvent).key === "Enter") void openDataSource(ds.id, false, (q as HTMLInputElement).value.trim()); };
      set(pane,
        h("div", { cls: "row-l wrap" }, h("button", { onclick: back }, "← Back"), canWrite && !loading && cols.length ? h("button", { onclick: () => void startRowForm("newrow") }, "＋ New row") : null),
        form === "newrow" && rowCtx ? rowForm() : null,
        h("h2", {}, ds.title || (loading ? "Loading…" : "Database")), q, errEl,
        ...ds.rows.map((r) => h("div", { cls: "msg", role: "button", tabindex: "0", onclick: () => void openPage(r.id), onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") void openPage(r.id); } },
          h("div", { cls: "sub" }, r.title || "(untitled)"), h("div", { cls: "snip" }, r.cells.slice(0, 4).map((c) => `${c.name}: ${c.value}`).join(" · ")))),
        loading ? h("p", { cls: "mut" }, "Loading…") : !ds.rows.length && !error ? h("p", { cls: "mut" }, ds.q ? "No rows match." : "This table has no rows.") : null,
        ds.next && !loading ? h("div", { cls: "row" }, h("button", { onclick: () => void moreRows() }, "Load more")) : null);
      return;
    }

    if (pg) {
      set(pane,
        h("div", { cls: "row-l wrap" }, h("button", { onclick: back }, "← Back"),
          canWrite && !loading && pg.isRow ? h("button", { onclick: () => void startRowForm("editrow") }, "✎ Edit properties") : null,
          canWrite && !loading && pg.title !== undefined ? h("button", { onclick: () => { form = "append"; draw(); } }, "＋ Add text") : null,
          canWrite && !loading ? h("button", { onclick: () => { form = "create"; draw(); } }, "＋ New page here") : null),
        form === "append" || form === "create" ? textForm(pg) : null,
        form === "editrow" && rowCtx ? rowForm() : null,
        h("h2", {}, pg.title || (loading ? "Loading…" : "(untitled)")),
        pg.props.length ? h("div", { cls: "nprops" }, ...pg.props.map((p) => h("div", {}, h("b", {}, p.name + ": "), p.value))) : null,
        errEl,
        ...pg.nodes.map((_, i) => blockEl(pg.nodes, i, 1)),
        loading ? h("p", { cls: "mut" }, "Loading…") : !pg.nodes.length && !error ? h("p", { cls: "mut" }, "This page has no content.") : null,
        pg.next && !loading ? h("div", { cls: "row" }, h("button", { onclick: () => void moreBlocks() }, "Load more")) : null);
      return;
    }

    const tab = (k: "pages" | "databases", label: string) => h("button", { cls: "tab" + (S.kind === k ? " active" : ""), role: "tab", "aria-selected": String(S.kind === k), onclick: () => { S.kind = k; toList(); void loadResults(false); } }, label);
    set(pane,
      h("div", { cls: "tabs", role: "tablist" }, tab("pages", "Pages"), tab("databases", "Databases")),
      h("h3", { cls: "folder" }, S.q ? `Results for “${S.q}”` : S.kind === "pages" ? "Recently edited pages shared with this connection" : "Databases shared with this connection"), errEl,
      ...S.results.map((r) => {
        const open = () => { S.stack = []; if (S.kind === "databases") void openDataSource(r.id, false); else void openPage(r.id, false); };
        return h("div", { cls: "msg", role: "button", tabindex: "0", onclick: open, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") open(); } },
          h("div", { cls: "sub" }, (S.kind === "databases" ? "🗂 " : "") + (r.title || "(untitled)")), h("div", { cls: "snip" }, r.edited ? "Edited " + fmtDate(r.edited) : ""));
      }),
      loading ? h("p", { cls: "mut" }, "Loading…") : !S.results.length && !error ? h("p", { cls: "mut" }, S.loaded ? (S.kind === "databases" ? "No databases found. Share the database itself (not only a page inside it) on Notion's approval screen." : "No pages found. Only pages you shared on Notion's approval screen are visible.") : "") : null,
      S.next && !loading ? h("div", { cls: "row" }, h("button", { onclick: () => void loadResults(true) }, "Load more")) : null);
  }

  if (S.page || S.ds || S.pick) draw(); else { draw(); if (!S.loaded) void loadResults(false); }
}
