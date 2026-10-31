// ─── 도메인 타입 정의 ───────────────────────────────────────────────────────
//
// 금액은 모두 bigint 마이크로USDC (1 USDC = 1_000_000n)로 처리합니다.
// JavaScript number/parseFloat 는 정산 계산에 사용하지 않습니다.

export type ParticipantId = "A" | "B" | "C" | "D";

/** 온체인 정산 상태 (MoaArkTreasury SettlementStatus enum과 일치) */
export type SettlementStatus =
  | "None"
  | "Proposed"
  | "DeficitPaying"
  | "ClaimStarted"
  | "Completed";

/**
 * 자금 흐름 유형 구분
 * - community_deposit : 참여자가 공동지갑 컨트랙트에 입금
 * - community_release : 관리자가 공동자금을 결제자 외부지갑으로 이체
 * - community_return  : 결제자가 외부지갑 공동자금을 컨트랙트로 반납
 * - personal_prepaid  : 결제자가 자기 개인 자금으로 선결제 (공동자금 미사용)
 */
export type PaymentFlowType =
  | "community_deposit"
  | "community_release"
  | "community_return"
  | "personal_prepaid";

/**
 * 온체인 읽기 상태.
 * - disabled: 읽기 불가 (레거시 방 / onchain tripId 없음)
 * - loading : 첫 응답 대기 중
 * - error   : 읽기 실패 (0n 으로 간주하지 말 것)
 * - ok      : 온체인에서 실제로 읽은 값
 */
export type OnchainReadStatus = "disabled" | "loading" | "error" | "ok";

export interface Participant {
  id: ParticipantId;
  name: string;
  address: string; // 0x...
  isAdmin: boolean;
  /** 실제 온체인 입금 완료액 (마이크로USDC bigint) */
  depositedAmount: bigint;
  /** 입금 예정액 (마이크로USDC bigint) — 온체인 값이 아닌 오프체인 의사 */
  plannedDeposit: bigint;
  /** 결제자 외부 지갑에 나가있는 공동자금 (마이크로USDC bigint, onchain allocatedBudget) */
  allocatedBudget: bigint;
  /** 외부 지갑에서 실제 사용 확인된 공동자금 (마이크로USDC bigint, onchain spentFromBudget) */
  spentFromBudget: bigint;
  /** 개인 자금으로 선결제한 금액 (마이크로USDC bigint, onchain personalPrepaid) */
  personalPrepaid: bigint;
  /** 납입한 부족분 (마이크로USDC bigint, onchain paidDeficit) */
  paidDeficit: bigint;
  /** 환급 수령 완료 여부 */
  refundClaimed: boolean;
  /**
   * depositedAmount / allocatedBudget / spentFromBudget 의 온체인 읽기 상태.
   * undefined = 로컬(시연) 데이터로 간주. "ok"가 아니면 위 세 필드의 0n은 "값 없음"이지 실제 0이 아닙니다.
   */
  onchainStatus?: OnchainReadStatus;
}

export type ExpenseCategory = "식비" | "숙박" | "교통" | "기타";
export type ExpenseStatus =
  | "승인대기"
  | "확정"
  | "수정안투표중"
  | "취소됨";

export interface ShareEntry {
  participantId: ParticipantId;
  /** 분담액 (마이크로USDC bigint) */
  amount: bigint;
}

export interface SettlementApprovalRecord {
  participantId: ParticipantId;
  approvedAt: string | null; // ISO date string or null
  action: "승인" | "수정요청" | null;
  reason?: string; // 수정 요청 사유
}

export interface ExpenseVersion {
  version: number;
  shares: ShareEntry[];
  proposedBy: ParticipantId;
  proposedAt: string; // ISO date string
  reason: string; // 변경 이유
  approvals: SettlementApprovalRecord[];
  status: ExpenseStatus;
}

/**
 * 환불 상태 구분
 * - pending_external  : 환불 예정 (외부에서 아직 처리 중, 공동지갑 미입금)
 * - confirmed_external: 외부에서 환불 완료됐다고 결제자가 확인, 온체인 미입금
 * - completed_onchain : 실제로 공동지갑 컨트랙트 잔액에 반영 완료
 */
export type RefundOnchainStatus =
  | "pending_external"
  | "confirmed_external"
  | "completed_onchain";

export interface Refund {
  id: string;
  expenseId: string;
  type: "전액환불" | "부분환불비례" | "부분환불지정";
  /** 실제 환불된 금액 (마이크로USDC bigint) */
  amount: bigint;
  returnedTo: "공동지갑" | "결제지갑";
  /** 온체인 확인 전 상태 구분 */
  onchainStatus: RefundOnchainStatus;
  completedAt?: string;
  shareAdjustments?: ShareEntry[];
  note: string;
}

