# MoaArc

> 여행 공동경비 관리 및 Arc Testnet 정산 웹앱

MoaArc는 여행 일정을 관리하고, 참여자 간 공동경비를 Arc 블록체인에서 투명하게 정산하는 앱입니다.

**핵심 흐름:** 일정 입력 → 비용 예측(에이전트) → 공동예산 편성 → 실제 지출 기록 → 예상/실제 비교 → 분담 승인 → 지갑 서명 → Arc Testnet 공동경비 정산

---

## 구현된 기능

### 스마트 컨트랙트 (`MoaArkTreasury` — Arc Testnet 배포 완료)
- **주소:** `0x63aff048f159b1712e7c8d728cdc61b004eed40e` ([Arc 탐색기](https://explorer.testnet.arc.io/address/0x63aff048f159b1712e7c8d728cdc61b004eed40e))
- 여행방 생성 (`createTrip`) — 관리자 + 참여자 등록, 최대 50명
- 입금 (`deposit`) — USDC ERC-20 approve + transferFrom, 여행방별 잔액 분리
- 예산 이체 (`releaseBudget`) — 결제자 외부 지갑으로 공동자금 이체 (참여자만 가능)
- 예산 반납 (`returnUnusedBudget`) — 외부 지갑 공동자금을 컨트랙트로 반환
- 부족분 납입 (`payDeficit`) — 최종 정산 시 추가 납부
- 최종 정산 제안 (`proposeFinalSettlement`) — 관리자 제출, 온체인 해시 파생
- 정산 승인 (`approveFinalSettlement`) — 참여자 전원 서명 필요
- 환급 수령 (`claimRefund`) — 전원 승인 + 부족분 완납 + 잔액 일치 검증 후 개별 수령
- `SettlementStatus` 상태머신 (None → Proposed → DeficitPaying → ClaimStarted → Completed)
- 개인 선결제 기록 (`recordPersonalPrepaid`) / 실제 사용액 기록 (`recordActualSpend`)
- 정산 제안 후 `releaseBudget`/`returnUnusedBudget` 잠금 (`MoaArcTreasury` v2에서 구현 예정)

### 프론트엔드
- **DEMO 모드:** A/B/C/D 시연 데이터, 역할 전환, 시연 초기화 — 실제 트랜잭션 없음
- **TESTNET 모드:** 지갑 연결 필수, Arc Testnet 지갑 주소로 참여자 인식, 역할 전환 비활성화
- 상단 요약 바: 내가 낸 돈 / 내가 부담한 돈 / 돌려받거나 추가로 낼 돈 (bigint 정수 계산)
- 탭 5개: 대시보드, 내 경비, 지출 목록, 최종 정산, 일정·에이전트
- 지출 분담 수정 (관리자 전용) + 전원 승인 흐름 (버전 이력, 수정 요청)
- 전액/비율 환불 처리 (bigint 정수 비례 계산, 마지막 참여자 보정)
- 온체인 읽기 훅: `tripBalance`, `depositedAmount`, `allocatedBudget`, `isParticipant`, `settlementStatus`, USDC 잔액 등 (15초 interval refetch)
- 온체인 쓰기 훅: `deposit`, `releaseBudget`, `returnUnusedBudget`, `payDeficit`, `approveFinalSettlement`, `claimRefund`, `createTrip`
- 트랜잭션 영수증 확인 후 성공 처리 + Arc Testnet 탐색기 링크 제공
- 일정·에이전트 탭: 일정 목록, 비용 예측 표시 (출처/신뢰도/조회 시각), 에이전트 대화

---

## 구현 상태 및 제한

| 항목 | 상태 | 비고 |
|------|------|------|
| **백엔드 서버 / 영속 DB** | ✅ 구현됨 | Hono + Prisma + SQLite(개발), `bun run server` |
| **지갑 서명 인증 (nonce/JWT)** | ✅ 구현됨 | `GET /api/auth/nonce` + `POST /api/auth/verify`, 24h JWT |
| **여행방 DB 등록/목록** | ✅ 구현됨 | `POST /api/trips`, `GET /api/trips` (참여자별 필터) |
| **일정 CRUD** | ✅ 구현됨 | `GET/POST /api/trips/:id/itinerary`, PATCH 지원 |
| **지출 기록·승인 흐름** | ✅ 구현됨 | 버전 이력, 수정 요청, 전원 승인 |
| **Gemini 에이전트 실검색** | ⚠️ 부분 | `GEMINI_API_KEY` 미설정 시 응답 없음, 설정 시 활성 |
| **푸시 알림** | ❌ 앱 내 표시만 | 백그라운드 서버·웹소켓 필요 |
| **정산 중 잔액 변경 잠금** | ⚠️ 부분 | `MoaArcTreasury` v2 배포 예정 |
| **실제 tripId 동적 파싱** | ⚠️ 부분 | `TripCreated` 이벤트 파싱 완성 필요 |
| **Mainnet 배포** | 🚫 금지 | 독립 보안 감사 + 사용자 직접 배포 |

### 백엔드 실행

```bash
# .env 또는 환경변수 설정 (env.example 참고)
DATABASE_URL=file:./server/prisma/dev.db
JWT_SECRET=<랜덤 32바이트 이상>
MOARC_CONTRACT_ADDRESS=0x63aff048f159b1712e7c8d728cdc61b004eed40e
ARC_TESTNET_RPC_FALLBACK=https://rpc.testnet.arc.io

bun run server          # API 서버 (localhost:3001)
bun run dev             # Vite 개발 서버 (localhost:5173, /api → 3001 프록시)
```

### Arc Studio 프리뷰 환경

Arc Studio 프리뷰(`*.preview.studio.arc.io`)에서는 Vite proxy(`/api → localhost:3001`)가 브라우저와 서버를 연결합니다. 절대 주소(`http://localhost:3001`)는 브라우저에서 도달 불가이므로 항상 상대 경로(`/api/...`)를 사용합니다.

---

## 배포된 컨트랙트

| 컨트랙트 | 네트워크 | 주소 | 상태 |
|---------|---------|------|------|
| TripSharedTreasury (V1) | Arc Testnet | `0x0e540064015628b03ec62b44d94721b1b50e5d92` | Superseded |
| TripSharedTreasuryV2 | Arc Testnet | `0x3bc08cdabcf702e01b458923a946cd664e438c3e` | Superseded |
| **MoaArkTreasury** | **Arc Testnet** | **`0x63aff048f159b1712e7c8d728cdc61b004eed40e`** | **Active** |

> 이미 배포된 컨트랙트는 온체인에서 이름을 변경할 수 없습니다. 안전성 수정이 필요하면 새 `MoaArcTreasury` 컨트랙트를 Arc Testnet에 배포합니다.

---

## 설치 및 실행

```bash
bun install
bun run dev        # 개발 서버 (localhost:5173)
bun run check      # lint + typecheck
bun run contracts:test   # Foundry 단위 테스트 (42개)
bun run contracts:build  # forge build
```

### 환경변수 (`.env.example` 참고)

```env
# Gemini API (서버 전용 — 클라이언트 번들에 포함 금지)
GEMINI_API_KEY=

# 모델 ID (기본값: gemini-2.0-flash)
GEMINI_MODEL_ID=gemini-2.0-flash

# DB (서버 구현 시)
DATABASE_URL=
```

---

## 기술 스택

- **Frontend:** React 18, Vite, TypeScript, Tailwind CSS
- **Web3:** wagmi v2, viem v2, ConnectKit
- **Contracts:** Solidity 0.8.28, Foundry
- **Chain:** Arc Testnet (Chain ID: 5042002)
- **Token:** USDC (ERC-20, 6 decimals, `0x3600000000000000000000000000000000000000`)
- **금액 처리:** 모든 금액 bigint 마이크로USDC (1 USDC = 1_000_000n)

---

## 보안 고지

- 이 앱은 독립적인 제3자 보안 감사를 받지 않았습니다.
- 지출 내역은 수동 기록이며 외부 결제 시스템의 거래를 검증하지 않습니다.
- 영수증 첨부는 참여자 확인 기록이며 카드사/결제 플랫폼 검증과 다릅니다.
- Mainnet 배포 전 반드시 독립 감사를 받으십시오.
