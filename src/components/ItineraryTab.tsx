// ─── 일정 관리 + 에이전트 대화 탭 ────────────────────────────────────────
//
// 에이전트 기능 범위:
//  - 일정 초안 작성, 비용 추정, 지출 비교, 예산 알림
//  - 할 수 없는 것: 지갑 서명, 자동 승인, 확정 데이터 변경
//
// Gemini API 연동 상태:
//  DEMO 모드: 사전 입력된 시연 메시지만 표시 (실제 API 없음)
//  TESTNET 모드: 서버 GEMINI_API_KEY 환경변수 필요 (현재 미구성 — 아래 안내 참고)

import { useState, useRef, useEffect } from "react";
import { useI18n } from "../i18n";
import type {
  Trip,
  ParticipantId,
  ItineraryItem,
  AgentMessage,
  CostEstimateConfidence,
  Expense,
  ExpenseVersion,
} from "../types";
import { fmtUsdc } from "../calculations";

interface Props {
  trip: Trip | null;
  currentUserId: ParticipantId;
  onTripUpdate: (t: Trip) => void;
  agentMessages: AgentMessage[];
  onAgentMessagesUpdate: (msgs: AgentMessage[]) => void;
  /** DB 여행방 ID */
  dbTripId?: string | null;
  /** 일정 새로고침 콜백 */
  onItineraryReload?: () => void | Promise<void>;
}



// 신뢰도 배지
function ConfidenceBadge({ level, note }: { level: CostEstimateConfidence; note?: string }) {
  const styles: Record<CostEstimateConfidence, string> = {
    high: "bg-emerald-100 text-emerald-700 border-emerald-200",
    medium: "bg-amber-100 text-amber-700 border-amber-200",
    low: "bg-rose-100 text-rose-700 border-rose-200",
    unknown: "bg-stone-100 text-stone-500 border-stone-200",
  };
  const { t } = useI18n();
  const labels: Record<CostEstimateConfidence, string> = {
    high: t("confidence_high"),
    medium: t("confidence_medium"),
    low: t("confidence_low"),
    unknown: t("confidence_unknown"),
  };
  return (
    <span
      title={note ?? ""}
      className={`text-xs px-1.5 py-0.5 rounded border font-medium ${styles[level]}`}
    >
      {labels[level]}
    </span>
  );
}

