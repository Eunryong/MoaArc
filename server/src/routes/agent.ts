/**
 * POST /api/agent/chat
 * GET  /api/agent/history/:tripDbId
 *
 * Gemini Flash + Google Search grounding 기반 여행 에이전트.
 *
 * 보안 규칙:
 * - GEMINI_API_KEY는 process.env로만 읽음. 응답·로그에 노출 금지.
 * - tripDbId가 제공된 경우 요청자가 해당 여행방 참여자인지 DB에서 확인.
 * - 에이전트는 지갑 서명·자동 승인·송금·환급 불가.
 * - 제안(proposal)은 requiresConfirmation=true. 사용자 확인 전 DB 반영 금지.
 *
 * 검색 정책:
 * - requestCostSearch=true 또는 가격·비용 관련 키워드일 때만 Google Search grounding 활성화.
 * - 일반 대화(일정 질문, 조언 등)에는 검색 도구를 붙이지 않음.
 * - 검색 근거가 없으면 비용 견적을 확정값처럼 제시 금지.
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/requireAuth.js";
import { prisma } from "../lib/prisma.js";

const agent = new Hono();

// ─── 타입 ─────────────────────────────────────────────────────────────────────

interface ItineraryDraftItem {
  date: string;
  time?: string;
  location: string;
  activity: string;
  participants?: string[];
  estMinUsdc?: string | null;
  estMaxUsdc?: string | null;
  estCurrency?: string | null;
  estSource?: string | null;   // grounding에서 추출한 실제 URL
  confidence?: string | null; // high | medium | low | none
}

interface AgentProposal {
  type: "itinerary_draft" | "budget_warning" | "share_suggestion";
  itineraryDrafts?: ItineraryDraftItem[];
  message?: string;
  requiresConfirmation: true;
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  groundingMetadata?: {
    webSearchQueries?: string[];
    groundingChunks?: GroundingChunk[];
    groundingSupports?: Array<{ groundingChunkIndices?: number[] }>;
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

// ─── Gemini 호출 헬퍼 ────────────────────────────────────────────────────────

async function callGemini(opts: {
  userMessage: string;
  tripContext: string;
  useSearch: boolean;
}): Promise<{
  text: string;
  proposal?: AgentProposal;
  searchUsed: boolean;
  sources: Array<{ url: string; title?: string }>;
  error?: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      text: "",
      searchUsed: false,
      sources: [],
      error: "GEMINI_API_KEY가 서버에 설정되지 않았습니다.",
    };
  }

  const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const searchNote = opts.useSearch
    ? "비용·가격 정보가 필요하면 Google Search로 검색하세요. 검색 결과에서 얻은 URL을 estSource에 넣으세요."
    : "이 요청은 비용 검색이 필요하지 않습니다. 가격 정보를 생성하지 마세요. estMinUsdc, estMaxUsdc는 null로 두세요.";

  const systemPrompt = `당신은 여행 일정 관리 에이전트입니다.
역할:
- 사용자의 자연어 여행 요청을 일정 초안과 비용 견적으로 구조화합니다.
- ${searchNote}
- 출처 없는 가격은 생성하지 않습니다. 검색 근거가 없으면 confidence="none", estMinUsdc=null로 표시합니다.
- 사용자 확인 전 확정 일정·정산 데이터를 변경하지 않습니다.
- 지갑 서명, 자동 승인, 송금, 환급을 수행하지 않습니다.

여행 컨텍스트:
${opts.tripContext}

응답은 반드시 아래 JSON 형식으로만 반환하세요:
{
  "message": "사용자에게 전달할 자연어 응답",
  "proposal": {
    "type": "itinerary_draft",
    "requiresConfirmation": true,
    "itineraryDrafts": [
      {
        "date": "YYYY-MM-DD",
        "time": "HH:MM 또는 null",
        "location": "장소명",
        "activity": "활동 설명",
        "estMinUsdc": "마이크로USDC 최솟값 문자열 또는 null",
        "estMaxUsdc": "마이크로USDC 최댓값 문자열 또는 null",
        "estCurrency": "현지 통화 코드 또는 null",
        "estSource": "검색으로 확인된 출처 URL 또는 null",
        "confidence": "high|medium|low|none"
      }
    ]
  }
}
proposal이 없으면 "proposal": null 로 설정하세요.`;

  // 검색이 필요할 때만 tools에 googleSearch 포함
  const tools = opts.useSearch ? [{ googleSearch: {} }] : [];

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${systemPrompt}\n\n사용자 요청: ${opts.userMessage}` }],
      },
    ],
    ...(tools.length > 0 ? { tools } : {}),
    generationConfig: {
      temperature: opts.useSearch ? 0.3 : 0.5,
      topP: 0.8,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (e) {
    return { text: "", searchUsed: false, sources: [], error: `네트워크 오류: ${String(e)}` };
  }

  if (!response.ok) {
    const errText = await response.text();
    // API 키나 세부 내용은 로그에만, 사용자에게는 상태 코드만
    console.error("[Gemini API error]", response.status, errText.slice(0, 200));
    return {
      text: "",
      searchUsed: false,
      sources: [],
      error: `Gemini API 오류 (${response.status}). 잠시 후 다시 시도해주세요.`,
    };
  }

  const data = await response.json() as GeminiResponse;
  const candidate = data.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text ?? "";

  // grounding 출처 추출 (실제 검색이 이뤄진 경우에만 존재)
  const groundingMeta = candidate?.groundingMetadata;
  const searchUsed = (groundingMeta?.webSearchQueries?.length ?? 0) > 0;
  const sources: Array<{ url: string; title?: string }> = (
    groundingMeta?.groundingChunks ?? []
  )
    .filter((c) => c.web?.uri)
    .map((c) => ({ url: c.web!.uri!, title: c.web!.title }));

  // JSON 파싱
  try {
    const parsed = JSON.parse(rawText) as { message?: string; proposal?: AgentProposal | null };

    // proposal에 근거 없는 가격이 있는데 검색을 하지 않았다면 estSource를 null로 보정
    const proposal = parsed.proposal ?? undefined;
    if (proposal?.itineraryDrafts && !searchUsed) {
      for (const draft of proposal.itineraryDrafts) {
        draft.estMinUsdc = null;
        draft.estMaxUsdc = null;
        draft.estSource = null;
        draft.confidence = "none";
      }
    }

    return {
      text: parsed.message ?? rawText,
      proposal,
      searchUsed,
      sources,
    };
  } catch {
    // 파싱 실패: 텍스트만 반환, proposal 없음
    return { text: rawText, searchUsed, sources };
  }
}

// ─── POST /api/agent/chat ────────────────────────────────────────────────────

agent.post("/chat", requireAuth, async (c) => {
  const caller = c.get("callerAddress");
  const body = await c.req.json<{
    message: string;
    tripDbId?: string;
    requestCostSearch?: boolean;
  }>();

  if (!body.message || body.message.trim().length === 0) {
    return c.json({ error: "message 필드가 비어 있습니다." }, 400);
  }
  if (body.message.length > 2000) {
    return c.json({ error: "메시지가 너무 깁니다 (최대 2000자)." }, 400);
  }

  // tripDbId가 있으면 참여자 권한 확인
  let tripContext = "여행방 정보 없음";
  if (body.tripDbId) {
    const participant = await prisma.participantRecord.findFirst({
      where: { tripId: body.tripDbId, address: caller },
    });
    if (!participant) {
      return c.json({ error: "이 여행방의 참여자가 아닙니다." }, 403);
    }

    const trip = await prisma.tripRecord.findUnique({
      where: { id: body.tripDbId },
      include: { participants: true },
    });
    if (trip) {
      const itinerary = await prisma.itineraryRecord.findMany({
        where: { tripId: trip.id, status: { not: "cancelled" } },
        orderBy: [{ date: "asc" }],
        take: 20,
      });
      const itineraryText = itinerary
        .map((i) => `- ${i.date} ${i.time ?? ""} ${i.location}: ${i.activity}`)
        .join("\n");
      tripContext = [
        `여행명: ${trip.name}`,
        `참여자 수: ${trip.participants.length}`,
        `생성일: ${trip.createdAt.toLocaleDateString("ko")}`,
        itinerary.length > 0 ? `\n현재 일정 (${itinerary.length}건):\n${itineraryText}` : "등록된 일정 없음",
      ].join("\n");
    }
  }

  // Gemini 미설정 시 즉시 반환
  if (!process.env.GEMINI_API_KEY) {
    return c.json({
      role: "agent",
      content: "에이전트 실시간 검색이 아직 설정되지 않았습니다.\n서버에 GEMINI_API_KEY 환경변수를 설정하면 활성화됩니다.",
      hasError: true,
      errorDetail: "GEMINI_API_KEY 미설정",
      proposal: null,
      searchUsed: false,
      sources: [],
    });
  }

  // 검색 여부: requestCostSearch=true 또는 비용 관련 키워드 포함
  const COST_KEYWORDS = /비용|얼마|가격|견적|예산|숙소 요금|식당 가격|입장료|교통 요금|티켓/;
  const useSearch = body.requestCostSearch === true || COST_KEYWORDS.test(body.message);

  const result = await callGemini({
    userMessage: body.message,
    tripContext,
    useSearch,
  });

  if (result.error) {
    return c.json({
      role: "agent",
      content: result.error,
      hasError: true,
      errorDetail: result.error,
      proposal: null,
      searchUsed: false,
      sources: [],
    });
  }

  // 대화 기록 저장 (tripDbId가 있을 때만)
  if (body.tripDbId) {
    try {
      await prisma.agentConversation.create({
        data: {
          tripId: body.tripDbId,
          address: caller,
          role: "agent",
          content: result.text,
          hasError: false,
          proposal: result.proposal ? JSON.stringify(result.proposal) : null,
        },
      });
    } catch (e) {
      console.error("[agent] conversation save failed:", String(e));
    }
  }

  return c.json({
    role: "agent",
    content: result.text,
    hasError: false,
    proposal: result.proposal ?? null,
    searchUsed: result.searchUsed,
    sources: result.sources,  // grounding에서 추출한 실제 출처
    retrievedAt: new Date().toISOString(),
  });
});

// ─── GET /api/agent/history/:tripDbId ─────────────────────────────────────────
// 참여자만 접근 가능

agent.get("/history/:tripDbId", requireAuth, async (c) => {
  const tripDbId = c.req.param("tripDbId");
  const caller = c.get("callerAddress");

  // 참여자 확인
  const participant = await prisma.participantRecord.findFirst({
    where: { tripId: tripDbId, address: caller },
  });
  if (!participant) {
    return c.json({ error: "이 여행방의 참여자가 아닙니다." }, 403);
  }

  const history = await prisma.agentConversation.findMany({
    where: { tripId: tripDbId },  // 여행방 전체 대화 (참여자 확인 후)
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return c.json({ history });
});

export default agent;
