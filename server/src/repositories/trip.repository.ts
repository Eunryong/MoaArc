/**
 * Trip Repository — bun:sqlite 직접 쿼리만 담당합니다.
 * 업무 규칙, HTTP 관련 코드가 없습니다.
 * 모든 사용자 입력값은 파라미터 바인딩으로만 전달합니다.
 */

import { getDb, newId, toIso, parseDateField, toBigIntSafe } from "../lib/db.js";

// ─── 내부 타입 헬퍼 ───────────────────────────────────────────────────────────

/**
 * DB raw row 타입 — INTEGER 컬럼은 bun:sqlite 기본(safeIntegers=false)에서
 * number로 반환됩니다. Prisma 기존 행과의 하위 호환을 위해 number | bigint | string을
 * 허용하고, fromRow 함수에서 parseDateField / toBigIntSafe로 정규화합니다.
 */

/** DB에서 읽은 TripRecord raw row */
interface TripRow {
  id: string;
  chainId: number | bigint;
  contractAddress: string;
  onchainTripId: number | bigint | string;
  name: string;
  adminAddress: string;
  createTxHash: string;
  createdAt: string | number;
  updatedAt: string | number;
}

interface ParticipantRow {
  id: string;
  tripId: string;
  address: string;
  displayName: string;
  isAdmin: number | bigint;
}

interface ItineraryRow {
  id: string;
  tripId: string;
  date: string;
  time: string | null;
  location: string;
  activity: string;
  participants: string;
  status: string;
  notes: string | null;
  estMinUsdc: number | bigint | string | null;
  estMaxUsdc: number | bigint | string | null;
  estCurrency: string | null;
  estSource: string | null;
  estAt: string | number | null;
  confidence: string | null;
  createdBy: string;
  createdAt: string | number;
  updatedAt: string | number;
}

interface ExpenseRow {
  id: string;
  tripId: string;
  payerAddress: string;
  title: string;
  category: string;
  date: string;
  localCurrency: string | null;
  localAmount: number | null;
  totalUsdc: number | bigint | string;
  paymentFlow: string;
  currentVersion: number | bigint;
  status: string;
  receiptNote: string | null;
  createdBy: string;
  createdAt: string | number;
  updatedAt: string | number;
}

interface VersionRow {
  id: string;
  expenseId: string;
  version: number | bigint;
  shares: string;
  proposedBy: string;
  proposedAt: string | number;
  reason: string;
  status: string;
}

interface ApprovalRow {
  id: string;
  versionId: string;
  address: string;
  action: string;
  reason: string | null;
  approvedAt: string | number;
}

interface NotificationRow {
  id: string;
  tripId: string;
  address: string;
  type: string;
  title: string;
  body: string;
  read: number | bigint;
  createdAt: string | number;
}

// ─── 공통 변환 헬퍼 ───────────────────────────────────────────────────────────
//
// 각 fromRow 함수는 bun:sqlite에서 읽은 raw row를 정규화합니다.
//  - 날짜: parseDateField() — TEXT(ISO-8601) 및 INTEGER(밀리초 epoch) 모두 처리
//  - BigInt: toBigIntSafe() — number, bigint, string 모두 처리
//  - Boolean: !== 0 비교 — INTEGER 0/1 (bun:sqlite) 및 bigint 0n 모두 처리

function tripFromRow(row: TripRow) {
  return {
    ...row,
    chainId: Number(row.chainId),
    onchainTripId: toBigIntSafe(row.onchainTripId) ?? 0n,
    createdAt: parseDateField(row.createdAt) ?? new Date(0),
    updatedAt: parseDateField(row.updatedAt) ?? new Date(0),
  };
}

function participantFromRow(row: ParticipantRow) {
  return { ...row, isAdmin: Number(row.isAdmin) !== 0 };
}

function itineraryFromRow(row: ItineraryRow) {
  return {
    ...row,
    estMinUsdc: row.estMinUsdc != null ? toBigIntSafe(row.estMinUsdc) : null,
    estMaxUsdc: row.estMaxUsdc != null ? toBigIntSafe(row.estMaxUsdc) : null,
    estAt: row.estAt != null ? parseDateField(row.estAt) : null,
    createdAt: parseDateField(row.createdAt) ?? new Date(0),
    updatedAt: parseDateField(row.updatedAt) ?? new Date(0),
  };
}

