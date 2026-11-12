import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

const state = { user: null, folders: [], current: null }; // current: 선택한 폴더 id (null = 전체 최상위)

// ---------- 공통 ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}
function kindFromMime(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}
const KIND_LABEL = { note: "글", image: "사진", video: "영상", audio: "음악", link: "링크", file: "파일" };

// ---------- 인증 ----------
let authMode = "signin";
$("auth-form").addEventListener("click", (e) => { if (e.target.dataset.mode) authMode = e.target.dataset.mode; });
$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim(), password = $("password").value;
  $("auth-msg").textContent = "처리 중…";
  const { data, error } = authMode === "signup"
    ? await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } })
    : await sb.auth.signInWithPassword({ email, password });
  if (error) return ($("auth-msg").textContent = error.message);
  if (authMode === "signup" && !data.session) $("auth-msg").textContent = "확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인하세요.";
});
$("signout").onclick = () => sb.auth.signOut();

sb.auth.onAuthStateChange((_event, session) => {
  state.user = session?.user ?? null;
  $("auth").classList.toggle("hidden", !!state.user);
  $("app").classList.toggle("hidden", !state.user);
  if (state.user) { $("user-email").textContent = state.user.email; loadAll(); }
});

// ---------- 폴더 (계층 구조) ----------
async function loadFolders() {
  const { data, error } = await sb.from("folders").select("*").order("name");
  if (error) return alert(error.message);
  state.folders = data;
}
function childrenOf(parentId) { return state.folders.filter((f) => f.parent_id === parentId); }
function pathTo(id) {
  const path = [];
  let f = state.folders.find((x) => x.id === id);
  while (f) { path.unshift(f); f = state.folders.find((x) => x.id === f.parent_id); }
  return path;
}

function renderTree() {
  const tree = $("tree");
  tree.replaceChildren();
  const root = el("div", { className: "node" + (state.current === null ? " active" : ""), textContent: "📥 전체" });
  root.onclick = () => select(null);
  tree.append(root);
  const walk = (parentId, depth) => {
    for (const f of childrenOf(parentId)) {
      const add = el("button", { className: "add", title: "하위 폴더", textContent: "+" });
      add.onclick = (e) => { e.stopPropagation(); createFolder(f.id); };
      const node = el("div", { className: "node" + (state.current === f.id ? " active" : "") }, el("span", { textContent: "📁 " + f.name }), add);
      node.style.paddingLeft = 6 + depth * 14 + "px";
      node.onclick = () => select(f.id);
      tree.append(node);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
}

function renderCrumbs() {
  const c = $("crumbs");
  c.replaceChildren();
  const home = el("a", { textContent: "전체" });
  home.onclick = () => select(null);
  c.append(home);
  for (const f of pathTo(state.current)) {
    const a = el("a", { textContent: f.name });
    a.onclick = () => select(f.id);
    c.append(" / ", a);
  }
}

async function createFolder(parentId = state.current) {
  const name = prompt("폴더 이름");
  if (!name?.trim()) return;
  const { error } = await sb.from("folders").insert({ name: name.trim(), parent_id: parentId });
  if (error) return alert(error.message);
  await loadFolders(); renderTree();
}
$("new-folder").onclick = () => createFolder(state.current);

function select(id) {
  state.current = id;
  $("auto-classify").classList.toggle("hidden", id !== null);
  renderTree(); renderCrumbs(); loadItems();
}

// ---------- AI 자동 분류 ----------
// 사진을 640px JPEG로 줄여서 AI에 보냄 (전송량·비용 절감)
async function makeThumb(src) {
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = url; });
    const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8);
  } catch {
    return null; // 이미지를 못 읽으면 파일명만으로 분류
  } finally {
    if (typeof src !== "string") URL.revokeObjectURL(url);
  }
}

