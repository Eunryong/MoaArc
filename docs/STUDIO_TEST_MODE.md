# STUDIO_TEST_MODE — Arc Studio 프리뷰 전용 인증 우회

## 목적

Arc Studio 프리뷰 게이트웨이는 `Authorization` 헤더를 포함한 모든 커스텀 헤더를 제거합니다.  
이로 인해 JWT 기반 인증이 프리뷰 환경에서 동작하지 않습니다.  
`STUDIO_TEST_MODE`는 이 제약을 우회해 기능 테스트만 가능하게 하는 **임시 개발 전용** 모드입니다.

> **이 모드는 실제 인증이 아닙니다. 합성 데이터와 Arc Testnet 전용으로만 사용하세요.**

---

## 활성화 방법 (실행 명령에서만)

서버:
```bash
STUDIO_TEST_MODE=1 bun run server/src/index.ts
```

Vite 프런트엔드:
```bash
VITE_STUDIO_TEST_MODE=1 bun run dev
```

`.env` 파일에 이 값을 저장하지 마세요. 커밋되는 파일에 켜진 상태가 남으면 안 됩니다.

---

## 동작

- **서버**: `Authorization` 헤더가 없을 때 `?as=0x<address>` 쿼리를 `callerAddress`로 사용합니다.
- **클라이언트**: 지갑 연결만으로 인증된 것으로 간주하고, 보호 API 요청 URL에 `?as=<address>`를 자동 추가합니다.
- **배지**: 화면 상단에 "⚠️ TEST MODE: 서버 인증 우회 (Studio 전용)" 배지가 표시됩니다.

---

## 이중 잠금

1. 서버: `STUDIO_TEST_MODE=1` + `NODE_ENV=production` 조합이면 **즉시 `process.exit(1)`**.
2. 클라이언트: `import.meta.env.DEV !== true`이면 (빌드 결과물) 코드가 완전히 비활성.

---

## 메인넷 / 외부 배포 전 반드시 제거할 항목

- [ ] `server/src/middleware/requireAuth.ts` — `STUDIO_TEST_MODE` 상수 및 `as=` 분기 (`if (STUDIO_TEST_MODE) { ... }` 블록)
- [ ] `server/src/index.ts` — `STUDIO_TEST_MODE` 안전 가드 블록
- [ ] `src/apiClient.ts` — `STUDIO_TEST_MODE` 상수, `setStudioTestAddress`, `getStudioTestAddress`, `studioAs` 쿼리 추가 코드
- [ ] `src/useServerSync.ts` — `STUDIO_TEST_MODE` import 및 `useAuthState`의 스튜디오 분기
- [ ] `src/App.tsx` — `STUDIO_TEST_MODE` import, `setStudioTestAddress` useEffect, TEST MODE 배지 JSX
- [ ] 환경변수 `STUDIO_TEST_MODE`, `VITE_STUDIO_TEST_MODE` — 실행 스크립트/CI에서 제거
- [ ] 이 문서(`docs/STUDIO_TEST_MODE.md`) — 필요 없으면 삭제 가능

---

## 확인

제거 후 아래를 검증하세요:

1. `STUDIO_TEST_MODE` 없이 서버 시작 → `?as=` 쿼리 무시, 401 반환 확인
2. 빌드 결과물에 `VITE_STUDIO_TEST_MODE` 관련 코드 없음 확인 (`grep -r "studio-test" dist/`)
3. `STUDIO_TEST_MODE=1 NODE_ENV=production` 조합으로 서버 시작 시 즉시 종료 확인