function expenseFromRow(row: ExpenseRow) {
  return {
    ...row,
    totalUsdc: toBigIntSafe(row.totalUsdc) ?? 0n,
    currentVersion: Number(row.currentVersion),
    createdAt: parseDateField(row.createdAt) ?? new Date(0),
    updatedAt: parseDateField(row.updatedAt) ?? new Date(0),
  };
}

function versionFromRow(row: VersionRow) {
  return {
    ...row,
    version: Number(row.version),
    proposedAt: parseDateField(row.proposedAt) ?? new Date(0),
  };
}

function approvalFromRow(row: ApprovalRow) {
  return { ...row, approvedAt: parseDateField(row.approvedAt) ?? new Date(0) };
}

function notificationFromRow(row: NotificationRow) {
  return {
    ...row,
    read: Number(row.read) !== 0,
    createdAt: parseDateField(row.createdAt) ?? new Date(0),
  };
}

// ─── 여행방 ───────────────────────────────────────────────────────────────────

export async function findTripsByParticipant(address: string) {
  const db = getDb();
  const trips = db.prepare(
    `SELECT t.* FROM TripRecord t
     INNER JOIN ParticipantRecord p ON p.tripId = t.id
     WHERE p.address = ?
     ORDER BY t.createdAt DESC`
  ).all(address) as TripRow[];

  // 각 여행방에 participants 포함
  return trips.map((t) => {
    const participants = db.prepare(
      `SELECT * FROM ParticipantRecord WHERE tripId = ?`
    ).all(t.id) as ParticipantRow[];
    return { ...tripFromRow(t), participants: participants.map(participantFromRow) };
  });
}

export async function findTripById(id: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM TripRecord WHERE id = ? LIMIT 1`
  ).get(id) as TripRow | null;
  if (!row) return null;

  const participants = db.prepare(
    `SELECT * FROM ParticipantRecord WHERE tripId = ?`
  ).all(id) as ParticipantRow[];
  return { ...tripFromRow(row), participants: participants.map(participantFromRow) };
}

export async function findTripByOnchain(chainId: number, contractAddress: string, onchainTripId: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM TripRecord
     WHERE chainId = ? AND contractAddress = ? AND onchainTripId = ?
     LIMIT 1`
  ).get(chainId, contractAddress.toLowerCase(), onchainTripId) as TripRow | null;
  if (!row) return null;
  return tripFromRow(row);
}

export async function createTrip(data: {
  chainId: number;
  contractAddress: string;
  onchainTripId: string;
  name: string;
  adminAddress: string;
  createTxHash: string;
  participants: { address: string; displayName: string; isAdmin: boolean }[];
}) {
  const db = getDb();
  const id = newId();
  const now = toIso(new Date());

  db.prepare(
    `INSERT INTO TripRecord
       (id, chainId, contractAddress, onchainTripId, name, adminAddress, createTxHash, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.chainId,
    data.contractAddress.toLowerCase(),
    data.onchainTripId,
    data.name,
    data.adminAddress.toLowerCase(),
    data.createTxHash.toLowerCase(),
    now, now
  );

  for (const p of data.participants) {
    db.prepare(
      `INSERT INTO ParticipantRecord (id, tripId, address, displayName, isAdmin)
       VALUES (?, ?, ?, ?, ?)`
    ).run(newId(), id, p.address.toLowerCase(), p.displayName, p.isAdmin ? 1 : 0);
  }

  const result = await findTripById(id);
  if (!result) throw new Error("createTrip: 저장 직후 조회 실패");
  return result;
}

// ─── 참여자 ───────────────────────────────────────────────────────────────────

export async function findParticipant(tripId: string, address: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM ParticipantRecord WHERE tripId = ? AND address = ? LIMIT 1`
  ).get(tripId, address.toLowerCase()) as ParticipantRow | null;
  return row ? participantFromRow(row) : null;
}

export const findParticipantByAddress = findParticipant;