async function classifyItem(item, imageSrc) {
  const image = item.kind === "image" && imageSrc ? await makeThumb(imageSrc) : null;
  const topics = childrenOf(null).map((f) => f.name);
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch("/api/classify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ kind: item.kind, title: item.title, body: item.body, url: item.url, image, topics }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);

  let folder = childrenOf(null).find((f) => f.name === out.topic);
  if (!folder) {
    const { data, error } = await sb.from("folders").insert({ name: out.topic, parent_id: null }).select().single();
    if (error) throw error;
    folder = data;
    state.folders.push(data);
  }
  const { error } = await sb.from("items").update({ folder_id: folder.id }).eq("id", item.id);
  if (error) throw error;
  return out.topic;
}

// pairs: [{ item, imageSrc }] — 하나씩 순서대로 분류
async function classifyMany(pairs) {
  const status = $("ai-status");
  const btn = $("auto-classify");
  btn.disabled = true;
  let done = 0, failed = 0, lastError = "";
  for (const { item, imageSrc } of pairs) {
    status.textContent = `✨ 분류 중… ${done + failed + 1}/${pairs.length}`;
    try { await classifyItem(item, imageSrc); done++; }
    catch (e) { console.error(e); lastError = e.message; failed++; }
    renderTree();
  }
  status.textContent = failed
    ? `${done}개 정리 · ${failed}개 실패 (${lastError})`
    : `✨ ${done}개를 주제별로 정리했어요`;
  setTimeout(() => (status.textContent = ""), failed ? 10000 : 5000);
  btn.disabled = false;
  await loadFolders();
  renderTree();
  loadItems();
}

$("auto-classify").onclick = async () => {
  const { data, error } = await sb.from("items").select("*").is("folder_id", null);
  if (error) return alert(error.message);
  if (!data.length) return alert("'전체'에 정리할 항목이 없어요.");
  const paths = data.filter((i) => i.kind === "image" && i.file_path).map((i) => i.file_path);
  const urls = {};
  if (paths.length) {
    const { data: signed } = await sb.storage.from("uploads").createSignedUrls(paths, 600);
    for (const s of signed ?? []) urls[s.path] = s.signedUrl;
  }
  classifyMany(data.map((item) => ({ item, imageSrc: urls[item.file_path] })));
};

// ---------- 항목 ----------
async function loadItems() {
  let q = sb.from("items").select("*").order("created_at", { ascending: false });
  q = state.current === null ? q.is("folder_id", null) : q.eq("folder_id", state.current);
  const { data, error } = await q;
  if (error) return alert(error.message);

  // 파일은 비공개 저장소라 서명된 임시 URL로 표시
  const paths = data.filter((i) => i.file_path).map((i) => i.file_path);
  const urls = {};
  if (paths.length) {
    const { data: signed } = await sb.storage.from("uploads").createSignedUrls(paths, 3600);
    for (const s of signed ?? []) urls[s.path] = s.signedUrl;
  }
  renderItems(data, urls);
}

function renderItems(items, urls) {
  const grid = $("grid");
  grid.replaceChildren();
  $("empty").classList.toggle("hidden", items.length > 0);
  for (const it of items) {
    const src = it.file_path ? urls[it.file_path] : null;
    let media = null;
    if (it.kind === "image" && src) media = el("img", { src, alt: it.title, loading: "lazy" });
    if (it.kind === "video" && src) media = el("video", { src, controls: true, preload: "metadata" });
    if (it.kind === "audio" && src) media = el("audio", { src, controls: true });

    let titleNode = el("div", { className: "title", textContent: it.title || "(제목 없음)" });
    const href = it.kind === "link" ? it.url : it.kind === "file" ? src : null;
    if (href && /^https?:\/\//.test(href)) {
      titleNode = el("a", { className: "title", href, target: "_blank", rel: "noopener", textContent: it.title || it.url });
    }

    const del = el("button", { textContent: "삭제" });
    del.onclick = () => removeItem(it);
    const card = el("article", { className: "item" },
      media ? el("div", { className: "media" }, media) : null,
      el("div", { className: "body" },
        titleNode,
        it.body ? el("div", { className: "text", textContent: it.body }) : null,
        el("div", { className: "meta" },
          el("span", { className: "tag", textContent: KIND_LABEL[it.kind] }),
          el("span", { textContent: new Date(it.created_at).toLocaleDateString("ko-KR") }),
          del)));
    grid.append(card);
  }
}

async function removeItem(it) {
  if (!confirm("이 항목을 삭제할까요?")) return;
  if (it.file_path) await sb.storage.from("uploads").remove([it.file_path]);
  const { error } = await sb.from("items").delete().eq("id", it.id);
  if (error) return alert(error.message);
  loadItems();
}

$("add-note").onclick = async () => {
  const title = prompt("제목");
  if (title === null) return;
  const body = prompt("내용") ?? "";
  const { data, error } = await sb.from("items").insert({ kind: "note", title, body, folder_id: state.current }).select().single();
  if (error) return alert(error.message);
  if (state.current === null) classifyMany([{ item: data }]);
  else loadItems();
};

$("add-link").onclick = async () => {
  const url = prompt("저장할 링크 (https://…)");
  if (!url || !/^https?:\/\//.test(url)) return url && alert("http:// 또는 https:// 로 시작하는 주소를 넣어주세요.");
  const title = prompt("제목 (비워도 돼요)") ?? "";
  const { data, error } = await sb.from("items").insert({ kind: "link", url, title: title || url, folder_id: state.current }).select().single();
  if (error) return alert(error.message);
  if (state.current === null) classifyMany([{ item: data }]);
  else loadItems();
};

async function uploadFiles(files) {
  const added = [];
  for (const file of files) {
    const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
    const path = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await sb.storage.from("uploads").upload(path, file, { contentType: file.type });
    if (upErr) { alert(`${file.name}: ${upErr.message}`); continue; }
    const { data, error } = await sb.from("items").insert({
      kind: kindFromMime(file.type || ""), title: file.name, file_path: path, folder_id: state.current,
    }).select().single();
    if (error) alert(error.message);
    else added.push({ item: data, imageSrc: file });
  }
  // '전체'에 올린 경우에만 자동 분류 (특정 폴더에 올리면 그대로 둠)
  if (state.current === null && added.length) { loadItems(); classifyMany(added); }
  else loadItems();
}
$("file-input").onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ""; };

const drop = $("drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles([...e.dataTransfer.files]); };

async function loadAll() { await loadFolders(); select(state.current); }
