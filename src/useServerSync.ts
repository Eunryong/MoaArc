/**
 * 서버 동기화 훅
 *
 * 인증: Authorization: Bearer <token> 헤더만 사용합니다.
 * 서버가 없으면 null을 반환하고 오류를 노출합니다.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getHealth,
  getNetworkStatus,
  listMyTrips,
  listMyTripsWithToken,
  getItinerary,
  getExpenses,
  getNotifications,
  getToken,
  clearTokenIfEquals,
  ApiError,
  type TripApiRecord,
  type ItineraryApiItem,
  type ExpenseApiRecord,
  type NotificationApiRecord,
  type HealthStatus,
  type NetworkStatus,
} from "./apiClient";
import { NETWORK_CONFIG } from "./networkConfig";
import { backendNetworkMismatch } from "./networkConfigCore";
import type { ScopeGuard } from "./session";

/**
 * 신원(세션) 범위. key 가 바뀌면 훅이 보유한 데이터를 즉시 비우고,
 * guard 티켓이 무효화되면 이전 세션에서 시작된 응답은 버려집니다.
 */
export interface DataScope {
  key: string;
  guard: ScopeGuard;
}

/**
 * 요청 시작 시 begin() 으로 "stale 여부 판별 함수"를 받고, 응답 후 isStale() 이 true 면 결과를 버립니다.
 * - scope 의 guard 티켓: 계정 전환 / 로그아웃 / 토큰 만료
 * - resetKey 변경: 같은 세션 안에서 대상(여행방)이 바뀐 경우
 */
function useStaleGuard(scope: DataScope | undefined, resetKey: string) {
  const localRef = useRef(0);
  const guard = scope?.guard;
  const scopeKey = scope?.key;
  // 반드시 load 효과보다 먼저 선언 — 대상/세션이 바뀌면 이전 요청을 먼저 무효화
  useEffect(() => { localRef.current += 1; }, [resetKey, scopeKey]);
  return useCallback(() => {
    const local = localRef.current;
    const ticket = guard?.ticket();
    return () =>
      localRef.current !== local ||
      (guard !== undefined && ticket !== undefined && !guard.isCurrent(ticket));
  }, [guard]);
}

// ─── 서버 헬스 체크 ──────────────────────────────────────────────────────────

export function useServerHealth() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let mounted = true;
    void getHealth().then((h) => {
      if (mounted) { setHealth(h); setChecking(false); }
    });
    return () => { mounted = false; };
  }, []);

  return {
    health,
    checking,
    serverOnline: health?.status === "ok",
    geminiConfigured: health?.geminiConfigured ?? false,
    dbConfigured: health?.dbConfigured ?? false,
  };
}

// ─── 서버 네트워크 일치 확인 ──────────────────────────────────────────────────
// /api/network 결과로 서버 체인 설정이 프런트엔드와 일치하는지 확인합니다.
// networkReady=false이면 App.tsx에서 지갑 서명 버튼을 비활성화합니다.

export interface NetworkMatchState {
  /** 서버 응답 완료 여부 */
  checked: boolean;
  /** 서버가 온라인이고 체인 설정이 일치하면 true */
  networkReady: boolean;
  /** 불일치 시 사유 목록 */
  errors: string[];
  /** 원본 서버 응답 */
  raw: NetworkStatus | null;
}

