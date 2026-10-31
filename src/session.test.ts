// bun:test 타입 선언 파일을 명시적으로 로드합니다 (루트 tsconfig 는 bun 타입을 자동 포함하지 않음, 런타임 영향 없음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/**
 * 지갑 세션(연결 해제 / 계정 전환 / 새로고침 / 경합) 테스트.
 * 순수 로직(session.ts)만 사용합니다 — 네트워크·지갑·DB 없음.
 */

import { describe, test, expect } from "bun:test";
import { NOW, b64url, fakeJwt, MemoryStorage, FakeTimers } from "./session.testkit";
import {
  SessionController,
  TOKEN_KEY,
  canShowPrivateData,
  createScopeGuard,
  decodeJwtClaims,
  isTokenForAddress,
  resolveSessionPhase,
  scopeIdFor,
  type WalletStatus,
} from "./session";

// ─── 테스트 도구 ─────────────────────────────────────────────────────────────

const A = "0xAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeController(storage = new MemoryStorage(), timers = new FakeTimers()) {
  const resets: Array<{ from: string | null; to: string }> = [];
  let tokenCleared = 0;
  const controller = new SessionController({
    storage,
    now: () => NOW,
    setTimer: timers.set,
    clearTimer: timers.clear,
    graceMs: 1000,
    onScopeReset: (i) => resets.push(i),
    onTokenCleared: () => { tokenCleared += 1; },
  });
  return { controller, storage, timers, resets, tokenCleared: () => tokenCleared };
}

const last = <T>(a: T[]): T | undefined => a[a.length - 1];
const wallet = (status: WalletStatus, address?: string) => ({ status, address });

// ─── JWT 클레임 / subject 검증 ───────────────────────────────────────────────

describe("decodeJwtClaims / isTokenForAddress", () => {
  test("정상 토큰에서 sub·exp 추출", () => {
    const c = decodeJwtClaims(fakeJwt(A, 2_000_000_000));
    expect(c).toEqual({ sub: A.toLowerCase(), exp: 2_000_000_000 });
  });

  test("형식이 깨졌거나 JSON 이 아니면 null", () => {
    expect(decodeJwtClaims("abc")).toBeNull();
    expect(decodeJwtClaims("a.b.c")).toBeNull();
    expect(decodeJwtClaims("a.!!!.c")).toBeNull();
  });

  test("subject 와 주소가 같으면(대소문자 무시) 유효", () => {
    expect(isTokenForAddress(fakeJwt(A), A, NOW)).toBe(true);
    expect(isTokenForAddress(fakeJwt(A), A.toUpperCase().replace("0X", "0x"), NOW)).toBe(true);
  });

  test("다른 지갑의 토큰 / 주소 없음 / 토큰 없음은 무효", () => {
    expect(isTokenForAddress(fakeJwt(A), B, NOW)).toBe(false);
    expect(isTokenForAddress(fakeJwt(A), undefined, NOW)).toBe(false);
    expect(isTokenForAddress(null, A, NOW)).toBe(false);
  });

  test("만료되었거나 exp 가 없는 토큰은 무효", () => {
    expect(isTokenForAddress(fakeJwt(A, NOW / 1000 - 1), A, NOW)).toBe(false);
    const noExp = `${b64url({ alg: "HS256" })}.${b64url({ sub: A.toLowerCase() })}.sig`;
    expect(isTokenForAddress(noExp, A, NOW)).toBe(false);
  });
});

// ─── 단계 판정 ───────────────────────────────────────────────────────────────

