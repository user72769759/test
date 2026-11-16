import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

// current: null = 전체(모든 항목, 정리 안 된 항목이 맨 위), "trash" = 휴지통, 그 외 = 폴더 id
const state = { user: null, folders: [], current: null, items: [], urls: {}, selecting: false, selected: new Set() };
const inTrash = () => state.current === "trash";
// 새 항목이 들어갈 폴더 (전체 화면에서는 폴더 없음 → AI 자동 분류 대상)
const targetFolder = () => (state.current === null || inTrash() ? null : state.current);
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
$("settings-signout").onclick = () => sb.auth.signOut();

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
  const root = el("div", { className: "node" + (state.current === null ? " active" : ""), textContent: "전체" });
  root.dataset.key = "all";
  root.onclick = () => select(null);
  tree.append(root);
  // 폴더는 1단계만 (하위 폴더 없음)
  for (const f of childrenOf(null)) {
    const del = el("button", { className: "folder-del", title: `'${f.name}' 폴더 삭제`, textContent: "삭제" });
    del.onclick = (e) => { e.stopPropagation(); deleteFolder(f); };
    const node = el("div", { className: "node" + (state.current === f.id ? " active" : "") }, el("span", { className: "node-name", textContent: f.name }), del);
    node.dataset.key = f.id;
    node.onclick = (e) => { if (e.target.tagName !== "INPUT" && state.current !== f.id) select(f.id); };
    // PC: 폴더 이름 더블클릭 → 이름 바꾸기 (Enter 저장, Esc 취소)
    node.querySelector(".node-name").ondblclick = (e) => { e.stopPropagation(); startRename(f, e.currentTarget); };
    tree.append(node);
  }
  const trash = el("div", { className: "node trash-node" + (inTrash() ? " active" : ""), textContent: "휴지통" });
  trash.dataset.key = "trash";
  trash.onclick = () => select("trash");
  tree.append(trash);
}

function renderCrumbs() {
  const c = $("crumbs");
  c.replaceChildren();
  const home = el("a", { textContent: "전체" });
  home.onclick = () => select(null);
  c.append(home);
  if (inTrash()) c.append(" / 휴지통");
  for (const f of pathTo(state.current)) {
    const a = el("a", { textContent: f.name });
    a.onclick = () => select(f.id);
    c.append(" / ", a);
  }
}

async function createFolder() {
  const name = prompt("폴더 이름")?.trim();
  if (!name) return;
  if (childrenOf(null).some((f) => f.name === name)) return alert(`'${name}' 폴더가 이미 있어요.`);
  const { error } = await sb.from("folders").insert({ name, parent_id: null });
  if (error) return alert(error.message);
  await loadFolders(); renderTree();
}
$("new-folder").onclick = () => createFolder();

// 폴더 삭제: 안의 항목은 휴지통으로 (복원하면 '전체'의 정리 안 된 항목으로 돌아옴)
async function deleteFolder(f) {
  const { count, error: cErr } = await sb.from("items").select("id", { count: "exact", head: true })
    .eq("folder_id", f.id).is("deleted_at", null);
  if (cErr) return alert(cErr.message);
  const msg = count
    ? `'${f.name}' 폴더를 삭제할까요?\n안에 있는 ${count}개 항목은 휴지통으로 옮겨져요. (복원하면 '전체'에 정리 안 된 항목으로 돌아와요)`
    : `'${f.name}' 폴더를 삭제할까요? (빈 폴더)`;
  if (!confirm(msg)) return;
  if (count) {
    const { error } = await sb.from("items").update({ deleted_at: new Date().toISOString() })
      .eq("folder_id", f.id).is("deleted_at", null);
    if (error) return alert(error.message);
  }
  const { error } = await sb.from("folders").delete().eq("id", f.id);
  if (error) return alert(error.message);
  toast(count ? `'${f.name}' 폴더를 삭제하고 ${count}개 항목을 휴지통으로 옮겼어요` : `'${f.name}' 폴더를 삭제했어요`);
  await loadFolders();
  if (state.current === f.id) select(null);
  else { renderTree(); loadItems(); }
}

