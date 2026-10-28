/**
 * Trip Routes — URL 매핑과 middleware 연결만 담당합니다.
 * 업무 로직은 controllers/trips.controller.ts에 있습니다.
 *
 * POST   /api/trips
 * GET    /api/trips
 * GET    /api/trips/:dbTripId
 * GET    /api/trips/:dbTripId/itinerary
 * POST   /api/trips/:dbTripId/itinerary          (터널: GET ?_method=POST)
 * PATCH  /api/trips/:dbTripId/itinerary/:itemId  (터널: GET ?_method=PATCH)
 * GET    /api/trips/:dbTripId/expenses
 * POST   /api/trips/:dbTripId/expenses           (터널: GET ?_method=POST)
 * POST   /api/trips/:dbTripId/expenses/:eid/approve (터널: GET ?_method=POST)
 * GET    /api/trips/:dbTripId/notifications
 * PATCH  /api/trips/:dbTripId/notifications/:notifId/read (터널: GET ?_method=PATCH)
 *
 * GET 터널 처리:
 *   Arc Studio 프리뷰 게이트웨이가 POST/PATCH를 차단하므로
 *   클라이언트가 GET ?_method=POST&_body=base64 로 터널링합니다.
 *   index.ts 미들웨어가 _tunnelMethod/_tunnelBody를 context에 저장하고,
 *   각 GET 라우트 핸들러가 _tunnelMethod 값에 따라 컨트롤러를 분기합니다.
 */

import type { Context, Next } from "hono";
import { Hono } from "hono";
import { requireAuth, requireParticipant, requireAdmin } from "../middleware/requireAuth.js";
import * as ctrl from "../controllers/trips.controller.js";

const trips = new Hono();

// ─── GET 터널 분기 헬퍼 ──────────────────────────────────────────────────────
// _tunnelMethod가 expectedMethod면 middleware chain을 순서대로 실행하고 반환.
// 아니면 next()로 넘겨 뒤에 등록된 GET 핸들러(목록 조회)가 실행됩니다.
//
// chain: middleware(c, next) 또는 terminal handler(c) 를 섞어 쓸 수 있습니다.
// Hono v4는 c.res 직접 대입을 지원하지 않으므로 return 방식만 사용합니다.
type Handler    = (c: Context)              => Response | Promise<Response>;
type Middleware = (c: Context, next: Next)  => Promise<Response | void>;

function ifTunnel(expectedMethod: string, ...chain: (Handler | Middleware)[]) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const tm = c.req.query("_method")?.toUpperCase();
    if (tm !== expectedMethod) {
      return next();
    }
    let idx = 0;
    // dispatch must match Hono Next signature: () => Promise<void>
    const dispatch: Next = async (): Promise<void> => {
      if (idx >= chain.length) return;
      const fn = chain[idx++];
      if (fn.length >= 2) {
        await (fn as Middleware)(c, dispatch);
      } else {
        const res = await (fn as Handler)(c);
        // Store response so Hono can send it
        if (res instanceof Response) c.res = res;
      }
    };
    await dispatch();
    // Return c.res if set by a terminal handler
    return c.res instanceof Response ? c.res : undefined;
  };
}

// ─── 여행방 ───────────────────────────────────────────────────────────────────
trips.post("/",            requireAuth,                                      ctrl.createTrip);
trips.get("/",             requireAuth,                                      ctrl.listTrips);
trips.get("/:dbTripId",    requireAuth, requireParticipant,                  ctrl.getTripDetail);

// ─── 일정 ─────────────────────────────────────────────────────────────────────
trips.get( "/:dbTripId/itinerary",
  requireAuth, requireParticipant,
  ifTunnel("POST",  requireAdmin, ctrl.addItineraryItem),
  ctrl.getItinerary,
);
trips.post("/:dbTripId/itinerary",          requireAuth, requireParticipant, requireAdmin, ctrl.addItineraryItem);
trips.patch("/:dbTripId/itinerary/:itemId", requireAuth, requireParticipant, requireAdmin, ctrl.patchItineraryItem);
// PATCH 터널: GET /:dbTripId/itinerary/:itemId?_method=PATCH
trips.get("/:dbTripId/itinerary/:itemId",
  requireAuth, requireParticipant,
  ifTunnel("PATCH", requireAdmin, ctrl.patchItineraryItem),
  async (c) => c.json({ error: "Not found" }, 404),
);

// ─── 지출 ─────────────────────────────────────────────────────────────────────
// GET /expenses — 터널 POST 분기 포함
trips.get( "/:dbTripId/expenses",
  requireAuth, requireParticipant,
  ifTunnel("POST", ctrl.addExpense),
  ctrl.getExpenses,
);
trips.post("/:dbTripId/expenses",                        requireAuth, requireParticipant, ctrl.addExpense);

// GET /expenses/:expenseId/approve — 터널 POST 분기
trips.get( "/:dbTripId/expenses/:expenseId/approve",
  requireAuth, requireParticipant,
  ifTunnel("POST", ctrl.approveExpense),
  async (c) => c.json({ error: "Not found" }, 404),
);
trips.post("/:dbTripId/expenses/:expenseId/approve",     requireAuth, requireParticipant, ctrl.approveExpense);

// ─── 참여자 추가 ─────────────────────────────────────────────────────────────
// POST  /:dbTripId/participants        — 관리자 전용, onchain 검증 후 DB upsert
// GET 터널: GET /:dbTripId/participants?_method=POST
trips.get("/:dbTripId/participants",
  requireAuth, requireParticipant,
  ifTunnel("POST", requireAdmin, ctrl.addTripParticipant),
  async (c) => c.json({ error: "Not found" }, 404),
);
trips.post("/:dbTripId/participants", requireAuth, requireParticipant, requireAdmin, ctrl.addTripParticipant);

// ─── 알림 ─────────────────────────────────────────────────────────────────────
trips.get( "/:dbTripId/notifications",                   requireAuth, requireParticipant, ctrl.getNotifications);
// PATCH 터널: GET /:dbTripId/notifications/:notifId/read?_method=PATCH
trips.get( "/:dbTripId/notifications/:notifId/read",
  requireAuth, requireParticipant,
  ifTunnel("PATCH", ctrl.markNotifRead),
  async (c) => c.json({ error: "Not found" }, 404),
);
trips.patch("/:dbTripId/notifications/:notifId/read",    requireAuth, requireParticipant, ctrl.markNotifRead);

export default trips;
