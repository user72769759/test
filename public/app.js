import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

// current: null = 전체(모든 항목), "inbox" = 미분류(폴더 없음), "trash" = 휴지통, 그 외 = 폴더 id
const state = { user: null, folders: [], current: null, items: [], urls: {}, selecting: false, selected: new Set() };
const inTrash = () => state.current === "trash";
// 새 항목이 들어갈 폴더 (전체/미분류 화면에서는 폴더 없음 → AI 자동 분류 대상)
const targetFolder = () => (state.current === null || state.current === "inbox" || inTrash() ? null : state.current);
const folderName = (id) => state.folders.find((f) => f.id === id)?.name;

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
  if (!state.user) { state.loaded = false; return; }
  // Supabase 권장: 콜백 안에서 바로 다른 Supabase 호출을 기다리지 않도록 다음 틱으로 미룸
  setTimeout(() => {
    renderProfile();
    if (!state.loaded) { state.loaded = true; showSettings(false); loadAll(); }
  }, 0);
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
  const root = el("div", { className: "node" + (state.current === null ? " active" : ""), textContent: "🗂 전체" });
  root.onclick = () => select(null);
  const inbox = el("div", { className: "node" + (state.current === "inbox" ? " active" : ""), textContent: "📥 미분류" });
  inbox.onclick = () => select("inbox");
  tree.append(root, inbox);
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
  const trash = el("div", { className: "node trash-node" + (inTrash() ? " active" : ""), textContent: "🗑 휴지통" });
  trash.onclick = () => select("trash");
  tree.append(trash);
}

function renderCrumbs() {
  const c = $("crumbs");
  c.replaceChildren();
  const home = el("a", { textContent: "전체" });
  home.onclick = () => select(null);
  c.append(home);
  if (state.current === "inbox") c.append(" / 미분류");
  if (inTrash()) c.append(" / 휴지통");
  for (const f of pathTo(state.current)) {
    const a = el("a", { textContent: f.name });
    a.onclick = () => select(f.id);
    c.append(" / ", a);
  }
}

async function createFolder(parentId = targetFolder()) {
  const name = prompt("폴더 이름");
  if (!name?.trim()) return;
  const { error } = await sb.from("folders").insert({ name: name.trim(), parent_id: parentId });
  if (error) return alert(error.message);
  await loadFolders(); renderTree();
}
$("new-folder").onclick = () => createFolder(targetFolder());

function select(id) {
  state.current = id;
  setSelecting(false);
  $("lib-actions").classList.toggle("hidden", inTrash());
  $("drop").classList.toggle("hidden", inTrash());
  $("trash-actions").classList.toggle("hidden", !inTrash());
  renderTree(); renderCrumbs(); loadItems();
}

// ---------- AI 자동 분류 ----------
// 사진을 작은 JPEG로 줄임 (AI 전송·프로필 사진용)
async function makeThumb(src, maxSize = 640) {
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = url; });
    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
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
  const btn = $("auto-classify");
  btn.disabled = true;
  let done = 0, failed = 0, lastError = "";
  for (const { item, imageSrc } of pairs) {
    const n = done + failed;
    progress.show(`✨ AI가 분류 중 ${n + 1}/${pairs.length}`, item.title, n / pairs.length);
    try { await classifyItem(item, imageSrc); done++; }
    catch (e) { console.error(e); lastError = e.message; failed++; }
    renderTree();
  }
  progress.done(failed
    ? `${done}개 정리 · ${failed}개 실패 (${lastError})`
    : `✨ ${done}개를 주제별로 정리했어요`, !!failed);
  btn.disabled = false;
  await loadFolders();
  renderTree();
  loadItems();
}

