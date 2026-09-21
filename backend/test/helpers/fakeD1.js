/**
 * A minimal D1-shaped adapter over Node's built-in node:sqlite (same
 * underlying engine D1 runs on). This exists so tests can import and run
 * the *actual* src/db.js functions against a real, in-memory SQLite
 * database, instead of re-implementing the SQL logic separately in tests
 * -- a passing test here means the real queries work, not a copy of them.
 *
 * Only implements the handful of D1 Statement methods db.js actually
 * uses: .bind(), .run(), .first(), .all(). Not a general-purpose D1 mock.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "..", "..", "schema.sql");

class FakeD1BoundStatement {
  constructor(sqliteStmt, params) {
    this.sqliteStmt = sqliteStmt;
    this.params = params;
  }
  async run() {
    const info = this.sqliteStmt.run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
  async first() {
    const row = this.sqliteStmt.get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: this.sqliteStmt.all(...this.params) };
  }
}

class FakeD1Statement {
  constructor(sqliteStmt) {
    this.sqliteStmt = sqliteStmt;
  }
  bind(...args) {
    return new FakeD1BoundStatement(this.sqliteStmt, args);
  }
  // Real D1 statements also support calling .run()/.first()/.all()
  // directly, without .bind() first, for parameterless queries -- e.g.
  // listActiveFolders(). Delegate to a zero-arg bound statement so both
  // call styles work here too.
  run() {
    return new FakeD1BoundStatement(this.sqliteStmt, []).run();
  }
  first() {
    return new FakeD1BoundStatement(this.sqliteStmt, []).first();
  }
  all() {
    return new FakeD1BoundStatement(this.sqliteStmt, []).all();
  }
}

class FakeD1Database {
  constructor(sqliteDb) {
    this.sqliteDb = sqliteDb;
  }
  prepare(sql) {
    return new FakeD1Statement(this.sqliteDb.prepare(sql));
  }
}

/** Creates a fresh in-memory database with the real schema.sql applied,
 * wrapped to look like a D1 binding (`env.DB`). */
export function createFakeD1() {
  const sqliteDb = new DatabaseSync(":memory:");
  sqliteDb.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return new FakeD1Database(sqliteDb);
}

/** A minimal Hono-context-shaped object with just what db.js's getDb()
 * reads (`c.env.DB`) — enough to call db.js functions directly in tests
 * without spinning up a real Hono app. */
export function fakeContext(db) {
  return { env: { DB: db } };
}
