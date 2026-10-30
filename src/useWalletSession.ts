/**
 * 지갑 연결 상태 → 앱 세션 훅.
 *
 * 순수 판정/정리 로직은 session.ts(SessionController)에 있고, 이 훅은 React 와 연결만 합니다.
 *
 * - 비공개 화면 노출 여부(phase)는 렌더 시점에 즉시 계산됩니다 (효과 실행을 기다리지 않음).
 * - 메모리 상태 초기화·in-flight 무효화·토큰 정리는 layout effect 에서 수행합니다
 *   (모든 자식의 passive effect = 데이터 fetch 보다 먼저 실행되므로, 새 요청은 항상 새 스코프의 티켓을 받음).
 * - 다른 탭의 로그아웃/로그인은 `storage` 이벤트로 반영합니다.
 * - 서버 JWT 는 stateless 입니다. 여기서의 로그아웃은 이 브라우저의 토큰 삭제와 화면/상태 정리이며
 *   서버 측 폐기가 아닙니다 (만료 exp 까지 토큰을 가진 쪽에서는 유효).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getStoredTokenRaw, setActiveIdentity } from "./apiClient";
import {
  SessionController,
  TOKEN_KEY,
  canShowPrivateData,
  decodeJwtClaims,
  resolveSessionPhase,
  scopeIdFor,
  type SessionPhase,
  type WalletStatus,
} from "./session";
import type { DataScope } from "./useServerSync";

export interface WalletSessionOptions {
  /** 스코프(계정/로그인 상태)가 바뀌어 화면 상태(선택 여행방·메시지 등)를 비워야 할 때. 참조가 안정적이어야 함(useCallback) */
  onScopeReset?: () => void;
}

const MAX_TIMEOUT_MS = 2_147_000_000;

export function useWalletSession(
  wallet: { status: WalletStatus; address: string | undefined },
  options: WalletSessionOptions = {},
) {
  const queryClient = useQueryClient();
  const [tick, setTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isExpired, setIsExpired] = useState(false);
  // pending(재연결 중)에는 직전 스코프 키를 유지하기 위한 값 — layout effect 에서만 갱신
  const [lastKey, setLastKey] = useState("none");

  // 컨트롤러는 최초 렌더에 한 번 만들어지므로 options.onScopeReset 은 참조가 안정적이어야 합니다(useCallback).
  const { onScopeReset } = options;

  /** 토큰/시간이 바뀌었을 수 있으니 phase 를 다시 계산 */
  const reevaluate = useCallback(() => {
    setNowMs(Date.now());
    setTick((t) => t + 1);
  }, []);

  const [controller] = useState(
    () =>
      new SessionController({
        storage: localStorage,
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        onTokenCleared: reevaluate,
        onScopeReset: ({ from, to }) => {
          // 같은 지갑이 로그인만 완료한 경우(anon→auth)는 공개 읽기 캐시를 유지, 그 외에는 모든 쿼리 캐시 폐기
          const loginOnly = from !== null && from.endsWith("|anon") && to === from.replace(/\|anon$/, "|auth");
          if (!loginOnly) {
            queryClient.clear();
            setIsExpired(false);
          }
          onScopeReset?.();
        },
      }),
  );

  // ── 렌더 시점 즉시 판정 (효과를 기다리지 않아 stale 화면이 한 프레임도 보이지 않음) ──
  const rawToken = getStoredTokenRaw();
  const phase: SessionPhase = resolveSessionPhase({
    status: wallet.status,
    address: wallet.address,
    token: rawToken,
    nowMs,
  });
  const scopeId = scopeIdFor(phase, wallet.address);
  const scopeKey = scopeId ?? lastKey; // pending 은 직전 스코프 유지

  // ── 부수효과: 활성 신원 바인딩 + 컨트롤러 갱신 (자식 passive effect 보다 먼저) ──
  useLayoutEffect(() => {
    setActiveIdentity(wallet.status === "connected" ? wallet.address : null);
    controller.update({ status: wallet.status, address: wallet.address });
    if (scopeId !== null) setLastKey(scopeId);
  }, [controller, wallet.status, wallet.address, tick, scopeId]);

  useEffect(() => () => controller.dispose(), [controller]);

  // ── 다른 탭의 토큰 변경(로그아웃/로그인) 반영 ──
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === TOKEN_KEY || e.key === null) reevaluate();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reevaluate]);

  // ── 토큰 만료 시각에 맞춰 재평가 ──
  useEffect(() => {
    if (phase !== "authenticated" || !rawToken) return;
    const exp = decodeJwtClaims(rawToken)?.exp;
    if (exp === undefined) return;
    const delay = Math.min(Math.max(exp * 1000 - Date.now() + 250, 0), MAX_TIMEOUT_MS);
    const id = setTimeout(reevaluate, delay);
    return () => clearTimeout(id);
  }, [phase, rawToken, reevaluate]);

  const refresh = useCallback(() => {
    setIsExpired(false);
    reevaluate();
  }, [reevaluate]);

  /** 서버가 401 로 토큰을 거부했을 때. usedToken 이 이미 다른 토큰으로 교체됐다면 아무것도 하지 않음 */
  const markExpired = useCallback((usedToken?: string) => {
    controller.expire(usedToken);
    if (usedToken === undefined || getStoredTokenRaw() === null) setIsExpired(true);
    reevaluate();
  }, [controller, reevaluate]);

  /** 사용자가 직접 세션을 초기화 (토큰 삭제 + in-flight 무효화). 서버 데이터는 건드리지 않음 */
  const resetSession = useCallback(() => {
    controller.expire();
    setIsExpired(false);
    reevaluate();
  }, [controller, reevaluate]);

  const scope: DataScope = useMemo(
    () => ({ key: scopeKey, guard: controller.guard }),
    [scopeKey, controller],
  );

  return {
    phase,
    scope,
    isAuthenticated: canShowPrivateData(phase),
    /** 지갑이 실제로 연결된 상태 (connecting/reconnecting 제외) */
    isWalletConnected: phase === "authenticated" || phase === "unauthenticated",
    isPending: phase === "pending",
    isExpired,
    refresh,
    markExpired,
    resetSession,
  };
}
