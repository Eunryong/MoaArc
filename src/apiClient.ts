/**
 * MoaArc API 클라이언트 (프론트엔드 전용)
 *
 * DEMO MODE에서는 이 클라이언트를 호출하지 않습니다.
 * TESTNET MODE에서만 사용합니다.
 *
 * 인증 흐름:
 *   1. GET /api/auth/nonce?address=0x...  → { nonce }
 *   2. 지갑으로 nonce 서명 (wagmi signMessage)
 *   3. POST /api/auth/verify { address, nonce, signature } → { token }
 *   4. 이후 모든 요청 헤더: Authorization: Bearer <token>
 *
 * 토큰은 sessionStorage에 보관합니다 (탭 닫으면 만료).
 */

// 상대경로 "" 사용 → Vite proxy(/api → localhost:3001)로 전달
// 절대 주소(http://localhost:3001)를 쓰지 말 것 — Arc Studio 프리뷰에서 브라우저가 도달 불가
// 배포 시: VITE_API_BASE_URL에 외부 서버 주소 설정
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
const TOKEN_KEY = "moaarc_auth_token";

// ─── 토큰 관리 ────────────────────────────────────────────────────────────────
// 토큰은 localStorage에만 보관합니다.
// Authorization: Bearer 헤더로만 전송하며, 쿠키/URL 경로는 사용하지 않습니다.