export async function createParticipant(data: {
  tripId: string;
  address: string;
  displayName: string;
  isAdmin: boolean;
}) {
  const db = getDb();
  const id = newId();
  db.prepare(
    `INSERT INTO ParticipantRecord (id, tripId, address, displayName, isAdmin)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, data.tripId, data.address.toLowerCase(), data.displayName, data.isAdmin ? 1 : 0);

  const row = db.prepare(
    `SELECT * FROM ParticipantRecord WHERE id = ?`
  ).get(id) as ParticipantRow;
  return participantFromRow(row);
}

/**
 * 4인 제한 초과 방지를 DB 트랜잭션으로 직렬화합니다.
 * SQLite BEGIN EXCLUSIVE 트랜잭션 내에서 count → insert 순서를 보장합니다.
 * 동시 추가 요청이 제한을 초과하면 "MAX_PARTICIPANTS" 메시지로 throw합니다.
 */
export async function addParticipantAtomic(data: {
  tripId: string;
  address: string;
  displayName: string;
  maxParticipants: number;
}) {
  const db = getDb();
  const participantId = newId();

  // bun:sqlite의 동기 트랜잭션 — BEGIN EXCLUSIVE로 직렬화
  const run = db.transaction(() => {
    // safeIntegers=true에서 COUNT(*) 결과는 bigint이므로 Number()로 정규화
    const countRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM ParticipantRecord WHERE tripId = ?`
    ).get(data.tripId) as { cnt: number | bigint };

    const cnt = Number(countRow.cnt);
    if (cnt >= data.maxParticipants) {
      throw new Error(`MAX_PARTICIPANTS: ${cnt} >= ${data.maxParticipants}`);
    }

    db.prepare(
      `INSERT INTO ParticipantRecord (id, tripId, address, displayName, isAdmin)
       VALUES (?, ?, ?, ?, 0)`
    ).run(participantId, data.tripId, data.address.toLowerCase(), data.displayName);
  });

  run(); // 동기 실행 — throws on MAX_PARTICIPANTS

  return findTripById(data.tripId);
}

export async function findParticipantsByTrip(tripId: string) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM ParticipantRecord WHERE tripId = ?`
  ).all(tripId) as ParticipantRow[];
  return rows.map(participantFromRow);
}

// ─── 일정 ─────────────────────────────────────────────────────────────────────

export async function findItinerary(tripId: string) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM ItineraryRecord WHERE tripId = ? ORDER BY date ASC, time ASC`
  ).all(tripId) as ItineraryRow[];
  return rows.map(itineraryFromRow);
}

export async function findItineraryItem(itemId: string, tripId: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM ItineraryRecord WHERE id = ? AND tripId = ? LIMIT 1`
  ).get(itemId, tripId) as ItineraryRow | null;
  return row ? itineraryFromRow(row) : null;
}

export async function createItineraryItem(data: {
  tripId: string;
  date: string;
  time?: string;
  location: string;
  activity: string;
  participants?: string[];
  notes?: string;
  createdBy: string;
}) {
  const db = getDb();
  const id = newId();
  const now = toIso(new Date());
  db.prepare(
    `INSERT INTO ItineraryRecord
       (id, tripId, date, time, location, activity, participants, status, notes, createdBy, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
  ).run(
    id, data.tripId, data.date,
    data.time ?? null,
    data.location, data.activity,
    JSON.stringify(data.participants ?? []),
    data.notes ?? null,
    data.createdBy, now, now
  );
  const row = db.prepare(`SELECT * FROM ItineraryRecord WHERE id = ?`).get(id) as ItineraryRow;
  return itineraryFromRow(row);
}

/**
 * ItineraryRecord 수정 가능 컬럼 허용 목록.
 *
 * updateItineraryItem은 동적 SET 절을 사용합니다.
 * 컬럼명을 외부 입력에서 받지 않고 이 Set에서만 선택하여
 * 컬럼명 보간을 통한 SQL 주입을 원천 차단합니다.
 * 새 컬럼이 필요하면 이 Set에 추가해야 하며,
 * 그 외 컬럼명은 쿼리에 포함되지 않습니다.
 */
const ITINERARY_UPDATABLE_COLS = new Set([
  "date", "time", "location", "activity", "participants",
  "notes", "status", "estMinUsdc", "estMaxUsdc", "estCurrency",
  "estSource", "confidence", "estAt",
] as const);

