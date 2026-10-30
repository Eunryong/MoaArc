# MoaArc

> 여행 공동경비 관리 및 Arc Testnet 정산 웹앱

MoaArc는 여행 일정을 관리하고, 참여자 간 공동경비를 Arc 블록체인에서 투명하게 정산하는 앱입니다.

**핵심 흐름:** 일정 입력 → 비용 예측(에이전트) → 공동예산 편성 → 실제 지출 기록 → 예상/실제 비교 → 분담 승인 → 지갑 서명 → Arc Testnet 공동경비 정산

Built with [Arc Studio](https://studio.arc.io)

---

## 기술 스택

- **Frontend:** React 18, Vite 6, TypeScript 5, Tailwind CSS 3
- **Web3:** wagmi v2, viem v2, ConnectKit
- **Backend:** Hono, Bun, bun:sqlite (직접 SQL), SQLite
- **Contracts:** Solidity 0.8.28, Foundry
- **Chain:** Arc Testnet (Chain ID: 5042002) / Arc Mainnet (Chain ID: 5042) 환경변수로 전환
- **Token:** USDC (ERC-20, 6 decimals)
- **금액 처리:** 모든 금액 bigint 마이크로USDC (1 USDC = 1_000_000n)
- **인증:** Wallet Signature (nonce/JWT), Bearer only

---

## 개발 환경 설정

### 전제 조건

- [Bun](https://bun.sh) v1.3+
- [Foundry](https://getfoundry.sh) (계약 빌드/테스트)

### 설치 및 실행

```bash
# 1. 의존성 설치
bun install

# 2. 환경변수 설정 (아래 참고)
cp env.example .env
# .env를 편집해서 필수 값 채우기

# 3. 개발 서버 실행 (Vite + 백엔드 동시)
bun run dev        # Vite (localhost:5173)
bun run server     # Hono API 서버 (localhost:3001)

# 4. 검사
bun run check      # lint + typecheck
bun run contracts:test   # Foundry 계약 테스트 (75개)
```

### Clean checkout 재현 절차

```bash
git clone https://github.com/Eunryong/MoaArc.git
cd MoaArc
bun install             # bun.lock 기반 설치
npx tsc --noEmit        # 프런트엔드 typecheck (0 errors 기대)
npx tsc -p server/tsconfig.json --noEmit   # 서버 typecheck (0 errors 기대)
bun run check           # lint + typecheck 통합
```

> **주의:** `scripts/compass-deploy.ts`는 Arc Studio 내부 배포 스크립트로 `@circlefin/compass-chains`를 요구합니다.
> 이 패키지는 공개 npm에 없으며 Arc Studio 환경에서만 사용됩니다.
> `scripts/`는 `tsconfig.json`에서 제외되어 있으므로 일반 `tsc --noEmit`에 영향 없습니다.

---

## 환경변수

### 필수 (서버)

| 이름 | 목적 |
|------|------|
| `DATABASE_PATH` | SQLite 파일 경로 (기본: `server/prisma/dev.db`) |
| `JWT_SECRET` | JWT 서명 키 (랜덤 32바이트 이상 권장) |
| `MOARC_CONTRACT_ADDRESS` | 배포된 MoaArcTreasury 컨트랙트 주소 |
| `ARC_TESTNET_RPC_FALLBACK` | Arc Testnet 공개 RPC URL |

### 선택 (서버)

| 이름 | 목적 |
|------|------|
| `MOARC_NETWORK` | 정확히 소문자 `testnet`(기본) 또는 `mainnet`. 대소문자·공백이 다르거나 다른 값은 오류 (미설정/빈 값만 testnet 기본값) |
| `MOARC_CHAIN_ID` | 10진 정수. testnet 5042002(기본), mainnet 5042(필수) |
| `MOARC_USDC_ADDRESS` | USDC 주소 (mainnet 필수, 정확히 `0x3600…0000`) |
| `MOARC_CONTRACT_VERSION` | 기대 `VERSION()` (mainnet 은 `MoaArc-3.0` 고정) |
| `ARC_TESTNET_RPC_URL`(`_2`,`_3`), `ARC_RPC_URL`(`_2`,`_3`) | testnet 전용 추가 RPC |
| `ARC_MAINNET_RPC_URL`(`_2`,`_3`) | mainnet 전용 RPC (https 필수). 범용 `ARC_RPC_URL*`·테스트넷 fallback 은 mainnet 에서 사용 안 함 |
| `GEMINI_API_KEY` | Google AI Studio 키 (에이전트 기능) |
| `PORT` | 서버 포트 (기본: 3001) |

### 프런트엔드 빌드 (VITE_*)

| 이름 | 목적 |
|------|------|
| `VITE_NETWORK` | 정확히 소문자 `testnet`(기본) 또는 `mainnet` (서버 `MOARC_NETWORK` 와 동일 규칙) |
| `VITE_CONTRACT_ADDRESS` | mainnet 배포 시 필수 (테스트넷 배포 주소 거부) |
| `VITE_USDC_ADDRESS` | mainnet 배포 시 필수, 정확히 `0x3600…0000` |
| `VITE_CHAIN_ID` | mainnet 배포 시 필수 (`5042`) |
| `VITE_CONTRACT_VERSION` | 선택, mainnet 은 `MoaArc-3.0` 고정 |

Arc Mainnet 준비 체크리스트와 수동 Foundry 배포 절차는 [docs/MAINNET_DEPLOYMENT.md](docs/MAINNET_DEPLOYMENT.md) 를 참고하세요.
현재 mainnet 에 배포된 컨트랙트는 없습니다. 설정이 하나라도 잘못되면 앱은 온체인 write 를 차단합니다(fail-closed).

Arc Studio 환경에서 자동 주입되는 변수: `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` (Arc Studio 외부에서는 불필요).

---

## 배포된 컨트랙트

| 컨트랙트 | 네트워크 | 주소 | 상태 |
|---------|---------|------|------|
| TripSharedTreasury V1 | Arc Testnet | `0x0e540064015628b03ec62b44d94721b1b50e5d92` | Superseded |
| TripSharedTreasuryV2 | Arc Testnet | `0x3bc08cdabcf702e01b458923a946cd664e438c3e` | Superseded |
| MoaArcTreasury v2 | Arc Testnet | `0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3` | Superseded |
| **MoaArcTreasury v3** | **Arc Testnet** | **`0xf7a733fb2084b31591a0fbacded683efbe5b6728`** | **Active** |

---

## 계약 명령

```bash
bun run contracts:build   # forge build
bun run contracts:test    # forge test (75개 통과 — 53 unit + 2 invariant)
```

---

## 보안 고지

- 이 앱은 독립적인 제3자 보안 감사를 받지 않았습니다.
- Mainnet 배포 전 반드시 독립 감사를 받으십시오.
- `STUDIO_TEST_MODE` 인증 우회는 완전히 제거됐습니다.
