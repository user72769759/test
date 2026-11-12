// Cloudflare Worker: /api/* 요청만 처리하고, 나머지는 public/ 정적 파일을 그대로 제공
const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_IMAGE_CHARS = 2_000_000; // 약 1.5MB 이미지 (브라우저에서 미리 줄여서 보냄)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/classify" && request.method === "POST") return classify(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

// Supabase 로그인 토큰이 유효한지 확인 (로그인한 사용자만 AI 사용 가능)
async function getUser(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_KEY, authorization: auth },
  });
  return res.ok ? res.json() : null;
}

const KIND_LABEL = { note: "글", image: "사진", video: "영상", audio: "음악", link: "링크", file: "파일" };

async function classify(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요" }, 401);

  let input;
  try { input = await request.json(); } catch { return json({ error: "잘못된 요청" }, 400); }

  const topics = (Array.isArray(input.topics) ? input.topics : []).map(String).slice(0, 100);
  const clip = (s, n) => (s ? String(s).slice(0, n) : "");
  const lines = [
    `기존 주제 목록: ${topics.length ? topics.join(", ") : "(없음)"}`,
    `종류: ${KIND_LABEL[input.kind] || "기타"}`,
    `제목/파일명: ${clip(input.title, 200)}`,
    input.body ? `내용: ${clip(input.body, 2000)}` : null,
    input.url ? `링크: ${clip(input.url, 500)}` : null,
  ].filter(Boolean);

  const content = [{ type: "text", text: lines.join("\n") }];
  const image = typeof input.image === "string" && input.image.startsWith("data:image/") && input.image.length <= MAX_IMAGE_CHARS
    ? input.image : null;
  if (image) content.push({ type: "image_url", image_url: { url: image } });

  const system =
    "너는 사용자가 저장한 콘텐츠(사진, 글, 영상, 음악, 링크)를 주제별 폴더로 분류하는 도우미야. " +
    '반드시 JSON 한 줄만 출력해: {"topic":"주제"}. ' +
    "주제는 한국어 명사 1~2단어(최대 10자)로, 너무 구체적이지 않은 넓은 주제여야 해 " +
    "(예: 여행, 음식, 패션, 인테리어, 운동, 공부, 개발, 디자인, 음악, 영화, 반려동물, 일상, 쇼핑, 자연). " +
    "기존 주제 목록 중 어울리는 것이 있으면 반드시 그 이름을 글자 그대로 써. 판단이 어려우면 \"기타\".";

  let raw = "";
  try {
    const result = await env.AI.run(MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content }],
      max_tokens: 40,
      temperature: 0.2,
    });
    raw = typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? result);
  } catch (e) {
    return json({ error: "AI 호출 실패: " + (e?.message || e) }, 502);
  }

  let topic = "";
  try { topic = JSON.parse(raw.match(/\{[\s\S]*?\}/)?.[0] ?? "{}").topic ?? ""; } catch {}
  topic = String(topic).replace(/["'`\n\r]/g, "").trim().slice(0, 20) || "기타";

  // 기존 주제와 띄어쓰기/대소문자만 다르면 기존 이름으로 맞춤
  const norm = (s) => s.replace(/\s+/g, "").toLowerCase();
  topic = topics.find((t) => norm(t) === norm(topic)) ?? topic;

  return json({ topic, usedImage: !!image });
}