function select(id) {
  state.current = id;
  setSelecting(false);
  $("lib-actions").classList.toggle("hidden", inTrash());
  $("drop").classList.toggle("hidden", inTrash());
  $("trash-actions").classList.toggle("hidden", !inTrash());
  // 사이드바는 다시 그리지 않고 선택 표시만 바꿈 (더블클릭이 끊기지 않도록)
  const key = id === null ? "all" : id;
  const nodes = document.querySelectorAll("#tree .node");
  if (nodes.length && [...nodes].some((n) => n.dataset.key === key)) {
    for (const n of nodes) n.classList.toggle("active", n.dataset.key === key);
  } else renderTree();
  renderCrumbs(); loadItems();
}

function startRename(f, span) {
  const input = el("input", { className: "rename-input", value: f.name, maxLength: 50 });
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!save || !name || name === f.name) return renderTree();
    if (childrenOf(null).some((x) => x.id !== f.id && x.name === name)) {
      toast(`'${name}' 폴더가 이미 있어요`);
      return renderTree();
    }
    const old = f.name;
    const { error } = await sb.from("folders").update({ name }).eq("id", f.id);
    if (error) { alert(error.message); return renderTree(); }
    f.name = name;
    pushUndo("폴더 이름 변경", async () => {
      await sb.from("folders").update({ name: old }).eq("id", f.id);
      f.name = old;
      renderTree(); renderCrumbs(); loadItems();
    });
    toast(`폴더 이름을 '${name}'(으)로 바꿨어요`);
    renderTree(); renderCrumbs(); loadItems();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(false);
  input.onclick = (e) => e.stopPropagation();
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
  if (!res.ok) {
    const err = new Error(out.error || `HTTP ${res.status}`);
    err.quota = out.code === "quota";
    throw err;
  }

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
  let done = 0, failed = 0, lastError = "", quotaHit = false;
  for (const { item, imageSrc } of pairs) {
    const n = done + failed;
    progress.show(`✨ AI가 분류 중 ${n + 1}/${pairs.length}`, item.title, n / pairs.length);
    try { await classifyItem(item, imageSrc); done++; }
    catch (e) {
      console.error(e);
      if (e.quota) { quotaHit = true; break; } // 한도 초과: 남은 항목은 '정리 안 됨'으로 둠
      lastError = e.message; failed++;
    }
    renderTree();
  }
  const left = pairs.length - done - failed;
  if (quotaHit) progress.done(`오늘 AI 분류 한도(30건)를 다 썼어요. ${left}개는 '정리 안 됨'으로 두었다가 오전 9시 이후 ✨ 자동 분류로 이어서 정리하세요`, true);
  else progress.done(failed
    ? `${done}개 정리 · ${failed}개 실패 (${lastError})`
    : `✨ ${done}개를 주제별로 정리했어요`, !!failed);
  btn.disabled = false;
  await loadFolders();
  renderTree();
  loadItems();
}