// 전체·미분류 화면: 폴더 없는 항목을 정리 / 폴더 화면: 그 폴더의 항목을 주제별 폴더로 다시 정리
$("auto-classify").onclick = async () => {
  const folder = targetFolder();
  let q = sb.from("items").select("*").is("deleted_at", null);
  q = folder ? q.eq("folder_id", folder) : q.is("folder_id", null);
  const { data, error } = await q;
  if (error) return alert(error.message);
  if (!data.length) {
    return alert(folder ? "이 폴더에 정리할 항목이 없어요."
      : "미분류 항목이 없어요. 폴더 안 항목을 다시 정리하려면 그 폴더를 열고 눌러주세요.");
  }
  if (folder && !confirm(`'${folderName(folder)}' 폴더의 ${data.length}개 항목을 AI가 주제별 폴더로 옮겨요. 진행할까요?`)) return;
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
  let q = sb.from("items").select("*");
  if (inTrash()) q = q.not("deleted_at", "is", null).order("deleted_at", { ascending: false });
  else {
    q = q.is("deleted_at", null).order("created_at", { ascending: false });
    if (state.current === "inbox") q = q.is("folder_id", null);
    else if (state.current !== null) q = q.eq("folder_id", state.current);
  }
  const { data, error } = await q;
  if (error) return alert(error.message);

  // 파일은 비공개 저장소라 서명된 임시 URL로 표시
  const paths = data.filter((i) => i.file_path).map((i) => i.file_path);
  const urls = {};
  if (paths.length) {
    const { data: signed } = await sb.storage.from("uploads").createSignedUrls(paths, 3600);
    for (const s of signed ?? []) urls[s.path] = s.signedUrl;
  }
  state.items = data;
  state.urls = urls;
  // 사라진 항목은 선택에서 제외
  const ids = new Set(data.map((i) => i.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  renderItems(data, urls);
}

function renderItems(items, urls) {
  const grid = $("grid");
  grid.replaceChildren();
  $("empty").classList.toggle("hidden", items.length > 0);
  $("empty").textContent = inTrash() ? "휴지통이 비어 있어요." : "아직 저장된 항목이 없어요.";
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

    // 버튼: 일반 화면은 '삭제'(휴지통으로), 휴지통 화면은 '복원'·'영구 삭제'
    const btn = (label, fn) => {
      const b = el("button", { textContent: label });
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      return b;
    };
    const actions = inTrash()
      ? el("span", { className: "row" }, btn("복원", () => restoreItems([it])), btn("영구 삭제", () => purgeWithConfirm([it])))
      : btn("삭제", () => moveToTrash(it));
    // 사진: 정사각형에 꽉 채우고, 파일명·정보는 마우스를 올리면(모바일은 탭하면) 위에 표시
    const isPhoto = it.kind === "image" && src;
    const card = el("article", {
      className: "item" + (isPhoto ? " photo" : "") + (state.selected.has(it.id) ? " selected" : ""),
      tabIndex: isPhoto ? 0 : -1,
    },
      el("span", { className: "check", "aria-hidden": "true", textContent: "✓" }),
      media ? el("div", { className: "media" }, media) : null,
      el("div", { className: "body" },
        titleNode,
        it.body ? el("div", { className: "text", textContent: it.body }) : null,
        el("div", { className: "meta" },
          el("span", { className: "tag", textContent: KIND_LABEL[it.kind] + (state.current === null ? " · " + (folderName(it.folder_id) ?? "미분류") : "") }),
          el("span", { textContent: new Date(inTrash() ? it.deleted_at : it.created_at).toLocaleDateString("ko-KR") + (inTrash() ? " 삭제" : "") }),
          actions)));
    card.dataset.id = it.id;
    card.onclick = (e) => {
      if (state.selecting) { e.preventDefault(); toggleSelect(it.id, card); return; }
      if (isPhoto && !e.target.closest("a, button")) openViewer(it.id);
    };
    card.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (state.selecting) toggleSelect(it.id, card);
      else if (isPhoto) openViewer(it.id);
    };
    grid.append(card);
  }
}

// ---------- 휴지통 ----------
async function moveToTrash(it, { reload = true } = {}) {
  const { error } = await sb.from("items").update({ deleted_at: new Date().toISOString() }).eq("id", it.id);
  if (error) { alert(error.message); return false; }
  toast("휴지통으로 옮겼어요", "되돌리기", async () => {
    await sb.from("items").update({ deleted_at: null }).eq("id", it.id);
    loadItems();
  });
  if (reload) loadItems();
  return true;
}

async function restoreItems(items, { reload = true } = {}) {
  const { error } = await sb.from("items").update({ deleted_at: null }).in("id", items.map((i) => i.id));
  if (error) { alert(error.message); return false; }
  toast(`${items.length}개를 복원했어요`);
  if (reload) loadItems();
  return true;
}

// 영구 삭제: 저장소 파일 → DB 행 순서로 지움
async function purgeItems(items) {
  const paths = items.map((i) => i.file_path).filter(Boolean);
  for (let k = 0; k < paths.length; k += 500) {
    const { error } = await sb.storage.from("uploads").remove(paths.slice(k, k + 500));
    if (error) throw error;
  }
  const ids = items.map((i) => i.id);
  for (let k = 0; k < ids.length; k += 500) {
    const { error } = await sb.from("items").delete().in("id", ids.slice(k, k + 500));
    if (error) throw error;
  }
}