export async function updateItineraryItem(
  itemId: string,
  patch: Partial<{
    date: string; time: string | null; location: string; activity: string;
    participants: string;
    notes: string | null; status: string;
    estMinUsdc: bigint; estMaxUsdc: bigint; estCurrency: string;
    estSource: string; confidence: string; estAt: Date;
  }>
) {
  const db = getDb();
  // sets 배열에는 허용 목록에서 선택한 "col = ?" 리터럴만 들어갑니다.
  // 외부 입력(patch의 값)은 모두 vals를 통해 바인딩 파라미터로 전달됩니다.
  // bun:sqlite SQLQueryBindings: string | number | bigint | boolean | null (undefined 제외)
  const sets: string[] = [];
  const vals: (string | number | bigint | boolean | null)[] = [];

  // 각 항목은 ITINERARY_UPDATABLE_COLS에 포함된 컬럼명만 sets에 추가합니다.
  // TypeScript의 타입 체크 + 런타임 Set 검사로 이중 방어합니다.
  if (patch.date !== undefined)         { console.assert(ITINERARY_UPDATABLE_COLS.has("date"));         sets.push("date = ?");         vals.push(patch.date); }
  if (patch.time !== undefined)         { console.assert(ITINERARY_UPDATABLE_COLS.has("time"));         sets.push("time = ?");         vals.push(patch.time); }
  if (patch.location !== undefined)     { console.assert(ITINERARY_UPDATABLE_COLS.has("location"));     sets.push("location = ?");     vals.push(patch.location); }
  if (patch.activity !== undefined)     { console.assert(ITINERARY_UPDATABLE_COLS.has("activity"));     sets.push("activity = ?");     vals.push(patch.activity); }
  if (patch.participants !== undefined) { console.assert(ITINERARY_UPDATABLE_COLS.has("participants")); sets.push("participants = ?"); vals.push(patch.participants); }
  if (patch.notes !== undefined)        { console.assert(ITINERARY_UPDATABLE_COLS.has("notes"));        sets.push("notes = ?");        vals.push(patch.notes); }
  if (patch.status !== undefined)       { console.assert(ITINERARY_UPDATABLE_COLS.has("status"));       sets.push("status = ?");       vals.push(patch.status); }
  if (patch.estMinUsdc !== undefined)   { console.assert(ITINERARY_UPDATABLE_COLS.has("estMinUsdc"));   sets.push("estMinUsdc = ?");   vals.push(patch.estMinUsdc.toString()); }
  if (patch.estMaxUsdc !== undefined)   { console.assert(ITINERARY_UPDATABLE_COLS.has("estMaxUsdc"));   sets.push("estMaxUsdc = ?");   vals.push(patch.estMaxUsdc.toString()); }
  if (patch.estCurrency !== undefined)  { console.assert(ITINERARY_UPDATABLE_COLS.has("estCurrency"));  sets.push("estCurrency = ?");  vals.push(patch.estCurrency); }
  if (patch.estSource !== undefined)    { console.assert(ITINERARY_UPDATABLE_COLS.has("estSource"));    sets.push("estSource = ?");    vals.push(patch.estSource); }
  if (patch.confidence !== undefined)   { console.assert(ITINERARY_UPDATABLE_COLS.has("confidence"));   sets.push("confidence = ?");   vals.push(patch.confidence); }
  if (patch.estAt !== undefined)        { console.assert(ITINERARY_UPDATABLE_COLS.has("estAt"));        sets.push("estAt = ?");        vals.push(toIso(patch.estAt)); }

  if (sets.length === 0) {
    const row = db.prepare(`SELECT * FROM ItineraryRecord WHERE id = ?`).get(itemId) as ItineraryRow | null;
    return row ? itineraryFromRow(row) : null;
  }

  // sets의 요소는 위 코드에서 하드코딩된 "col = ?" 리터럴만 가능합니다.
  // vals의 요소는 모두 바인딩 파라미터로 전달됩니다.
  vals.push(itemId);
  db.prepare(`UPDATE ItineraryRecord SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  const row = db.prepare(`SELECT * FROM ItineraryRecord WHERE id = ?`).get(itemId) as ItineraryRow | null;
  return row ? itineraryFromRow(row) : null;
}

// ─── 지출 ─────────────────────────────────────────────────────────────────────

function loadVersionsWithApprovals(db: ReturnType<typeof getDb>, expenseId: string) {
  const versions = db.prepare(
    `SELECT * FROM ExpenseVersion WHERE expenseId = ? ORDER BY version ASC`
  ).all(expenseId) as VersionRow[];
  return versions.map((v) => {
    const approvals = db.prepare(
      `SELECT * FROM ExpenseApproval WHERE versionId = ?`
    ).all(v.id) as ApprovalRow[];
    return { ...versionFromRow(v), approvals: approvals.map(approvalFromRow) };
  });
}

export async function findExpenses(tripId: string) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM ExpenseRecord WHERE tripId = ? ORDER BY date ASC`
  ).all(tripId) as ExpenseRow[];
  return rows.map((r) => ({
    ...expenseFromRow(r),
    versions: loadVersionsWithApprovals(db, r.id),
  }));
}