export interface Expense {
  id: string;
  tripId: string;
  title: string; // 가맹점/제목
  category: ExpenseCategory;
  date: string; // ISO date string
  /** USDC 기준 정산금액 (마이크로USDC bigint) */
  totalAmount: bigint;
  localCurrency?: string; // 예: JPY
  localAmount?: number; // 현지 화폐 금액 (표시용, 정산에 미사용)
  fee?: bigint; // 확인된 수수료 (마이크로USDC bigint, 총액에 이미 포함된 경우 0n)
  paidBy: ParticipantId; // 결제자
  /** 해당 지출에 쓰인 자금 흐름 */
  paymentFlow: PaymentFlowType;
  participants: ParticipantId[]; // 해당 지출 참여자 목록
  receiptNote?: string; // 영수증 메모 (수동 기록 — 외부 플랫폼 검증 아님)
  currentVersion: number; // 현재 활성 버전 번호
  versions: ExpenseVersion[]; // 버전 히스토리
  refunds: Refund[];
  /** 연결된 일정 항목 ID (에이전트 제안, 사용자 확인 필요) */
  linkedItineraryId?: string;
  /** 일정 연결이 확정됐는지 여부 (false면 에이전트 제안 상태) */
  itineraryLinkConfirmed?: boolean;
}

export type SettlementApproval = {
  participantId: ParticipantId;
  approved: boolean;
  approvedAt?: string;
};

export interface FinalSettlement {
  /** 온체인 파생 해시 (MoaArkTreasury: keccak256(tripId, version, members, refunds, deficits)) */
  ledgerHash: string;
  /** 컨트랙트 정산 버전 */
  version: number;
  members: ParticipantId[];
  /** 돌려받을 금액 (마이크로USDC bigint) */
  finalRefundAmounts: Record<ParticipantId, bigint>;
  /** 추가 납입 필요 금액 (마이크로USDC bigint) */
  requiredDeficits: Record<ParticipantId, bigint>;
  approvals: SettlementApproval[];
  proposed: boolean;
  proposedAt?: string;
  /** 온체인 정산 상태 */
  status: SettlementStatus;
}

// ─── 일정 관리 타입 ──────────────────────────────────────────────────────────

export type ItineraryItemStatus =
  | "draft"       // 에이전트 초안 — 사용자 확인 전
  | "confirmed"   // 사용자 확인 완료
  | "cancelled";  // 취소됨

export type CostEstimateConfidence = "high" | "medium" | "low" | "unknown";

export interface CostEstimate {
  /** 예상 최솟값 (마이크로USDC bigint) */
  minAmount: bigint;
  /** 예상 최댓값 (마이크로USDC bigint) */
  maxAmount: bigint;
  /** 현지 통화 코드 (예: JPY) */
  localCurrency?: string;
  /** 현지 통화 예상 금액 (표시용) */
  localMin?: number;
  localMax?: number;
  /** 환율 정보 */
  exchangeRate?: number;
  exchangeRateSource?: string;
  exchangeRateAt?: string; // ISO date string
  /** 검색 출처 URL */
  sourceUrl?: string;
  /** 조사 시각 */
  retrievedAt?: string; // ISO date string
  /** 추정 신뢰도 */
  confidence: CostEstimateConfidence;
  /** 신뢰도가 낮거나 검색 실패 시 사유 */
  confidenceNote?: string;
}