async function purgeWithConfirm(items, { reload = true } = {}) {
  const msg = items.length === 1 ? "이 항목을 영구 삭제할까요? 되돌릴 수 없어요." : `${items.length}개 항목을 영구 삭제할까요? 되돌릴 수 없어요.`;
  if (!confirm(msg)) return false;
  try { await purgeItems(items); } catch (e) { alert("삭제 실패: " + e.message); return false; }
  toast(`${items.length}개를 영구 삭제했어요`);
  if (reload) loadItems();
  return true;
}

$("empty-trash").onclick = async () => {
  const { data, error } = await sb.from("items").select("id, file_path").not("deleted_at", "is", null);
  if (error) return alert(error.message);
  if (!data.length) return toast("휴지통이 이미 비어 있어요");
  purgeWithConfirm(data);
};

$("add-note").onclick = async () => {
  const title = prompt("제목");
  if (title === null) return;
  const body = prompt("내용") ?? "";
  const { data, error } = await sb.from("items").insert({ kind: "note", title, body, folder_id: targetFolder() }).select().single();
  if (error) return alert(error.message);
  if (targetFolder() === null) classifyMany([{ item: data }]);
  else loadItems();
};

$("add-link").onclick = async () => {
  const url = prompt("저장할 링크 (https://…)");
  if (!url || !/^https?:\/\//.test(url)) return url && alert("http:// 또는 https:// 로 시작하는 주소를 넣어주세요.");
  const title = prompt("제목 (비워도 돼요)") ?? "";
  const { data, error } = await sb.from("items").insert({ kind: "link", url, title: title || url, folder_id: targetFolder() }).select().single();
  if (error) return alert(error.message);
  if (targetFolder() === null) classifyMany([{ item: data }]);
  else loadItems();
};

// supabase-js 업로드는 진행률을 알려주지 않아서, 같은 저장소 API를 XHR로 직접 호출
async function uploadWithProgress(path, file, onProgress) {
  const { data: { session } } = await sb.auth.getSession();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${SUPABASE_URL}/storage/v1/object/uploads/${path}`);
    xhr.setRequestHeader("authorization", `Bearer ${session.access_token}`);
    xhr.setRequestHeader("apikey", SUPABASE_KEY);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      let msg = `HTTP ${xhr.status}`;
      try { msg = JSON.parse(xhr.responseText).message || msg; } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("네트워크 오류"));
    xhr.send(file);
  });
}

async function uploadFiles(files) {
  if (!files.length) return;
  const folderId = targetFolder(); // 업로드 도중 화면을 옮겨도 처음 위치에 저장
  const added = [];
  const failed = [];
  const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1;
  let doneBytes = 0;
  for (const [n, file] of files.entries()) {
    const label = `업로드 중 ${n + 1}/${files.length}`;
    progress.show(label, file.name, doneBytes / totalBytes);
    const ext = (file.name.includes(".") ? file.name.split(".").pop() : "bin").replace(/[^a-z0-9]/gi, "").slice(0, 10) || "bin";
    const path = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
    try {
      await uploadWithProgress(path, file, (f) => progress.show(label, file.name, (doneBytes + f * file.size) / totalBytes));
      const { data, error } = await sb.from("items").insert({
        kind: kindFromMime(file.type || ""), title: file.name, file_path: path, folder_id: folderId,
      }).select().single();
      if (error) throw error;
      added.push({ item: data, imageSrc: file });
    } catch (e) {
      console.error(e);
      failed.push(`${file.name} (${e.message})`);
    }
    doneBytes += file.size;
  }
  if (failed.length) progress.done(`${added.length}개 업로드 · ${failed.length}개 실패: ${failed[0]}`, true);
  else progress.done(`${added.length}개 업로드 완료`);
  // 전체·미분류에 올린 경우에만 자동 분류 (특정 폴더에 올리면 그대로 둠)
  if (folderId === null && added.length) { loadItems(); classifyMany(added); }
  else loadItems();
}
$("file-input").onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ""; };

const drop = $("drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles([...e.dataTransfer.files]); };

async function loadAll() { await loadFolders(); select(state.current); }

// ---------- 계정 설정 ----------
const meta = () => state.user?.user_metadata ?? {};
const displayName = () => meta().name || state.user?.email?.split("@")[0] || "";
const say = (t) => ($("settings-msg").textContent = t);

async function avatarUrl() {
  const p = meta().avatar_path;
  if (!p) return null;
  const { data } = await sb.storage.from("avatars").createSignedUrl(p, 3600);
  return data?.signedUrl ?? null;
}
function paintAvatar(node, url) {
  node.style.backgroundImage = url ? `url("${url}")` : "";
  node.textContent = url ? "" : (displayName()[0] || "?").toUpperCase();
}
async function renderProfile() {
  $("side-name").textContent = displayName();
  $("set-email").textContent = state.user.email;
  $("name-input").value = meta().name || "";
  const url = await avatarUrl();
  paintAvatar($("side-avatar"), url);
  paintAvatar($("set-avatar"), url);
}
function showSettings(on) {
  $("settings").classList.toggle("hidden", !on);
  $("library").classList.toggle("hidden", on);
  $("delete-confirm").value = "";
  say("");
}
$("open-settings").onclick = () => showSettings(true);
$("close-settings").onclick = () => showSettings(false);

// 이름 변경 (로그인 계정 정보 user_metadata.name 에 저장)
$("name-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("name-input").value.trim();
  const { data, error } = await sb.auth.updateUser({ data: { name } });
  if (error) return say(error.message);
  state.user = data.user;
  renderProfile();
  say("이름을 저장했어요.");
};

// 프로필 사진 변경 (256px로 줄여 avatars 저장소에 올림)
$("avatar-input").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  say("사진 올리는 중…");
  const dataUrl = await makeThumb(file, 256);
  if (!dataUrl) return say("이미지를 읽을 수 없어요.");
  const blob = await (await fetch(dataUrl)).blob();
  const path = `${state.user.id}/${Date.now()}.jpg`;
  const { error: upErr } = await sb.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg" });
  if (upErr) return say(upErr.message);
  const old = meta().avatar_path;
  const { data, error } = await sb.auth.updateUser({ data: { avatar_path: path } });
  if (error) return say(error.message);
  if (old) await sb.storage.from("avatars").remove([old]);
  state.user = data.user;
  await renderProfile();
  say("프로필 사진을 바꿨어요.");
};

$("avatar-remove").onclick = async () => {
  const old = meta().avatar_path;
  if (!old) return say("등록된 사진이 없어요.");
  const { data, error } = await sb.auth.updateUser({ data: { avatar_path: null } });
  if (error) return say(error.message);
  await sb.storage.from("avatars").remove([old]);
  state.user = data.user;
  renderProfile();
  say("프로필 사진을 삭제했어요.");
};

// 계정 삭제: 내 파일 전부 삭제 → DB 함수로 계정 삭제(폴더·항목 자동 삭제) → 로그아웃
async function removeAllFiles(bucket) {
  const prefix = state.user.id;
  for (let round = 0; round < 50; round++) {
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw error;
    if (!data.length) return;
    const { error: rmErr } = await sb.storage.from(bucket).remove(data.map((f) => `${prefix}/${f.name}`));
    if (rmErr) throw rmErr;
  }
  throw new Error("파일을 모두 지우지 못했어요.");
}

$("delete-form").onsubmit = async (e) => {
  e.preventDefault();
  if ($("delete-confirm").value.trim() !== "삭제") return say("'삭제'를 정확히 입력해 주세요.");
  if (!confirm("정말 계정과 모든 데이터를 영구 삭제할까요? 되돌릴 수 없어요.")) return;
  const btn = e.submitter;
  btn.disabled = true;
  say("삭제 중…");
  try {
    await removeAllFiles("uploads");
    await removeAllFiles("avatars");
    const { error } = await sb.rpc("delete_my_account");
    if (error) throw error;
    await sb.auth.signOut({ scope: "local" });
    alert("계정이 삭제됐어요. 이용해 주셔서 감사합니다.");
  } catch (err) {
    say("삭제 실패: " + err.message);
  } finally {
    btn.disabled = false;
  }
};

// ---------- 진행 상황 패널 (업로드·AI 분류 공용) ----------
const progress = {
  timer: null,
  show(label, sub = "", fraction = null) {
    clearTimeout(this.timer);
    $("progress").classList.remove("hidden", "done", "error");
    $("progress-label").textContent = label;
    $("progress-sub").textContent = sub;
    const fill = $("progress-fill");
    fill.classList.toggle("indeterminate", fraction === null);
    if (fraction !== null) fill.style.width = Math.round(Math.min(1, fraction) * 100) + "%";
  },
  done(label, isError = false) {
    $("progress").classList.add(isError ? "error" : "done");
    $("progress-label").textContent = label;
    $("progress-sub").textContent = "";
    $("progress-fill").classList.remove("indeterminate");
    $("progress-fill").style.width = "100%";
    clearTimeout(this.timer);
    this.timer = setTimeout(() => $("progress").classList.add("hidden"), isError ? 10000 : 3000);
  },
};

// ---------- 알림 ----------
let toastTimer;
function toast(msg, actionLabel, action) {
  clearTimeout(toastTimer);
  $("toast-msg").textContent = msg;
  const btn = $("toast-action");
  btn.classList.toggle("hidden", !actionLabel);
  btn.textContent = actionLabel || "";
  btn.onclick = async () => { $("toast").classList.add("hidden"); await action(); };
  $("toast").classList.remove("hidden");
  toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 5000);
}

// ---------- 사진 슬라이드쇼 ----------
const viewer = { list: [], i: 0, dirty: false };
const isViewerOpen = () => !$("viewer").classList.contains("hidden");

function folderOptions() {
  const out = [["", "📥 미분류"]];
  const walk = (pid, depth) => {
    for (const f of childrenOf(pid)) { out.push([f.id, "　".repeat(depth) + "📁 " + f.name]); walk(f.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}

function openViewer(id) {
  viewer.list = state.items.filter((i) => i.kind === "image" && state.urls[i.file_path]);
  viewer.i = Math.max(0, viewer.list.findIndex((x) => x.id === id));
  viewer.dirty = false;
  $("viewer").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  document.body.classList.add("viewer-open");
  $("v-move-wrap").classList.toggle("hidden", inTrash());
  $("v-restore").classList.toggle("hidden", !inTrash());
  $("v-delete").textContent = inTrash() ? "영구 삭제" : "휴지통으로";
  showSlide();
  $("v-close").focus();
}

function closeViewer() {
  $("viewer").classList.add("hidden");
  $("v-img").removeAttribute("src");
  document.body.style.overflow = "";
  document.body.classList.remove("viewer-open");
  if (viewer.dirty) loadItems();
}

function showSlide() {
  if (!viewer.list.length) return closeViewer();
  viewer.i = Math.min(Math.max(viewer.i, 0), viewer.list.length - 1);
  const it = viewer.list[viewer.i];
  $("v-img").src = state.urls[it.file_path];
  $("v-img").alt = it.title;
  $("v-title").textContent = it.title || "(제목 없음)";
  $("v-sub").textContent = `${viewer.i + 1} / ${viewer.list.length} · ${new Date(it.created_at).toLocaleDateString("ko-KR")}`;
  const sel = $("v-folder");
  sel.replaceChildren(...folderOptions().map(([v, t]) => el("option", { value: v, textContent: t })));
  sel.value = it.folder_id ?? "";
  $("v-prev").disabled = viewer.i === 0;
  $("v-next").disabled = viewer.i === viewer.list.length - 1;
  // 앞뒤 사진 미리 불러오기
  for (const j of [viewer.i - 1, viewer.i + 1]) {
    const n = viewer.list[j];
    if (n) new Image().src = state.urls[n.file_path];
  }
}

const step = (d) => { viewer.i += d; showSlide(); };
$("v-prev").onclick = () => step(-1);
$("v-next").onclick = () => step(1);
$("v-close").onclick = closeViewer;
$("viewer").onclick = (e) => { if (e.target.id === "viewer" || e.target.classList.contains("v-stage")) closeViewer(); };

// 지금 보는 화면에서 빠지는 사진이면 슬라이드에서도 제외
function dropCurrentIfGone(it) {
  const stays = state.current === null || (state.current === "inbox" ? it.folder_id === null : state.current === it.folder_id);
  if (!stays) viewer.list.splice(viewer.i, 1);
  showSlide();
}

$("v-folder").onchange = async (e) => {
  const it = viewer.list[viewer.i];
  const folder_id = e.target.value || null;
  const { error } = await sb.from("items").update({ folder_id }).eq("id", it.id);
  if (error) return alert(error.message);
  it.folder_id = folder_id;
  viewer.dirty = true;
  toast(`'${folderName(folder_id) ?? "미분류"}'(으)로 옮겼어요`);
  e.target.blur(); // 방향키가 다시 사진 넘기기로 동작하도록
  dropCurrentIfGone(it);
};

$("v-delete").onclick = async () => {
  const it = viewer.list[viewer.i];
  const ok = inTrash() ? await purgeWithConfirm([it], { reload: false }) : await moveToTrash(it, { reload: false });
  if (!ok) return;
  viewer.dirty = true;
  viewer.list.splice(viewer.i, 1);
  showSlide();
};

$("v-restore").onclick = async () => {
  const it = viewer.list[viewer.i];
  if (!(await restoreItems([it], { reload: false }))) return;
  viewer.dirty = true;
  viewer.list.splice(viewer.i, 1);
  showSlide();
};

document.addEventListener("keydown", (e) => {
  if (!isViewerOpen() || e.target.tagName === "SELECT") return;
  if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  else if (e.key === "Escape") closeViewer();
});

// 휴대폰: 좌우로 밀어서 넘기기
let touchX = null;
$("viewer").addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$("viewer").addEventListener("touchend", (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) step(dx > 0 ? -1 : 1);
});

// ---------- 선택 모드 (여러 항목 이동·삭제) ----------
function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  document.querySelector(".main").classList.toggle("selecting", on);
  $("select-btn").classList.toggle("hidden", on);
  $("select-bar").classList.toggle("hidden", !on);
  $("lib-actions").classList.toggle("hidden", on || inTrash());
  $("trash-actions").classList.toggle("hidden", on || !inTrash());
  $("sel-move").classList.toggle("hidden", inTrash());
  $("sel-restore").classList.toggle("hidden", !inTrash());
  $("sel-delete").textContent = inTrash() ? "영구 삭제" : "삭제";
  for (const c of document.querySelectorAll(".item.selected")) c.classList.remove("selected");
  if (on) fillMoveOptions();
  updateSelectBar();
}

function toggleSelect(id, card) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  card?.classList.toggle("selected", state.selected.has(id));
  updateSelectBar();
}

function updateSelectBar() {
  const n = state.selected.size;
  const all = state.items.length > 0 && n === state.items.length;
  $("sel-count").textContent = `${n}개 선택`;
  $("sel-all").textContent = all ? "선택 해제" : "모두 선택";
  for (const id of ["sel-move", "sel-restore", "sel-delete"]) $(id).disabled = n === 0;
}

function fillMoveOptions() {
  const sel = $("sel-move");
  sel.replaceChildren(
    el("option", { value: "__", textContent: "폴더로 이동…", disabled: true, selected: true }),
    ...folderOptions().map(([v, t]) => el("option", { value: v, textContent: t })),
  );
}

const selectedItems = () => state.items.filter((i) => state.selected.has(i.id));

$("select-btn").onclick = () => setSelecting(true);
$("sel-cancel").onclick = () => setSelecting(false);
$("sel-all").onclick = () => {
  const all = state.selected.size === state.items.length;
  state.selected = new Set(all ? [] : state.items.map((i) => i.id));
  for (const c of document.querySelectorAll("#grid .item")) c.classList.toggle("selected", state.selected.has(c.dataset.id));
  updateSelectBar();
};

$("sel-move").onchange = async (e) => {
  const items = selectedItems();
  const folder_id = e.target.value || null;
  e.target.value = "__";
  if (!items.length) return;
  const { error } = await sb.from("items").update({ folder_id }).in("id", items.map((i) => i.id));
  if (error) return alert(error.message);
  toast(`${items.length}개를 '${folderName(folder_id) ?? "미분류"}'(으)로 옮겼어요`);
  setSelecting(false);
  loadItems();
};

$("sel-delete").onclick = async () => {
  const items = selectedItems();
  if (!items.length) return;
  if (inTrash()) {
    if (await purgeWithConfirm(items, { reload: false })) { setSelecting(false); loadItems(); }
    return;
  }
  const ids = items.map((i) => i.id);
  const { error } = await sb.from("items").update({ deleted_at: new Date().toISOString() }).in("id", ids);
  if (error) return alert(error.message);
  toast(`${ids.length}개를 휴지통으로 옮겼어요`, "되돌리기", async () => {
    await sb.from("items").update({ deleted_at: null }).in("id", ids);
    loadItems();
  });
  setSelecting(false);
  loadItems();
};

$("sel-restore").onclick = async () => {
  const items = selectedItems();
  if (items.length && (await restoreItems(items, { reload: false }))) { setSelecting(false); loadItems(); }
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.selecting && !isViewerOpen()) setSelecting(false);
});
