/**
 * Trip Routes — URL 매핑과 middleware 연결만 담당합니다.
 * 업무 로직은 controllers/trips.controller.ts에 있습니다.
 *
 * POST   /api/trips
 * GET    /api/trips
 * GET    /api/trips/:dbTripId
 * GET    /api/trips/:dbTripId/itinerary
 * POST   /api/trips/:dbTripId/itinerary
 * PATCH  /api/trips/:dbTripId/itinerary/:itemId
 * GET    /api/trips/:dbTripId/expenses
 * POST   /api/trips/:dbTripId/expenses
 * POST   /api/trips/:dbTripId/expenses/:expenseId/approve
 * GET    /api/trips/:dbTripId/notifications
 * PATCH  /api/trips/:dbTripId/notifications/:notifId/read
 */

import { Hono } from "hono";
import { requireAuth, requireParticipant, requireAdmin } from "../middleware/requireAuth.js";
import * as ctrl from "../controllers/trips.controller.js";

const trips = new Hono();

// ─── 여행방 ───────────────────────────────────────────────────────────────────
trips.post("/",            requireAuth,                                      ctrl.createTrip);
trips.get("/",             requireAuth,                                      ctrl.listTrips);
trips.get("/:dbTripId",    requireAuth, requireParticipant,                  ctrl.getTripDetail);

// ─── 일정 ─────────────────────────────────────────────────────────────────────
trips.get( "/:dbTripId/itinerary",          requireAuth, requireParticipant,              ctrl.getItinerary);
trips.post("/:dbTripId/itinerary",          requireAuth, requireParticipant, requireAdmin, ctrl.addItineraryItem);
trips.patch("/:dbTripId/itinerary/:itemId", requireAuth, requireParticipant, requireAdmin, ctrl.patchItineraryItem);

// ─── 지출 ─────────────────────────────────────────────────────────────────────
trips.get( "/:dbTripId/expenses",                        requireAuth, requireParticipant, ctrl.getExpenses);
trips.post("/:dbTripId/expenses",                        requireAuth, requireParticipant, ctrl.addExpense);
trips.post("/:dbTripId/expenses/:expenseId/approve",     requireAuth, requireParticipant, ctrl.approveExpense);

// ─── 알림 ─────────────────────────────────────────────────────────────────────
trips.get( "/:dbTripId/notifications",                   requireAuth, requireParticipant, ctrl.getNotifications);
trips.patch("/:dbTripId/notifications/:notifId/read",    requireAuth, requireParticipant, ctrl.markNotifRead);

export default trips;
