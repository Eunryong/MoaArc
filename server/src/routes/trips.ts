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
    // c.set/get의 "as never" 캐스팅이 런타임에서 불안정하므로
    // req.query()로 직접 읽는 방식을 사용합니다.
    const tm = c.req.query("_method")?.toUpperCase();
    if (tm !== expectedMethod) {
      return next();
    }
    // chain을 순차 실행. middleware는 next 콜백으로 다음 step을 호출하고,
    // terminal handler는 Response를 반환해서 체인을 종료합니다.
    let idx = 0;
    const dispatch = async (): Promise<Response | void> => {
      if (idx >= chain.length) return;
      const fn = chain[idx++];
      if (fn.length >= 2) {
        // middleware signature: (c, next)
        return (fn as Middleware)(c, dispatch);
      }
      // terminal handler signature: (c)
      return (fn as Handler)(c);
    };
    return dispatch();
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