describe("resolveSessionPhase", () => {
  const tokenA = fakeJwt(A);
  const phase = (status: WalletStatus, address: string | undefined, token: string | null) =>
    resolveSessionPhase({ status, address, token, nowMs: NOW });

  test("connecting / reconnecting 은 pending (비공개 화면 숨김, 아직 로그아웃 아님)", () => {
    expect(phase("reconnecting", A, tokenA)).toBe("pending");
    expect(phase("connecting", undefined, tokenA)).toBe("pending");
    expect(canShowPrivateData("pending")).toBe(false);
  });

  test("disconnected 이거나 주소가 없으면 disconnected", () => {
    expect(phase("disconnected", undefined, tokenA)).toBe("disconnected");
    expect(phase("connected", undefined, tokenA)).toBe("disconnected");
    expect(canShowPrivateData("disconnected")).toBe(false);
  });

  test("토큰이 없으면 unauthenticated", () => {
    expect(phase("connected", A, null)).toBe("unauthenticated");
  });

  test("다른 지갑의 토큰이 저장돼 있어도 비공개 화면을 열지 않음 (타 계정 토큰 부활 금지)", () => {
    expect(phase("connected", B, tokenA)).toBe("unauthenticated");
    expect(canShowPrivateData(phase("connected", B, tokenA))).toBe(false);
  });

  test("만료된 토큰은 unauthenticated", () => {
    expect(phase("connected", A, fakeJwt(A, NOW / 1000 - 5))).toBe("unauthenticated");
  });

  test("연결 + subject 일치 + 미만료일 때만 authenticated", () => {
    expect(phase("connected", A, tokenA)).toBe("authenticated");
    expect(canShowPrivateData("authenticated")).toBe(true);
    expect(canShowPrivateData("unauthenticated")).toBe(false);
  });
});

describe("scopeIdFor", () => {
  test("pending 은 null(직전 스코프 유지), disconnected 는 none, 그 외 주소+인증여부", () => {
    expect(scopeIdFor("pending", A)).toBeNull();
    expect(scopeIdFor("disconnected", undefined)).toBe("none");
    expect(scopeIdFor("authenticated", A)).toBe(`${A.toLowerCase()}|auth`);
    expect(scopeIdFor("unauthenticated", A)).toBe(`${A.toLowerCase()}|anon`);
  });
});

describe("ScopeGuard", () => {
  test("bump 이전에 발급된 티켓은 무효", () => {
    const g = createScopeGuard();
    const t1 = g.ticket();
    expect(g.isCurrent(t1)).toBe(true);
    g.bump();
    expect(g.isCurrent(t1)).toBe(false);
    expect(g.isCurrent(g.ticket())).toBe(true);
  });
});

// ─── 컨트롤러: disconnect ────────────────────────────────────────────────────

describe("SessionController — disconnect", () => {
  test("Disconnect 즉시 비공개 단계가 해제되고 상태 초기화 + in-flight 무효화, 토큰은 유예 후 삭제", () => {
    const { controller, storage, timers, resets, tokenCleared } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));

    expect(controller.update(wallet("connected", A))).toBe("authenticated");
    const ticket = controller.guard.ticket();

    expect(controller.update(wallet("disconnected"))).toBe("disconnected");
    // 즉시: 스코프 리셋 + 티켓 무효
    expect(last(resets)).toEqual({ from: `${A.toLowerCase()}|auth`, to: "none" });
    expect(controller.guard.isCurrent(ticket)).toBe(false);
    // 유예 중에는 토큰이 아직 있다 (체인 전환 깜빡임 흡수)
    expect(storage.getItem(TOKEN_KEY)).not.toBeNull();

    timers.advance(1000);
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(tokenCleared()).toBe(1);
  });

  test("유예 안에 같은 지갑이 다시 연결되면 토큰 보존(세션 복구), 삭제 타이머 취소", () => {
    const { controller, storage, timers } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    controller.update(wallet("disconnected"));
    expect(timers.pending()).toBe(1);

    expect(controller.update(wallet("connected", A))).toBe("authenticated");
    expect(timers.pending()).toBe(0);
    timers.advance(5000);
    expect(storage.getItem(TOKEN_KEY)).not.toBeNull();
  });

  test("유예 안에 다른 지갑이 연결되면 그 지갑은 로그인 전 상태이고 이전 토큰은 사용되지 않음", () => {
    const { controller, storage } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    controller.update(wallet("disconnected"));
    expect(controller.update(wallet("connected", B))).toBe("unauthenticated");
  });

  test("유예 중 다른 탭이 새 토큰을 저장했다면 그 토큰은 지우지 않음", () => {
    const { controller, storage, timers } = makeController();
    const oldToken = fakeJwt(A);
    storage.setItem(TOKEN_KEY, oldToken);
    controller.update(wallet("connected", A));
    controller.update(wallet("disconnected"));
    const newToken = fakeJwt(B, NOW / 1000 + 7200);
    storage.setItem(TOKEN_KEY, newToken); // 다른 탭에서 B 로 로그인
    timers.advance(1000);
    expect(storage.getItem(TOKEN_KEY)).toBe(newToken);
  });

  test("처음부터 disconnected 인 새 방문에서도 남아 있던 토큰을 유예 후 정리", () => {
    const { controller, storage, timers } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    expect(controller.update(wallet("disconnected"))).toBe("disconnected");
    timers.advance(1000);
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
  });
});

