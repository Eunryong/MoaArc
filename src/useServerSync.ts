/**
 * 서버 동기화 훅
 *
 * 인증: Authorization: Bearer <token> 헤더만 사용합니다.
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
