import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useChainId, useSignMessage, useSwitchChain } from "wagmi";
import { ConnectKitButton } from "connectkit";
import { arcTestnet } from "viem/chains";
import type { ParticipantId, Trip, AgentMessage, ExpenseCategory } from "./types";
import { calcParticipantSummary } from "./calculations";
import { MOAARK_ADDRESS } from "./contractAbi";
import {
  useServerHealth,
  useAuthState,
  useMyTrips,
  useTripItinerary,
  useTripExpenses,
} from "./useServerSync";
import {
  fetchNonce,
  verifySignature,
  clearToken,
  type TripApiRecord,
} from "./apiClient";
import TopSummaryBar from "./components/TopSummaryBar";
import DashboardTab from "./components/DashboardTab";
import MyExpensesTab from "./components/MyExpensesTab";
import ExpenseListTab from "./components/ExpenseListTab";
import SettlementTab from "./components/SettlementTab";
import ItineraryTab from "./components/ItineraryTab";
import { CreateTripModal } from "./components/CreateTripModal";

type Tab = "dashboard" | "my" | "expenses" | "settlement" | "itinerary";

const TAB_LABELS: Record<Tab, string> = {
  dashboard: "대시보드",
  my: "내 경비",
  expenses: "지출 목록",
  settlement: "최종 정산",
  itinerary: "일정·에이전트",
};

// TripApiRecord → Trip 최소 변환 (온체인 잔액은 useContractState에서 별도 읽음)
function apiRecordToTrip(r: TripApiRecord): Trip {
  return {
    id: r.id,
    name: r.name,
    contractAddress: r.contractAddress,
    onchainTripId: BigInt(r.onchainTripId),
    adminId: (r.participants.find((p) => p.isAdmin)?.address ?? r.adminAddress) as ParticipantId,
    participants: r.participants.map((p, i) => ({
      id: (["A", "B", "C", "D"][i] ?? p.address.slice(2, 4)) as ParticipantId,
      name: p.displayName,
      address: p.address,
      isAdmin: p.isAdmin,
      depositedAmount: 0n,
      plannedDeposit: 0n,
      allocatedBudget: 0n,
      spentFromBudget: 0n,
      personalPrepaid: 0n,
      paidDeficit: 0n,
      refundClaimed: false,
    })),
    targetBudget: 0n,
    settlement: null,
    expenses: [],
    itinerary: [],
    createdAt: r.createdAt,
  };
}

