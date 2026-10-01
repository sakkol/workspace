import { h, mmss, fmtDate, set } from "../../core/dom";
import { api, post, lockApp, errText, ApiError } from "../../core/api";
import { caps, every, go, registerWiper } from "../../core/state";

interface Result { id: string; title: string; edited: string }
interface Block { id: string; type: string; text: string; hasChildren: boolean; checked?: boolean; language?: string }
interface BNode { b: Block; kids: BNode[] | null; open: boolean; busy: boolean }
interface Page { id: string; title: string; props: Array<{ name: string; value: string }>; nodes: BNode[]; next: string | null }

// In-memory only. Wiped when Notion is locked, expires, or the page is closed.
const S = { q: "", results: [] as Result[], next: null as string | null, loaded: false, page: null as Page | null, stack: [] as string[] };
const wipe = () => { Object.assign(S, { q: "", results: [], next: null, loaded: false, page: null, stack: [] }); };
registerWiper("notion", wipe);

const MAX_DEPTH = 3; // nested levels the UI will expand
const node = (b: Block): BNode => ({ b, kids: null, open: false, busy: false });

export function mountNotion(root: HTMLElement) {
  const cap = caps.get("notion")!;
  const canWrite = cap.access === "write";
  const cd = h("span");
  const tick = () => { cd.textContent = mmss(cap.expAt - Date.now()); };
  tick(); every(tick, 1000);

  const pane = h("div", { cls: "pane" });
  const toastEl = h("div", { cls: "toast", role: "status" });
  const toast = (t: string) => { toastEl.textContent = t; setTimeout(() => { if (toastEl.textContent === t) toastEl.textContent = ""; }, 4000); };
  let loading = false, error = "", form: "" | "append" | "create" = "";

  const search = h("input", { type: "search", placeholder: "Search page titles…", "aria-label": "Search Notion", autocomplete: "off", maxlength: "200" });
  search.onkeydown = (e) => { if ((e as KeyboardEvent).key === "Enter") { S.q = (search as HTMLInputElement).value.trim(); S.page = null; S.results = []; S.next = null; void loadResults(false); } };

  set(root,
    h("div", { cls: "bar" },
      h("div", {}, h("strong", {}, "📝 Notion "), h("span", { cls: "badge" }, canWrite ? "read & write" : "read only"),
        h("div", { cls: "mut small" }, "Session ends in ", cd)),
      h("div", { cls: "row-r" }, h("button", { onclick: () => go({ n: "launcher" }) }, "Apps"),
        h("button", { cls: "done", onclick: async () => { await lockApp("notion"); go({ n: "launcher" }); } }, "DONE — lock Notion"))),
    toastEl, search, pane);

  const fail = (e: unknown) => { if (!(e instanceof ApiError && e.status === 401)) error = errText(e); };

  async function loadResults(more: boolean) {
    if (loading) return;
    loading = true; error = ""; draw();
    try {
      const r = await post("notion", "/notion/search", { ...(S.q ? { query: S.q } : {}), ...(more && S.next ? { cursor: S.next } : {}) });
      S.results = more ? [...S.results, ...r.results.filter((x: Result) => !S.results.some((y) => y.id === x.id))] : r.results; S.next = r.next; S.loaded = true;
    } catch (e) { fail(e); }
    loading = false;
    if (caps.has("notion")) draw();
  }

  async function openPage(id: string, push = true) {
    if (push && S.page) S.stack.push(S.page.id);
    form = ""; error = ""; loading = true; S.page = { id, title: "", props: [], nodes: [], next: null }; draw();
    try {
      const r = await api("notion", `/notion/pages/${id}`);
      S.page = { id, title: r.title ?? "", props: r.props ?? [], nodes: r.blocks.map(node), next: r.next };
    } catch (e) { fail(e); S.page = null; }
    loading = false;
    if (caps.has("notion")) draw();
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

  const back = () => { const prev = S.stack.pop(); if (prev) void openPage(prev, false); else { S.page = null; form = ""; draw(); } };

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
    const line = b.type === "code" ? h("pre", {}, b.text) : h("span", {}, prefix + (b.text || (b.type === "divider" ? "" : "")));
    const tools: Array<Node | string> = [];
    if (b.type === "child_page" && b.id) tools.push(h("button", { cls: "linkb", onclick: () => void openPage(b.id) }, "open"));
    else if (b.hasChildren && b.id) {
      tools.push(depth < MAX_DEPTH ? h("button", { cls: "linkb", "aria-expanded": String(n.open), onclick: () => void expand(n) }, n.open ? "▾ hide" : "▸ show") : h("span", { cls: "mut small" }, " (nested deeper)"));
    }
    return h("div", { cls: "nb " + cls }, line, ...tools,
      n.busy ? h("span", { cls: "mut small" }, " loading…") : null,
      n.open && n.kids ? h("div", { cls: "nk" }, ...n.kids.map((_, j) => blockEl(n.kids!, j, depth + 1))) : null);
  }

  function writeForm(pg: Page): HTMLElement {
    const isCreate = form === "create";
    const title = h("input", { type: "text", maxlength: "300", placeholder: "Title of the new page", "aria-label": "New page title", autocomplete: "off" });
    const text = h("textarea", { rows: "8", maxlength: "20000", "aria-label": "Text", placeholder: isCreate ? "Text of the new page (blank line = new paragraph). Optional." : "Text to add at the end of this page (blank line = new paragraph)." });
    const msg = h("p", { cls: "err", role: "alert" });
    const review = h("button", { cls: "pri" }, "Review");
    review.onclick = () => {
      const t = (text as HTMLTextAreaElement).value, ti = (title as HTMLInputElement).value.trim();
      if (isCreate && !ti) { msg.textContent = "Enter a title."; return; }
      if (!isCreate && !t.trim()) { msg.textContent = "Enter some text."; return; }
      msg.textContent = "";
      const send = h("button", { cls: "pri" }, isCreate ? "Create page" : "Add text");
      const st = h("p", { cls: "err", role: "alert" });
      send.onclick = async () => {
        send.disabled = true; st.textContent = "";
        try {
          if (isCreate) { const r = await post("notion", "/notion/pages", { parentId: pg.id, title: ti, text: t }); toast("Page created"); form = ""; await openPage(r.id); }
          else { await post("notion", `/notion/blocks/${pg.id}/append`, { text: t }); toast("Text added"); form = ""; await openPage(pg.id, false); }
        } catch (e) { send.disabled = false; if (!(e instanceof ApiError && e.status === 401)) st.textContent = errText(e); }
      };
      set(wrap, h("h3", {}, "Review"), h("div", { cls: "review" },
        h("div", {}, h("strong", {}, isCreate ? "New page under: " : "Added at the end of: "), pg.title || "(untitled)"),
        isCreate ? h("div", {}, h("strong", {}, "Title: "), ti) : null, h("pre", { cls: "body" }, t)),
        h("p", { cls: "mut small" }, "This cannot be undone from here: there is no edit or delete in this workspace. Remove it in Notion if needed."),
        st, h("div", { cls: "row-l" }, send, h("button", { onclick: () => { form = isCreate ? "create" : "append"; draw(); } }, "← Edit")));
    };
    const wrap = h("div", { cls: "review" }, h("h3", {}, isCreate ? "New page under this page" : "Add text to this page"), isCreate ? title : null, text, msg,
      h("div", { cls: "row-l" }, review, h("button", { onclick: () => { form = ""; draw(); } }, "Cancel")));
    return wrap;
  }

  function draw() {
    if (!caps.has("notion")) return;
    const errEl = error ? h("p", { cls: "err", role: "alert" }, error) : null;
    const pg = S.page;
    if (!pg) {
      set(pane, h("h3", { cls: "folder" }, S.q ? `Results for “${S.q}”` : "Recently edited pages shared with this connection"), errEl,
        ...S.results.map((r) => h("div", { cls: "msg", role: "button", tabindex: "0", onclick: () => { S.stack = []; void openPage(r.id, false); }, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") { S.stack = []; void openPage(r.id, false); } } },
          h("div", { cls: "sub" }, r.title || "(untitled)"), h("div", { cls: "snip" }, r.edited ? "Edited " + fmtDate(r.edited) : ""))),
        loading ? h("p", { cls: "mut" }, "Loading…") : !S.results.length && !error ? h("p", { cls: "mut" }, S.loaded ? "No pages found. Only pages you shared on Notion's approval screen are visible." : "") : null,
        S.next && !loading ? h("div", { cls: "row" }, h("button", { onclick: () => void loadResults(true) }, "Load more")) : null);
      return;
    }
    set(pane,
      h("div", { cls: "row-l wrap" }, h("button", { onclick: back }, "← Back"),
        canWrite && !loading && pg.title !== undefined ? h("button", { onclick: () => { form = "append"; draw(); } }, "＋ Add text") : null,
        canWrite && !loading ? h("button", { onclick: () => { form = "create"; draw(); } }, "＋ New page here") : null),
      form ? writeForm(pg) : null,
      h("h2", {}, pg.title || (loading ? "Loading…" : "(untitled)")),
      pg.props.length ? h("div", { cls: "nprops" }, ...pg.props.map((p) => h("div", {}, h("b", {}, p.name + ": "), p.value))) : null,
      errEl,
      ...pg.nodes.map((_, i) => blockEl(pg.nodes, i, 1)),
      loading ? h("p", { cls: "mut" }, "Loading…") : !pg.nodes.length && !error ? h("p", { cls: "mut" }, "This page has no content.") : null,
      pg.next && !loading ? h("div", { cls: "row" }, h("button", { onclick: () => void moreBlocks() }, "Load more")) : null);
  }

  if (S.page) draw(); else { draw(); if (!S.loaded) void loadResults(false); }
}
