/**
 * Intent Controller — 여행방 생성 의도 준비·제출·상태 조회
 *
 * 흐름:
 *   POST /api/intent/create-trip      → intent 발급 + calldata 반환
 *   POST /api/intent/:id/submit       → txHash 제출 → RPC 검증 → TripRecord 생성
 *   GET  /api/intent/:id              → intent 상태 조회 (polling용)
 */

import type { Context } from "hono";

// GET 터널(_method=POST) 또는 일반 POST에서 JSON body를 파싱합니다.
async function parseBody<T>(c: Context): Promise<T> {
  // GET 터널: URL 쿼리 _body=base64(JSON) 에서 직접 읽음
  const tunnelB64 = c.req.query("_body");
  if (tunnelB64) {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(tunnelB64)))) as T;
    } catch {
      throw Object.assign(new Error("터널 body JSON 파싱 실패"), { status: 400 });
    }
  }
  return c.req.json<T>();
}
import {
  encodeCreateTripCalldata,
  getTransactionStatus,
  verifyCreateTripTx,
  fetchOnchainParticipants,
  ACTIVE_CHAIN_ID,
  getMoarcContract,
} from "../lib/chain.js";
import * as intentRepo from "../repositories/intent.repository.js";
import * as tripRepo from "../repositories/trip.repository.js";

// ─── 1. intent 준비 ───────────────────────────────────────────────────────────

export async function prepareCreateTripIntent(c: Context) {
  const caller = c.get("callerAddress") as string;
  const body = await parseBody<{
    tripName: string;
    participantAddresses: string[];
    targetBudget: string;
  }>(c);

  const { tripName, participantAddresses, targetBudget } = body ?? {};
  if (!tripName || !Array.isArray(participantAddresses) || targetBudget === undefined) {
    return c.json({ error: "tripName, participantAddresses, targetBudget 필드가 필요합니다." }, 400);
  }

  if (typeof tripName !== "string" || tripName.trim().length === 0 || tripName.length > 200)
    return c.json({ error: "tripName은 1~200자여야 합니다." }, 400);
  if (participantAddresses.length > 50)
    return c.json({ error: "participantAddresses는 최대 50개입니다." }, 400);

  const ADDR_RE = /^0x[0-9a-fA-F]{40}$/i;
  for (const addr of participantAddresses) {
    if (!ADDR_RE.test(addr)) return c.json({ error: `유효하지 않은 주소: ${addr}` }, 400);
  }

  // 마이크로USDC 10진 정수 문자열만 허용 (BigInt() 는 "0x10"·공백·빈 문자열도 받아 주므로 정규식으로 먼저 거름)
  if (typeof targetBudget !== "string" || !/^\d+$/.test(targetBudget)) {
    return c.json({ error: "targetBudget은 0 이상의 정수 문자열(마이크로USDC)이어야 합니다." }, 400);
  }
  const budget = BigInt(targetBudget);
  if (budget > (1n << 256n) - 1n) return c.json({ error: "targetBudget이 너무 큽니다." }, 400);

  const contractAddress = getMoarcContract();
  const chainId = ACTIVE_CHAIN_ID;

  // 생성자는 컨트랙트가 자동 추가 → participants에서 제외
  const otherParticipants = participantAddresses
    .map((a) => a.toLowerCase())
    .filter((a) => a !== caller.toLowerCase()) as `0x${string}`[];

  const calldata = encodeCreateTripCalldata(tripName, otherParticipants, budget);

  const intent = await intentRepo.createIntent({
    creatorAddress: caller,
    chainId,
    contractAddress,
    tripName,
    participantAddresses: otherParticipants,
    targetBudget: budget,
    calldata,
  });

  return c.json({
    intentId: intent.id,
    // 프론트가 지갑에 전달할 unsigned tx 요소
    tx: {
      to: contractAddress as `0x${string}`,
      data: calldata as `0x${string}`,
      value: "0x0",
      chainId,
    },
  }, 201);
}

// ─── 2. txHash 제출 + 백엔드 검증 ────────────────────────────────────────────

export async function submitIntentTxHash(c: Context) {
  const caller = c.get("callerAddress") as string;
  const intentId = c.req.param("intentId") ?? "";
  const body = await parseBody<{ txHash: string }>(c);

  const { txHash } = body ?? {};
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return c.json({ error: "유효한 txHash가 필요합니다." }, 400);
  }

  const intent = await intentRepo.findIntentById(intentId);
  if (!intent) return c.json({ error: "intent를 찾을 수 없습니다." }, 404);
  if (intent.creatorAddress.toLowerCase() !== caller.toLowerCase()) {
    return c.json({ error: "본인의 intent만 제출할 수 있습니다." }, 403);
  }

  // 중복 제출 — 이미 처리된 경우 idempotent 반환
  if (intent.status === "confirmed") {
    return c.json({ intentId: intent.id, status: intent.status });
  }
  if (intent.txHash && intent.txHash.toLowerCase() !== txHash.toLowerCase()) {
    return c.json({ error: "이미 다른 txHash로 제출된 intent입니다." }, 409);
  }

  // txHash 저장 (submitted)
  await intentRepo.submitIntentTxHash(intentId, txHash);

  // 백엔드에서 RPC로 즉시 조회 시도
  const txStatus = await getTransactionStatus(txHash.toLowerCase() as `0x${string}`);

  if (!txStatus.found || !txStatus.confirmed) {
    // 아직 블록 미확인 — pending 상태 반환, 클라이언트가 status polling
    return c.json({ intentId: intent.id, status: "submitted", confirmed: false });
  }

  if (!txStatus.success) {
    await intentRepo.updateIntentStatus(intentId, "reverted", {
      errorMessage: "트랜잭션이 revert되었습니다.",
    });
    return c.json({ intentId: intent.id, status: "reverted", error: "트랜잭션이 revert되었습니다." });
  }

  // 영수증 확인됨 → TripCreated 이벤트 파싱
  return await _confirmAndCreateTrip(c, intent, txHash.toLowerCase() as `0x${string}`);
}