// 자동 분류: 어느 화면에서 눌러도 '정리 안 된 항목'(폴더 없음)만 AI가 주제별 폴더로 정리
$("auto-classify").onclick = async () => {
  const { data, error } = await sb.from("items").select("*").is("deleted_at", null).is("folder_id", null);
  if (error) return alert(error.message);
  if (!data.length) return toast("정리 안 된 항목이 없어요. 모두 폴더에 들어가 있어요");
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
    if (state.current !== null) q = q.eq("folder_id", state.current);
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
  // 전체 화면: 정리 안 된 항목(폴더 없음)을 맨 위로, 나머지는 최신순 유지
  if (state.current === null) data.sort((a, b) => (a.folder_id === null ? 0 : 1) - (b.folder_id === null ? 0 : 1));
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
    const unsorted = state.current === null && !it.folder_id;
    const card = el("article", {
      className: "item" + (isPhoto ? " photo" : "") + (unsorted ? " unsorted" : "") + (state.selected.has(it.id) ? " selected" : ""),
      tabIndex: isPhoto ? 0 : -1,
    },
      el("span", { className: "check", "aria-hidden": "true", textContent: "✓" }),
      unsorted ? el("span", { className: "unsorted-badge", textContent: "정리 안 됨" }) : null,
      media ? el("div", { className: "media" }, media) : null,
      el("div", { className: "body" },
        titleNode,
        it.body ? el("div", { className: "text", textContent: it.body }) : null,
        el("div", { className: "meta" },
          el("span", { className: "tag", textContent: KIND_LABEL[it.kind] + (state.current === null && it.folder_id ? " · " + (folderName(it.folder_id) ?? "") : "") }),
          el("span", { textContent: new Date(inTrash() ? it.deleted_at : it.created_at).toLocaleDateString("ko-KR") + (inTrash() ? " 삭제" : "") }),
          actions)));
    card.dataset.id = it.id;
    card.onclick = (e) => {
      // PC: Shift + 클릭 → 선택 모드를 켜고 이 항목 선택
      if (e.shiftKey && !state.selecting) { e.preventDefault(); setSelecting(true); }
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
  const undo = pushUndo("휴지통으로 이동", async () => {
    await sb.from("items").update({ deleted_at: null }).eq("id", it.id);
    loadItems();
  });
  toast("휴지통으로 옮겼어요", "되돌리기", undo);
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
  const ids0 = new Set(items.map((i) => i.id));
  let paths = [...new Set(items.map((i) => i.file_path).filter(Boolean))];
  // 붙여넣기로 만든 복사본이 같은 파일을 공유할 수 있어서, 다른 항목이 쓰는 파일은 지우지 않음
  for (let k = 0; k < paths.length; k += 200) {
    const { data, error } = await sb.from("items").select("id, file_path").in("file_path", paths.slice(k, k + 200));
    if (error) throw error;
    const shared = new Set(data.filter((r) => !ids0.has(r.id)).map((r) => r.file_path));
    paths = paths.filter((p) => !shared.has(p));
  }
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

$("add-note").onclick = () => openComposer("note");
$("add-link").onclick = () => openComposer("link");

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

// ---------- 1인당 한도 (10명 기준) ----------
const STORAGE_LIMIT = 90 * 1024 * 1024; // 90MB
const FILE_LIMIT = 20 * 1024 * 1024;    // 파일 1개 20MB
const AI_LIMIT = 30;                     // 하루 30건
const mb = (b) => (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0) + "MB";

async function getUsage() {
  const { data, error } = await sb.rpc("my_usage");
  if (error) throw error;
  return data;
}

// 사진 압축: 긴 변 2000px JPEG로 줄여 저장 공간 절약 (작은 파일·GIF는 그대로)
async function compressImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) || file.size < 400 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff"; // 투명 PNG 배경
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file; // 브라우저가 못 읽는 형식이면 원본 그대로
  }
}