// ─── 컨트롤러: 새로고침 / 재연결 / 체인 전환 ─────────────────────────────────

describe("SessionController — reload & transient states", () => {
  test("새로고침: reconnecting 동안 토큰 유지·화면 숨김, 같은 지갑이 복구되면 로그인 없이 복귀", () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    // 새 페이지 로드 = 새 컨트롤러
    const { controller, timers, resets } = makeController(storage);

    const pending = controller.update(wallet("reconnecting"));
    expect(pending).toBe("pending");
    expect(canShowPrivateData(pending)).toBe(false);
    expect(storage.getItem(TOKEN_KEY)).not.toBeNull();
    expect(timers.pending()).toBe(0);
    expect(resets).toHaveLength(0); // pending 은 스코프를 건드리지 않음

    expect(controller.update(wallet("connected", A))).toBe("authenticated");
    expect(storage.getItem(TOKEN_KEY)).not.toBeNull();
  });

  test("새로고침 후 다른 지갑으로 복구되면 이전 토큰은 사용되지 않음 (그리고 다른 subject 토큰은 삭제하지도 않음)", () => {
    const storage = new MemoryStorage();
    const tokenA = fakeJwt(A);
    storage.setItem(TOKEN_KEY, tokenA);
    const { controller } = makeController(storage);
    controller.update(wallet("reconnecting"));
    expect(controller.update(wallet("connected", B))).toBe("unauthenticated");
    // 다른 탭의 A 세션일 수 있으므로 삭제하지 않음
    expect(storage.getItem(TOKEN_KEY)).toBe(tokenA);
  });

  test("disconnected→pending(reconnecting)→connected: pending 진입 시 유예 타이머 취소 → 토큰 보존", () => {
    // ConnectKit/일부 지갑은 첫 연결 직후 disconnected를 잠깐 거쳤다가 reconnecting→connected로 복구합니다.
    // 이전 동작: pending 중에도 타이머가 유지되어 1초 뒤 토큰이 삭제 → 로그인 성공 직후 로그아웃 증상.
    // 수정 후: pending 진입 시 타이머를 취소하여 정상 복구 경로에서 토큰을 보존합니다.
    const { controller, storage, timers } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));

    // disconnected: 유예 타이머 시작
    controller.update(wallet("disconnected"));
    expect(timers.pending()).toBe(1);

    // reconnecting(pending): 타이머 즉시 취소
    controller.update(wallet("reconnecting", A));
    expect(timers.pending()).toBe(0);

    // 1초 경과해도 토큰은 살아있어야 함
    timers.advance(1000);
    expect(storage.getItem(TOKEN_KEY)).not.toBeNull();

    // connected 복구 → authenticated
    expect(controller.update(wallet("connected", A))).toBe("authenticated");
    expect(storage.getItem(TOKEN_KEY)).not.toBeNull();
  });

  test("disconnected→pending→disconnected: pending에서 타이머 취소 후 다시 disconnected 되면 새 타이머 시작", () => {
    const { controller, storage, timers } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));

    controller.update(wallet("disconnected"));
    expect(timers.pending()).toBe(1);

    controller.update(wallet("reconnecting", A));
    expect(timers.pending()).toBe(0); // 취소됨

    // 재연결 실패 → 다시 disconnected
    controller.update(wallet("disconnected"));
    expect(timers.pending()).toBe(1); // 새 타이머 시작

    timers.advance(1000);
    expect(storage.getItem(TOKEN_KEY)).toBeNull(); // 이번엔 삭제
  });

  test("체인 전환 중 connected→reconnecting→connected: 토큰·스코프·티켓 모두 유지", () => {
    const { controller, storage, resets } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    const ticket = controller.guard.ticket();
    const resetsBefore = resets.length;

    expect(controller.update(wallet("reconnecting", A))).toBe("pending");
    expect(controller.update(wallet("connected", A))).toBe("authenticated");

    expect(resets.length).toBe(resetsBefore);
    expect(controller.guard.isCurrent(ticket)).toBe(true);
    expect(storage.getItem(TOKEN_KEY)).not.toBeNull();
  });

  test("만료 시각이 지나면 authenticated → unauthenticated 로 스코프가 바뀜", () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_KEY, fakeJwt(A, NOW / 1000 + 10));
    let now = NOW;
    const resets: Array<{ from: string | null; to: string }> = [];
    const c = new SessionController({
      storage, now: () => now, setTimer: () => 0, clearTimer: () => undefined,
      onScopeReset: (i) => resets.push(i),
    });
    expect(c.update(wallet("connected", A))).toBe("authenticated");
    now = NOW + 11_000;
    expect(c.update(wallet("connected", A))).toBe("unauthenticated");
    expect(last(resets)?.to).toBe(`${A.toLowerCase()}|anon`);
  });
});