export async function findExpenseById(expenseId: string, tripId: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM ExpenseRecord WHERE id = ? AND tripId = ? LIMIT 1`
  ).get(expenseId, tripId) as ExpenseRow | null;
  if (!row) return null;
  const versions = db.prepare(
    `SELECT * FROM ExpenseVersion WHERE expenseId = ? ORDER BY version DESC LIMIT 1`
  ).all(expenseId) as VersionRow[];
  const versionsWithApprovals = versions.map((v) => {
    const approvals = db.prepare(
      `SELECT * FROM ExpenseApproval WHERE versionId = ?`
    ).all(v.id) as ApprovalRow[];
    return { ...versionFromRow(v), approvals: approvals.map(approvalFromRow) };
  });
  return { ...expenseFromRow(row), versions: versionsWithApprovals };
}

export async function createExpense(data: {
  tripId: string;
  payerAddress: string;
  title: string;
  category: string;
  date: string;
  totalUsdc: bigint;
  paymentFlow: string;
  localCurrency?: string;
  localAmount?: number;
  receiptNote?: string;
  createdBy: string;
  shares: { address: string; amountUsdc: string }[];
}) {
  const db = getDb();
  const expenseId = newId();
  const versionId = newId();
  const approvalId = newId();
  const now = toIso(new Date());

  db.transaction(() => {
    db.prepare(
      `INSERT INTO ExpenseRecord
         (id, tripId, payerAddress, title, category, date, localCurrency, localAmount,
          totalUsdc, paymentFlow, currentVersion, status, receiptNote, createdBy, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '승인대기', ?, ?, ?, ?)`
    ).run(
      expenseId, data.tripId, data.payerAddress, data.title, data.category, data.date,
      data.localCurrency ?? null, data.localAmount ?? null,
      data.totalUsdc.toString(), data.paymentFlow,
      data.receiptNote ?? null, data.createdBy, now, now
    );

    db.prepare(
      `INSERT INTO ExpenseVersion (id, expenseId, version, shares, proposedBy, reason, status, proposedAt)
       VALUES (?, ?, 1, ?, ?, '최초 등록', '승인대기', ?)`
    ).run(versionId, expenseId, JSON.stringify(data.shares), data.createdBy, now);

    db.prepare(
      `INSERT INTO ExpenseApproval (id, versionId, address, action, approvedAt)
       VALUES (?, ?, ?, '승인', ?)`
    ).run(approvalId, versionId, data.createdBy, now);
  })();

  const result = await findExpenseById(expenseId, data.tripId);
  if (!result) throw new Error("createExpense: 저장 직후 조회 실패");
  return result;
}

export async function createExpenseVersion(data: {
  expenseId: string;
  version: number;
  shares: { address: string; amountUsdc: string }[];
  proposedBy: string;
  reason: string;
}) {
  const db = getDb();
  const versionId = newId();
  const approvalId = newId();
  const now = toIso(new Date());

  db.transaction(() => {
    db.prepare(
      `INSERT INTO ExpenseVersion (id, expenseId, version, shares, proposedBy, reason, status, proposedAt)
       VALUES (?, ?, ?, ?, ?, ?, '승인대기', ?)`
    ).run(versionId, data.expenseId, data.version, JSON.stringify(data.shares), data.proposedBy, data.reason, now);

    db.prepare(
      `INSERT INTO ExpenseApproval (id, versionId, address, action, approvedAt)
       VALUES (?, ?, ?, '승인', ?)`
    ).run(approvalId, versionId, data.proposedBy, now);
  })();

  const row = db.prepare(`SELECT * FROM ExpenseVersion WHERE id = ?`).get(versionId) as VersionRow;
  const approvals = db.prepare(`SELECT * FROM ExpenseApproval WHERE versionId = ?`).all(versionId) as ApprovalRow[];
  return { ...versionFromRow(row), approvals: approvals.map(approvalFromRow) };
}

export async function updateExpenseStatus(expenseId: string, data: { status: string; currentVersion?: number }) {
  const db = getDb();
  if (data.currentVersion !== undefined) {
    db.prepare(
      `UPDATE ExpenseRecord SET status = ?, currentVersion = ? WHERE id = ?`
    ).run(data.status, data.currentVersion, expenseId);
  } else {
    db.prepare(
      `UPDATE ExpenseRecord SET status = ? WHERE id = ?`
    ).run(data.status, expenseId);
  }
}

export async function updateExpenseVersionStatus(versionId: string, status: string) {
  const db = getDb();
  db.prepare(`UPDATE ExpenseVersion SET status = ? WHERE id = ?`).run(status, versionId);
}

export async function findExpenseApproval(versionId: string, address: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM ExpenseApproval WHERE versionId = ? AND address = ? LIMIT 1`
  ).get(versionId, address.toLowerCase()) as ApprovalRow | null;
  return row ? approvalFromRow(row) : null;
}