async function uploadFiles(rawFiles) {
  if (!rawFiles.length) return;
  const folderId = targetFolder(); // 업로드 도중 화면을 옮겨도 처음 위치에 저장
  const added = [];
  const failed = [];
  progress.show("사진 준비 중…", "", null);
  const files = [];
  for (const f of rawFiles) files.push(await compressImage(f));
  let used = 0;
  try { used = (await getUsage()).storage_used; } catch { /* 확인 실패 시 서버 규칙이 막아 줌 */ }
  const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1;
  let doneBytes = 0;
  for (const [n, file] of files.entries()) {
    const label = `업로드 중 ${n + 1}/${files.length}`;
    progress.show(label, file.name, doneBytes / totalBytes);
    if (file.size > FILE_LIMIT) {
      failed.push(`${file.name} (파일 1개는 20MB까지 올릴 수 있어요)`);
      doneBytes += file.size;
      continue;
    }
    if (used >= STORAGE_LIMIT) {
      failed.push(`${file.name} (저장 공간 90MB를 다 썼어요. 휴지통을 비우거나 항목을 정리해 주세요)`);
      doneBytes += file.size;
      continue;
    }
    const ext = (file.name.includes(".") ? file.name.split(".").pop() : "bin").replace(/[^a-z0-9]/gi, "").slice(0, 10) || "bin";
    const path = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
    try {
      await uploadWithProgress(path, file, (f) => progress.show(label, file.name, (doneBytes + f * file.size) / totalBytes));
      const { data, error } = await sb.from("items").insert({
        kind: kindFromMime(file.type || ""), title: file.name, file_path: path, folder_id: folderId,
      }).select().single();
      if (error) throw error;
      added.push({ item: data, imageSrc: file });
      used += file.size;
    } catch (e) {
      console.error(e);
      failed.push(`${file.name} (${e.message})`);
    }
    doneBytes += file.size;
  }
  if (failed.length) progress.done(`${added.length}개 업로드 · ${failed.length}개 못 올림: ${failed[0]}`, true);
  else progress.done(`${added.length}개 업로드 완료`);
  // 전체에 올린 경우에만 자동 분류 (특정 폴더에 올리면 그대로 둠)
  if (folderId === null && added.length) { loadItems(); classifyMany(added); }
  else loadItems();
}
$("file-input").onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ""; };

// 드래그 앤 드롭: 페이지 어디에 놓아도 업로드 (브라우저가 파일을 열어 버리는 기본 동작 차단)
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
// 지금 화면에서 업로드할 수 있는지 (보관함 화면, 휴지통 아님, 다른 창이 열려 있지 않음)
const canDropHere = () =>
  !!state.user && !inTrash() && !$("library").classList.contains("hidden") && !isViewerOpen() && !isComposerOpen();
let dragDepth = 0;
const showDropOverlay = (on) => {
  if (on) {
    const f = targetFolder();
    $("drop-overlay-sub").textContent = f
      ? `'${folderName(f)}' 폴더에 저장돼요 · 파일당 20MB까지`
      : "AI가 주제별 폴더로 정리해요 · 파일당 20MB까지";
  }
  $("drop-overlay").classList.toggle("hidden", !on);
  $("drop").classList.toggle("over", on);
};

window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  if (canDropHere()) showDropOverlay(true);
});
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); // 이게 없으면 브라우저가 파일을 새 화면으로 열어 버림
  e.dataTransfer.dropEffect = canDropHere() ? "copy" : "none";
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDropOverlay(false);
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showDropOverlay(false);
  if (!state.user) return;
  if (inTrash()) return toast("휴지통에서는 올릴 수 없어요. 다른 폴더로 이동해서 올려 주세요");
  if (!canDropHere()) return;
  uploadFiles([...e.dataTransfer.files]);
});

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
async function renderUsage() {
  try {
    const u = await getUsage();
    $("u-storage-text").textContent = `${mb(u.storage_used)} / ${mb(u.storage_limit)}`;
    $("u-storage-fill").style.width = Math.min(100, (u.storage_used / u.storage_limit) * 100) + "%";
    $("u-ai-text").textContent = `${u.ai_used_today} / ${u.ai_limit}건`;
    $("u-ai-fill").style.width = Math.min(100, (u.ai_used_today / u.ai_limit) * 100) + "%";
  } catch {
    $("u-storage-text").textContent = $("u-ai-text").textContent = "확인하지 못했어요";
  }
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
$("open-settings").onclick = () => { showSettings(true); renderUsage(); };
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
  const out = [["", "폴더에서 빼기"]];
  for (const f of childrenOf(null)) out.push([f.id, f.name]);
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
  $("v-folder-label").textContent = folderName(it.folder_id) ?? "정리 안 됨";
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
  const stays = state.current === null || state.current === it.folder_id;
  if (!stays) viewer.list.splice(viewer.i, 1);
  showSlide();
}