// ─── 컨트롤러: 계정 전환 ─────────────────────────────────────────────────────

describe("SessionController — account switching", () => {
  test("A→B 직접 전환: 즉시 스코프 리셋, A 토큰 삭제, B 는 로그인 필요", () => {
    const { controller, storage, resets, tokenCleared } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    const ticket = controller.guard.ticket();

    expect(controller.update(wallet("connected", B))).toBe("unauthenticated");

    expect(last(resets)).toEqual({ from: `${A.toLowerCase()}|auth`, to: `${B.toLowerCase()}|anon` });
    expect(controller.guard.isCurrent(ticket)).toBe(false);
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(tokenCleared()).toBe(1);
  });

  test("A→B 전환 시 이미 B 의 유효 토큰(다른 탭 로그인)이 저장돼 있으면 그 토큰은 지우지 않고 사용", () => {
    const { controller, storage } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    const tokenB = fakeJwt(B);
    storage.setItem(TOKEN_KEY, tokenB);
    expect(controller.update(wallet("connected", B))).toBe("authenticated");
    expect(storage.getItem(TOKEN_KEY)).toBe(tokenB);
  });

  test("A→disconnected→B: 데이터는 disconnected 시점에 이미 비워지고 B 는 A 데이터를 볼 수 없음", () => {
    const { controller, storage, resets } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    controller.update(wallet("disconnected"));
    controller.update(wallet("connected", B));
    expect(resets.map((r) => r.to)).toEqual([
      `${A.toLowerCase()}|auth`, "none", `${B.toLowerCase()}|anon`,
    ]);
  });

  test("A→disconnected→B(유예 안): 유예 타이머는 취소되지만 A 의 토큰은 B 연결 시점에 정리됨", () => {
    const { controller, storage, timers } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    controller.update(wallet("disconnected"));
    expect(storage.getItem(TOKEN_KEY)).not.toBeNull(); // 아직 유예 중
    controller.update(wallet("connected", B));
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(timers.pending()).toBe(0);
  });

  test("같은 주소를 대소문자만 바꿔 전달해도 계정 전환으로 보지 않음", () => {
    const { controller, storage, resets } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    const n = resets.length;
    controller.update(wallet("connected", A.toLowerCase()));
    expect(resets.length).toBe(n);
  });
});