export async function upsertExpenseApproval(data: {
  existingId?: string;
  versionId: string;
  address: string;
  action: string;
  reason?: string;
}) {
  const db = getDb();
  const now = toIso(new Date());
  if (data.existingId) {
    db.prepare(
      `UPDATE ExpenseApproval SET action = ?, reason = ? WHERE id = ?`
    ).run(data.action, data.reason ?? null, data.existingId);
    const row = db.prepare(`SELECT * FROM ExpenseApproval WHERE id = ?`).get(data.existingId) as ApprovalRow;
    return approvalFromRow(row);
  }
  const id = newId();
  db.prepare(
    `INSERT INTO ExpenseApproval (id, versionId, address, action, reason, approvedAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, data.versionId, data.address.toLowerCase(), data.action, data.reason ?? null, now);
  const row = db.prepare(`SELECT * FROM ExpenseApproval WHERE id = ?`).get(id) as ApprovalRow;
  return approvalFromRow(row);
}

export async function findAllApprovals(versionId: string) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM ExpenseApproval WHERE versionId = ?`
  ).all(versionId) as ApprovalRow[];
  return rows.map(approvalFromRow);
}

/**
 * 전원 승인 판정 및 확정 전환.
 * shares JSON에 포함된 주소 전원이 "승인" 레코드를 가질 때만 확정합니다.
 */
export async function checkAndConfirmExpense(
  expenseId: string,
  versionId: string,
  sharesJson: string,
): Promise<boolean> {
  let shareAddresses: string[];
  try {
    const parsed = JSON.parse(sharesJson) as { address: string }[];
    shareAddresses = parsed.map((s) => s.address.toLowerCase());
  } catch {
    return false;
  }

  if (shareAddresses.length === 0) return false;

  const db = getDb();
  const approvals = db.prepare(
    `SELECT address, action FROM ExpenseApproval WHERE versionId = ?`
  ).all(versionId) as { address: string; action: string }[];

  const approvedSet = new Set(
    approvals.filter((a) => a.action === "승인").map((a) => a.address.toLowerCase()),
  );

  const allApproved = shareAddresses.every((addr) => approvedSet.has(addr));
  if (!allApproved) return false;

  // 두 테이블을 트랜잭션으로 확정
  db.transaction(() => {
    db.prepare(`UPDATE ExpenseVersion SET status = '확정' WHERE id = ?`).run(versionId);
    db.prepare(`UPDATE ExpenseRecord SET status = '확정' WHERE id = ?`).run(expenseId);
  })();

  return true;
}

// ─── 알림 ─────────────────────────────────────────────────────────────────────

export async function findNotifications(tripId: string, address: string) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM NotificationRecord WHERE tripId = ? AND address = ?
     ORDER BY createdAt DESC LIMIT 50`
  ).all(tripId, address.toLowerCase()) as NotificationRow[];
  return rows.map(notificationFromRow);
}

export async function findNotification(notifId: string, address: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM NotificationRecord WHERE id = ? AND address = ? LIMIT 1`
  ).get(notifId, address.toLowerCase()) as NotificationRow | null;
  return row ? notificationFromRow(row) : null;
}

export async function markNotificationRead(notifId: string) {
  const db = getDb();
  db.prepare(`UPDATE NotificationRecord SET read = 1 WHERE id = ?`).run(notifId);
}
