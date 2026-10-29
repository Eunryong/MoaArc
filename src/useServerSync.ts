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
  clearToken,
  ApiError,
  type TripApiRecord,
  type ItineraryApiItem,
  type ExpenseApiRecord,
  type NotificationApiRecord,
  type HealthStatus,
  type NetworkStatus,
} from "./apiClient";
import { NETWORK_CONFIG } from "./networkConfig";

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

// ─── 인증 상태 ────────────────────────────────────────────────────────────────

export function useAuthState(_connectedAddress?: string) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getToken());
  const [isExpired, setIsExpired] = useState(false);

  const refresh = useCallback(() => {
    setIsAuthenticated(!!getToken());
    setIsExpired(false);
  }, []);

  const markExpired = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
    setIsExpired(true);
  }, []);

  return { isAuthenticated, isExpired, refresh, markExpired };
}

// ─── 내 여행방 목록 ───────────────────────────────────────────────────────────

export function useMyTrips(enabled: boolean, onAuthExpired?: () => void) {
  const [trips, setTrips] = useState<TripApiRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const skipNextAutoRef = useRef(false);

  const load = useCallback(async (explicitToken?: string) => {
    if (!explicitToken && skipNextAutoRef.current) {
      skipNextAutoRef.current = false;
      return;
    }
    if (!explicitToken && !getToken()) return;
    setLoading(true);
    setError(null);
    try {
      const data = explicitToken
        ? await listMyTripsWithToken(explicitToken)
        : await listMyTrips();
      setTrips(data);
      setLoadedOnce(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearToken();
        onAuthExpired?.();
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [onAuthExpired]);

  useEffect(() => { if (enabled) void load(); }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [enabled, load]);

  const reload = useCallback((explicitToken?: string) => {
    if (explicitToken) skipNextAutoRef.current = true;
    return load(explicitToken);
  }, [load]);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    if (!enabled) setError(null);
  }, [enabled]);

  return { trips, loading, error, loadedOnce, reload, clearError };
}

// ─── 여행방 일정 ─────────────────────────────────────────────────────────────

export function useTripItinerary(dbTripId: string | null, enabled: boolean) {
  const [items, setItems] = useState<ItineraryApiItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled || !dbTripId || !getToken()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getItinerary(dbTripId);
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, dbTripId]);

  useEffect(() => { void load(); }, [load]);
  return { items, loading, error, reload: load };
}

// ─── 지출 목록 ────────────────────────────────────────────────────────────────

export function useTripExpenses(dbTripId: string | null, enabled: boolean) {
  const [expenses, setExpenses] = useState<ExpenseApiRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled || !dbTripId || !getToken()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getExpenses(dbTripId);
      setExpenses(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, dbTripId]);

  useEffect(() => { void load(); }, [load]);
  return { expenses, loading, error, reload: load };
}

// ─── 알림 ────────────────────────────────────────────────────────────────────

export function useTripNotifications(dbTripId: string | null, enabled: boolean) {
  const [notifications, setNotifications] = useState<NotificationApiRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const load = useCallback(async () => {
    if (!enabled || !dbTripId || !getToken()) return;
    try {
      const data = await getNotifications(dbTripId);
      setNotifications(data);
      setUnreadCount(data.filter((n) => !n.read).length);
    } catch {
      // 알림 로드 실패는 조용히 처리
    }
  }, [enabled, dbTripId]);

  useEffect(() => { void load(); }, [load]);
  return { notifications, unreadCount, reload: load };
}