async function moveViewerItem(folder_id) {
  const it = viewer.list[viewer.i];
  if (!it) return;
  const prev = it.folder_id;
  const { error } = await sb.from("items").update({ folder_id }).eq("id", it.id);
  if (error) return alert(error.message);
  it.folder_id = folder_id;
  pushUndo("폴더 이동", async () => {
    await sb.from("items").update({ folder_id: prev }).eq("id", it.id);
    loadItems();
  });
  viewer.dirty = true;
  toast(folder_id ? `'${folderName(folder_id)}'(으)로 옮겼어요` : "폴더에서 뺐어요 · '전체' 맨 위에 있어요");
  $("v-folder").blur(); // 방향키가 다시 사진 넘기기로 동작하도록
  dropCurrentIfGone(it);
}

$("v-folder").onclick = (e) => {
  const it = viewer.list[viewer.i];
  if (!it) return;
  openFolderMenu(e.currentTarget, { current: it.folder_id, onPick: (id) => moveViewerItem(id) });
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
  if (!isViewerOpen() || isFolderMenuOpen() || isTyping(e.target)) return;
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

const selectedItems = () => state.items.filter((i) => state.selected.has(i.id));

$("select-btn").onclick = () => setSelecting(true);
$("sel-cancel").onclick = () => setSelecting(false);
$("sel-all").onclick = () => {
  const all = state.selected.size === state.items.length;
  state.selected = new Set(all ? [] : state.items.map((i) => i.id));
  for (const c of document.querySelectorAll("#grid .item")) c.classList.toggle("selected", state.selected.has(c.dataset.id));
  updateSelectBar();
};

async function moveSelectedTo(folder_id) {
  const items = selectedItems();
  if (!items.length) return;
  if (!(await moveItems(items, folder_id))) return;
  setSelecting(false);
  loadItems();
}

$("sel-move").onclick = (e) => {
  if (!selectedItems().length) return;
  openFolderMenu(e.currentTarget, { current: undefined, onPick: (id) => moveSelectedTo(id) });
};

$("sel-delete").onclick = async () => {
  const items = selectedItems();
  if (!items.length) return;
  if (inTrash()) {
    if (await purgeWithConfirm(items, { reload: false })) { setSelecting(false); loadItems(); }
    return;
  }
  if (!(await trashMany(items))) return;
  setSelecting(false);
  loadItems();
};

$("sel-restore").onclick = async () => {
  const items = selectedItems();
  if (items.length && (await restoreItems(items, { reload: false }))) { setSelecting(false); loadItems(); }
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.selecting && !isViewerOpen() && !isComposerOpen()) setSelecting(false);
});

// ---------- 글쓰기 · 링크 저장 패널 ----------
const composer = { mode: "note", saving: false };
const isComposerOpen = () => $("composer").classList.contains("open");
const AUTO = "__auto";

function openComposer(mode) {
  composer.mode = mode;
  const isLink = mode === "link";
  $("composer-heading").textContent = isLink ? "링크 저장" : "새 글";
  $("c-url").classList.toggle("hidden", !isLink);
  $("c-url").required = isLink;
  $("c-title").placeholder = isLink ? "제목 (비워 두면 링크 주소로 저장돼요)" : "제목";
  $("c-body").placeholder = isLink ? "이 링크에 대한 메모 (선택)" : "떠오르는 생각을 자유롭게 적어 보세요";
  $("c-title").value = $("c-body").value = $("c-url").value = "";
  $("c-msg").textContent = "";
  const sel = $("c-folder");
  sel.replaceChildren(
    el("option", { value: AUTO, textContent: "✨ AI가 알아서 분류" }),
    ...folderOptions().filter(([v]) => v).map(([v, t]) => el("option", { value: v, textContent: t })),
  );
  sel.value = targetFolder() ?? AUTO;
  $("composer").classList.add("open");
  $("composer").setAttribute("aria-hidden", "false");
  $("composer-backdrop").classList.remove("hidden");
  setTimeout(() => (isLink ? $("c-url") : $("c-title")).focus(), 180);
}