export default function App() {
  // ─── TESTNET 상태 ──────────────────────────────────────────────────────
  const [selectedDbTripId, setSelectedDbTripId] = useState<string | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);

  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [showCreateModal, setShowCreateModal] = useState(false);

  // ─── 지갑·체인 ─────────────────────────────────────────────────────────
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const { switchChain, isPending: isSwitchingChain, error: switchChainError } = useSwitchChain();

  // ─── 서버 상태 ─────────────────────────────────────────────────────────
  const { serverOnline, geminiConfigured, checking: serverChecking } = useServerHealth();
  const { isAuthenticated, isExpired, refresh: refreshAuth, markExpired } = useAuthState();

  // ─── 여행방 목록 ───────────────────────────────────────────────────────
  // 서버 온라인 + 인증됨일 때만 활성화. 401 발생 시 markExpired 호출
  const {
    trips: serverTrips,
    loading: tripsLoading,
    error: tripsError,
    loadedOnce: tripsLoadedOnce,
    reload: reloadTrips,
    clearError: clearTripsError,
  } = useMyTrips(serverOnline && isAuthenticated, markExpired);

  // ─── 선택된 여행방 일정·지출 ───────────────────────────────────────────
  const {
    items: serverItinerary,
    reload: reloadItinerary,
  } = useTripItinerary(
    selectedDbTripId,
    serverOnline && isAuthenticated && !!selectedDbTripId
  );
  const {
    expenses: serverExpenses,
  } = useTripExpenses(
    selectedDbTripId,
    serverOnline && isAuthenticated && !!selectedDbTripId
  );

  // ─── 여행방 목록 → 최초 선택 ──────────────────────────────────────────
  useEffect(() => {
    if (serverTrips.length > 0 && !selectedDbTripId) {
      setSelectedDbTripId(serverTrips[0].id);
    }
  }, [serverTrips, selectedDbTripId]);

  // ─── 선택된 여행방 → trip 갱신 ────────────────────────────────────────
  useEffect(() => {
    if (!selectedDbTripId) {
      setTrip(null);
      return;
    }
    const found = serverTrips.find((t) => t.id === selectedDbTripId);
    if (found) {
      setTrip((prev) => {
        const base = apiRecordToTrip(found);
        if (prev?.id === found.id) {
          return { ...prev, name: base.name, participants: base.participants };
        }
        return base;
      });
    }
  }, [selectedDbTripId, serverTrips]);

  // ─── 서버 일정/지출 → trip 병합 ───────────────────────────────────────
  useEffect(() => {
    if (!trip) return;
    if (serverItinerary.length > 0 || serverExpenses.length > 0) {
      setTrip((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          itinerary: serverItinerary.map((i) => ({
            id: i.id,
            tripId: selectedDbTripId ?? "",
            date: i.date,
            time: i.time ?? undefined,
            place: i.location,
            location: i.location,
            activity: i.activity,
            category: (i.category ?? "기타") as ExpenseCategory,
            participants: [] as ParticipantId[],
            status: (i.status as "draft" | "confirmed" | "cancelled") ?? "draft",
            note: i.notes ?? undefined,
            createdAt: i.createdAt,
            updatedAt: i.createdAt,
            costEstimate: (i.estMinUsdc && i.estMaxUsdc)
              ? {
                  minAmount: BigInt(i.estMinUsdc),
                  maxAmount: BigInt(i.estMaxUsdc),
                  currency: i.estCurrency ?? "USD",
                  sourceUrl: i.estSource ?? undefined,
                  retrievedAt: i.estAt ?? new Date().toISOString(),
                  confidence: (
                    i.confidence === "high" || i.confidence === "medium" || i.confidence === "low"
                      ? i.confidence : "unknown"
                  ),
                }
              : null,
          })),
        };
      });
    }
  }, [serverItinerary, serverExpenses, selectedDbTripId]);

  // ─── 지갑 주소 변경 시 데이터 초기화 ──────────────────────────────────
  // address ref: 실제 주소가 달라진 경우(A→B)에만 토큰을 삭제한다.
  // 같은 지갑에서 체인만 전환되면 wagmi가 일시적으로 address를 undefined로 내보낼 수 있으므로
  // undefined → 주소 복귀 시에는 clearToken을 하지 않는다.
  const prevAddressRef = useRef<string | undefined>(address);
  useEffect(() => {
    const prev = prevAddressRef.current;
    prevAddressRef.current = address;

    if (prev && address && prev.toLowerCase() !== address.toLowerCase()) {
      clearToken();
      refreshAuth();
      setTrip(null);
      setSelectedDbTripId(null);
      setAgentMessages([]);
      setAuthError(null);
    }
  }, [address, refreshAuth]);

  // ─── 체인 전환 감지: 다른 체인 → Arc Testnet(5042002) ─────────────────
  // 사용자가 지갑에서 수동으로 Arc Testnet으로 전환하면:
  // 1) stale 오류 메시지를 즉시 제거
  // 2) 세션 토큰이 있으면 여행방 목록을 재요청
  // 자동 체인 전환·서명·거래는 절대 하지 않음.
  const prevChainIdRef = useRef<number>(chainId);
  useEffect(() => {
    const prev = prevChainIdRef.current;
    prevChainIdRef.current = chainId;

    const arcTestnetId = 5042002;
    if (prev !== chainId && chainId === arcTestnetId && prev !== arcTestnetId) {
      // Arc Testnet으로 전환됨 — stale 오류 모두 제거
      setAuthError(null);
      clearTripsError();
      // 세션 토큰이 있으면 trips 재요청 (토큰 없으면 로그인 CTA 표시)
      if (isAuthenticated) {
        void reloadTrips();
      }
    }
  }, [chainId, isAuthenticated, reloadTrips, clearTripsError]);

  // ─── 지갑 서명 로그인 ─────────────────────────────────────────────────
  const handleWalletLogin = useCallback(async () => {
    if (!address) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const nonce = await fetchNonce(address);
      const signature = await signMessageAsync({ message: nonce });
      // verifySignature가 saveToken()을 호출해 sessionStorage에 토큰 저장 후 토큰을 반환
      const newToken = await verifySignature(address, nonce, signature);
      // refreshAuth: React state 업데이트 (비동기 — 이 줄 이후 isAuthenticated는 아직 false일 수 있음)
      refreshAuth();
      // 발급된 토큰을 reloadTrips에 직접 전달 — sessionStorage/state 타이밍 의존성 완전 제거
      await reloadTrips(newToken);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
        setAuthError("서명을 취소했습니다.");
      } else {
        setAuthError(`로그인 실패: ${msg}`);
      }
    } finally {
      setAuthLoading(false);
    }
  }, [address, signMessageAsync, refreshAuth, reloadTrips]);

  // ─── 파생 상태 ─────────────────────────────────────────────────────────
  const connectedParticipant = isConnected && address && trip
    ? trip.participants.find((p) => p.address.toLowerCase() === address.toLowerCase())
    : undefined;

  const currentUserId: ParticipantId = connectedParticipant?.id ?? "A";
  const currentParticipant = trip?.participants.find((p) => p.id === currentUserId) ?? null;
  const summary = trip ? calcParticipantSummary(trip, currentUserId) : null;
  const isWrongChain = isConnected && chainId !== arcTestnet.id;
  const isParticipant = isConnected && !!connectedParticipant;
  const isNonParticipant = isConnected && !connectedParticipant && !!trip;

  // ─── RENDER ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-dvh" style={{ background: "#F7F6F2" }}>
      {/* 헤더 */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-30">
        <div className="max-w-4xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h1 className="text-base font-bold text-stone-800 tracking-tight">
                MoaArc {trip ? `— ${trip.name}` : ""}
              </h1>
              <p className="text-xs text-stone-400">
                <span className="font-mono">
                  {MOAARK_ADDRESS.slice(0, 6)}…{MOAARK_ADDRESS.slice(-4)}
                </span>
                {" · "}
                <a
                  href={`https://explorer.testnet.arc.io/address/${MOAARK_ADDRESS}`}
                  target="_blank" rel="noreferrer"
                  className="text-indigo-500 hover:underline"
                >
                  Arc 탐색기 ↗
                </a>
              </p>
            </div>
            <ConnectKitButton />
          </div>

          {/* 체인 경고 — 잘못된 체인이면 이 배너만 표시하고 인증 UI는 숨김 */}
          {isWrongChain && (
            <div className="mb-2 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-700">
              <div className="flex items-center justify-between gap-2">
                <span>⚠️ Arc Testnet (Chain ID: 5042002)으로 전환해주세요. 현재: {chainId}</span>
                <button
                  onClick={() => switchChain({ chainId: arcTestnet.id })}
                  disabled={isSwitchingChain}
                  className="shrink-0 px-2 py-1 rounded-full bg-rose-600 text-white font-semibold hover:bg-rose-700 disabled:opacity-50"
                >
                  {isSwitchingChain ? "전환 중…" : "Arc Testnet으로 전환"}
                </button>
              </div>
              {switchChainError && (
                <p className="mt-1 text-rose-600">
                  {switchChainError.message.includes("rejected") || switchChainError.message.includes("denied")
                    ? "지갑에서 네트워크 전환을 취소했습니다."
                    : switchChainError.message.includes("Unrecognized chain")
                      ? "지갑이 Arc Testnet을 인식하지 못했습니다. 지갑에서 직접 Arc Testnet을 추가한 뒤 다시 시도하세요."
                      : "네트워크 전환 실패. 지갑에서 직접 Arc Testnet으로 전환해주세요."}
                </p>
              )}
            </div>
          )}

          {/* 로그인 UI — 올바른 체인이고 미인증일 때만 표시 */}
          {isConnected && !isWrongChain && !isAuthenticated && serverOnline && (
            <div className={`mb-2 border rounded-lg px-3 py-2 flex items-center justify-between ${
              isExpired
                ? "bg-amber-50 border-amber-200"
                : "bg-indigo-50 border-indigo-200"
            }`}>
              <span className={`text-xs ${isExpired ? "text-amber-700" : "text-indigo-700"}`}>
                {authLoading
                  ? "지갑에서 서명 요청을 확인해주세요…"
                  : isExpired
                    ? "로그인이 만료됐습니다. 다시 서명해주세요."
                    : "서버에 로그인하려면 지갑으로 서명하세요."}
              </span>
              <button
                onClick={() => { void handleWalletLogin(); }}
                disabled={authLoading}
                className={`ml-3 px-3 py-1 rounded-full text-xs font-semibold text-white disabled:opacity-50 ${
                  isExpired
                    ? "bg-amber-600 hover:bg-amber-700"
                    : "bg-indigo-600 hover:bg-indigo-700"
                }`}
              >
                {authLoading ? "서명 중…" : isExpired ? "지갑으로 다시 인증" : "지갑 서명으로 로그인"}
              </button>
            </div>
          )}

          {/* 오류 메시지 — 잘못된 체인에서는 숨김, tripsError는 인증됐을 때만 표시 */}
          {!isWrongChain && (authError || (isAuthenticated && tripsError)) && (
            <div className="mb-2 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-700">
              {authError || tripsError}
            </div>
          )}

          {/* 참여자 인식 */}
          {isParticipant && (
            <div className="mb-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-700">
              지갑 인식: <strong>{connectedParticipant?.name}</strong> ({address?.slice(0, 6)}…{address?.slice(-4)})
            </div>
          )}
          {isNonParticipant && (
            <div className="mb-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
              ⚠️ 연결된 지갑이 이 여행방 참여자가 아닙니다. 읽기 전용.
            </div>
          )}

          {/* 여행방 전환 (인증됨) + 여행방 추가 버튼 */}
          {isAuthenticated && !isWrongChain && (
            <div className="mb-2 flex items-center gap-2 flex-wrap">
              {serverTrips.length > 0 && (
                <span className="text-xs text-stone-500">여행방:</span>
              )}
              {serverTrips.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedDbTripId(t.id)}
                  className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
                    selectedDbTripId === t.id
                      ? "bg-indigo-100 border-indigo-300 text-indigo-700 font-semibold"
                      : "bg-stone-100 border-stone-200 text-stone-500 hover:bg-stone-200"
                  }`}
                >
                  {t.name}
                </button>
              ))}
              <button
                onClick={() => setShowCreateModal(true)}
                className="px-2 py-0.5 rounded-full text-xs border border-dashed border-indigo-400 text-indigo-600 hover:bg-indigo-50 transition-colors"
                title="여행방 추가"
              >
                + 여행방 추가
              </button>
            </div>
          )}

          {/* Arc Testnet 표시 */}
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-100 text-emerald-800 border-emerald-300">
              🔗 Arc Testnet (5042002)
            </span>
            <span className="text-xs text-stone-500">
              지갑 연결 후 서명으로 로그인
            </span>
          </div>
        </div>
      </header>

      {/* 상단 요약 바 */}
      {currentParticipant && summary && (
        <TopSummaryBar participant={currentParticipant} summary={summary} />
      )}

      {/* 탭 네비게이션 */}
      <div className="bg-white border-b border-stone-200 sticky top-[140px] z-20">
        <div className="max-w-4xl mx-auto px-4">
          <div className="flex overflow-x-auto">
            {(Object.keys(TAB_LABELS) as Tab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === tab
                    ? "border-indigo-600 text-indigo-700"
                    : "border-transparent text-stone-500 hover:text-stone-700"
                }`}
              >
                {TAB_LABELS[tab]}
                {tab === "itinerary" && trip &&
                  trip.itinerary.filter((i) => i.status === "draft").length > 0 && (
                  <span className="ml-1.5 text-xs bg-amber-500 text-white rounded-full px-1.5 py-0.5">
                    {trip.itinerary.filter((i) => i.status === "draft").length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 탭 콘텐츠 */}
      <main className="max-w-4xl mx-auto px-4 py-4 pb-12">

        {/* 서버 오프라인 */}
        {!serverChecking && !serverOnline && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center mt-4">
            <p className="text-amber-700 font-medium mb-1">⚠ API 서버 오프라인</p>
            <p className="text-xs text-amber-600">
              일정·지출·에이전트 데이터는 서버가 실행 중일 때만 저장·복원됩니다.
              서버를 시작하려면: <code className="font-mono bg-amber-100 px-1 rounded">bun run server</code>
            </p>
          </div>
        )}

        {/* ── 체인이 틀림: 체인 전환 안내만 ── */}
        {isConnected && isWrongChain && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-8 text-center mt-4">
            <p className="text-3xl mb-3">🔗</p>
            <h2 className="text-base font-semibold text-rose-700 mb-2">
              Arc Testnet으로 전환하세요
            </h2>
            <p className="text-sm text-rose-600 mb-1">
              현재 체인: <strong>{chainId}</strong> · 필요한 체인: <strong>5042002</strong>
            </p>
            <p className="text-xs text-rose-500">
              지갑에서 직접 네트워크를 Arc Testnet으로 변경해주세요.
            </p>
          </div>
        )}

        {/* ── 지갑 미연결: 연결 CTA ── */}
        {!isConnected && serverOnline && (
          <div className="bg-white rounded-xl border border-stone-200 p-8 text-center mt-4">
            <p className="text-3xl mb-3">👛</p>
            <h2 className="text-base font-semibold text-stone-700 mb-2">지갑을 연결하세요</h2>
            <p className="text-sm text-stone-500 mb-4">
              상단의 지갑 연결 버튼을 눌러 Arc Testnet 지갑을 연결하세요.
            </p>
          </div>
        )}

        {/* ── 지갑 연결됨 + 올바른 체인 + 미인증: 로그인 CTA ── */}
        {isConnected && !isWrongChain && serverOnline && !isAuthenticated && !authLoading && (
          <div className={`rounded-xl border p-8 text-center mt-4 ${
            isExpired
              ? "bg-amber-50 border-amber-200"
              : "bg-white border-stone-200"
          }`}>
            <p className="text-3xl mb-3">{isExpired ? "⏱️" : "🔑"}</p>
            <h2 className={`text-base font-semibold mb-2 ${
              isExpired ? "text-amber-800" : "text-stone-700"
            }`}>
              {isExpired ? "로그인이 만료되었습니다" : "로그인이 필요합니다"}
            </h2>
            <p className={`text-sm mb-4 ${isExpired ? "text-amber-700" : "text-stone-500"}`}>
              {isExpired
                ? "지갑 연결은 유지됩니다. 다시 서명하면 여행방 목록을 불러옵니다."
                : "지갑 서명으로 로그인하면 여행방 목록을 불러옵니다."}
            </p>
            <button
              onClick={() => { void handleWalletLogin(); }}
              disabled={authLoading}
              className={`px-4 py-2 rounded-full text-sm font-semibold text-white disabled:opacity-50 ${
                isExpired
                  ? "bg-amber-600 hover:bg-amber-700"
                  : "bg-indigo-600 hover:bg-indigo-700"
              }`}
            >
              {isExpired ? "지갑으로 다시 인증" : "지갑 서명으로 로그인"}
            </button>
          </div>
        )}

        {/* 인증됨, 여행방 로드 중 */}
        {serverOnline && isAuthenticated && tripsLoading && (
          <div className="text-center py-12 text-stone-400 text-sm">여행방 목록 불러오는 중…</div>
        )}

        {/* 인증됨, 여행방 일반 오류 (401 제외) — 체인이 틀리면 숨김 (체인 안내가 우선) */}
        {serverOnline && isAuthenticated && !isWrongChain && !tripsLoading && tripsError && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 mt-4 text-xs text-rose-700">
            여행방 목록 오류: {tripsError}
            <button onClick={() => { void reloadTrips(); }} className="ml-2 underline">재시도</button>
          </div>
        )}

        {/* ── 인증됨 + API 200 + 빈 배열: 여행방 없음 + 생성 CTA ── */}
        {serverOnline && isAuthenticated && !tripsLoading && !tripsError
          && tripsLoadedOnce && !trip && (
          <div className="bg-white rounded-xl border border-stone-200 p-8 text-center mt-4">
            <p className="text-3xl mb-3">🗺️</p>
            <h2 className="text-base font-semibold text-stone-700 mb-2">참여한 여행방이 없습니다</h2>
            <p className="text-sm text-stone-500 mb-4">
              Arc Testnet에서 스마트 컨트랙트로 여행방을 생성하고 여기에 등록하세요.
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-5 py-2 rounded-full text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700"
            >
              + 여행방 추가
            </button>
            <div className="mt-4 text-xs text-stone-400 bg-stone-50 rounded-lg p-3 text-left space-y-1 max-w-sm mx-auto">
              <p className="font-semibold text-stone-500">등록 방법</p>
              <p>1. Arc Testnet 지갑에서 <code className="font-mono bg-stone-100 px-1 rounded">MoaArcTreasury.createTrip()</code> 실행</p>
              <p>2. 트랜잭션이 완료되면 "여행방 추가" 버튼 클릭</p>
              <p>3. 트랜잭션 해시와 참여자 정보 입력 후 등록</p>
            </div>
          </div>
        )}

        {/* 탭 콘텐츠 — trip이 있을 때 */}
        {trip && activeTab === "dashboard" && (
          <DashboardTab
            trip={trip}
            currentUserId={currentUserId}
            onTripUpdate={setTrip}
            connectedAddress={address}
            isWrongChain={isWrongChain}
          />
        )}
        {trip && activeTab === "my" && (
          <MyExpensesTab trip={trip} currentUserId={currentUserId} />
        )}
        {trip && activeTab === "expenses" && (
          <ExpenseListTab
            trip={trip}
            currentUserId={currentUserId}
            onTripUpdate={setTrip}
          />
        )}
        {trip && activeTab === "settlement" && (
          <SettlementTab
            trip={trip}
            currentUserId={currentUserId}
            onTripUpdate={setTrip}
            connectedAddress={address}
            isWrongChain={isWrongChain}
          />
        )}
        {activeTab === "itinerary" && (
          <ItineraryTab
            trip={trip}
            currentUserId={currentUserId}
            onTripUpdate={trip ? setTrip : () => undefined}
            agentMessages={agentMessages}
            onAgentMessagesUpdate={setAgentMessages}
            dbTripId={selectedDbTripId}
            onItineraryReload={reloadItinerary}
          />
        )}
      </main>

      {/* 여행방 추가 모달 */}
      {showCreateModal && (
        <CreateTripModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(newTrip: import("./apiClient").TripApiRecord) => {
            void reloadTrips();
            setSelectedDbTripId(newTrip.id);
            setShowCreateModal(false);
          }}
          connectedAddress={address ?? ""}
        />
      )}

      {/* 하단 면책 */}
      <footer className="border-t border-stone-200 bg-white py-3 px-4">
        <div className="max-w-4xl mx-auto text-xs text-stone-400 space-y-0.5">
          <p>
            MoaArcTreasury: <span className="font-mono">{MOAARK_ADDRESS}</span> ·
            Arc Testnet (MoaArcTreasury v2.0)
          </p>
          {!serverChecking && (
            <p className={serverOnline ? "text-emerald-600 font-medium" : "text-amber-500 font-medium"}>
              {serverOnline
                ? "✓ API 서버 연결됨 — 일정·지출·메모가 DB에 영속 저장됩니다."
                : "⚠ API 서버 오프라인 — bun run server 로 시작하세요."}
            </p>
          )}
          {serverOnline && (
            <p className={geminiConfigured ? "text-emerald-600 font-medium" : "text-amber-500 font-medium"}>
              {geminiConfigured
                ? "✓ Gemini 에이전트 활성 — 실시간 가격 조사 가능"
                : "⚠ Gemini 미구성 — GEMINI_API_KEY 서버 환경변수 설정 필요"}
            </p>
          )}
          <p className="text-amber-500 font-medium">
            ⚠ 푸시 알림 미구현 — 앱 내 알림만 지원합니다.
          </p>
          <p>
            지출 내역은 수동 입력이며 외부 카드 결제 진위를 앱이 검증하지 않습니다.
          </p>
          <p>
            이 앱은 독립적인 제3자 보안 감사를 받지 않았습니다. 실제 자금 운용 전 감사를 받으세요.
          </p>
        </div>
      </footer>
    </div>
  );
}