// ─── 경합(race): 오래된 응답 / 오래된 401 / 다른 탭 ──────────────────────────

describe("races", () => {
  test("계정 A 의 느린 응답이 계정 B 로 전환된 뒤 도착해도 적용되지 않음", async () => {
    const { controller, storage } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));

    let shown: string[] = [];
    let resolveSlow!: (v: string[]) => void;
    const slow = new Promise<string[]>((r) => { resolveSlow = r; });

    // useMyTrips 와 같은 패턴: 티켓 발급 → await → 현재 티켓일 때만 적용
    const request = (async () => {
      const ticket = controller.guard.ticket();
      const data = await slow;
      if (!controller.guard.isCurrent(ticket)) return;
      shown = data;
    })();

    controller.update(wallet("connected", B)); // 응답 도착 전에 계정 전환
    resolveSlow(["A 의 비공개 여행방"]);
    await request;

    expect(shown).toEqual([]);
  });

  test("Disconnect 후 도착한 응답도 적용되지 않음", async () => {
    const { controller, storage } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    let shown = 0;
    let resolveSlow!: () => void;
    const slow = new Promise<void>((r) => { resolveSlow = r; });
    const request = (async () => {
      const ticket = controller.guard.ticket();
      await slow;
      if (controller.guard.isCurrent(ticket)) shown += 1;
    })();
    controller.update(wallet("disconnected"));
    resolveSlow();
    await request;
    expect(shown).toBe(0);
  });

  test("체인 전환(pending 왕복) 중이던 요청은 그대로 유효", async () => {
    const { controller, storage } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("connected", A));
    let shown = 0;
    let resolveSlow!: () => void;
    const slow = new Promise<void>((r) => { resolveSlow = r; });
    const request = (async () => {
      const ticket = controller.guard.ticket();
      await slow;
      if (controller.guard.isCurrent(ticket)) shown += 1;
    })();
    controller.update(wallet("reconnecting", A));
    controller.update(wallet("connected", A));
    resolveSlow();
    await request;
    expect(shown).toBe(1);
  });

  test("expire(usedToken): 그 사이 새 토큰으로 교체됐다면 오래된 401 은 새 토큰을 지우지 못함", () => {
    const { controller, storage } = makeController();
    const oldToken = fakeJwt(A, NOW / 1000 + 100);
    const newToken = fakeJwt(A, NOW / 1000 + 5000);
    storage.setItem(TOKEN_KEY, newToken);
    const ticket = controller.guard.ticket();
    controller.expire(oldToken);
    expect(storage.getItem(TOKEN_KEY)).toBe(newToken);
    expect(controller.guard.isCurrent(ticket)).toBe(true);
  });

  test("expire(usedToken): 현재 저장된 토큰이 거부된 것이면 삭제 + in-flight 무효화", () => {
    const { controller, storage, tokenCleared } = makeController();
    const token = fakeJwt(A);
    storage.setItem(TOKEN_KEY, token);
    const ticket = controller.guard.ticket();
    controller.expire(token);
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(controller.guard.isCurrent(ticket)).toBe(false);
    expect(tokenCleared()).toBe(1);
  });

  test("다른 탭에서 로그아웃(저장소 토큰 제거)되면 다음 평가에서 이 탭도 비공개 화면을 닫음", () => {
    const { controller, storage, resets } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    expect(controller.update(wallet("connected", A))).toBe("authenticated");
    storage.removeItem(TOKEN_KEY); // 다른 탭의 로그아웃 → storage 이벤트 → update 재호출
    expect(controller.update(wallet("connected", A))).toBe("unauthenticated");
    expect(last(resets)?.to).toBe(`${A.toLowerCase()}|anon`);
  });

  test("dispose 는 대기 중인 삭제 타이머를 취소", () => {
    const { controller, storage, timers } = makeController();
    storage.setItem(TOKEN_KEY, fakeJwt(A));
    controller.update(wallet("disconnected"));
    expect(timers.pending()).toBe(1);
    controller.dispose();
    expect(timers.pending()).toBe(0);
  });
});