function closeComposer(force = false) {
  const dirty = $("c-title").value.trim() || $("c-body").value.trim() || $("c-url").value.trim();
  if (!force && dirty && !confirm("작성 중인 내용이 사라져요. 닫을까요?")) return;
  $("composer").classList.remove("open");
  $("composer").setAttribute("aria-hidden", "true");
  $("composer-backdrop").classList.add("hidden");
}

$("composer-close").onclick = () => closeComposer();
$("c-cancel").onclick = () => closeComposer();
$("composer-backdrop").onclick = () => closeComposer();

$("composer-form").onsubmit = async (e) => {
  e.preventDefault();
  if (composer.saving) return;
  const isLink = composer.mode === "link";
  const title = $("c-title").value.trim();
  const body = $("c-body").value.trim();
  const url = $("c-url").value.trim();
  if (isLink && !/^https?:\/\/\S+/.test(url)) return ($("c-msg").textContent = "http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.");
  if (!isLink && !title && !body) return ($("c-msg").textContent = "제목이나 내용을 적어 주세요.");
  const choice = $("c-folder").value;
  const auto = choice === AUTO;
  const row = isLink
    ? { kind: "link", url, title: title || url, body: body || null, folder_id: auto ? null : choice || null }
    : { kind: "note", title, body, folder_id: auto ? null : choice || null };
  composer.saving = true;
  $("c-save").disabled = true;
  const { data, error } = await sb.from("items").insert(row).select().single();
  composer.saving = false;
  $("c-save").disabled = false;
  if (error) return ($("c-msg").textContent = "저장하지 못했어요: " + error.message);
  closeComposer(true);
  toast(isLink ? "링크를 저장했어요" : "글을 저장했어요");
  if (auto) classifyMany([{ item: data }]);
  else loadItems();
};

document.addEventListener("keydown", (e) => {
  if (!isComposerOpen()) return;
  if (e.key === "Escape") { e.preventDefault(); closeComposer(); }
  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("composer-form").requestSubmit(); }
});

// ---------- 폴더 선택 메뉴 (테마 적용, 선택 모드·슬라이드쇼 공용) ----------
const isFolderMenuOpen = () => !$("folder-menu").classList.contains("hidden");
let folderMenuAnchor = null;

function closeFolderMenu() {
  $("folder-menu").classList.add("hidden");
  $("folder-menu").replaceChildren();
  folderMenuAnchor?.setAttribute("aria-expanded", "false");
  folderMenuAnchor?.focus();
  folderMenuAnchor = null;
}

// current: 지금 들어 있는 폴더 id(null = 정리 안 됨, undefined = 여러 개라 표시 안 함)
function openFolderMenu(anchor, { current, onPick }) {
  if (isFolderMenuOpen() && folderMenuAnchor === anchor) return closeFolderMenu();
  const menu = $("folder-menu");
  menu.replaceChildren();
  menu.classList.toggle("dark", !!anchor.closest(".viewer"));
  const pick = (id) => { closeFolderMenu(); onPick(id); };

  const item = (label, id, cls = "") => {
    const b = el("button", { type: "button", className: "fm-item " + cls, textContent: label, role: "menuitem" });
    if (id === current) { b.classList.add("current"); b.append(el("span", { className: "fm-check", textContent: "✓" })); }
    b.onclick = () => pick(id);
    return b;
  };

  // 새 폴더 (강조) → 누르면 메뉴 안에서 이름 입력
  const newBtn = el("button", { type: "button", className: "fm-item fm-new", role: "menuitem" },
    el("span", { className: "fm-plus", textContent: "+" }), "새 폴더에 저장하기");
  newBtn.onclick = () => {
    const form = el("form", { className: "fm-newform" });
    const input = el("input", { className: "fm-input", placeholder: "새 폴더 이름", maxLength: 50 });
    const ok = el("button", { type: "submit", className: "fm-ok", textContent: "저장" });
    form.append(input, ok);
    newBtn.replaceWith(form);
    input.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return input.focus();
      ok.disabled = true;
      try { const id = await ensureFolder(name); pick(id); }
      catch (err) { ok.disabled = false; alert("폴더를 만들지 못했어요: " + err.message); }
    };
  };

  menu.append(newBtn, el("div", { className: "fm-sep" }));
  const list = el("div", { className: "fm-list" });
  for (const f of childrenOf(null)) list.append(item(f.name, f.id));
  if (!childrenOf(null).length) list.append(el("div", { className: "fm-empty", textContent: "아직 폴더가 없어요" }));
  menu.append(list);
  if (current !== null) menu.append(el("div", { className: "fm-sep" }), item("폴더에서 빼기", null, "fm-remove"));

  // 버튼 위치에 맞춰 띄우기 (아래 공간이 모자라면 위로)
  menu.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight, mw = menu.offsetWidth;
  const below = window.innerHeight - r.bottom;
  menu.style.top = (below >= mh + 8 || below > r.top ? r.bottom + 6 : r.top - mh - 6) + "px";
  menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + "px";
  folderMenuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  (menu.querySelector(".fm-item.current") || newBtn).focus();
}

