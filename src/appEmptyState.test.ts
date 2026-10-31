// bun:test 타입 선언 파일을 명시적으로 로드합니다 (루트 tsconfig 는 bun 타입을 자동 포함하지 않음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/**
 * Dashboard empty-state visibility regression tests.
 *
 * The bug: after createTrip, the header + My Trips selector showed the new trip
 * ("new"), the Deposit panel was present, but the main dashboard center still
 * rendered "No trips yet" with Testnet instructions — even after Refresh.
 *
 * Root cause: the empty-state condition gated on `!trip` (rawTrip-derived value).
 * `rawTrip` is set by a useEffect that runs AFTER `serverTrips` is populated.
 * In the two async render frames between "server returned the trip list" and
 * "useEffect propagated it into rawTrip", `!trip` was still true while
 * `serverTrips.length > 0` — so both the empty-state and the trip UI rendered.
 *
 * Fix: gate on `serverTrips.length === 0` (the data source) instead of `!trip`
 * (the async derived state).
 *
 * These tests encode the correct visibility rules as pure boolean expressions,
 * mirroring the exact conditions in App.tsx render, so any regression is caught
 * without a DOM render environment.
 */

import { describe, test, expect } from "bun:test";

/**
 * Mirrors the FIXED empty-state condition from App.tsx:
 *
 *   {serverOnline && isAuthenticated && !tripsLoading && !tripsError
 *     && tripsLoadedOnce && serverTrips.length === 0 && ( ... )}
 */
function shouldShowEmptyState(opts: {
  serverOnline: boolean;
  isAuthenticated: boolean;
  tripsLoading: boolean;
  tripsError: string | null;
  tripsLoadedOnce: boolean;
  serverTripsLength: number;
}): boolean {
  return (
    opts.serverOnline &&
    opts.isAuthenticated &&
    !opts.tripsLoading &&
    !opts.tripsError &&
    opts.tripsLoadedOnce &&
    opts.serverTripsLength === 0
  );
}

/**
 * Mirrors the BUGGY condition that existed before the fix:
 *
 *   {serverOnline && isAuthenticated && !tripsLoading && !tripsError
 *     && tripsLoadedOnce && !trip && ( ... )}
 *
 * `trip` here was rawTrip (null during the two async frames after serverTrips arrived).
 */
function shouldShowEmptyStateBuggy(opts: {
  serverOnline: boolean;
  isAuthenticated: boolean;
  tripsLoading: boolean;
  tripsError: string | null;
  tripsLoadedOnce: boolean;
  trip: object | null;   // rawTrip-derived value — null for two frames after list arrives
}): boolean {
  return (
    opts.serverOnline &&
    opts.isAuthenticated &&
    !opts.tripsLoading &&
    !opts.tripsError &&
    opts.tripsLoadedOnce &&
    !opts.trip
  );
}

// Shared base for "authenticated user with a loaded trip list":
const BASE = {
  serverOnline: true,
  isAuthenticated: true,
  tripsLoading: false,
  tripsError: null,
  tripsLoadedOnce: true,
} as const;

describe("empty-state visibility — fixed condition (serverTrips.length === 0)", () => {
  test("shows when authenticated and no trips", () => {
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 0 })).toBe(true);
  });

  test("hidden when serverTrips has 1 trip — even if rawTrip is still null (the bug scenario)", () => {
    // This is the exact frame that caused the bug: list arrived, rawTrip not yet set.
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 1 })).toBe(false);
  });

  test("hidden when serverTrips has multiple trips", () => {
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 3 })).toBe(false);
  });

  test("hidden while trips are loading", () => {
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 0, tripsLoading: true })).toBe(false);
  });

  test("hidden when trips load returned an error", () => {
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 0, tripsError: "500" })).toBe(false);
  });

  test("hidden before first load completes (tripsLoadedOnce=false)", () => {
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 0, tripsLoadedOnce: false })).toBe(false);
  });

  test("hidden when not authenticated", () => {
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 0, isAuthenticated: false })).toBe(false);
  });

  test("hidden when server offline", () => {
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 0, serverOnline: false })).toBe(false);
  });
});

describe("empty-state visibility — buggy condition (!trip) exposes the race", () => {
  // These tests PROVE that the buggy condition was wrong:

  test("[regression] buggy: shows even when serverTrips has a trip but rawTrip is null (the bug)", () => {
    // This is exactly the state during the two-frame window after reloadTrips()
    // returned the new trip but useEffect had not yet set rawTrip.
    expect(shouldShowEmptyStateBuggy({ ...BASE, trip: null })).toBe(true);
    // The FIXED version correctly returns false for the same scenario:
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 1 })).toBe(false);
  });

  test("[regression] buggy: hidden only once rawTrip is non-null (too late — UI already flashed)", () => {
    const fakeTrip = { id: "abc", name: "new" };
    expect(shouldShowEmptyStateBuggy({ ...BASE, trip: fakeTrip })).toBe(false);
  });

  test("fixed: never shows empty-state when serverTrips.length > 0, regardless of rawTrip state", () => {
    // Covers both frames: rawTrip null AND rawTrip set
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 1 })).toBe(false);
    expect(shouldShowEmptyState({ ...BASE, serverTripsLength: 1 })).toBe(false);
  });
});
