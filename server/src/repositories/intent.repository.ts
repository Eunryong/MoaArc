/**
 * TripCreationIntent repository — bun:sqlite 직접 쿼리만 담당합니다.
 */

import { getDb, newId, toIso, parseDateField } from "../lib/db.js";

export type IntentStatus =
  | "pending_tx"   // 프론트가 아직 트랜잭션을 전송하지 않음
  | "submitted"    // txHash 제출됨, 아직 블록 미확인
  | "confirmed"    // 영수증 확인, TripRecord 생성됨
  | "failed"       // DB 저장 실패 등 내부 오류
  | "reverted";    // 온체인 revert 확인됨

interface IntentRow {
  id: string;
  creatorAddress: string;
  chainId: number | bigint;
  contractAddress: string;
  tripName: string;
  participantAddresses: string;
  targetBudget: string;
  calldata: string;
  status: string;
  txHash: string | null;
  onchainTripId: string | null;
  errorMessage: string | null;
  createdAt: string | number;
  updatedAt: string | number;
}

function intentFromRow(row: IntentRow) {
  return {
    ...row,
    chainId: Number(row.chainId),
    createdAt: parseDateField(row.createdAt) ?? new Date(0),
    updatedAt: parseDateField(row.updatedAt) ?? new Date(0),
  };
}

export async function createIntent(data: {
  creatorAddress: string;
  chainId: number;
  contractAddress: string;
  tripName: string;
  participantAddresses: string[];
  targetBudget: bigint;
  calldata: string;
}) {
  const db = getDb();
  const id = newId();
  const now = toIso(new Date());

  db.prepare(
    `INSERT INTO TripCreationIntent
       (id, creatorAddress, chainId, contractAddress, tripName, participantAddresses,
        targetBudget, calldata, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_tx', ?, ?)`
  ).run(
    id,
    data.creatorAddress.toLowerCase(),
    data.chainId,
    data.contractAddress.toLowerCase(),
    data.tripName,
    JSON.stringify(data.participantAddresses.map((a) => a.toLowerCase())),
    data.targetBudget.toString(),
    data.calldata,
    now, now
  );

  const row = getDb().prepare(
    `SELECT * FROM TripCreationIntent WHERE id = ?`
  ).get(id) as IntentRow;
  return intentFromRow(row);
}

export async function findIntentById(id: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM TripCreationIntent WHERE id = ? LIMIT 1`
  ).get(id) as IntentRow | null;
  return row ? intentFromRow(row) : null;
}

export async function findIntentByTxHash(txHash: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM TripCreationIntent WHERE txHash = ? LIMIT 1`
  ).get(txHash.toLowerCase()) as IntentRow | null;
  return row ? intentFromRow(row) : null;
}

export async function submitIntentTxHash(id: string, txHash: string) {
  const db = getDb();
  db.prepare(
    `UPDATE TripCreationIntent SET txHash = ?, status = 'submitted' WHERE id = ?`
  ).run(txHash.toLowerCase(), id);
  const row = db.prepare(`SELECT * FROM TripCreationIntent WHERE id = ?`).get(id) as IntentRow;
  return intentFromRow(row);
}

export async function updateIntentStatus(
  id: string,
  status: IntentStatus,
  extra?: { onchainTripId?: string; errorMessage?: string }
) {
  const db = getDb();
  if (extra?.onchainTripId !== undefined && extra?.errorMessage !== undefined) {
    db.prepare(
      `UPDATE TripCreationIntent SET status = ?, onchainTripId = ?, errorMessage = ? WHERE id = ?`
    ).run(status, extra.onchainTripId, extra.errorMessage, id);
  } else if (extra?.onchainTripId !== undefined) {
    db.prepare(
      `UPDATE TripCreationIntent SET status = ?, onchainTripId = ? WHERE id = ?`
    ).run(status, extra.onchainTripId, id);
  } else if (extra?.errorMessage !== undefined) {
    db.prepare(
      `UPDATE TripCreationIntent SET status = ?, errorMessage = ? WHERE id = ?`
    ).run(status, extra.errorMessage, id);
  } else {
    db.prepare(
      `UPDATE TripCreationIntent SET status = ? WHERE id = ?`
    ).run(status, id);
  }
  const row = db.prepare(`SELECT * FROM TripCreationIntent WHERE id = ?`).get(id) as IntentRow;
  return intentFromRow(row);
}
