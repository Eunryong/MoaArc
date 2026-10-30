// bun:test 타입 선언 파일을 명시적으로 로드합니다 (루트 tsconfig 는 bun 타입을 자동 포함하지 않음, 런타임 영향 없음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/**
 * apiClient 의 토큰 ↔ 지갑 신원 바인딩 테스트.
 * localStorage / fetch 를 메모리 가짜로 대체합니다 — 실제 네트워크·브라우저 저장소·DB 를 쓰지 않습니다.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TOKEN_KEY } from "./session";
import { MemoryStorage, fakeJwt } from "./session.testkit";
import {
  setActiveIdentity,
  getToken,
  saveToken,
  clearTokenIfEquals,
  verifySignature,
  listMyTrips,
  ApiError,
} from "./apiClient";

const A = "0xAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const future = () => Math.floor(Date.now() / 1000) + 3600;

type FetchCall = { url: string; auth: string | undefined };

const g = globalThis as unknown as { localStorage: unknown; fetch: unknown };
let store: MemoryStorage;
let savedLocalStorage: unknown;
let savedFetch: unknown;
let calls: FetchCall[];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch(handler: (call: FetchCall) => Promise<Response> | Response) {
  g.fetch = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { url, auth: headers.Authorization };
    calls.push(call);
    return handler(call);
  };
}

beforeEach(() => {
  store = new MemoryStorage();
  savedLocalStorage = g.localStorage;
  savedFetch = g.fetch;
  g.localStorage = store;
  calls = [];
  setActiveIdentity(null);
});

afterEach(() => {
  g.localStorage = savedLocalStorage;
  g.fetch = savedFetch;
  setActiveIdentity(null);
});

describe("getToken — 활성 지갑과 subject 가 같을 때만 반환", () => {
  test("활성 신원이 없으면(연결 해제/재연결 중) 저장된 토큰이 있어도 null", () => {
    store.setItem(TOKEN_KEY, fakeJwt(A, future()));
    expect(getToken()).toBeNull();
  });

  test("subject 일치 시 반환, 다른 지갑으로 바뀌면 null (타 계정 토큰 부활 금지)", () => {
    const tokenA = fakeJwt(A, future());
    store.setItem(TOKEN_KEY, tokenA);
    setActiveIdentity(A);
    expect(getToken()).toBe(tokenA);
    setActiveIdentity(B);
    expect(getToken()).toBeNull();
    setActiveIdentity(null);
    expect(getToken()).toBeNull();
  });

  test("만료된 토큰은 반환하지 않음", () => {
    store.setItem(TOKEN_KEY, fakeJwt(A, Math.floor(Date.now() / 1000) - 10));
    setActiveIdentity(A);
    expect(getToken()).toBeNull();
  });
});

describe("saveToken / verifySignature", () => {
  test("활성 신원과 subject 가 같을 때만 저장", () => {
    setActiveIdentity(A);
    expect(saveToken(fakeJwt(B, future()))).toBe(false);
    expect(store.getItem(TOKEN_KEY)).toBeNull();
    const ok = fakeJwt(A, future());
    expect(saveToken(ok)).toBe(true);
    expect(store.getItem(TOKEN_KEY)).toBe(ok);
  });

  test("서명 도중 지갑이 바뀌면(활성 신원 변경) 발급된 토큰을 저장하지 않고 오류", async () => {
    setActiveIdentity(A);
    installFetch(async () => {
      setActiveIdentity(B); // 서버 응답을 기다리는 사이 사용자가 B 계정으로 전환
      return jsonResponse(200, { token: fakeJwt(A, future()) });
    });
    await expect(verifySignature(A, "nonce", "0xsig")).rejects.toThrow();
    expect(store.getItem(TOKEN_KEY)).toBeNull();
  });

  test("정상 로그인은 토큰을 저장하고 반환", async () => {
    setActiveIdentity(A);
    const token = fakeJwt(A, future());
    installFetch(async () => jsonResponse(200, { token }));
    expect(await verifySignature(A, "nonce", "0xsig")).toBe(token);
    expect(store.getItem(TOKEN_KEY)).toBe(token);
  });

  test("서버가 다른 주소의 토큰을 돌려줘도 저장하지 않음", async () => {
    setActiveIdentity(A);
    installFetch(async () => jsonResponse(200, { token: fakeJwt(B, future()) }));
    await expect(verifySignature(A, "nonce", "0xsig")).rejects.toThrow();
    expect(store.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe("요청 헤더 — 다른 지갑의 토큰은 전송하지 않음", () => {
  test("subject 일치 시 Authorization 헤더 전송", async () => {
    const tokenA = fakeJwt(A, future());
    store.setItem(TOKEN_KEY, tokenA);
    setActiveIdentity(A);
    installFetch(async () => jsonResponse(200, { trips: [] }));
    await listMyTrips();
    expect(calls[0].auth).toBe(`Bearer ${tokenA}`);
  });

  test("저장소에 A 의 토큰이 있어도 B 로 연결돼 있으면 헤더 없음", async () => {
    store.setItem(TOKEN_KEY, fakeJwt(A, future()));
    setActiveIdentity(B);
    installFetch(async () => jsonResponse(200, { trips: [] }));
    await listMyTrips();
    expect(calls[0].auth).toBeUndefined();
  });

  test("연결 해제 후에는 헤더 없음", async () => {
    store.setItem(TOKEN_KEY, fakeJwt(A, future()));
    setActiveIdentity(null);
    installFetch(async () => jsonResponse(200, { trips: [] }));
    await listMyTrips();
    expect(calls[0].auth).toBeUndefined();
  });
});

describe("401 처리 경합", () => {
  const EXPIRED_MSG = { error: "유효하지 않거나 만료된 토큰입니다." };

  test("요청에 쓴 토큰이 여전히 저장돼 있으면 401 에 삭제", async () => {
    const tokenA = fakeJwt(A, future());
    store.setItem(TOKEN_KEY, tokenA);
    setActiveIdentity(A);
    installFetch(async () => jsonResponse(401, EXPIRED_MSG));
    await expect(listMyTrips()).rejects.toBeInstanceOf(ApiError);
    expect(store.getItem(TOKEN_KEY)).toBeNull();
  });

  test("요청 중 같은 계정으로 재로그인해 새 토큰이 저장됐다면, 오래된 요청의 401 이 새 토큰을 지우지 못함", async () => {
    const oldToken = fakeJwt(A, future());
    const newToken = fakeJwt(A, future() + 1000);
    store.setItem(TOKEN_KEY, oldToken);
    setActiveIdentity(A);
    installFetch(async () => {
      store.setItem(TOKEN_KEY, newToken); // 응답 대기 중 새 로그인
      return jsonResponse(401, EXPIRED_MSG);
    });
    await expect(listMyTrips()).rejects.toBeInstanceOf(ApiError);
    expect(store.getItem(TOKEN_KEY)).toBe(newToken);
  });

  test("clearTokenIfEquals 는 다른 토큰을 지우지 않음", () => {
    const t = fakeJwt(A, future());
    store.setItem(TOKEN_KEY, t);
    clearTokenIfEquals(fakeJwt(A, future() + 5));
    expect(store.getItem(TOKEN_KEY)).toBe(t);
    clearTokenIfEquals(t);
    expect(store.getItem(TOKEN_KEY)).toBeNull();
  });
});
