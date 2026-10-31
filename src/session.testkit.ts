// 세션/토큰 테스트 공용 도구 (테스트 전용 — 앱 번들에서 import 하지 않음)
import type { TokenStorage } from "./session";

export const NOW = 1_800_000_000_000; // ms

export function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 서명 없는 가짜 JWT — 클라이언트는 서명을 검증하지 않고 sub/exp 만 읽는다 */
export function fakeJwt(sub: string, expSec: number = NOW / 1000 + 3600): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: sub.toLowerCase(), exp: expSec })}.sig`;
}

export class MemoryStorage implements TokenStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

export class FakeTimers {
  private seq = 0;
  private timers = new Map<number, { fn: () => void; at: number }>();
  now = 0;
  set = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.set(id, { fn, at: this.now + ms }); return id; };
  clear = (h: unknown) => { this.timers.delete(h as number); };
  advance(ms: number) {
    this.now += ms;
    for (const [id, t] of [...this.timers]) {
      if (t.at <= this.now) { this.timers.delete(id); t.fn(); }
    }
  }
  pending() { return this.timers.size; }
}

