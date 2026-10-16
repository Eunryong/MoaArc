/**
 * TESTNET MODE 전용 서버 동기화 훅
 *
 * DEMO MODE에서는 이 훅을 사용하지 않습니다.
 * 이 훅은 API 서버/DB가 실행 중일 때만 데이터를 반환합니다.
 * 서버가 없으면 null을 반환하고 오류를 노출합니다.
 */

import { useState, useEffect, useCallback } from "react";
import {
  getHealth,
  listMyTrips,
  getItinerary,
  getExpenses,
  getNotifications,
  getToken,
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

export function useAuthState() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getToken());

  // 토큰이 갱신되면 상태 업데이트
  const refresh = useCallback(() => {
    setIsAuthenticated(!!getToken());
  }, []);

  return { isAuthenticated, refresh };
}

// ─── 내 여행방 목록 ───────────────────────────────────────────────────────────

export function useMyTrips(enabled: boolean) {
  const [trips, setTrips] = useState<TripApiRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled || !getToken()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await listMyTrips();
      setTrips(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { void load(); }, [load]);
  return { trips, loading, error, reload: load };
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
