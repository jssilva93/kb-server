import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export interface SearchResult {
  id: number;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
  updated_at: string;
}

export interface Document {
  id: number;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface DocumentMeta {
  id: number;
  title: string;
  tags: string[];
  updated_at: string;
}

export class KnowledgeBase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "kb.sqlite");
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(
        title,
        content,
        tags,
        content_rowid='rowid'
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  search(query: string, limit: number = 5): SearchResult[] {
    // Wrap each token in double quotes so FTS5 treats hyphens and
    // special characters as literals instead of operators
    const safeQuery = query
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, "")}"`)
      .join(" ");

    const stmt = this.db.prepare(`
      SELECT
        m.id,
        m.title,
        snippet(documents, 1, '<mark>', '</mark>', '...', 20) AS snippet,
        rank AS score,
        m.tags,
        m.updated_at
      FROM documents
      JOIN meta m ON m.id = documents.rowid
      WHERE documents MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    const rows = stmt.all(safeQuery, limit) as Array<{
      id: number;
      title: string;
      snippet: string;
      score: number;
      tags: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      ...row,
      tags: row.tags ? row.tags.split(",").map((t) => t.trim()) : [],
    }));
  }

  ingest(title: string, content: string, tags: string[] = []): number {
    const tagsStr = tags.join(", ");
    const isEvergreen = tags.includes("evergreen");

    if (isEvergreen) {
      const existing = this.db
        .prepare("SELECT id FROM meta WHERE title = ?")
        .get(title) as { id: number } | undefined;

      if (existing) {
        const updateMeta = this.db.prepare(`
          UPDATE meta SET tags = ?, updated_at = datetime('now') WHERE id = ?
        `);
        const deleteFts = this.db.prepare(
          "DELETE FROM documents WHERE rowid = ?"
        );
        const insertFts = this.db.prepare(
          "INSERT INTO documents(rowid, title, content, tags) VALUES (?, ?, ?, ?)"
        );

        const txn = this.db.transaction(() => {
          updateMeta.run(tagsStr, existing.id);
          deleteFts.run(existing.id);
          insertFts.run(existing.id, title, content, tagsStr);
        });
        txn();

        return existing.id;
      }
    }

    const insertMeta = this.db.prepare(
      "INSERT INTO meta (title, tags) VALUES (?, ?)"
    );
    const insertFts = this.db.prepare(
      "INSERT INTO documents(rowid, title, content, tags) VALUES (?, ?, ?, ?)"
    );

    let newId: number = 0;
    const txn = this.db.transaction(() => {
      const result = insertMeta.run(title, tagsStr);
      newId = Number(result.lastInsertRowid);
      insertFts.run(newId, title, content, tagsStr);
    });
    txn();

    return newId;
  }

  read(id: number): Document | null {
    const row = this.db
      .prepare(
        `
      SELECT m.id, m.title, d.content, m.tags, m.created_at, m.updated_at
      FROM meta m
      JOIN documents d ON d.rowid = m.id
      WHERE m.id = ?
    `
      )
      .get(id) as
      | {
          id: number;
          title: string;
          content: string;
          tags: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      ...row,
      tags: row.tags ? row.tags.split(",").map((t) => t.trim()) : [],
    };
  }

  list(prefix?: string): DocumentMeta[] {
    let rows: Array<{
      id: number;
      title: string;
      tags: string;
      updated_at: string;
    }>;

    if (prefix !== undefined) {
      rows = this.db
        .prepare(
          `
        SELECT id, title, tags, updated_at FROM meta
        WHERE title LIKE ? || '%'
        ORDER BY updated_at DESC
      `
        )
        .all(prefix) as typeof rows;
    } else {
      rows = this.db
        .prepare(
          "SELECT id, title, tags, updated_at FROM meta ORDER BY updated_at DESC"
        )
        .all() as typeof rows;
    }

    return rows.map((row) => ({
      ...row,
      tags: row.tags ? row.tags.split(",").map((t) => t.trim()) : [],
    }));
  }

  delete(id: number): boolean {
    const existing = this.db
      .prepare("SELECT id FROM meta WHERE id = ?")
      .get(id) as { id: number } | undefined;

    if (!existing) return false;

    const txn = this.db.transaction(() => {
      this.db.prepare("DELETE FROM documents WHERE rowid = ?").run(id);
      this.db.prepare("DELETE FROM meta WHERE id = ?").run(id);
    });
    txn();

    return true;
  }

  // --- OAuth methods ---

  saveAuthCode(code: string, clientId: string, redirectUri: string, ttlMs: number): void {
    this.db.prepare(
      "INSERT INTO oauth_codes (code, client_id, redirect_uri, expires_at) VALUES (?, ?, ?, ?)"
    ).run(code, clientId, redirectUri, Date.now() + ttlMs);
  }

  consumeAuthCode(code: string): { clientId: string; redirectUri: string } | null {
    const row = this.db.prepare(
      "SELECT client_id, redirect_uri, expires_at FROM oauth_codes WHERE code = ?"
    ).get(code) as { client_id: string; redirect_uri: string; expires_at: number } | undefined;

    if (!row) return null;

    // Always delete (one-time use)
    this.db.prepare("DELETE FROM oauth_codes WHERE code = ?").run(code);

    if (row.expires_at < Date.now()) return null;

    return { clientId: row.client_id, redirectUri: row.redirect_uri };
  }

  saveAccessToken(token: string, clientId: string, ttlMs: number): void {
    this.db.prepare(
      "INSERT INTO oauth_tokens (token, client_id, expires_at) VALUES (?, ?, ?)"
    ).run(token, clientId, Date.now() + ttlMs);
  }

  validateAccessToken(token: string): boolean {
    const row = this.db.prepare(
      "SELECT expires_at FROM oauth_tokens WHERE token = ?"
    ).get(token) as { expires_at: number } | undefined;

    if (!row) return false;

    if (row.expires_at < Date.now()) {
      this.db.prepare("DELETE FROM oauth_tokens WHERE token = ?").run(token);
      return false;
    }

    return true;
  }

  cleanupExpiredOAuth(): void {
    const now = Date.now();
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now);
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM meta")
      .get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}
