// ─── 지갑 세션 판정 / 정리 로직 (순수 TS — React·wagmi·DOM 의존 없음, 단위 테스트 가능) ──
//
// 원칙
//  1. 비공개 화면은 "지갑이 connected 이고, 저장된 토큰의 subject 가 그 지갑 주소와 같을 때"만 보인다.
//  2. connecting / reconnecting(새로고침, 체인 전환 중 재연결)은 "일시 상태" — 화면은 숨기되 토큰은 지우지 않는다.
//  3. disconnected 는 즉시 화면·메모리 상태를 비우고, 짧은 유예(grace) 뒤 앱 토큰을 지운다.
//  4. 계정 전환(A→B)은 "떠나는 계정 A 의 토큰"만 지운다. 다른 subject 의 토큰은 다른 탭의 유효 세션일 수 있으므로
//     지우지 않고, 대신 절대 사용하지 않는다(= 타 지갑 토큰 부활 금지).
//  5. 비동기 응답은 ScopeGuard 티켓으로 검증해 세션이 바뀐 뒤 도착한 응답을 버린다.
//
// 주의: 이것은 "클라이언트 측" 세션 종료입니다. 서버 JWT 는 stateless 라 서버에서 폐기되지 않으며,
// 만료(exp)까지 토큰을 가진 쪽에서는 유효합니다.

export const TOKEN_KEY = "moaarc_auth_token";

/** localStorage 호환 최소 인터페이스 (테스트에서 메모리 구현 주입) */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ─── JWT 클레임(서명 검증 아님 — UX 가드용) ──────────────────────────────────

export interface JwtClaims {
  sub?: string;
  exp?: number;
}

/**
 * JWT payload 를 디코딩합니다. 서명은 검증하지 않습니다(클라이언트는 비밀키가 없음).
 * 이 값은 "이 토큰을 이 지갑 주소에 쓸 수 있는가" 를 판단하는 보조 용도이며,
 * 실제 인증/인가는 서버가 매 요청마다 서명을 검증해 수행합니다.
 */
export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { sub, exp } = parsed as Record<string, unknown>;
    return {
      sub: typeof sub === "string" ? sub : undefined,
      exp: typeof exp === "number" ? exp : undefined,
    };
  } catch {
    return null;
  }
}

export function normalizeAddress(address: string | null | undefined): string | null {
  return address ? address.toLowerCase() : null;
}

/** 토큰 subject 가 주소와 같고(대소문자 무시), exp 가 있으며 아직 만료되지 않았는가 */
export function isTokenForAddress(token: string | null, address: string | null | undefined, nowMs: number): boolean {
  if (!token || !address) return false;
  const claims = decodeJwtClaims(token);
  if (!claims?.sub || claims.exp === undefined) return false;
  if (claims.sub.toLowerCase() !== address.toLowerCase()) return false;
  return claims.exp * 1000 > nowMs;
}

// ─── 세션 단계 판정 ──────────────────────────────────────────────────────────

export type WalletStatus = "connected" | "connecting" | "reconnecting" | "disconnected";

export type SessionPhase =
  /** 지갑 연결/재연결 진행 중 — 화면은 숨기되 토큰·상태는 유지 */
  | "pending"
  /** 지갑 없음 — 즉시 모든 비공개 화면/상태 제거 */
  | "disconnected"
  /** 지갑은 연결됐지만 이 지갑 소유의 유효한 토큰이 없음 — 로그인 필요 */
  | "unauthenticated"
  /** 지갑 연결 + 토큰 subject 일치 + 미만료 */
  | "authenticated";

export function resolveSessionPhase(input: {
  status: WalletStatus;
  address: string | undefined;
  token: string | null;
  nowMs: number;
}): SessionPhase {
  if (input.status === "connecting" || input.status === "reconnecting") return "pending";
  if (input.status === "disconnected" || !input.address) return "disconnected";
  return isTokenForAddress(input.token, input.address, input.nowMs) ? "authenticated" : "unauthenticated";
}

/** 비공개 데이터를 렌더링해도 되는 유일한 단계 */
export function canShowPrivateData(phase: SessionPhase): boolean {
  return phase === "authenticated";
}

/**
 * React key / 데이터 스코프 식별자. pending 은 null(= 직전 스코프 유지).
 * 같은 값이면 같은 세션, 다르면 상태를 모두 버려야 합니다.
 */
export function scopeIdFor(phase: SessionPhase, address: string | undefined): string | null {
  if (phase === "pending") return null;
  if (phase === "disconnected") return "none";
  return `${normalizeAddress(address)}|${phase === "authenticated" ? "auth" : "anon"}`;
}

// ─── 스코프 가드 (비동기 응답 stale 방지) ────────────────────────────────────

export interface ScopeGuard {
  /** 요청 시작 시 발급받는 티켓 */
  ticket(): number;
  /** 응답 도착 시 확인 — false 면 응답을 버려야 함 */
  isCurrent(ticket: number): boolean;
  /** 세션/계정이 바뀌면 호출 — 이전 티켓 전부 무효화 */
  bump(): void;
}

export function createScopeGuard(): ScopeGuard {
  let epoch = 0;
  return {
    ticket: () => epoch,
    isCurrent: (t) => t === epoch,
    bump: () => { epoch += 1; },
  };
}