// 메뉴 바깥 클릭 · Esc · 방향키
document.addEventListener("mousedown", (e) => {
  if (isFolderMenuOpen() && !e.target.closest("#folder-menu") && !e.target.closest(".menu-btn")) closeFolderMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (!isFolderMenuOpen()) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeFolderMenu(); return; }
  if (e.target.classList?.contains("fm-input")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); e.stopImmediatePropagation();
    const items = [...$("folder-menu").querySelectorAll(".fm-item")];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }
}, true);
window.addEventListener("resize", () => { if (isFolderMenuOpen()) closeFolderMenu(); });

// 같은 이름 폴더가 있으면 그 폴더를, 없으면 새로 만들어 id 반환
async function ensureFolder(name) {
  const existing = childrenOf(null).find((f) => f.name === name);
  if (existing) return existing.id;
  const { data, error } = await sb.from("folders").insert({ name, parent_id: null }).select().single();
  if (error) throw error;
  state.folders.push(data);
  state.folders.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  renderTree();
  return data.id;
}

// ---------- 되돌리기 (⌘Z) ----------
const undoStack = [];
// 되돌릴 동작을 기록하고, 알림의 '되돌리기' 버튼에도 쓸 수 있는 함수를 돌려줌 (한 번만 실행)
function pushUndo(label, fn) {
  const entry = { label, fn, used: false };
  undoStack.push(entry);
  if (undoStack.length > 30) undoStack.shift();
  return async () => {
    if (entry.used) return;
    entry.used = true;
    const i = undoStack.indexOf(entry);
    if (i >= 0) undoStack.splice(i, 1);
    await fn();
  };
}
async function undoLast() {
  const entry = undoStack.pop();
  if (!entry) return toast("되돌릴 작업이 없어요");
  entry.used = true;
  try { await entry.fn(); toast(`되돌렸어요 · ${entry.label}`); }
  catch (e) { alert("되돌리지 못했어요: " + e.message); }
}

async function trashMany(items) {
  const ids = items.map((i) => i.id);
  const { error } = await sb.from("items").update({ deleted_at: new Date().toISOString() }).in("id", ids);
  if (error) { alert(error.message); return false; }
  const undo = pushUndo(`${ids.length}개 휴지통으로 이동`, async () => {
    await sb.from("items").update({ deleted_at: null }).in("id", ids);
    loadItems();
  });
  toast(`${ids.length}개를 휴지통으로 옮겼어요`, "되돌리기", undo);
  return true;
}