// 일정 항목 카드
function ItineraryCard({
  item,
  isAdmin,
  onConfirm,
  onCancel,
}: {
  item: ItineraryItem;
  isAdmin: boolean;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const { t } = useI18n();
  const catColors: Record<string, string> = {
    식비: "bg-orange-50 text-orange-700 border-orange-200",
    숙박: "bg-indigo-50 text-indigo-700 border-indigo-200",
    교통: "bg-sky-50 text-sky-700 border-sky-200",
    기타: "bg-stone-50 text-stone-600 border-stone-200",
  };
  const date = new Date(item.date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const est = item.costEstimate;

  return (
    <div
      className={`bg-white rounded-xl border p-4 ${
        item.status === "draft"
          ? "border-amber-200 bg-amber-50/30"
          : item.status === "cancelled"
          ? "border-stone-200 opacity-50"
          : "border-stone-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-xs px-1.5 py-0.5 rounded border ${catColors[item.category] ?? catColors["기타"]}`}>
              {item.category}
            </span>
            {item.status === "draft" && (
              <span className="text-xs px-1.5 py-0.5 rounded border bg-amber-100 text-amber-700 border-amber-200">
                {t("itinerary_draft_badge")}
              </span>
            )}
            {item.status === "cancelled" && (
              <span className="text-xs px-1.5 py-0.5 rounded border bg-stone-100 text-stone-500 border-stone-200">
                {t("status_cancelled")}
              </span>
            )}
          </div>
          <p className="font-semibold text-stone-800 text-sm">{item.activity}</p>
          <p className="text-xs text-stone-500 mt-0.5">
            {date} · {item.place}
          </p>
          {item.note && (
            <p className="text-xs text-stone-400 mt-1 italic">{item.note}</p>
          )}
        </div>
        {/* 비용 예측 */}
        {est ? (
          <div className="text-right shrink-0">
            <div className="flex items-center gap-1 justify-end mb-0.5">
              <ConfidenceBadge level={est.confidence} note={est.confidenceNote} />
            </div>
            <p className="text-sm font-semibold text-stone-700">
              {fmtUsdc(est.minAmount)}–{fmtUsdc(est.maxAmount)} USDC
            </p>
            {est.localCurrency && (
              <p className="text-xs text-stone-400">
                {est.localCurrency} {(est.localMin ?? 0).toLocaleString()}–{(est.localMax ?? 0).toLocaleString()}
              </p>
            )}
            {est.sourceUrl && (
              <a
                href={est.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-indigo-500 hover:underline block truncate max-w-[140px]"
              >
                {t("source_link")} ↗
              </a>
            )}
            {est.retrievedAt && (
              <p className="text-xs text-stone-400">
                {t("retrieved_at")}: {new Date(est.retrievedAt).toLocaleDateString()}
              </p>
            )}
          </div>
        ) : (
          <div className="text-right shrink-0">
            <ConfidenceBadge level="unknown" />
            <p className="text-xs text-stone-400 mt-1">{t("manual_input_needed")}</p>
          </div>
        )}
      </div>

      {/* 연결 지출 */}
      {item.linkedExpenseId && (
        <p className="text-xs text-stone-400 mt-2 border-t border-stone-100 pt-2">
          Linked expense: {item.linkedExpenseId}
        </p>
      )}

      {/* 초안 확인 버튼 (관리자만) */}
      {item.status === "draft" && isAdmin && (
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => onConfirm(item.id)}
            className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium"
          >
            {t("itinerary_confirm_btn")}
          </button>
          <button
            onClick={() => onCancel(item.id)}
            className="px-3 py-1.5 text-xs bg-stone-100 text-stone-600 rounded-lg hover:bg-stone-200"
          >
            {t("skip_btn")}
          </button>
        </div>
      )}
      {item.status === "draft" && !isAdmin && (
        <p className="text-xs text-amber-600 mt-2">{t("admin_confirm_pending")}</p>
      )}
    </div>
  );
}

// 에이전트 메시지 버블
function MessageBubble({
  msg,
  onAccept,
  onReject,
}: {
  msg: AgentMessage;
  onAccept?: (id: string) => void;
  onReject?: (id: string) => void;
}) {
  const { t } = useI18n();
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";

  if (isSystem) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-700 mx-2 my-1">
        {msg.content}
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-bold text-indigo-700 mr-2 mt-1 shrink-0">
          AI
        </div>
      )}
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
          isUser
            ? "bg-indigo-600 text-white rounded-br-sm"
            : "bg-white border border-stone-200 text-stone-800 rounded-bl-sm"
        }`}
      >
        <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
        {msg.hasError && (
          <p className="text-xs text-rose-400 mt-1">
            ⚠️ {msg.errorDetail ?? t("err_500")}
          </p>
        )}
        {/* 제안 카드 */}
        {msg.proposal && msg.proposalResolution === "pending" && (
          <div className="mt-2 pt-2 border-t border-stone-100">
            {msg.proposal.requiresConfirmation && onAccept && onReject && (
              <div className="flex gap-2">
                <button
                  onClick={() => onAccept(msg.id)}
                  className="px-2 py-1 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700"
                >
                  {msg.proposal.confirmLabel ?? t("confirm_btn")}
                </button>
                <button
                  onClick={() => onReject(msg.id)}
                  className="px-2 py-1 text-xs bg-stone-100 text-stone-600 rounded-lg hover:bg-stone-200"
                >
                  {msg.proposal.rejectLabel ?? t("skip_btn")}
                </button>
              </div>
            )}
          </div>
        )}
        {msg.proposalResolution === "accepted" && (
          <p className="text-xs text-emerald-400 mt-1">{t("accepted_label")}</p>
        )}
        {msg.proposalResolution === "rejected" && (
          <p className="text-xs text-stone-400 mt-1">{t("skipped_label")}</p>
        )}
        <p className={`text-xs mt-1 ${isUser ? "text-indigo-200" : "text-stone-400"}`}>
          {new Date(msg.timestamp).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}

// ─── 예산 요약 배너 ────────────────────────────────────────────────────────

function ItineraryBudgetBanner({ trip }: { trip: Trip }) {
  const { t } = useI18n();
  const confirmed = trip.itinerary.filter((i: ItineraryItem) => i.status === "confirmed");
  const drafts = trip.itinerary.filter((i: ItineraryItem) => i.status === "draft");

  let estMin = 0n;
  let estMax = 0n;
  let unknownCount = 0;
  let lowConfCount = 0;

  for (const item of confirmed) {
    if (item.costEstimate) {
      estMin += item.costEstimate.minAmount;
      estMax += item.costEstimate.maxAmount;
      if (item.costEstimate.confidence === "low") lowConfCount++;
    } else {
      unknownCount++;
    }
  }

  const actualConfirmed = trip.expenses
    .filter((e: Expense) => {
      const ver = e.versions.find((v: ExpenseVersion) => v.version === e.currentVersion);
      return ver?.status === "확정";
    })
    .reduce((sum: bigint, e: Expense) => sum + e.totalAmount, 0n);

  const midEst = (estMin + estMax) / 2n;
  const variance = actualConfirmed - midEst;

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-4 mb-4">
      <h3 className="text-sm font-semibold text-stone-700 mb-3">{t("budget_summary_title")}</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <p className="text-stone-400">{t("itinerary_est_range")}</p>
          <p className="font-semibold text-stone-800">
            {fmtUsdc(estMin)}–{fmtUsdc(estMax)} USDC
          </p>
        </div>
        <div>
          <p className="text-stone-400">{t("actual_confirmed_expense")}</p>
          <p className="font-semibold text-stone-800">
            {fmtUsdc(actualConfirmed)} USDC
          </p>
        </div>
        <div>
          <p className="text-stone-400">{t("actual_vs_est")}</p>
          <p className={`font-semibold ${variance > 0n ? "text-rose-600" : "text-emerald-600"}`}>
            {variance >= 0n ? "+" : ""}{fmtUsdc(variance)} USDC
          </p>
        </div>
        <div>
          <p className="text-stone-400">{t("itinerary_status")}</p>
          <p className="font-semibold text-stone-700">
            {t("status_confirmed")} {confirmed.length} / draft {drafts.length}
          </p>
        </div>
      </div>
      {(unknownCount > 0 || lowConfCount > 0) && (
        <p className="text-xs text-amber-600 mt-2 bg-amber-50 px-2 py-1 rounded">
          ⚠️ {t("confidence_unknown")} ×{unknownCount}, {t("confidence_low")} ×{lowConfCount} — manual check needed
        </p>
      )}
      {variance > estMax && (
        <p className="text-xs text-rose-600 mt-2 bg-rose-50 px-2 py-1 rounded">
          🔴 Actual expenses exceeded estimate ceiling ({fmtUsdc(estMax)} USDC).
        </p>
      )}
    </div>
  );
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────

// ─── Main component ──────────────────────────────────────────────────────────
export default function ItineraryTab({
  trip,
  currentUserId,
  onTripUpdate,
  agentMessages,
  onAgentMessagesUpdate,
  dbTripId,
  onItineraryReload,
}: Props) {
  const { t } = useI18n();
  const isAdmin = trip?.participants.find((p) => p.id === currentUserId)?.isAdmin ?? false;
  const [inputText, setInputText] = useState("");
  const [activeView, setActiveView] = useState<"itinerary" | "chat">("itinerary");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 채팅창 자동 스크롤
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agentMessages]);

  const [itineraryError, setItineraryError] = useState<string | null>(null);
  const [itineraryLoading, setItineraryLoading] = useState(false);

  // TESTNET 모드에서 여행방 없을 때 빈 화면
  if (!trip) {
    return (
      <div className="space-y-4">
        <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
          <p className="text-2xl mb-3">🗓️</p>
          <h2 className="text-sm font-semibold text-stone-700 mb-2">{t("no_itinerary")}</h2>
          <p className="text-xs text-stone-400">
            {t("no_itinerary_desc")}
          </p>
        </div>
      </div>
    );
  }

  // early return 이후 trip은 반드시 non-null
  const nonNullTrip = trip;

  // 일정 확정 — 서버 PATCH status=confirmed
  async function handleConfirmItem(itemId: string) {
    if (!isAdmin || !dbTripId) return;
    setItineraryError(null);
    setItineraryLoading(true);
    try {
      const { updateItineraryItem } = await import("../apiClient");
      await updateItineraryItem(dbTripId, itemId, { status: "confirmed" });
      await onItineraryReload?.();
      addAgentMsg(`Itinerary item "${nonNullTrip.itinerary.find((i) => i.id === itemId)?.activity}" confirmed.`);
    } catch (e) {
      setItineraryError(e instanceof Error ? e.message : t("err_500"));
    } finally {
      setItineraryLoading(false);
    }
  }

  // 일정 취소 — 서버 PATCH status=cancelled
  async function handleCancelItem(itemId: string) {
    if (!isAdmin || !dbTripId) return;
    setItineraryError(null);
    setItineraryLoading(true);
    try {
      const { updateItineraryItem } = await import("../apiClient");
      await updateItineraryItem(dbTripId, itemId, { status: "cancelled" });
      await onItineraryReload?.();
    } catch (e) {
      setItineraryError(e instanceof Error ? e.message : t("err_500"));
    } finally {
      setItineraryLoading(false);
    }
  }

  // 에이전트 메시지 추가
  function addAgentMsg(content: string, hasError = false, errorDetail?: string) {
    const msg: AgentMessage = {
      id: `msg-${String(Date.now())}`,
      role: "agent",
      content,
      timestamp: new Date().toISOString(),
      hasError,
      errorDetail,
    };
    onAgentMessagesUpdate([...agentMessages, msg]);
  }

  // 제안 수락 — 서버 POST로 초안 일정 저장
  function handleAcceptProposal(msgId: string) {
    const msg = agentMessages.find((m) => m.id === msgId);
    if (!msg?.proposal) return;
    const updated = agentMessages.map((m) =>
      m.id === msgId ? { ...m, proposalResolution: "accepted" as const } : m
    );
    onAgentMessagesUpdate(updated);

    if (msg.proposal.itineraryDrafts && isAdmin && dbTripId) {
      setItineraryLoading(true);
      setItineraryError(null);
      const drafts = msg.proposal.itineraryDrafts;
      void (async () => {
        try {
          const { addItineraryItem } = await import("../apiClient");
          for (const d of drafts) {
            const loc = (d as { place?: string; location?: string }).place
              ?? (d as { location?: string }).location
              ?? "미정";
            const timeVal = (d as { time?: string }).time;
            const note = (d as { note?: string }).note;
            await addItineraryItem(dbTripId, {
              date: d.date,
              time: timeVal,
              location: loc,
              activity: d.activity,
              participants: [],
              notes: note,
            });
          }
          await onItineraryReload?.();
          addAgentMsg(`${drafts.length} draft item(s) saved. Admin confirmation required.`);
        } catch (e) {
          setItineraryError(e instanceof Error ? e.message : t("err_500"));
        } finally {
          setItineraryLoading(false);
        }
      })();
    }
  }

  function handleRejectProposal(msgId: string) {
    const updated = agentMessages.map((m) =>
      m.id === msgId ? { ...m, proposalResolution: "rejected" as const } : m
    );
    onAgentMessagesUpdate(updated);
  }

  // 사용자 메시지 전송
  function handleSendMessage() {
    const text = inputText.trim();
    if (!text) return;
    const userMsg: AgentMessage = {
      id: `msg-${String(Date.now())}-u`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    const newMsgs = [...agentMessages, userMsg];
    onAgentMessagesUpdate(newMsgs);
    setInputText("");

    // 서버 API 호출
    void handleTestnetAgentRequest(text, newMsgs);
  }

  // TESTNET 전용: 서버 /api/agent/chat 호출
  async function handleTestnetAgentRequest(text: string, msgs: AgentMessage[]) {
    // 비용 관련 키워드 감지 — 서버 측에서도 동일하게 체크하지만 프론트에서도 힌트 전달
    const COST_RE = /비용|얼마|가격|견적|예산|숙소 요금|식당 가격|입장료|교통 요금|티켓/;
    const requestCostSearch = COST_RE.test(text);

    // dynamic import로 번들에 apiClient를 조건부 포함 (DEMO 경로에서는 미실행)
    const { sendAgentMessage, getToken } = await import("../apiClient");

    if (!getToken()) {
      addAgentMsg(
        "Server login required. Click 'Sign in with wallet' above.",
        true, "auth required"
      );
      return;
    }

    // 로딩 메시지 추가
    const loadingId = `msg-${String(Date.now())}-loading`;
    onAgentMessagesUpdate([
      ...msgs,
      { id: loadingId, role: "agent" as const, content: "…", timestamp: new Date().toISOString() },
    ]);

    try {
      const result = await sendAgentMessage(text, dbTripId ?? undefined, requestCostSearch);

      // 로딩 메시지를 실제 응답으로 교체
      const agentMsg: AgentMessage = {
        id: `msg-${String(Date.now())}-a`,
        role: "agent",
        content: result.content,
        timestamp: new Date().toISOString(),
        hasError: result.hasError,
        errorDetail: result.errorDetail,
        // 검색 출처 표시
        ...(result.searchUsed && result.sources && result.sources.length > 0
          ? { searchSources: result.sources }
          : {}),
        // 제안 — requiresConfirmation=true이므로 사용자 확인 전 미반영
        ...(result.proposal
          ? {
              proposal: {
                type: result.proposal.type as "itinerary_draft",
                requiresConfirmation: true,
                itineraryDrafts: result.proposal.itineraryDrafts?.map((d) => ({
                  id: `draft-${String(Date.now())}-${d.date}`,
                  tripId: nonNullTrip?.id ?? "",
                  date: d.date,
                  time: d.time,
                  place: d.location,
                  location: d.location,
                  activity: d.activity,
                  category: "기타" as const,
                  participants: [] as ParticipantId[],
                  status: "draft" as const,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  costEstimate: (d.estMinUsdc && d.estMaxUsdc)
                    ? {
                        minAmount: BigInt(d.estMinUsdc),
                        maxAmount: BigInt(d.estMaxUsdc),
                        currency: d.estCurrency ?? "USD",
                        sourceUrl: d.estSource ?? undefined,
                        retrievedAt: result.retrievedAt ?? new Date().toISOString(),
                        confidence: ((d.confidence === "high" || d.confidence === "medium" || d.confidence === "low") ? d.confidence : "unknown"),
                      }
                    : null,
                })),
                confirmLabel: t("add_to_itinerary"),
                rejectLabel: t("skip_btn"),
              },
              proposalResolution: "pending" as const,
            }
          : {}),
      };

      onAgentMessagesUpdate([
        ...msgs,
        agentMsg,
      ]);

      // 제안 없이 일정을 저장했다면 (확인 후 저장은 handleAcceptProposal에서)
      // 여기서는 아무것도 DB에 저장하지 않음 — 사용자가 "일정에 추가"를 눌러야 저장됨
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      onAgentMessagesUpdate([
        ...msgs,
        {
          id: `msg-${String(Date.now())}-err`,
          role: "agent" as const,
          content: `Server error: ${errMsg}`,
          timestamp: new Date().toISOString(),
          hasError: true,
          errorDetail: errMsg,
        },
      ]);
    }
  }

  const activeItinerary = nonNullTrip.itinerary.filter((i) => i.status !== "cancelled");

  return (
    <div className="space-y-4">
      {/* 탭 전환 */}
      <div className="flex rounded-xl overflow-hidden border border-stone-200 bg-white">
        <button
          onClick={() => setActiveView("itinerary")}
          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
            activeView === "itinerary"
              ? "bg-stone-800 text-white"
              : "text-stone-500 hover:bg-stone-50"
          }`}
        >
          {t("itinerary_view_tab")}
        </button>
        <button
          onClick={() => setActiveView("chat")}
          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
            activeView === "chat"
              ? "bg-stone-800 text-white"
              : "text-stone-500 hover:bg-stone-50"
          }`}
        >
          {t("agent_chat_tab")}
        </button>
      </div>

      {/* 예산 요약 배너 (공통) */}
      <ItineraryBudgetBanner trip={trip} />

      {/* 일정 서버 오류 표시 */}
      {itineraryError && (
        <div className="bg-rose-50 rounded-xl border border-rose-200 px-3 py-2 text-xs text-rose-700">
          ⚠ {itineraryError}
        </div>
      )}

      {/* 일정 목록 뷰 */}
      {activeView === "itinerary" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-stone-700">
              {t("itinerary_view_tab")} ({activeItinerary.length})
              {itineraryLoading && <span className="ml-2 text-xs text-stone-400">{t("saving")}</span>}
            </h3>
          </div>

          {activeItinerary.length === 0 ? (
            <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
              <p className="text-stone-400 text-sm">{t("no_itinerary")}</p>
              <p className="text-xs text-stone-400 mt-1">
                {t("no_itinerary_desc")}
              </p>
            </div>
          ) : (
            activeItinerary.map((item) => (
              <ItineraryCard
                key={item.id}
                item={item}
                isAdmin={isAdmin}
                onConfirm={handleConfirmItem}
                onCancel={handleCancelItem}
              />
            ))
          )}

          {/* 비용 예측 신뢰도 안내 */}
          <div className="bg-stone-50 rounded-xl border border-stone-200 p-3">
            <p className="text-xs text-stone-500 leading-relaxed">
              ℹ️ Cost estimates are from agent research and may differ from actual amounts.
              <br />
              Actual expenses must be recorded manually in the Expenses tab and approved by all participants.
              <br />
              <strong>Agent proposals never automatically change wallet transactions or splits.</strong>
            </p>
          </div>
        </div>
      )}

      {/* 에이전트 대화 뷰 */}
      {activeView === "chat" && (
        <div className="flex flex-col" style={{ height: "520px" }}>
          {/* API 상태 안내 */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-700 mb-3">
            <strong>Server API required</strong> — set GEMINI_API_KEY in server env for real Gemini search. Falls back to local processing otherwise.
          </div>

          {/* 메시지 목록 */}
          <div className="flex-1 overflow-y-auto bg-white border border-stone-200 rounded-xl p-3 mb-3">
            {agentMessages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                onAccept={handleAcceptProposal}
                onReject={handleRejectProposal}
              />
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* 입력창 */}
          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
              placeholder={t("agent_chat_placeholder")}
              className="flex-1 border border-stone-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
            />
            <button
              onClick={handleSendMessage}
              disabled={!inputText.trim()}
              className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("send_btn")}
            </button>
          </div>

          {/* 에이전트 권한 안내 */}
          <p className="text-xs text-stone-400 mt-2 text-center">
            {t("agent_disclaimer")}
          </p>
        </div>
      )}
    </div>
  );
}
