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
  const labels: Record<CostEstimateConfidence, string> = {
    high: "높은 신뢰도",
    medium: "중간 신뢰도",
    low: "낮은 신뢰도",
    unknown: "가격 자료 없음",
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
  const catColors: Record<string, string> = {
    식비: "bg-orange-50 text-orange-700 border-orange-200",
    숙박: "bg-indigo-50 text-indigo-700 border-indigo-200",
    교통: "bg-sky-50 text-sky-700 border-sky-200",
    기타: "bg-stone-50 text-stone-600 border-stone-200",
  };
  const date = new Date(item.date).toLocaleDateString("ko-KR", {
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
                에이전트 초안 — 확인 필요
              </span>
            )}
            {item.status === "cancelled" && (
              <span className="text-xs px-1.5 py-0.5 rounded border bg-stone-100 text-stone-500 border-stone-200">
                취소됨
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
                출처 ↗
              </a>
            )}
            {est.retrievedAt && (
              <p className="text-xs text-stone-400">
                조회: {new Date(est.retrievedAt).toLocaleDateString("ko-KR")}
              </p>
            )}
          </div>
        ) : (
          <div className="text-right shrink-0">
            <ConfidenceBadge level="unknown" />
            <p className="text-xs text-stone-400 mt-1">수동 입력 필요</p>
          </div>
        )}
      </div>

      {/* 연결 지출 */}
      {item.linkedExpenseId && (
        <p className="text-xs text-stone-400 mt-2 border-t border-stone-100 pt-2">
          연결된 지출: {item.linkedExpenseId}
        </p>
      )}

      {/* 초안 확인 버튼 (관리자만) */}
      {item.status === "draft" && isAdmin && (
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => onConfirm(item.id)}
            className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium"
          >
            일정 확정
          </button>
          <button
            onClick={() => onCancel(item.id)}
            className="px-3 py-1.5 text-xs bg-stone-100 text-stone-600 rounded-lg hover:bg-stone-200"
          >
            건너뜀
          </button>
        </div>
      )}
      {item.status === "draft" && !isAdmin && (
        <p className="text-xs text-amber-600 mt-2">관리자가 확정 전 대기 중</p>
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
            ⚠️ {msg.errorDetail ?? "오류 발생"}
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
                  {msg.proposal.confirmLabel ?? "확인"}
                </button>
                <button
                  onClick={() => onReject(msg.id)}
                  className="px-2 py-1 text-xs bg-stone-100 text-stone-600 rounded-lg hover:bg-stone-200"
                >
                  {msg.proposal.rejectLabel ?? "건너뜀"}
                </button>
              </div>
            )}
          </div>
        )}
        {msg.proposalResolution === "accepted" && (
          <p className="text-xs text-emerald-400 mt-1">확인됨</p>
        )}
        {msg.proposalResolution === "rejected" && (
          <p className="text-xs text-stone-400 mt-1">건너뜀</p>
        )}
        <p className={`text-xs mt-1 ${isUser ? "text-indigo-200" : "text-stone-400"}`}>
          {new Date(msg.timestamp).toLocaleTimeString("ko-KR", {
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
      <h3 className="text-sm font-semibold text-stone-700 mb-3">예산 요약</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <p className="text-stone-400">일정 예상 범위</p>
          <p className="font-semibold text-stone-800">
            {fmtUsdc(estMin)}–{fmtUsdc(estMax)} USDC
          </p>
        </div>
        <div>
          <p className="text-stone-400">확정 실제 지출</p>
          <p className="font-semibold text-stone-800">
            {fmtUsdc(actualConfirmed)} USDC
          </p>
        </div>
        <div>
          <p className="text-stone-400">실제 vs 예상 차이</p>
          <p className={`font-semibold ${variance > 0n ? "text-rose-600" : "text-emerald-600"}`}>
            {variance >= 0n ? "+" : ""}{fmtUsdc(variance)} USDC
          </p>
        </div>
        <div>
          <p className="text-stone-400">일정 현황</p>
          <p className="font-semibold text-stone-700">
            확정 {confirmed.length}건 / 초안 {drafts.length}건
          </p>
        </div>
      </div>
      {(unknownCount > 0 || lowConfCount > 0) && (
        <p className="text-xs text-amber-600 mt-2 bg-amber-50 px-2 py-1 rounded">
          ⚠️ 가격 자료 없음 {unknownCount}건, 낮은 신뢰도 {lowConfCount}건 — 수동 확인 필요
        </p>
      )}
      {variance > estMax && (
        <p className="text-xs text-rose-600 mt-2 bg-rose-50 px-2 py-1 rounded">
          🔴 실제 누적 지출이 예상 상한({fmtUsdc(estMax)} USDC)을 초과했습니다.
        </p>
      )}
    </div>
  );
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────

export default function ItineraryTab({
  trip,
  currentUserId,
  onTripUpdate,
  agentMessages,
  onAgentMessagesUpdate,
  dbTripId,
  onItineraryReload: _onItineraryReload,
}: Props) {
  const isAdmin = trip?.participants.find((p) => p.id === currentUserId)?.isAdmin ?? false;
  const [inputText, setInputText] = useState("");
  const [activeView, setActiveView] = useState<"itinerary" | "chat">("itinerary");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 채팅창 자동 스크롤
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agentMessages]);

  // TESTNET 모드에서 여행방 없을 때 빈 화면
  if (!trip) {
    return (
      <div className="space-y-4">
        <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
          <p className="text-2xl mb-3">🗓️</p>
          <h2 className="text-sm font-semibold text-stone-700 mb-2">일정 정보가 없습니다</h2>
          <p className="text-xs text-stone-400">
            테스트넷 모드에서 여행방을 생성한 뒤 일정을 추가하세요.
          </p>
        </div>
      </div>
    );
  }

  // early return 이후 trip은 반드시 non-null
  const nonNullTrip = trip;

  // 일정 확정
  function handleConfirmItem(itemId: string) {
    if (!isAdmin) return;
    const updated = nonNullTrip.itinerary.map((i) =>
      i.id === itemId ? { ...i, status: "confirmed" as const, updatedAt: new Date().toISOString() } : i
    );
    onTripUpdate({ ...nonNullTrip, itinerary: updated });
    addAgentMsg(`일정 "${nonNullTrip.itinerary.find((i) => i.id === itemId)?.activity}"이(가) 확정되었습니다.`);
  }

  // 일정 취소
  function handleCancelItem(itemId: string) {
    if (!isAdmin) return;
    const updated = nonNullTrip.itinerary.map((i) =>
      i.id === itemId ? { ...i, status: "cancelled" as const, updatedAt: new Date().toISOString() } : i
    );
    onTripUpdate({ ...nonNullTrip, itinerary: updated });
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

  // 제안 수락/거절
  function handleAcceptProposal(msgId: string) {
    const msg = agentMessages.find((m) => m.id === msgId);
    if (!msg?.proposal) return;
    const updated = agentMessages.map((m) =>
      m.id === msgId ? { ...m, proposalResolution: "accepted" as const } : m
    );
    onAgentMessagesUpdate(updated);
    // 초안 일정을 여행에 추가 (관리자만)
    if (msg.proposal.itineraryDrafts && isAdmin) {
      onTripUpdate({
        ...nonNullTrip,
        itinerary: [
          ...nonNullTrip.itinerary.filter(
            (i) => !msg.proposal?.itineraryDrafts?.some((d) => d.id === i.id)
          ),
          ...msg.proposal.itineraryDrafts,
        ],
      });
      addAgentMsg("초안 일정이 추가되었습니다. 관리자가 각 항목을 확인해주세요.");
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
        "서버 로그인이 필요합니다. 상단의 '지갑 서명으로 로그인' 버튼을 눌러주세요.",
        true, "인증 필요"
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
                confirmLabel: "일정에 추가",
                rejectLabel: "건너뜀",
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
          content: `서버 오류: ${errMsg}`,
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
          일정 목록
        </button>
        <button
          onClick={() => setActiveView("chat")}
          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
            activeView === "chat"
              ? "bg-stone-800 text-white"
              : "text-stone-500 hover:bg-stone-50"
          }`}
        >
          에이전트 대화
        </button>
      </div>

      {/* 예산 요약 배너 (공통) */}
      <ItineraryBudgetBanner trip={trip} />

      {/* 일정 목록 뷰 */}
      {activeView === "itinerary" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-stone-700">
              일정 ({activeItinerary.length}개)
            </h3>
          </div>

          {activeItinerary.length === 0 ? (
            <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
              <p className="text-stone-400 text-sm">등록된 일정이 없습니다.</p>
              <p className="text-xs text-stone-400 mt-1">
                에이전트 대화 탭에서 일정을 추가해보세요.
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
              ℹ️ 비용 예측은 에이전트 조사 결과이며 실제 금액과 다를 수 있습니다.
              <br />
              실제 지출은 "지출 목록" 탭에서 수동 기록 후 전원 승인을 받아야 확정됩니다.
              <br />
              <strong>에이전트 제안이 지갑 거래나 분담액을 자동으로 변경하지 않습니다.</strong>
            </p>
          </div>
        </div>
      )}

      {/* 에이전트 대화 뷰 */}
      {activeView === "chat" && (
        <div className="flex flex-col" style={{ height: "520px" }}>
          {/* API 상태 안내 */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-700 mb-3">
            <strong>서버 API 필요</strong> — 실제 Gemini 검색을 사용하려면 서버에
            GEMINI_API_KEY 설정이 필요합니다. 미설정 시 로컬 처리로 응답합니다.
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
              placeholder="일정·비용 질문, 변경 요청을 입력하세요..."
              className="flex-1 border border-stone-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
            />
            <button
              onClick={handleSendMessage}
              disabled={!inputText.trim()}
              className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              전송
            </button>
          </div>

          {/* 에이전트 권한 안내 */}
          <p className="text-xs text-stone-400 mt-2 text-center">
            에이전트는 제안만 합니다. 확정·서명·이체는 항상 사용자가 직접 처리합니다.
          </p>
        </div>
      )}
    </div>
  );
}