export function useNetworkMatch(serverOnline: boolean): NetworkMatchState {
  const [state, setState] = useState<NetworkMatchState>({
    checked: false,
    networkReady: false,
    errors: [],
    raw: null,
  });

  useEffect(() => {
    if (!serverOnline) {
      // 서버 오프라인 — 검증 불가 → networkReady=false (서버 없이는 write 허용 안 함)
      setState({ checked: true, networkReady: false, errors: ["network_status_unavailable"], raw: null });
      return;
    }

    let mounted = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    async function check() {
      const ns = await getNetworkStatus();
      if (!mounted) return;

      if (!ns) {
        // 서버 온라인이지만 /api/network 응답 없음 — 차단
        setState({ checked: true, networkReady: false, errors: ["network_status_unavailable"], raw: null });
        return;
      }

      // 필수 필드 누락 차단 (chainId, contractAddress, version, usdcAddress)
      if (
        ns.status === "ok" &&
        (ns.chainId === undefined || !ns.contractAddress || !ns.version || !ns.usdcAddress)
      ) {
        setState({
          checked: true,
          networkReady: false,
          errors: ["network_mismatch_banner"],
          raw: ns,
        });
        return;
      }

      if (ns.status === "pending") {
        // 검증 진행 중 — 3초 후 재조회
        setState({ checked: false, networkReady: false, errors: ["network_pending"], raw: ns });
        retryTimer = setTimeout(() => { void check(); }, 3_000);
        return;
      }

      if (ns.status !== "ok") {
        setState({ checked: true, networkReady: false, errors: ns.errors ?? ["network_mismatch_banner"], raw: ns });
        return;
      }

      // chainId 비교
      if (ns.chainId !== NETWORK_CONFIG.chainId) {
        setState({
          checked: true,
          networkReady: false,
          errors: [`network_chain_mismatch:${ns.chainId}:${NETWORK_CONFIG.chainId}`],
          raw: ns,
        });
        return;
      }

      // contractAddress 비교 (필수 필드 체크를 통과했으므로 non-null)
      const serverContract = ns.contractAddress!;
      if (serverContract.toLowerCase() !== NETWORK_CONFIG.contractAddress.toLowerCase()) {
        setState({
          checked: true,
          networkReady: false,
          errors: [`network_contract_mismatch:${serverContract}:${NETWORK_CONFIG.contractAddress}`],
          raw: ns,
        });
        return;
      }

      // network 이름("mainnet"/"testnet"), USDC 주소, VERSION 까지 모두 일치해야 ready
      const mismatch = backendNetworkMismatch(ns, NETWORK_CONFIG);
      if (mismatch !== null) {
        setState({ checked: true, networkReady: false, errors: [`network_mismatch:${mismatch}`], raw: ns });
        return;
      }

      setState({ checked: true, networkReady: true, errors: [], raw: ns });
    }

    void check();

    return () => {
      mounted = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [serverOnline]);

  return state;
}

// ─── 내 여행방 목록 ───────────────────────────────────────────────────────────

export function useMyTrips(enabled: boolean, onAuthExpired?: (usedToken?: string) => void, scope?: DataScope) {
  const [trips, setTrips] = useState<TripApiRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const skipNextAutoRef = useRef(false);
  const scopeKey = scope?.key ?? "";
  const beginRequest = useStaleGuard(scope, "trips");

  // 세션/계정이 바뀌면 이전 계정의 목록·오류·로딩 상태를 즉시 폐기 (load 효과보다 먼저 선언)
  useEffect(() => {
    setTrips([]);
    setLoadedOnce(false);
    setError(null);
    setLoading(false);
    skipNextAutoRef.current = false;
  }, [scopeKey]);

  const load = useCallback(async (explicitToken?: string) => {
    if (!explicitToken && skipNextAutoRef.current) {
      skipNextAutoRef.current = false;
      return;
    }
    const usedToken = explicitToken ?? getToken();
    if (!usedToken) return;
    const isStale = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const data = explicitToken
        ? await listMyTripsWithToken(explicitToken)
        : await listMyTrips();
      if (isStale()) return; // 계정 전환/로그아웃 이후 도착한 응답은 버림
      setTrips(data);
      setLoadedOnce(true);
    } catch (e) {
      if (isStale()) return;
      if (e instanceof ApiError && e.status === 401) {
        clearTokenIfEquals(usedToken);
        onAuthExpired?.(usedToken);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [onAuthExpired, beginRequest]);

  useEffect(() => { if (enabled) void load(); }, [enabled, load, scopeKey]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [enabled, load, scopeKey]);

  const reload = useCallback((explicitToken?: string) => {
    if (explicitToken) skipNextAutoRef.current = true;
    return load(explicitToken);
  }, [load]);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    if (!enabled) setError(null);
  }, [enabled]);

  // enabled=false(로그아웃/미인증)이면 캐시된 목록을 아예 노출하지 않음
  return {
    trips: enabled ? trips : [],
    loading: enabled ? loading : false,
    error: enabled ? error : null,
    loadedOnce: enabled ? loadedOnce : false,
    reload,
    clearError,
  };
}

// ─── 여행방 일정 ─────────────────────────────────────────────────────────────

export function useTripItinerary(dbTripId: string | null, enabled: boolean, scope?: DataScope) {
  const [items, setItems] = useState<ItineraryApiItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = scope?.key ?? "";
  const beginRequest = useStaleGuard(scope, dbTripId ?? "");

  // 다른 여행방/다른 계정으로 바뀌면 이전 항목을 즉시 비움
  useEffect(() => {
    setItems([]);
    setError(null);
    setLoading(false);
  }, [dbTripId, scopeKey]);

  const load = useCallback(async () => {
    if (!enabled || !dbTripId || !getToken()) return;
    const isStale = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const data = await getItinerary(dbTripId);
      if (isStale()) return;
      setItems(data);
    } catch (e) {
      if (isStale()) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [enabled, dbTripId, beginRequest]);

  useEffect(() => { void load(); }, [load, scopeKey]);
  return { items: enabled ? items : [], loading, error, reload: load };
}

// ─── 지출 목록 ────────────────────────────────────────────────────────────────

export function useTripExpenses(dbTripId: string | null, enabled: boolean, scope?: DataScope) {
  const [expenses, setExpenses] = useState<ExpenseApiRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = scope?.key ?? "";
  const beginRequest = useStaleGuard(scope, dbTripId ?? "");

  useEffect(() => {
    setExpenses([]);
    setError(null);
    setLoading(false);
  }, [dbTripId, scopeKey]);

  const load = useCallback(async () => {
    if (!enabled || !dbTripId || !getToken()) return;
    const isStale = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const data = await getExpenses(dbTripId);
      if (isStale()) return;
      setExpenses(data);
    } catch (e) {
      if (isStale()) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [enabled, dbTripId, beginRequest]);

  useEffect(() => { void load(); }, [load, scopeKey]);
  return { expenses: enabled ? expenses : [], loading, error, reload: load };
}

// ─── 알림 ────────────────────────────────────────────────────────────────────

export function useTripNotifications(dbTripId: string | null, enabled: boolean, scope?: DataScope) {
  const [notifications, setNotifications] = useState<NotificationApiRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const scopeKey = scope?.key ?? "";
  const beginRequest = useStaleGuard(scope, dbTripId ?? "");

  useEffect(() => {
    setNotifications([]);
    setUnreadCount(0);
  }, [dbTripId, scopeKey]);

  const load = useCallback(async () => {
    if (!enabled || !dbTripId || !getToken()) return;
    const isStale = beginRequest();
    try {
      const data = await getNotifications(dbTripId);
      if (isStale()) return;
      setNotifications(data);
      setUnreadCount(data.filter((n) => !n.read).length);
    } catch {
      // 알림 로드 실패는 조용히 처리
    }
  }, [enabled, dbTripId, beginRequest]);

  useEffect(() => { void load(); }, [load, scopeKey]);
  return {
    notifications: enabled ? notifications : [],
    unreadCount: enabled ? unreadCount : 0,
    reload: load,
  };
}