export interface ItineraryItem {
  id: string;
  tripId: string;
  /** 상태: 에이전트 초안 vs 사용자 확정 */
  status: ItineraryItemStatus;
  /** 날짜·시간 (ISO date string) */
  date: string;
  /** 장소 (도시, 명칭 등) */
  place: string;
  /** 활동/제목 */
  activity: string;
  /** 분류 */
  category: ExpenseCategory;
  /** 이 일정에 참여하는 사람들 */
  participants: ParticipantId[];
  /** 비용 예측 (에이전트가 채움, null이면 미조사) */
  costEstimate: CostEstimate | null;
  /** 실제 연결된 지출 ID */
  linkedExpenseId?: string;
  /** 메모 */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── 에이전트 대화 타입 ──────────────────────────────────────────────────────

export type AgentMessageRole = "user" | "agent" | "system";

/** 에이전트 제안의 종류 */
export type AgentProposalType =
  | "itinerary_draft"     // 일정 초안
  | "cost_estimate"       // 비용 추정
  | "expense_match"       // 지출-일정 매칭 제안
  | "budget_alert"        // 예산 초과 알림
  | "share_suggestion"    // 분담안 제안 (확정 아님)
  | "info";               // 일반 정보

export interface AgentProposal {
  type: AgentProposalType;
  /** 초안 일정 항목들 (itinerary_draft) */
  itineraryDrafts?: ItineraryItem[];
  /** 영향받는 기존 일정 ID */
  affectedItineraryIds?: string[];
  /** 지출-일정 매칭 제안 */
  expenseMatch?: { expenseId: string; itineraryId: string };
  /** 비용 변경 전후 비교 */
  costComparison?: {
    before: bigint;
    after: bigint;
    affectedParticipants: ParticipantId[];
  };
  /** 확인이 필요한지 여부 */
  requiresConfirmation: boolean;
  /** 확인 버튼 레이블 */
  confirmLabel?: string;
  /** 거절 버튼 레이블 */
  rejectLabel?: string;
}

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  timestamp: string; // ISO date string
  /** 첨부된 에이전트 제안 (role === "agent"인 경우) */
  proposal?: AgentProposal;
  /** 제안 처리 결과 */
  proposalResolution?: "accepted" | "rejected" | "pending";
  /** API/검색 오류가 있었는지 */
  hasError?: boolean;
  errorDetail?: string;
  /** Gemini grounding에서 추출한 검색 출처 */
  searchSources?: Array<{ url: string; title?: string }>;
}

export interface Trip {
  id: string;
  name: string;
  contractAddress: string;
  /** 온체인 tripId (bigint, TESTNET 모드에서만 유효) */
  onchainTripId?: bigint;
  adminId: ParticipantId;
  participants: Participant[];
  /** 목표 예산 (마이크로USDC bigint) */
  targetBudget: bigint;
  expenses: Expense[];
  /** 여행 일정 항목 */
  itinerary: ItineraryItem[];
  settlement: FinalSettlement | null;
  createdAt: string;
  /** 앱이 온체인에서 직접 읽은 tripBalance (마이크로USDC bigint) */
  onchainTripBalance?: bigint;
  /** 온체인 정산 상태 */
  onchainSettlementStatus?: SettlementStatus;
}

// ─── 계산 헬퍼 타입 ─────────────────────────────────────────────────────────

export interface ParticipantSummary {
  /** 실제 온체인 입금 완료액 (마이크로USDC bigint) */
  depositedAmount: bigint;
  /** 입금 예정액 (마이크로USDC bigint) */
  plannedDeposit: bigint;
  /** 전원 승인 완료된 확정 부담액 (마이크로USDC bigint) */
  confirmedBurden: bigint;
  /** 아직 대기 중인 잠정 부담액 (마이크로USDC bigint) */
  pendingBurden: bigint;
  /** 외부 결제지갑에 나가있는 공동자금 (마이크로USDC bigint) */
  allocatedBudget: bigint;
  /** 외부 지갑에서 확인된 실사용 공동자금 (마이크로USDC bigint) */
  spentFromBudget: bigint;
  /** 개인 선결제액 (마이크로USDC bigint) */
  personalPrepaid: bigint;
  /** 납입한 부족분 (마이크로USDC bigint) */
  paidDeficit: bigint;
  /**
   * 정산 차액 = depositedAmount - confirmedBurden - allocatedBudget (미반납 공동자금)
   * 양수: 돌려받을 금액 / 음수: 추가 납부 필요
   */
  netBalance: bigint;
  refundClaimed: boolean;
  /** deposited/allocated/spent/netBalance 가 온체인에서 실제로 읽혔는지. "ok"가 아니면 표시하지 말 것 */
  balancesStatus: OnchainReadStatus;
}

// ─── 일정 예산 요약 ──────────────────────────────────────────────────────────

export interface ItineraryBudgetSummary {
  /** 일정 예상 합계 최솟값 (마이크로USDC bigint) */
  estimatedMin: bigint;
  /** 일정 예상 합계 최댓값 (마이크로USDC bigint) */
  estimatedMax: bigint;
  /** 확정 실제 지출 합계 (마이크로USDC bigint) */
  actualConfirmed: bigint;
  /** 확정 지출 - 예상 합계 중간값 (마이크로USDC bigint, 양수면 초과) */
  variance: bigint;
  /** 미조사 항목 수 */
  unknownCount: number;
  /** 낮은 신뢰도 항목 수 */
  lowConfidenceCount: number;
}
