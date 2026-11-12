# 모아두기 (프로토타입)

글·사진·영상·음악을 직접 올려서 폴더(주제) 계층으로 정리하는 웹 서비스.

## 구조

```
Claude (코드 작성) → GitHub (버전 관리) → Cloudflare Workers (자동 배포) → Supabase (DB · 로그인 · 파일 저장)
```

| 경로 | 설명 |
|---|---|
| `public/` | 배포되는 정적 사이트 (HTML/CSS/JS, 빌드 과정 없음) |
| `public/config.js` | Supabase 주소와 공개용 키 |
| `wrangler.jsonc` | Cloudflare Workers 배포 설정 |
| `supabase/migrations/` | DB 테이블·보안 정책 기록 |

## 배포

`main` 브랜치에 푸시하면 Cloudflare가 자동으로 `npx wrangler deploy`를 실행해 배포한다.

## 로컬에서 보기

```bash
npx wrangler dev
```
