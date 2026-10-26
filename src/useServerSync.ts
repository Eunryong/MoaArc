/**
 * TESTNET MODE 전용 서버 동기화 훅
 *
 * DEMO MODE에서는 이 훅을 사용하지 않습니다.
 * 이 훅은 API 서버/DB가 실행 중일 때만 데이터를 반환합니다.
 * 서버가 없으면 null을 반환하고 오류를 노출합니다.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getHealth,
  listMyTrips,
  listMyTripsWithToken,
  getItinerary,
  getExpenses,
  getNotifications,
  getToken,
  clearToken,
  STUDIO_TEST_MODE,
  getStudioTestAddress,
  ApiError,
  type TripApiRecord,
  type ItineraryApiItem,
  type ExpenseApiRecord,
  type NotificationApiRecord,
  type HealthStatus,
} from "./apiClient";

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

// ─── 인증 상태 ────────────────────────────────────────────────────────────────

export function useAuthState(connectedAddress?: string) {
  // [STUDIO_TEST_MODE] 지갑 연결만으로 인증된 것으로 간주
  const [isAuthenticated, setIsAuthenticated] = useState(() =>
    STUDIO_TEST_MODE ? !!connectedAddress : !!getToken()
  );
  // 만료 구분: 토큰이 있었지만 서버가 401을 반환한 경우
  const [isExpired, setIsExpired] = useState(false);

  // [STUDIO_TEST_MODE] 지갑 연결 주소가 바뀌면 인증 상태도 갱신
  useEffect(() => {
    if (STUDIO_TEST_MODE) {
      setIsAuthenticated(!!connectedAddress);
      if (!connectedAddress) setIsExpired(false);
    }
  }, [connectedAddress]);

  const refresh = useCallback(() => {
    if (STUDIO_TEST_MODE) {
      setIsAuthenticated(!!connectedAddress);
    } else {
      setIsAuthenticated(!!getToken());
    }
    setIsExpired(false);
  }, [connectedAddress]);

  const markExpired = useCallback(() => {
    if (!STUDIO_TEST_MODE) clearToken();
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
  // 요청이 실제 성공(200)했는지 — true여야만 빈 배열을 "없음"으로 표시
  const [loadedOnce, setLoadedOnce] = useState(false);

  // skipNextAutoLoad: reloadTrips(explicitToken)이 이미 진행 중일 때
  // useEffect 자동 실행이 중복 요청을 만들지 않도록 1회 skip하는 플래그
  const skipNextAutoRef = useRef(false);

  // explicitToken: 로그인 직후 React state 반영 전에 발급된 토큰을 직접 전달
  const load = useCallback(async (explicitToken?: string) => {
    // 자동 실행(explicitToken 없음)이고 skip 플래그가 설정된 경우: 1회 skip
    if (!explicitToken && skipNextAutoRef.current) {
      skipNextAutoRef.current = false;
      return;
    }
    // [STUDIO_TEST_MODE] as 주소가 설정돼 있으면 토큰 없이도 통과
    const hasAccess = STUDIO_TEST_MODE ? !!getStudioTestAddress() : !!getToken();
    if (!explicitToken && !hasAccess) return;
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
        // 메시지 무관: 모든 401은 현재 토큰으로 서버 접근 불가.
        // clearToken으로 localStorage를 비우고 로그인 화면으로 전환.
        // 자동 재시도 없음 — 로그인 성공 후 reloadTrips(newToken)이 1회 재조회.
        clearToken();
        onAuthExpired?.();
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [onAuthExpired]);

  // 자동 실행: enabled가 true로 바뀔 때(isAuthenticated 반영 후)
  // reloadTrips(explicitToken)이 이미 진행 중이면 skipNextAutoRef로 1회 skip
  useEffect(() => { if (enabled) void load(); }, [enabled, load]);

  // 30초 폴링: 새 여행방 추가 등 외부 변경 사항을 주기적으로 반영
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [enabled, load]);

  // reload(token?): 인수 없으면 sessionStorage 토큰 사용, 있으면 직접 전달
  // explicitToken이 있으면 자동 effect가 같은 직후 중복 실행을 skip하도록 플래그 설정
  const reload = useCallback((explicitToken?: string) => {
    if (explicitToken) {
      // 다음 자동 effect 1회 skip — React가 enabled 변화로 load()를 재실행하는 것을 막음
      skipNextAutoRef.current = true;
    }
    return load(explicitToken);
  }, [load]);

  // clearError: 체인 전환·로그아웃 등으로 stale 오류를 외부에서 초기화
  const clearError = useCallback(() => setError(null), []);

  // enabled가 false로 바뀌면(로그아웃·만료) stale error를 초기화
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
    const hasAccess = STUDIO_TEST_MODE ? !!getStudioTestAddress() : !!getToken();
    if (!enabled || !dbTripId || !hasAccess) return;
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
    const hasAccess = STUDIO_TEST_MODE ? !!getStudioTestAddress() : !!getToken();
    if (!enabled || !dbTripId || !hasAccess) return;
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
    const hasAccess = STUDIO_TEST_MODE ? !!getStudioTestAddress() : !!getToken();
    if (!enabled || !dbTripId || !hasAccess) return;
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
