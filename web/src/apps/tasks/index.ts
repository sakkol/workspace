import { h, mmss, set } from "../../core/dom";
import { api, post, lockApp, errText, ApiError } from "../../core/api";
import { caps, every, go, registerWiper } from "../../core/state";

interface Task { id: string; title: string; notes: string; status: "needsAction" | "completed"; due: string; parent: string; updated: string }
interface List { id: string; title: string }

// In-memory only. Wiped when Google Tasks is locked, expires, or the page is closed.
const S = { lists: [] as List[], listId: "", tasks: [] as Task[], next: null as string | null, showDone: false, loaded: false };
const wipe = () => { Object.assign(S, { lists: [], listId: "", tasks: [], next: null, showDone: false, loaded: false }); };
registerWiper("tasks", wipe);

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dueLabel = (d: string) => new Date(d + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: d.slice(0, 4) === today().slice(0, 4) ? undefined : "numeric" });
const base = (lid: string) => `/tasks/lists/${encodeURIComponent(lid)}/tasks`;

export function mountTasks(root: HTMLElement) {
  const cap = caps.get("tasks")!;
  const canWrite = cap.access === "write";
  const cd = h("span");
  const tick = () => { cd.textContent = mmss(cap.expAt - Date.now()); };
  tick(); every(tick, 1000);

  const pane = h("div", { cls: "pane" });
  const toastEl = h("div", { cls: "toast", role: "status" });
  const toast = (t: string) => { toastEl.textContent = t; setTimeout(() => { if (toastEl.textContent === t) toastEl.textContent = ""; }, 4000); };
  const nav = h("nav", { cls: "nav" });
  let loading = false, error = "", editing = "";

  set(root,
    h("div", { cls: "bar" },
      h("div", {}, h("strong", {}, "✅ Google Tasks "), h("span", { cls: "badge" }, canWrite ? "read & write" : "read only"),
        h("div", { cls: "mut small" }, "Session ends in ", cd)),
      h("div", { cls: "row-r" }, h("button", { onclick: () => go({ n: "launcher" }) }, "Apps"),
        h("button", { cls: "done", onclick: async () => { await lockApp("tasks"); go({ n: "launcher" }); } }, "DONE — lock Tasks"))),
    toastEl,
    h("div", { cls: "mail" }, nav, h("div", { cls: "main" }, pane)));

  const fail = (e: unknown) => { if (!(e instanceof ApiError && e.status === 401)) error = errText(e); };

  async function loadLists() {
    loading = true; error = ""; draw();
    try {
      const r = await api("tasks", "/tasks/lists");
      S.lists = r.lists; S.loaded = true;
      if (!S.lists.some((l) => l.id === S.listId)) S.listId = S.lists[0]?.id ?? "";
    } catch (e) { fail(e); }
    loading = false;
    if (S.listId) await loadTasks(false); else if (caps.has("tasks")) draw();
  }

  async function loadTasks(more: boolean) {
    if (!S.listId) return;
    loading = true; error = ""; draw();
    try {
      const qs = new URLSearchParams();
      if (S.showDone) qs.set("completed", "1");
      if (more && S.next) qs.set("pageToken", S.next);
      const r = await api("tasks", base(S.listId) + (qs.size ? "?" + qs : ""));
      S.tasks = more ? [...S.tasks, ...r.tasks.filter((t: Task) => !S.tasks.some((x) => x.id === t.id))] : r.tasks; S.next = r.nextPageToken;
    } catch (e) { fail(e); }
    loading = false;
    if (caps.has("tasks")) draw();
  }

  const pickList = (id: string) => { S.listId = id; S.tasks = []; S.next = null; editing = ""; void loadTasks(false); };

  async function update(t: Task, patch: Record<string, unknown>, msg: string) {
    error = "";
    try {
      const r = await post("tasks", `${base(S.listId)}/${encodeURIComponent(t.id)}/update`, patch);
      Object.assign(t, r.task);
      if (t.status === "completed" && !S.showDone) S.tasks = S.tasks.filter((x) => x.id !== t.id);
      editing = ""; toast(msg);
    } catch (e) { fail(e); }
    draw();
  }

  function addForm() {
    const title = h("input", { type: "text", placeholder: "Add a task…", maxlength: "500", "aria-label": "New task title", autocomplete: "off" });
    const due = h("input", { type: "date", "aria-label": "Due date (optional)" });
    const add = h("button", { cls: "pri" }, "Add");
    const go_ = async () => {
      const t = (title as HTMLInputElement).value.trim();
      if (!t) return;
      add.disabled = true; error = "";
      try {
        const r = await post("tasks", base(S.listId), { title: t, ...((due as HTMLInputElement).value ? { due: (due as HTMLInputElement).value } : {}) });
        S.tasks = [r.task, ...S.tasks]; toast("Task added");
      } catch (e) { fail(e); }
      draw();
    };
    add.onclick = go_;
    title.onkeydown = (e) => { if ((e as KeyboardEvent).key === "Enter") void go_(); };
    return h("div", { cls: "addrow" }, title, due, add);
  }

  function editForm(t: Task) {
    const title = h("input", { type: "text", value: t.title, maxlength: "500", "aria-label": "Title" });
    const notes = h("textarea", { rows: "4", value: t.notes, "aria-label": "Notes" });
    const due = h("input", { type: "date", value: t.due, "aria-label": "Due date" });
    const save = h("button", { cls: "pri" }, "Save");
    save.onclick = () => { save.disabled = true; void update(t, { title: (title as HTMLInputElement).value, notes: (notes as HTMLTextAreaElement).value, due: (due as HTMLInputElement).value || null }, "Saved"); };
    return h("div", { cls: "tb" }, h("label", { cls: "field" }, h("span", {}, "Title"), title), h("label", { cls: "field" }, h("span", {}, "Notes"), notes),
      h("label", { cls: "field" }, h("span", {}, "Due date (leave empty for none)"), due),
      h("div", { cls: "row-l" }, save, h("button", { onclick: () => { editing = ""; draw(); } }, "Cancel")));
  }

  function row(t: Task, child: boolean) {
    const done = t.status === "completed";
    if (editing === t.id && canWrite) return h("div", { cls: "task" + (child ? " child" : "") }, editForm(t));
    const box = h("input", { type: "checkbox", checked: done, disabled: !canWrite, "aria-label": done ? "Mark as not done" : "Mark as done" });
    box.onchange = () => { (box as HTMLInputElement).disabled = true; void update(t, { status: done ? "needsAction" : "completed" }, done ? "Reopened" : "Done ✓"); };
    return h("div", { cls: "task" + (done ? " done" : "") + (child ? " child" : "") },
      box,
      h("div", { cls: "tb" },
        h("div", { cls: "tt" }, t.title || "(no title)", t.due ? h("span", { cls: "due" + (!done && t.due < today() ? " over" : "") }, "📅 " + dueLabel(t.due)) : null),
        // Notes are untrusted text: plain text node, links are not clickable.
        t.notes ? h("div", { cls: "tn" }, t.notes) : null),
      canWrite ? h("button", { onclick: () => { editing = t.id; draw(); } }, "Edit") : null);
  }

  function draw() {
    if (!caps.has("tasks")) return;
    set(nav, ...S.lists.map((l) => h("button", { cls: "navb" + (l.id === S.listId ? " active" : ""), onclick: () => pickList(l.id) }, l.title || "(untitled)")),
      canWrite ? null : h("div", { cls: "mut small" }, "Read-only session"));
    const ids = new Set(S.tasks.map((t) => t.id));
    const roots = S.tasks.filter((t) => !t.parent || !ids.has(t.parent));
    const rows = roots.flatMap((t) => [row(t, false), ...S.tasks.filter((c) => c.parent === t.id).map((c) => row(c, true))]);
    const cur = S.lists.find((l) => l.id === S.listId);
    set(pane,
      cur ? h("h3", { cls: "folder" }, cur.title) : null,
      canWrite && S.listId ? addForm() : null,
      h("label", { cls: "small" }, h("input", { type: "checkbox", checked: S.showDone, onchange: (e: Event) => { S.showDone = (e.target as HTMLInputElement).checked; S.tasks = []; S.next = null; void loadTasks(false); } }), " Show completed tasks"),
      ...(error ? [h("p", { cls: "err", role: "alert" }, error)] : []),
      ...rows,
      loading ? h("p", { cls: "mut" }, "Loading…") : !rows.length && !error ? h("p", { cls: "mut" }, S.loaded && !S.lists.length ? "You have no task lists." : "No tasks here.") : null,
      S.next && !loading ? h("div", { cls: "row" }, h("button", { onclick: () => void loadTasks(true) }, "Load more")) : null);
  }

  if (S.loaded && S.listId) { draw(); void loadTasks(false); } else void loadLists();
}