export function saveToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// ─── 기본 fetch 래퍼 ────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit, explicitToken?: string): Promise<T> {
  // explicitToken이 있으면 우선 사용 — 로그인 직후 React state 반영 전 stale closure 방지
  const token = explicitToken ?? getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };

  // ── GET 터널링 ─────────────────────────────────────────────────────────────────
  // Arc Studio 프리뷰 게이트웨이가 POST/PATCH/DELETE를 403으로 차단합니다.
  // 변경 메서드는 GET ?_method=POST&_body=<base64(body)> 로 터널링합니다.
  // 인증은 Authorization 헤더로만 전달합니다. URL에 토큰을 싣지 않습니다.
  // 주의: Arc Studio 게이트웨이가 Authorization 헤더도 제거하는 경우 인증이 실패합니다.
  //       이는 보안 차단으로 간주하며 URL 우회는 하지 않습니다.
  const method = (init?.method ?? "GET").toUpperCase();
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  let fetchUrl: string;
  let fetchInit: RequestInit;

  if (isMutating) {
    const base = `${API_BASE}${path}`;
    const params = new URLSearchParams();
    params.set("_method", method);
    if (init?.body) params.set("_body", btoa(unescape(encodeURIComponent(String(init.body)))));
    fetchUrl = `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;
    fetchInit = { headers };
  } else {
    fetchUrl = `${API_BASE}${path}`;
    fetchInit = { ...init, headers };
  }

  const res = await fetch(fetchUrl, fetchInit);

  // ── Content-Type 먼저 확인: HTML(502/504 등)을 JSON으로 파싱하지 않도록 방지 ──
  // 401이라도 서버가 JSON을 반환할 수 있으므로 Content-Type 체크를 우선합니다.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    if (res.status === 401) {
      // JSON이 아닌 401 — 게이트웨이/프록시 오류. 토큰 미삭제, 재시도 가능.
      throw new ApiError(401, `게이트웨이 오류 (HTTP 401)`);
    }
    if (res.status === 403) {
      // 403 Forbidden — Arc Studio 게이트웨이가 반환. 인증 토큰 문제가 아님.
      // 토큰 삭제 없이 에러만 전파합니다.
      throw new ApiError(403, `네트워크 오류 (HTTP 403): 페이지를 새로고침하세요.`);
    }
    throw new ApiError(
      res.status,
      res.ok
        ? `예상치 못한 응답 형식 (${contentType || "unknown"})`
        : `네트워크 오류 ${res.status}`
    );
  }

  const body = await res.json() as Record<string, unknown>;

  if (res.status === 401) {
    const serverMsg = (body.error as string) ?? "";
    // "인증이 필요합니다." = Authorization 헤더 자체가 서버에 도달하지 않음
    //   → 게이트웨이 제거 또는 토큰 없이 발사된 경우
    //   → 토큰은 보존: 헤더를 보냈는데 게이트웨이가 제거한 것일 수 있음
    // "유효하지 않거나 만료된 토큰" = 헤더 도달했지만 검증 실패
    //   → clearToken: 이 토큰은 더 이상 사용 불가
    const isMissingHeader = serverMsg.includes("인증이 필요합니다");
    if (!isMissingHeader) {
      clearToken();
    }
    throw new ApiError(401, serverMsg || "인증이 필요합니다. 다시 로그인해주세요.");
  }

  if (!res.ok) {
    throw new ApiError(res.status, (body.error as string) ?? "알 수 없는 오류");
  }

  return body as T;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// ─── 서버 상태 확인 ───────────────────────────────────────────────────────────

export interface HealthStatus {
  status: string;
  geminiConfigured: boolean;
  dbConfigured: boolean;
  contractConfigured: boolean;
}

export async function getHealth(): Promise<HealthStatus | null> {
  try {
    return await apiFetch<HealthStatus>("/api/health");
  } catch {
    return null;
  }
}

// ─── 인증 ─────────────────────────────────────────────────────────────────────

export async function fetchNonce(address: string): Promise<string> {
  const data = await apiFetch<{ nonce: string }>(`/api/auth/nonce?address=${encodeURIComponent(address)}`);
  return data.nonce;
}

export async function verifySignature(
  address: string,
  nonce: string,
  signature: string
): Promise<string> {
  const data = await apiFetch<{ token: string }>("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address, nonce, signature }),
  });
  saveToken(data.token);
  return data.token;
}

// ─── 여행방 ───────────────────────────────────────────────────────────────────

export interface TripApiRecord {
  id: string;
  chainId: number;
  contractAddress: string;
  onchainTripId: string; // BigInt serialized as string
  name: string;
  adminAddress: string;
  createTxHash: string;
  createdAt: string;
  participants: Array<{
    id: string;
    address: string;
    displayName: string;
    isAdmin: boolean;
  }>;
}

export async function registerTrip(payload: {
  txHash: string;
  chainId: number;
  contractAddress: string;
  participants: { address: string; displayName: string }[];
}): Promise<TripApiRecord> {
  const data = await apiFetch<{ trip: TripApiRecord }>("/api/trips", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return data.trip;
}

export async function listMyTrips(): Promise<TripApiRecord[]> {
  const data = await apiFetch<{ trips: TripApiRecord[] }>("/api/trips");
  return data.trips;
}

/** 로그인 직후 발급된 토큰을 명시적으로 전달 — sessionStorage 타이밍 의존성 제거 */
export async function listMyTripsWithToken(token: string): Promise<TripApiRecord[]> {
  const data = await apiFetch<{ trips: TripApiRecord[] }>("/api/trips", undefined, token);
  return data.trips;
}

export async function getTripById(dbTripId: string): Promise<TripApiRecord> {
  const data = await apiFetch<{ trip: TripApiRecord }>(`/api/trips/${dbTripId}`);
  return data.trip;
}

// ─── 일정 ─────────────────────────────────────────────────────────────────────

export interface ItineraryApiItem {
  id: string;
  date: string;
  time?: string | null;
  location: string;
  activity: string;
  category?: string | null;
  participants: string; // JSON string
  status: string;
  notes?: string | null;
  estMinUsdc?: string | null;
  estMaxUsdc?: string | null;
  estCurrency?: string | null;
  estSource?: string | null;
  estAt?: string | null;
  confidence?: string | null;
  createdBy: string;
  createdAt: string;
}

export async function getItinerary(dbTripId: string): Promise<ItineraryApiItem[]> {
  const data = await apiFetch<{ itinerary: ItineraryApiItem[] }>(
    `/api/trips/${dbTripId}/itinerary`
  );
  return data.itinerary;
}

export async function addItineraryItem(
  dbTripId: string,
  item: { date: string; time?: string; location: string; activity: string; participants?: string[]; notes?: string }
): Promise<ItineraryApiItem> {
  const data = await apiFetch<{ item: ItineraryApiItem }>(
    `/api/trips/${dbTripId}/itinerary`,
    { method: "POST", body: JSON.stringify(item) }
  );
  return data.item;
}

export async function updateItineraryItem(
  dbTripId: string,
  itemId: string,
  patch: Partial<ItineraryApiItem> & { estMinUsdc?: string; estMaxUsdc?: string }
): Promise<ItineraryApiItem> {
  const data = await apiFetch<{ item: ItineraryApiItem }>(
    `/api/trips/${dbTripId}/itinerary/${itemId}`,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
  return data.item;
}

// ─── 지출 ─────────────────────────────────────────────────────────────────────

export interface ExpenseApiRecord {
  id: string;
  tripId: string;
  payerAddress: string;
  title: string;
  category: string;
  date: string;
  localCurrency?: string | null;
  localAmount?: number | null;
  totalUsdc: string; // BigInt as string
  paymentFlow: string;
  currentVersion: number;
  status: string;
  receiptNote?: string | null;
  versions: Array<{
    id: string;
    version: number;
    shares: string; // JSON
    proposedBy: string;
    proposedAt: string;
    reason: string;
    status: string;
    approvals: Array<{
      id: string;
      address: string;
      action: string;
      reason?: string | null;
      approvedAt: string;
    }>;
  }>;
}

export async function getExpenses(dbTripId: string): Promise<ExpenseApiRecord[]> {
  const data = await apiFetch<{ expenses: ExpenseApiRecord[] }>(
    `/api/trips/${dbTripId}/expenses`
  );
  return data.expenses;
}

export async function addExpense(
  dbTripId: string,
  expense: {
    title: string; category: string; date: string;
    totalUsdc: string; paymentFlow: string;
    localCurrency?: string; localAmount?: number;
    receiptNote?: string;
    shares: { address: string; amountUsdc: string }[];
  }
): Promise<ExpenseApiRecord> {
  const data = await apiFetch<{ expense: ExpenseApiRecord }>(
    `/api/trips/${dbTripId}/expenses`,
    { method: "POST", body: JSON.stringify(expense) }
  );
  return data.expense;
}

export async function approveExpense(
  dbTripId: string,
  expenseId: string,
  payload: { action: "승인" | "수정요청"; reason?: string; newShares?: { address: string; amountUsdc: string }[] }
): Promise<void> {
  await apiFetch(`/api/trips/${dbTripId}/expenses/${expenseId}/approve`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ─── 에이전트 ─────────────────────────────────────────────────────────────────

export interface AgentChatResponse {
  role: "agent";
  content: string;
  hasError: boolean;
  errorDetail?: string;
  proposal: null | {
    type: string;
    requiresConfirmation: true;
    itineraryDrafts?: Array<{
      date: string; time?: string; location: string; activity: string;
      estMinUsdc?: string; estMaxUsdc?: string; estCurrency?: string;
      estSource?: string; confidence?: string;
    }>;
    message?: string;
  };
  searchUsed: boolean;
  retrievedAt?: string;
  sources?: Array<{ url: string; title?: string }>;
}

export async function sendAgentMessage(
  message: string,
  tripDbId?: string,
  requestCostSearch?: boolean
): Promise<AgentChatResponse> {
  return apiFetch<AgentChatResponse>("/api/agent/chat", {
    method: "POST",
    body: JSON.stringify({ message, tripDbId, requestCostSearch }),
  });
}

export async function getAgentHistory(tripDbId: string) {
  return apiFetch<{ history: Array<{ role: string; content: string; proposal: string | null; createdAt: string }> }>(
    `/api/agent/history/${tripDbId}`
  );
}

// ─── 알림 ─────────────────────────────────────────────────────────────────────

export interface NotificationApiRecord {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export async function getNotifications(dbTripId: string): Promise<NotificationApiRecord[]> {
  const data = await apiFetch<{ notifications: NotificationApiRecord[] }>(
    `/api/trips/${dbTripId}/notifications`
  );
  return data.notifications;
}

export async function markNotificationRead(dbTripId: string, notifId: string): Promise<void> {
  await apiFetch(`/api/trips/${dbTripId}/notifications/${notifId}/read`, { method: "PATCH" });
}

// ─── 여행방 생성 intent ───────────────────────────────────────────────────────

export interface CreateTripIntentRequest {
  tripName: string;
  participantAddresses: string[];
  targetBudget: string; // BigInt 문자열
}

export interface CreateTripIntentResponse {
  intentId: string;
  tx: {
    to: `0x${string}`;
    data: `0x${string}`;
    value: string;
    chainId: number;
  };
}

export interface IntentStatusResponse {
  intentId: string;
  status: "pending_tx" | "submitted" | "confirmed" | "failed" | "reverted";
  tripId?: string;
  trip?: TripApiRecord;
  onchainTripId?: string | null;
  error?: string | null;
  confirmed?: boolean;
}

export async function prepareCreateTripIntent(
  req: CreateTripIntentRequest
): Promise<CreateTripIntentResponse> {
  return apiFetch<CreateTripIntentResponse>("/api/intent/create-trip", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function submitTripIntentTxHash(
  intentId: string,
  txHash: string
): Promise<IntentStatusResponse> {
  return apiFetch<IntentStatusResponse>(`/api/intent/${intentId}/submit`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
}

export async function getIntentStatus(intentId: string): Promise<IntentStatusResponse> {
  return apiFetch<IntentStatusResponse>(`/api/intent/${intentId}`);
}