async function moveItems(items, folder_id) {
  const { error } = await sb.from("items").update({ folder_id }).in("id", items.map((i) => i.id));
  if (error) { alert(error.message); return false; }
  // 원래 폴더별로 묶어서 되돌리기
  const byPrev = new Map();
  for (const it of items) {
    const k = it.folder_id ?? "";
    if (!byPrev.has(k)) byPrev.set(k, []);
    byPrev.get(k).push(it.id);
  }
  pushUndo(`${items.length}개 폴더 이동`, async () => {
    for (const [k, ids] of byPrev) await sb.from("items").update({ folder_id: k || null }).in("id", ids);
    loadItems();
  });
  toast(folder_id ? `${items.length}개를 '${folderName(folder_id)}'(으)로 옮겼어요` : `${items.length}개를 폴더에서 뺐어요`);
  return true;
}

// ---------- 복사 · 붙여넣기 ----------
const clipboard = { items: [] };

async function pasteItems() {
  if (inTrash()) return toast("휴지통에는 붙여넣을 수 없어요");
  const folder = targetFolder();
  if (!folder) return toast("붙여넣을 폴더를 사이드바에서 열어 주세요");
  const rows = clipboard.items.map((it) => ({
    kind: it.kind, title: it.title, body: it.body, url: it.url, file_path: it.file_path, folder_id: folder,
  }));
  const { data, error } = await sb.from("items").insert(rows).select("id");
  if (error) return alert(error.message);
  const ids = data.map((r) => r.id);
  pushUndo(`${ids.length}개 붙여넣기`, async () => {
    await sb.from("items").delete().in("id", ids); // 복사본만 지움 (파일은 원본이 계속 사용)
    loadItems();
  });
  toast(`${ids.length}개를 '${folderName(folder)}'에 붙여넣었어요`);
  loadItems();
}

// ---------- 단축키 (PC): ⌘/Ctrl + X 삭제 · C 복사 · V 붙여넣기 · Z 되돌리기 ----------
const isTyping = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
const shortcutsReady = () =>
  !!state.user && !isComposerOpen() && !$("library").classList.contains("hidden");

// 단축키 대상: 슬라이드쇼면 지금 사진, 아니면 선택한 항목들
function shortcutTargets() {
  if (isViewerOpen()) return viewer.list[viewer.i] ? [viewer.list[viewer.i]] : [];
  return state.selecting ? selectedItems() : [];
}

document.addEventListener("keydown", async (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || isTyping(e.target) || !shortcutsReady()) return;
  const key = e.key.toLowerCase();

  if (key === "z" && !e.shiftKey) { e.preventDefault(); return undoLast(); }

  if (key === "x") {
    const items = shortcutTargets();
    e.preventDefault();
    if (!items.length) return toast("먼저 항목을 선택해 주세요 (Shift + 클릭)");
    if (inTrash()) {
      if (!(await purgeWithConfirm(items, { reload: false }))) return;
    } else if (!(await trashMany(items))) return;
    if (isViewerOpen()) { viewer.dirty = true; viewer.list.splice(viewer.i, 1); showSlide(); }
    else { setSelecting(false); loadItems(); }
    return;
  }

  if (key === "c") {
    if (String(window.getSelection?.() || "").trim()) return; // 글자를 드래그해 둔 경우엔 원래 복사
    const items = shortcutTargets();
    if (!items.length || inTrash()) return;
    e.preventDefault();
    clipboard.items = items.map((i) => ({ ...i }));
    toast(`${items.length}개를 복사했어요 · 붙여넣을 폴더를 열고 ⌘V`);
  }
});

// ⌘V: 컴퓨터에서 복사한 이미지 → 업로드 / 앱에서 복사한 항목 → 지금 폴더에 붙여넣기
document.addEventListener("paste", (e) => {
  if (isTyping(e.target) || !shortcutsReady() || isViewerOpen()) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    if (inTrash()) return toast("휴지통에서는 올릴 수 없어요");
    return uploadFiles(files);
  }
  if (clipboard.items.length) { e.preventDefault(); pasteItems(); }
});

// Windows/Linux에서는 단축키 안내를 Ctrl로 표시
if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  for (const n of document.querySelectorAll(".shortcut-hint")) n.textContent = n.textContent.replaceAll("⌘", "Ctrl+");
}