// ─── 세션 컨트롤러 (부수효과: 토큰 삭제·가드 무효화·유예 타이머) ─────────────

export interface SessionControllerDeps {
  storage: TokenStorage;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** disconnected 후 토큰을 지우기까지의 유예(ms). 체인 전환 중 일시적 disconnected 깜빡임 흡수용 */
  graceMs?: number;
  /** 스코프가 바뀌어 메모리 상태를 비워야 할 때 */
  onScopeReset?: (info: { from: string | null; to: string }) => void;
  /** 컨트롤러가 저장소 토큰을 지운 뒤 (화면 재평가용) */
  onTokenCleared?: () => void;
}

export const DEFAULT_DISCONNECT_GRACE_MS = 1_000;

export class SessionController {
  readonly guard: ScopeGuard = createScopeGuard();
  private scope: string | null = null;
  /** 마지막으로 연결됐던 지갑 주소(소문자) — disconnect 를 거친 계정 전환(A→끊김→B)에서도 A 의 토큰을 정리하기 위함 */
  private lastAddress: string | null = null;
  private graceTimer: unknown = null;
  private readonly graceMs: number;

  constructor(private readonly deps: SessionControllerDeps) {
    this.graceMs = deps.graceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  }

  currentScope(): string | null { return this.scope; }

  /** 지갑 상태가 바뀔 때마다(렌더 후 layout effect) 호출 */
  update(input: { status: WalletStatus; address: string | undefined }): SessionPhase {
    const token = this.deps.storage.getItem(TOKEN_KEY);
    const phase = resolveSessionPhase({ ...input, token, nowMs: this.deps.now() });
    const next = scopeIdFor(phase, input.address);

    if (next !== null && next !== this.scope) {
      const prev = this.scope;
      this.guard.bump(); // 이전 스코프에서 시작된 모든 in-flight 응답 무효화

      // 계정 전환(직전에 쓰던 계정 ≠ 새 계정): "떠나는 계정"의 토큰만 삭제한다.
      // 다른 subject 의 토큰은 다른 탭의 유효 세션일 수 있어 건드리지 않는다.
      // disconnect(next === "none")는 여기서 지우지 않고 유예 타이머가 처리한다.
      const nextAddress = next !== "none" ? next.split("|")[0] : null;
      const leaving = this.lastAddress;
      if (nextAddress && leaving && leaving !== nextAddress) {
        const stored = this.deps.storage.getItem(TOKEN_KEY);
        if (stored && decodeJwtClaims(stored)?.sub?.toLowerCase() === leaving) {
          this.deps.storage.removeItem(TOKEN_KEY);
          this.deps.onTokenCleared?.();
        }
      }
      if (nextAddress) this.lastAddress = nextAddress;

      this.scope = next;
      this.deps.onScopeReset?.({ from: prev, to: next });
    }

    // disconnected: 유예 후 토큰 삭제. 그 사이 다시 연결되거나 reconnecting이 되면 취소.
    // pending(reconnecting): 체인 전환·지갑 초기화 중 disconnected→pending→connected 경로에서
    //   disconnected 시점에 시작된 타이머가 pending 구간 중에 만료되면 유효한 토큰이 삭제됩니다.
    //   reconnecting은 곧 연결로 복구된다는 의미이므로 이미 돌고 있는 유예 타이머를 취소합니다.
    //   pending에서 결국 disconnected로 끝나면 그 update() 호출에서 타이머를 새로 시작합니다.
    if (phase === "disconnected") {
      this.armGraceClear();
    } else {
      // connected, unauthenticated, pending 모두 유예 타이머 취소
      this.cancelGraceClear();
    }
    return phase;
  }

  /**
   * 서버가 토큰을 거부(401)했거나 만료 — 토큰 삭제 + 모든 in-flight 무효화.
   * usedToken 을 주면 "그 토큰이 아직 저장돼 있을 때만" 삭제합니다
   * (그 사이 새로 로그인해 저장된 다른 토큰을 오래된 401 이 지우지 못하게).
   */
  expire(usedToken?: string): void {
    const stored = this.deps.storage.getItem(TOKEN_KEY);
    if (usedToken !== undefined && stored !== usedToken) return;
    this.deps.storage.removeItem(TOKEN_KEY);
    this.guard.bump();
    this.deps.onTokenCleared?.();
  }

  dispose(): void { this.cancelGraceClear(); }

  private armGraceClear(): void {
    if (this.graceTimer !== null) return;
    // 유예 시작 시점의 토큰만 지운다 — 그 사이 다른 탭이 새로 저장한 토큰은 보존
    const armedToken = this.deps.storage.getItem(TOKEN_KEY);
    this.graceTimer = this.deps.setTimer(() => {
      this.graceTimer = null;
      if (this.deps.storage.getItem(TOKEN_KEY) === armedToken && armedToken !== null) {
        this.deps.storage.removeItem(TOKEN_KEY);
        this.deps.onTokenCleared?.();
      }
    }, this.graceMs);
  }

  private cancelGraceClear(): void {
    if (this.graceTimer === null) return;
    this.deps.clearTimer(this.graceTimer);
    this.graceTimer = null;
  }
}