// ─── 3. intent 상태 조회 (polling) ───────────────────────────────────────────

export async function getIntentStatus(c: Context) {
  const caller = c.get("callerAddress") as string;
  const intentId = c.req.param("intentId") ?? "";

  const intent = await intentRepo.findIntentById(intentId);
  if (!intent) return c.json({ error: "intent를 찾을 수 없습니다." }, 404);
  if (intent.creatorAddress.toLowerCase() !== caller.toLowerCase()) {
    return c.json({ error: "본인의 intent만 조회할 수 있습니다." }, 403);
  }

  // submitted 상태이면 RPC를 다시 조회해서 갱신
  if (intent.status === "submitted" && intent.txHash) {
    const txStatus = await getTransactionStatus(intent.txHash as `0x${string}`);
    if (txStatus.found && txStatus.confirmed) {
      if (!txStatus.success) {
        await intentRepo.updateIntentStatus(intentId, "reverted", {
          errorMessage: "트랜잭션이 revert되었습니다.",
        });
        return c.json({ intentId: intent.id, status: "reverted", error: "트랜잭션이 revert되었습니다." });
      }
      // 성공 — TripRecord 생성 시도
      return await _confirmAndCreateTrip(c, intent, intent.txHash as `0x${string}`);
    }
  }

  return c.json({
    intentId: intent.id,
    status: intent.status,
    onchainTripId: intent.onchainTripId ?? null,
    error: intent.errorMessage ?? null,
  });
}

// ─── 내부: 영수증 파싱 + TripRecord 저장 ─────────────────────────────────────

async function _confirmAndCreateTrip(
  c: Context,
  intent: { id: string; chainId: number; contractAddress: string; creatorAddress: string; participantAddresses: string },
  txHash: `0x${string}`
) {
  try {
    const verified = await verifyCreateTripTx(txHash, intent.chainId, intent.contractAddress);

    // admin 검증 — intent의 creatorAddress와 일치해야 함
    if (verified.admin.toLowerCase() !== intent.creatorAddress.toLowerCase()) {
      await intentRepo.updateIntentStatus(intent.id, "failed", {
        errorMessage: "트랜잭션의 admin 주소가 요청자와 다릅니다.",
      });
      return c.json({ intentId: intent.id, status: "failed", error: "admin 주소 불일치" }, 400);
    }

    const onchainTripIdStr = verified.tripId.toString();

    // 중복 체크
    const existing = await tripRepo.findTripByOnchain(
      intent.chainId,
      intent.contractAddress,
      onchainTripIdStr
    );
    if (existing) {
      await intentRepo.updateIntentStatus(intent.id, "confirmed", {
        onchainTripId: onchainTripIdStr,
      });
      return c.json({ intentId: intent.id, status: "confirmed", tripId: existing.id });
    }

    // 온체인 참여자 목록
    const onchainParticipants = await fetchOnchainParticipants(
      intent.contractAddress,
      verified.tripId
    );

    const intentParticipants: string[] = JSON.parse(intent.participantAddresses) as string[];
    const displayNameMap = new Map<string, string>(
      intentParticipants.map((a) => [a.toLowerCase(), a.slice(0, 10)])
    );

    const allParticipants = onchainParticipants.map((addr) => ({
      address: addr,
      displayName: displayNameMap.get(addr) ?? addr.slice(0, 10),
      isAdmin: addr === intent.creatorAddress.toLowerCase(),
    }));

    const trip = await tripRepo.createTrip({
      chainId: intent.chainId,
      contractAddress: intent.contractAddress,
      onchainTripId: onchainTripIdStr,
      name: verified.name,
      adminAddress: intent.creatorAddress,
      createTxHash: txHash,
      participants: allParticipants,
    });

    await intentRepo.updateIntentStatus(intent.id, "confirmed", {
      onchainTripId: verified.tripId.toString(),
    });

    return c.json({ intentId: intent.id, status: "confirmed", tripId: trip.id, trip });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await intentRepo.updateIntentStatus(intent.id, "failed", { errorMessage: msg });
    return c.json({ intentId: intent.id, status: "failed", error: msg }, 400);
  }
}
