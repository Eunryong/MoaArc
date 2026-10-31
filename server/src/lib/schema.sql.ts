/**
 * MoaArc SQLite 스키마 DDL
 *
 * bun:sqlite Database를 받아 테이블/인덱스/외래키/트리거를 한 번에 초기화합니다.
 * idempotent: CREATE TABLE IF NOT EXISTS — 이미 존재하면 그대로 유지합니다.
 *
 * 설계 원칙:
 *  - BigInt (onchainTripId, totalUsdc 등): INTEGER (SQLite 64bit signed)
 *  - DateTime: TEXT (ISO-8601, "YYYY-MM-DDTHH:mm:ss.sssZ")
 *  - Boolean: INTEGER (0/1)
 *  - 외래키 무결성: FOREIGN KEY ... ON DELETE CASCADE
 *  - 외래키 활성화: PRAGMA foreign_keys = ON (호출자 책임 — initSchema에서 설정)
 */

import type { Database } from "bun:sqlite";

export function initSchema(db: Database): void {
  // bun:sqlite는 기본적으로 외래키를 비활성화합니다.
  // journal_mode=WAL은 :memory: DB에는 적용되지 않습니다 (SQLite 무시).
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    -- ─── TripRecord ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS TripRecord (
      id              TEXT    NOT NULL PRIMARY KEY,
      chainId         INTEGER NOT NULL,
      contractAddress TEXT    NOT NULL,
      onchainTripId   INTEGER NOT NULL,
      name            TEXT    NOT NULL,
      adminAddress    TEXT    NOT NULL,
      createTxHash    TEXT    NOT NULL,
      createdAt       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updatedAt       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(chainId, contractAddress, onchainTripId)
    );
    CREATE INDEX IF NOT EXISTS idx_trip_admin ON TripRecord(adminAddress);

    CREATE TRIGGER IF NOT EXISTS trg_trip_updatedAt
      AFTER UPDATE ON TripRecord
      FOR EACH ROW
      BEGIN
        UPDATE TripRecord SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
      END;

    -- ─── ParticipantRecord ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ParticipantRecord (
      id          TEXT    NOT NULL PRIMARY KEY,
      tripId      TEXT    NOT NULL,
      address     TEXT    NOT NULL,
      displayName TEXT    NOT NULL,
      isAdmin     INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(tripId) REFERENCES TripRecord(id) ON DELETE CASCADE,
      UNIQUE(tripId, address)
    );
    CREATE INDEX IF NOT EXISTS idx_participant_address ON ParticipantRecord(address);

    -- ─── AuthNonce ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS AuthNonce (
      id        TEXT    NOT NULL PRIMARY KEY,
      address   TEXT    NOT NULL,
      nonce     TEXT    NOT NULL UNIQUE,
      expiresAt TEXT    NOT NULL,
      used      INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nonce_address ON AuthNonce(address);

    -- ─── ItineraryRecord ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ItineraryRecord (
      id           TEXT    NOT NULL PRIMARY KEY,
      tripId       TEXT    NOT NULL,
      date         TEXT    NOT NULL,
      time         TEXT,
      location     TEXT    NOT NULL,
      activity     TEXT    NOT NULL,
      participants TEXT    NOT NULL DEFAULT '[]',
      status       TEXT    NOT NULL DEFAULT 'draft',
      notes        TEXT,
      estMinUsdc   INTEGER,
      estMaxUsdc   INTEGER,
      estCurrency  TEXT,
      estSource    TEXT,
      estAt        TEXT,
      confidence   TEXT,
      createdBy    TEXT    NOT NULL,
      createdAt    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updatedAt    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(tripId) REFERENCES TripRecord(id) ON DELETE CASCADE
    );

    CREATE TRIGGER IF NOT EXISTS trg_itinerary_updatedAt
      AFTER UPDATE ON ItineraryRecord
      FOR EACH ROW
      BEGIN
        UPDATE ItineraryRecord SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
      END;

    -- ─── ExpenseRecord ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ExpenseRecord (
      id             TEXT    NOT NULL PRIMARY KEY,
      tripId         TEXT    NOT NULL,
      payerAddress   TEXT    NOT NULL,
      title          TEXT    NOT NULL,
      category       TEXT    NOT NULL,
      date           TEXT    NOT NULL,
      localCurrency  TEXT,
      localAmount    REAL,
      totalUsdc      INTEGER NOT NULL,
      paymentFlow    TEXT    NOT NULL,
      currentVersion INTEGER NOT NULL DEFAULT 1,
      status         TEXT    NOT NULL DEFAULT '승인대기',
      receiptNote    TEXT,
      createdBy      TEXT    NOT NULL,
      createdAt      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updatedAt      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(tripId) REFERENCES TripRecord(id) ON DELETE CASCADE
    );

    CREATE TRIGGER IF NOT EXISTS trg_expense_updatedAt
      AFTER UPDATE ON ExpenseRecord
      FOR EACH ROW
      BEGIN
        UPDATE ExpenseRecord SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
      END;

    -- ─── ExpenseVersion ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ExpenseVersion (
      id          TEXT    NOT NULL PRIMARY KEY,
      expenseId   TEXT    NOT NULL,
      version     INTEGER NOT NULL,
      shares      TEXT    NOT NULL,
      proposedBy  TEXT    NOT NULL,
      proposedAt  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      reason      TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT '승인대기',
      FOREIGN KEY(expenseId) REFERENCES ExpenseRecord(id) ON DELETE CASCADE,
      UNIQUE(expenseId, version)
    );

    -- ─── ExpenseApproval ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ExpenseApproval (
      id         TEXT    NOT NULL PRIMARY KEY,
      versionId  TEXT    NOT NULL,
      address    TEXT    NOT NULL,
      action     TEXT    NOT NULL,
      reason     TEXT,
      approvedAt TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(versionId) REFERENCES ExpenseVersion(id) ON DELETE CASCADE,
      UNIQUE(versionId, address)
    );

    -- ─── TripCreationIntent ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS TripCreationIntent (
      id                   TEXT    NOT NULL PRIMARY KEY,
      creatorAddress       TEXT    NOT NULL,
      chainId              INTEGER NOT NULL,
      contractAddress      TEXT    NOT NULL,
      tripName             TEXT    NOT NULL,
      participantAddresses TEXT    NOT NULL,
      targetBudget         TEXT    NOT NULL,
      calldata             TEXT    NOT NULL,
      status               TEXT    NOT NULL DEFAULT 'pending_tx',
      txHash               TEXT    UNIQUE,
      onchainTripId        TEXT,
      errorMessage         TEXT,
      createdAt            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updatedAt            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_intent_creator ON TripCreationIntent(creatorAddress);
    CREATE INDEX IF NOT EXISTS idx_intent_txhash  ON TripCreationIntent(txHash);
    CREATE INDEX IF NOT EXISTS idx_intent_status  ON TripCreationIntent(status);

    CREATE TRIGGER IF NOT EXISTS trg_intent_updatedAt
      AFTER UPDATE ON TripCreationIntent
      FOR EACH ROW
      BEGIN
        UPDATE TripCreationIntent SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
      END;

    -- ─── AgentConversation ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS AgentConversation (
      id        TEXT    NOT NULL PRIMARY KEY,
      tripId    TEXT    NOT NULL,
      address   TEXT    NOT NULL,
      role      TEXT    NOT NULL,
      content   TEXT    NOT NULL,
      hasError  INTEGER NOT NULL DEFAULT 0,
      proposal  TEXT,
      createdAt TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- ─── NotificationRecord ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS NotificationRecord (
      id        TEXT    NOT NULL PRIMARY KEY,
      tripId    TEXT    NOT NULL,
      address   TEXT    NOT NULL,
      type      TEXT    NOT NULL,
      title     TEXT    NOT NULL,
      body      TEXT    NOT NULL,
      read      INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(tripId) REFERENCES TripRecord(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_notif_address_read ON NotificationRecord(address, read);
  `);
}
