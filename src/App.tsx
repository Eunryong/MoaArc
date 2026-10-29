import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "./i18n";
import { useAccount, useChainId, useSignMessage, useSwitchChain } from "wagmi";
import { ConnectKitButton } from "connectkit";
import type { ParticipantId, Trip, AgentMessage, ExpenseCategory } from "./types";
import { calcParticipantSummary } from "./calculations";
import { NETWORK_CONFIG, addressExplorerUrl, CONFIG_VALID } from "./networkConfig";
import {
  useServerHealth,
  useNetworkMatch,
  useAuthState,
  useMyTrips,
  useTripItinerary,
  useTripExpenses,
  useTripNotifications,
} from "./useServerSync";
import { markNotificationRead } from "./apiClient";
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
  const { t, lang, setLang } = useI18n();

  // tab labels inside component so t() is available
  const TAB_LABELS: Record<Tab, string> = {
    dashboard: t("tab_dashboard"),
    my: t("tab_my_expenses"),
    expenses: t("tab_expense_list"),
    settlement: t("tab_settlement"),
    itinerary: t("tab_itinerary"),
  };

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
  // 서버 네트워크 일치 확인 — 불일치 시 지갑 서명 차단
  const { networkReady, errors: networkErrors } = useNetworkMatch(serverOnline);
  const { isAuthenticated, isExpired, refresh: refreshAuth, markExpired } = useAuthState(address);

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

  // ─── 선택된 여행방 알림 ────────────────────────────────────────────────
  const {
    notifications: serverNotifications,
    unreadCount: notifUnreadCount,
    reload: reloadNotifications,
  } = useTripNotifications(
    selectedDbTripId,
    serverOnline && isAuthenticated && !!selectedDbTripId
  );

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
    reload: reloadExpenses,
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

        // 서버 지출 레코드 → Expense 타입 변환
        // address(0x...) → ParticipantId("A","B",...) 역매핑 헬퍼
        const addrToId = (addr: string): ParticipantId => {
          const found = prev.participants.find(
            (p) => p.address.toLowerCase() === addr.toLowerCase()
          );
          return (found?.id ?? addr.slice(2, 4)) as ParticipantId;
        };

        const mappedExpenses: import("./types").Expense[] = serverExpenses.map((e) => {
          const versions: import("./types").ExpenseVersion[] = e.versions.map((v) => {
            const shares = (JSON.parse(v.shares) as { address: string; amountUsdc: string }[]).map((s) => ({
              participantId: addrToId(s.address),
              amount: BigInt(s.amountUsdc),
            }));
            return {
              version: v.version,
              shares,
              proposedBy: addrToId(v.proposedBy),
              proposedAt: v.proposedAt,
              reason: v.reason,
              approvals: v.approvals.map((a) => ({
                participantId: addrToId(a.address),
                approvedAt: a.action === "승인" ? a.approvedAt : null,
                action: (a.action === "승인" || a.action === "수정요청") ? a.action : null,
                reason: a.reason ?? undefined,
              })),
              status: v.status as import("./types").ExpenseStatus,
            };
          });
          const participants = versions[0]
            ? versions[0].shares.map((s) => s.participantId)
            : [];
          return {
            id: e.id,
            tripId: selectedDbTripId ?? "",
            title: e.title,
            category: e.category as ExpenseCategory,
            date: e.date,
            paidBy: addrToId(e.payerAddress),
            totalAmount: BigInt(e.totalUsdc),
            paymentFlow: e.paymentFlow as import("./types").PaymentFlowType,
            participants,
            currentVersion: e.currentVersion,
            versions,
            status: e.status as import("./types").ExpenseStatus,
            refunds: [],
            localCurrency: e.localCurrency ?? undefined,
            localAmount: e.localAmount ?? undefined,
            receiptNote: e.receiptNote ?? undefined,
          };
        });

        return {
          ...prev,
          expenses: mappedExpenses,
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- trip은 setTrip(prev=>) 내부에서만 쓰여 dep 불필요
  }, [serverItinerary, serverExpenses, selectedDbTripId]); // trip 의도적 제외: setTrip(prev=>) 패턴

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

    const targetChainId = NETWORK_CONFIG.chainId;
    if (prev !== chainId && chainId === targetChainId && prev !== targetChainId) {
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
      // 진단: verify 성공 직후 localStorage 토큰 존재 여부만 기록 (값 미기록)
      console.log("[auth] verify success tokenSavedToStorage=" + (!!newToken && !!localStorage.getItem("moaarc_auth_token")));
      // refreshAuth: React state 업데이트 (비동기 — 이 줄 이후 isAuthenticated는 아직 false일 수 있음)
      refreshAuth();
      // 발급된 토큰을 reloadTrips에 직접 전달 — sessionStorage/state 타이밍 의존성 완전 제거
      await reloadTrips(newToken);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
        setAuthError("Signature cancelled.");
      } else {
        setAuthError(`Sign-in failed: ${msg}`);
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
  const isWrongChain = isConnected && chainId !== NETWORK_CONFIG.chainId;
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
                  {NETWORK_CONFIG.contractAddress.slice(0, 6)}…{NETWORK_CONFIG.contractAddress.slice(-4)}
                </span>
                {" · "}
                <a
                  href={addressExplorerUrl(NETWORK_CONFIG.contractAddress)}
                  target="_blank" rel="noreferrer"
                  className="text-indigo-500 hover:underline"
                >
                  {NETWORK_CONFIG.isMainnet ? "Arc Explorer ↗" : "Arc Testnet Explorer ↗"}
                </a>
                {!CONFIG_VALID && (
                  <span className="ml-2 text-rose-500 font-semibold">⚠ 네트워크 설정 오류</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {/* Language toggle */}
              <div className="flex rounded-full border border-stone-200 overflow-hidden text-xs font-semibold">
                <button
                  onClick={() => setLang("en")}
                  className={`px-2.5 py-1 transition-colors ${lang === "en" ? "bg-indigo-600 text-white" : "bg-white text-stone-500 hover:bg-stone-50"}`}
                >
                  {t("lang_en")}
                </button>
                <button
                  onClick={() => setLang("ko")}
                  className={`px-2.5 py-1 transition-colors ${lang === "ko" ? "bg-indigo-600 text-white" : "bg-white text-stone-500 hover:bg-stone-50"}`}
                >
                  {t("lang_ko")}
                </button>
              </div>
              <ConnectKitButton />
            </div>
          </div>

          {/* 체인 경고 — 잘못된 체인이면 이 배너만 표시하고 인증 UI는 숨김 */}
          {isWrongChain && (
            <div className="mb-2 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-700">
              <div className="flex items-center justify-between gap-2">
                <span>⚠️ {t("wrong_chain")} (current: {chainId})</span>
                <button
                  onClick={() => switchChain({ chainId: NETWORK_CONFIG.chainId })}
                  disabled={isSwitchingChain}
                  className="shrink-0 px-2 py-1 rounded-full bg-rose-600 text-white font-semibold hover:bg-rose-700 disabled:opacity-50"
                >
                  {isSwitchingChain ? t("status_loading") : t("switch_to_arc")}
                </button>
              </div>
              {switchChainError && (
                <p className="mt-1 text-rose-600">
                  {switchChainError.message.includes("rejected") || switchChainError.message.includes("denied")
                    ? "Wallet rejected the network switch."
                    : switchChainError.message.includes("Unrecognized chain")
                      ? `Wallet does not recognise this network (chainId ${NETWORK_CONFIG.chainId}). Add it manually and try again.`
                      : `Network switch failed. Please switch to chainId ${NETWORK_CONFIG.chainId} manually in your wallet.`}
                </p>
              )}
            </div>
          )}

          {/* 네트워크 불일치 경고 — 서버 온라인이고 불일치이면 표시 */}
          {serverOnline && !networkReady && networkErrors.length > 0 && (
            <div className="mb-2 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-700">
              ⚠️ {t("network_mismatch_banner")}
              {networkErrors.map((errKey, i) => (
                <div key={i} className="font-mono mt-0.5">
                  {errKey === "network_status_unavailable" ? t("network_status_unavailable")
                    : errKey === "network_pending" ? t("network_pending")
                    : errKey.startsWith("network_chain_mismatch:") ? (() => {
                        const [, sv, cl] = errKey.split(":");
                        return t("network_chain_mismatch", { server: sv ?? "", client: cl ?? "" });
                      })()
                    : errKey.startsWith("network_contract_mismatch:") ? (() => {
                        const [, sv, cl] = errKey.split(":");
                        return t("network_contract_mismatch", { server: sv ?? "", client: cl ?? "" });
                      })()
                    : errKey}
                </div>
              ))}
            </div>
          )}

          {/* 로그인 UI — 올바른 체인이고 미인증이고 네트워크 일치 시 표시 */}
          {isConnected && !isWrongChain && !isAuthenticated && serverOnline && networkReady && (
            <div className={`mb-2 border rounded-lg px-3 py-2 flex items-center justify-between ${
              isExpired
                ? "bg-amber-50 border-amber-200"
                : "bg-indigo-50 border-indigo-200"
            }`}>
              <span className={`text-xs ${isExpired ? "text-amber-700" : "text-indigo-700"}`}>
                {authLoading
                  ? t("signing_in")
                  : isExpired
                    ? t("err_401")
                    : t("sign_in_desc")}
              </span>
              <button
                onClick={() => { void handleWalletLogin(); }}
                disabled={authLoading || !networkReady}
                className={`ml-3 px-3 py-1 rounded-full text-xs font-semibold text-white disabled:opacity-50 ${
                  isExpired
                    ? "bg-amber-600 hover:bg-amber-700"
                    : "bg-indigo-600 hover:bg-indigo-700"
                }`}
              >
                {authLoading ? t("signing_in") : t("sign_in")}
              </button>
            </div>
          )}

          {/* 오류 메시지 — 잘못된 체인에서는 숨김, tripsError는 인증됐을 때만 표시 */}
          {!isWrongChain && (authError || (isAuthenticated && tripsError)) && (
            <div className="mb-2 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-700 flex items-center justify-between gap-2">
              <span>{authError || tripsError}</span>
              <button
                onClick={() => {
                  clearToken();
                  refreshAuth();
                  clearTripsError();
                  setAuthError(null);
                  void handleWalletLogin();
                }}
                disabled={authLoading}
                className="shrink-0 px-2 py-1 rounded-full bg-rose-600 text-white font-semibold hover:bg-rose-700 disabled:opacity-50"
              >
                {t("session_reset")}
              </button>
            </div>
          )}

          {/* 참여자 인식 */}
          {isParticipant && (
            <div className="mb-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-700">
              Wallet: <strong>{connectedParticipant?.name}</strong> ({address?.slice(0, 6)}…{address?.slice(-4)})
            </div>
          )}
          {isNonParticipant && (
            <div className="mb-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
              ⚠️ This wallet is not a participant in this trip. Read-only.
            </div>
          )}

          {/* Trip selector + add button */}
          {isAuthenticated && !isWrongChain && (
            <div className="mb-2 flex items-center gap-2 flex-wrap">
              {serverTrips.length > 0 && (
                <span className="text-xs text-stone-500">{t("my_trips")}:</span>
              )}
              {serverTrips.map((tr) => (
                <button
                  key={tr.id}
                  onClick={() => setSelectedDbTripId(tr.id)}
                  className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
                    selectedDbTripId === tr.id
                      ? "bg-indigo-100 border-indigo-300 text-indigo-700 font-semibold"
                      : "bg-stone-100 border-stone-200 text-stone-500 hover:bg-stone-200"
                  }`}
                >
                  {tr.name}
                </button>
              ))}
              <button
                onClick={() => setShowCreateModal(true)}
                className="px-2 py-0.5 rounded-full text-xs border border-dashed border-indigo-400 text-indigo-600 hover:bg-indigo-50 transition-colors"
                title={t("add_trip")}
              >
                {t("add_trip")}
              </button>
              <button
                onClick={() => { void reloadTrips(); }}
                className="px-2 py-0.5 rounded-full text-xs border border-stone-300 text-stone-500 hover:bg-stone-100 transition-colors"
                title={t("refresh")}
              >
                ↻
              </button>
            </div>
          )}

          {/* Arc Testnet badge */}
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-100 text-emerald-800 border-emerald-300">
              🔗 Arc Testnet (5042002)
            </span>
            <span className="text-xs text-stone-500">
              {t("sign_in_desc")}
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
                {tab === "dashboard" && notifUnreadCount > 0 && (
                  <span className="ml-1.5 text-xs bg-rose-500 text-white rounded-full px-1.5 py-0.5">
                    {notifUnreadCount}
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
            <p className="text-amber-700 font-medium mb-1">⚠ API server offline</p>
            <p className="text-xs text-amber-600">
              Itinerary, expenses and agent data are only persisted while the server is running.
              To start: <code className="font-mono bg-amber-100 px-1 rounded">bun run server</code>
            </p>
          </div>
        )}

        {/* ── 체인이 틀림: 체인 전환 안내만 ── */}
        {isConnected && isWrongChain && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-8 text-center mt-4">
            <p className="text-3xl mb-3">🔗</p>
            <h2 className="text-base font-semibold text-rose-700 mb-2">
              {t("switch_to_arc")}
            </h2>
            <p className="text-sm text-rose-600 mb-1">
              Current chain: <strong>{chainId}</strong> · Required: <strong>5042002</strong>
            </p>
            <p className="text-xs text-rose-500">
              Switch to Arc Testnet manually in your wallet.
            </p>
          </div>
        )}

        {/* ── Wallet not connected ── */}
        {!isConnected && serverOnline && (
          <div className="bg-white rounded-xl border border-stone-200 p-8 text-center mt-4">
            <p className="text-3xl mb-3">👛</p>
            <h2 className="text-base font-semibold text-stone-700 mb-2">{t("connect_wallet")}</h2>
            <p className="text-sm text-stone-500 mb-4">
              Click the wallet button above to connect your Arc Testnet wallet.
            </p>
          </div>
        )}

        {/* ── Connected + correct chain + not authenticated ── */}
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
              {isExpired ? t("err_401") : t("sign_in")}
            </h2>
            <p className={`text-sm mb-4 ${isExpired ? "text-amber-700" : "text-stone-500"}`}>
              {t("sign_in_desc")}
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
              {t("sign_in")}
            </button>
          </div>
        )}

        {/* Loading trips */}
        {serverOnline && isAuthenticated && tripsLoading && (
          <div className="text-center py-12 text-stone-400 text-sm">{t("loading_trips")}</div>
        )}

        {/* Trips error */}
        {serverOnline && isAuthenticated && !isWrongChain && !tripsLoading && tripsError && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 mt-4 text-xs text-rose-700">
            Trip list error: {tripsError}
            <button onClick={() => { void reloadTrips(); }} className="ml-2 underline">Retry</button>
          </div>
        )}

        {/* ── Authenticated, no trips ── */}
        {serverOnline && isAuthenticated && !tripsLoading && !tripsError
          && tripsLoadedOnce && !trip && (
          <div className="bg-white rounded-xl border border-stone-200 p-8 text-center mt-4">
            <p className="text-3xl mb-3">🗺️</p>
            <h2 className="text-base font-semibold text-stone-700 mb-2">{t("no_trips")}</h2>
            <p className="text-sm text-stone-500 mb-4">
              Create a trip on Arc Testnet using the smart contract and register it here.
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-5 py-2 rounded-full text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700"
            >
              {t("add_trip")}
            </button>
            <div className="mt-4 text-xs text-stone-400 bg-stone-50 rounded-lg p-3 text-left space-y-1 max-w-sm mx-auto">
              <p className="font-semibold text-stone-500">How to create a trip</p>
              <p>1. Call <code className="font-mono bg-stone-100 px-1 rounded">MoaArcTreasury.createTrip()</code> from your Arc Testnet wallet</p>
              <p>2. Once the transaction confirms, click "{t("add_trip")}"</p>
              <p>3. Enter the transaction hash and participant info</p>
            </div>
          </div>
        )}

        {/* 알림 패널 — 대시보드 탭 전용 */}
        {activeTab === "dashboard" && serverNotifications.length > 0 && (
          <div className="mb-4 space-y-2">
            <h3 className="text-sm font-semibold text-stone-700">
              {t("notifications_title")} ({notifUnreadCount > 0 ? `${notifUnreadCount} unread` : "all read"})
            </h3>
            {serverNotifications.map((n) => (
              <div
                key={n.id}
                className={`flex items-start justify-between rounded-xl border px-3 py-2 text-sm ${
                  n.read
                    ? "bg-stone-50 border-stone-200 text-stone-500"
                    : "bg-indigo-50 border-indigo-200 text-stone-800"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-xs">{n.title}</p>
                  <p className="text-xs mt-0.5 break-words">{n.body}</p>
                  <p className="text-xs text-stone-400 mt-0.5">{n.createdAt.slice(0, 16).replace("T", " ")}</p>
                </div>
                {!n.read && selectedDbTripId && (
                  <button
                    onClick={() => {
                      void markNotificationRead(selectedDbTripId, n.id).then(() => reloadNotifications());
                    }}
                    className="ml-2 shrink-0 text-xs text-indigo-600 hover:text-indigo-800 font-medium whitespace-nowrap"
                  >
                    {t("mark_read")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 탭 콘텐츠 — trip이 있을 때 */}
        {trip && activeTab === "dashboard" && (
          <DashboardTab
            trip={trip}
            dbTripId={selectedDbTripId ?? ""}
            currentUserId={currentUserId}
            onTripUpdate={setTrip}
            onParticipantAdded={() => { void reloadTrips(); }}
            connectedAddress={address}
            isWrongChain={isWrongChain}
          />
        )}
        {trip && activeTab === "my" && (
          <MyExpensesTab
            trip={trip}
            currentUserId={currentUserId}
            onchainTripId={trip.onchainTripId}
            connectedAddress={address}
          />
        )}
        {trip && activeTab === "expenses" && (
          <ExpenseListTab
            trip={trip}
            currentUserId={currentUserId}
            onTripUpdate={setTrip}
            dbTripId={selectedDbTripId ?? ""}
            onExpenseReload={() => { void reloadExpenses(); }}
            allTrips={serverTrips ?? []}
            onTripSelect={setSelectedDbTripId}
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
            MoaArcTreasury: <span className="font-mono">{NETWORK_CONFIG.contractAddress}</span>
            {" · "}{NETWORK_CONFIG.isMainnet ? "Arc Mainnet" : "Arc Testnet"}
            {" · "}{NETWORK_CONFIG.contractVersion}
          </p>
          {!serverChecking && (
            <p className={serverOnline ? "text-emerald-600 font-medium" : "text-amber-500 font-medium"}>
              {serverOnline
                ? "✓ API server connected — itinerary, expenses and memos are persisted in DB."
                : "⚠ API server offline — run: bun run server"}
            </p>
          )}
          {serverOnline && (
            <p className={geminiConfigured ? "text-emerald-600 font-medium" : "text-amber-500 font-medium"}>
              {geminiConfigured
                ? "✓ Gemini agent active — real-time price research available"
                : "⚠ Gemini not configured — set GEMINI_API_KEY in server env"}
            </p>
          )}
          <p className="text-amber-500 font-medium">
            ⚠ Push notifications not implemented — in-app notifications only.
          </p>
          <p>{t("footer_disclaimer")}</p>
        </div>
      </footer>
    </div>
  );
}
