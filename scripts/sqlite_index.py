import json
import sqlite3
import sys
from pathlib import Path


def load_payload():
    if sys.stdin.isatty():
        return {}

    raw = sys.stdin.read().strip()
    if not raw:
        return {}

    return sanitize_value(json.loads(raw))


def sanitize_text(value):
    return value.encode("utf-8", "replace").decode("utf-8")


def sanitize_value(value):
    if isinstance(value, str):
        return sanitize_text(value)

    if isinstance(value, list):
        return [sanitize_value(item) for item in value]

    if isinstance(value, dict):
        return {key: sanitize_value(item) for key, item in value.items()}

    return value


def connect(db_path):
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    init_schema(conn)
    return conn


def init_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS documents (
          doc_id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          canonical_url TEXT,
          redirected_url TEXT,
          domain TEXT,
          title TEXT,
          source_type TEXT,
          authority TEXT,
          quality_status TEXT,
          retrieval_allowed INTEGER NOT NULL,
          airline_name TEXT,
          airline_slug TEXT,
          fetched_at TEXT,
          content_hash TEXT,
          metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS sections (
          section_id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          canonical_url TEXT,
          redirected_url TEXT,
          domain TEXT,
          title TEXT,
          source_type TEXT,
          authority TEXT,
          quality_status TEXT,
          retrieval_allowed INTEGER NOT NULL,
          airline_name TEXT,
          airline_slug TEXT,
          fetched_at TEXT,
          content_hash TEXT,
          section_index INTEGER,
          part_index INTEGER,
          section_title TEXT,
          section_path_json TEXT,
          section_slug TEXT,
          anchor_text TEXT,
          text TEXT,
          text_hash TEXT,
          status_code INTEGER
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
          section_id UNINDEXED,
          title,
          section_title,
          section_path_text,
          anchor_text,
          text,
          airline_name,
          tokenize = 'porter unicode61'
        );

        CREATE TABLE IF NOT EXISTS airline_registry (
          registry_id TEXT PRIMARY KEY,
          doc_id TEXT,
          airline_name TEXT NOT NULL,
          airline_slug TEXT NOT NULL,
          source_url TEXT NOT NULL,
          canonical_url TEXT,
          row_text TEXT,
          policy_urls_json TEXT NOT NULL,
          crawl_status TEXT
        );

        CREATE TABLE IF NOT EXISTS baggage_facts (
          fact_id TEXT PRIMARY KEY,
          section_id TEXT NOT NULL REFERENCES sections(section_id) ON DELETE CASCADE,
          doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          canonical_url TEXT,
          title TEXT,
          source_type TEXT,
          airline_name TEXT,
          facet TEXT,
          value_text TEXT,
          conditions TEXT,
          units TEXT,
          effective_date TEXT,
          retrieval_allowed INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sections_doc_id ON sections(doc_id);
        CREATE INDEX IF NOT EXISTS idx_sections_source_type ON sections(source_type);
        CREATE INDEX IF NOT EXISTS idx_sections_airline ON sections(airline_name);
        CREATE INDEX IF NOT EXISTS idx_registry_airline ON airline_registry(airline_slug);
        CREATE INDEX IF NOT EXISTS idx_facts_airline_facet ON baggage_facts(airline_name, facet);
        """
    )


def delete_document(conn, doc_id):
    section_ids = [
        row["section_id"]
        for row in conn.execute(
            "SELECT section_id FROM sections WHERE doc_id = ?",
            (doc_id,),
        ).fetchall()
    ]

    for section_id in section_ids:
        conn.execute("DELETE FROM sections_fts WHERE section_id = ?", (section_id,))

    conn.execute("DELETE FROM baggage_facts WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM airline_registry WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM sections WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))


def json_or_none(value):
    if value is None:
        return None

    return json.dumps(value)


def upsert_document(conn, payload):
    document = payload["document"]
    sections = payload.get("sections", [])
    airline_registry = payload.get("airlineRegistry", [])
    facts = payload.get("facts", [])

    delete_document(conn, document["docId"])

    conn.execute(
        """
        INSERT INTO documents (
          doc_id, url, canonical_url, redirected_url, domain, title, source_type,
          authority, quality_status, retrieval_allowed, airline_name, airline_slug,
          fetched_at, content_hash, metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            document["docId"],
            document["url"],
            document.get("canonicalUrl"),
            document.get("redirectedUrl"),
            document.get("domain"),
            document.get("title"),
            document.get("sourceType"),
            document.get("authority"),
            document.get("qualityStatus"),
            1 if document.get("retrievalAllowed") else 0,
            document.get("airlineName"),
            document.get("airlineSlug"),
            document.get("fetchedAt"),
            document.get("contentHash"),
            json_or_none(document.get("metadata")),
        ),
    )

    for section in sections:
        conn.execute(
            """
            INSERT INTO sections (
              section_id, doc_id, url, canonical_url, redirected_url, domain, title,
              source_type, authority, quality_status, retrieval_allowed, airline_name,
              airline_slug, fetched_at, content_hash, section_index, part_index,
              section_title, section_path_json, section_slug, anchor_text, text,
              text_hash, status_code
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                section["sectionId"],
                section["docId"],
                section["url"],
                section.get("canonicalUrl"),
                section.get("redirectedUrl"),
                section.get("domain"),
                section.get("title"),
                section.get("sourceType"),
                section.get("authority"),
                section.get("qualityStatus"),
                1 if section.get("retrievalAllowed") else 0,
                section.get("airlineName"),
                section.get("airlineSlug"),
                section.get("fetchedAt"),
                section.get("contentHash"),
                section.get("sectionIndex"),
                section.get("partIndex"),
                section.get("sectionTitle"),
                json_or_none(section.get("sectionPath")),
                section.get("sectionSlug"),
                section.get("anchorText"),
                section.get("text"),
                section.get("textHash"),
                section.get("statusCode"),
            ),
        )
        conn.execute(
            """
            INSERT INTO sections_fts (
              section_id, title, section_title, section_path_text, anchor_text, text, airline_name
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                section["sectionId"],
                section.get("title") or "",
                section.get("sectionTitle") or "",
                " > ".join(section.get("sectionPath", [])),
                section.get("anchorText") or "",
                section.get("text") or "",
                section.get("airlineName") or "",
            ),
        )

    for entry in airline_registry:
        conn.execute(
            """
            INSERT INTO airline_registry (
              registry_id, doc_id, airline_name, airline_slug, source_url,
              canonical_url, row_text, policy_urls_json, crawl_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry["registryId"],
                entry.get("docId"),
                entry["airlineName"],
                entry["airlineSlug"],
                entry["sourceUrl"],
                entry.get("canonicalUrl"),
                entry.get("rowText"),
                json.dumps(entry.get("policyUrls", [])),
                entry.get("crawlStatus"),
            ),
        )

    for fact in facts:
        conn.execute(
            """
            INSERT INTO baggage_facts (
              fact_id, section_id, doc_id, url, canonical_url, title, source_type,
              airline_name, facet, value_text, conditions, units, effective_date,
              retrieval_allowed
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fact["factId"],
                fact["sectionId"],
                fact["docId"],
                fact["url"],
                fact.get("canonicalUrl"),
                fact.get("title"),
                fact.get("sourceType"),
                fact.get("airlineName"),
                fact.get("facet"),
                fact.get("valueText"),
                fact.get("conditions"),
                fact.get("units"),
                fact.get("effectiveDate"),
                1 if fact.get("retrievalAllowed") else 0,
            ),
        )

    conn.commit()
    return {
        "docId": document["docId"],
        "sectionCount": len(sections),
        "airlineRegistryCount": len(airline_registry),
        "factCount": len(facts),
    }


def build_section_filters(payload):
    clauses = ["s.retrieval_allowed = 1"]
    values = []
    filters = payload.get("filters") or {}

    if filters.get("url"):
      clauses.append("s.url = ?")
      values.append(filters["url"])

    if filters.get("domain"):
      clauses.append("s.domain = ?")
      values.append(filters["domain"])

    if filters.get("sourceType"):
      clauses.append("s.source_type = ?")
      values.append(filters["sourceType"])

    if filters.get("airline"):
      clauses.append("LOWER(s.airline_name) = LOWER(?)")
      values.append(filters["airline"])

    airline_names = payload.get("airlineNames") or []
    if airline_names:
      placeholders = ", ".join(["?"] * len(airline_names))
      clauses.append(f"LOWER(s.airline_name) IN ({placeholders})")
      values.extend(airline_names)

    return clauses, values


def query_sections(conn, payload):
    fts_query = payload.get("ftsQuery")
    if not fts_query:
        return {"results": []}

    top_k = int(payload.get("topK") or 6)
    clauses, values = build_section_filters(payload)
    sql = f"""
      SELECT
        s.*,
        bm25(sections_fts, 4.0, 3.0, 2.5, 1.8, 1.0, 1.5) AS bm25_score
      FROM sections_fts
      JOIN sections s ON s.section_id = sections_fts.section_id
      WHERE sections_fts MATCH ?
        AND {' AND '.join(clauses)}
      ORDER BY bm25_score ASC, s.section_index ASC, s.part_index ASC
      LIMIT ?
    """

    rows = conn.execute(sql, [fts_query, *values, top_k]).fetchall()
    results = []

    for row in rows:
        results.append(
            {
                "id": row["section_id"],
                "sectionId": row["section_id"],
                "docId": row["doc_id"],
                "url": row["url"],
                "canonicalUrl": row["canonical_url"],
                "redirectedUrl": row["redirected_url"],
                "domain": row["domain"],
                "title": row["title"],
                "sourceType": row["source_type"],
                "authority": row["authority"],
                "qualityStatus": row["quality_status"],
                "retrievalAllowed": bool(row["retrieval_allowed"]),
                "airlineName": row["airline_name"],
                "airlineSlug": row["airline_slug"],
                "fetchedAt": row["fetched_at"],
                "contentHash": row["content_hash"],
                "chunkIndex": row["section_index"],
                "sectionIndex": row["section_index"],
                "partIndex": row["part_index"],
                "sectionTitle": row["section_title"],
                "sectionPath": json.loads(row["section_path_json"] or "[]"),
                "sectionSlug": row["section_slug"],
                "anchorText": row["anchor_text"],
                "text": row["text"],
                "textHash": row["text_hash"],
                "score": 1 / (1 + max(row["bm25_score"], 0)),
                "retrievalStrategy": "lexical",
            }
        )

    return {"results": results}


def query_facts(conn, payload):
    facet = payload.get("facet")
    airline_names = payload.get("airlineNames") or []
    if not facet or not airline_names:
        return {"results": []}

    top_k = int(payload.get("topK") or 6)
    placeholders = ", ".join(["?"] * len(airline_names))
    sql = f"""
      WITH ranked AS (
        SELECT
          f.*,
          s.section_index,
          s.part_index,
          s.section_title,
          s.section_path_json,
          s.section_slug,
          s.anchor_text,
          s.text,
          s.domain,
          s.authority,
          s.quality_status,
          ROW_NUMBER() OVER (
            PARTITION BY LOWER(f.airline_name), f.facet
            ORDER BY s.section_index ASC, s.part_index ASC
          ) AS row_number
        FROM baggage_facts f
        JOIN sections s ON s.section_id = f.section_id
        WHERE f.retrieval_allowed = 1
          AND f.facet = ?
          AND LOWER(f.airline_name) IN ({placeholders})
      )
      SELECT * FROM ranked
      WHERE row_number = 1
      LIMIT ?
    """
    rows = conn.execute(sql, [facet, *airline_names, top_k]).fetchall()
    results = []

    for row in rows:
        results.append(
            {
                "id": row["fact_id"],
                "sectionId": row["section_id"],
                "docId": row["doc_id"],
                "url": row["url"],
                "canonicalUrl": row["canonical_url"],
                "domain": row["domain"],
                "title": row["title"],
                "sourceType": row["source_type"],
                "authority": row["authority"],
                "qualityStatus": row["quality_status"],
                "retrievalAllowed": True,
                "airlineName": row["airline_name"],
                "chunkIndex": row["section_index"],
                "sectionIndex": row["section_index"],
                "partIndex": row["part_index"],
                "sectionTitle": row["section_title"],
                "sectionPath": json.loads(row["section_path_json"] or "[]"),
                "sectionSlug": row["section_slug"],
                "anchorText": row["anchor_text"],
                "text": row["text"],
                "score": 1.0,
                "retrievalStrategy": "fact",
                "matchedFact": {
                    "factId": row["fact_id"],
                    "facet": row["facet"],
                    "valueText": row["value_text"],
                    "conditions": row["conditions"],
                    "units": row["units"],
                    "effectiveDate": row["effective_date"],
                },
            }
        )

    return {"results": results}


def list_documents(conn, payload):
    filters = payload.get("filters") or {}
    clauses = ["1 = 1"]
    values = []

    if filters.get("url"):
        clauses.append("url = ?")
        values.append(filters["url"])

    if filters.get("domain"):
        clauses.append("domain = ?")
        values.append(filters["domain"])

    if filters.get("sourceType"):
        clauses.append("source_type = ?")
        values.append(filters["sourceType"])

    if filters.get("airline"):
        clauses.append("LOWER(airline_name) = LOWER(?)")
        values.append(filters["airline"])

    airline_names = payload.get("airlineNames") or []
    if airline_names:
        placeholders = ", ".join(["?"] * len(airline_names))
        clauses.append(f"LOWER(airline_name) IN ({placeholders})")
        values.extend(airline_names)

    rows = conn.execute(
        f"""
        SELECT *
        FROM documents
        WHERE {' AND '.join(clauses)}
        ORDER BY title COLLATE NOCASE ASC
        """,
        values,
    ).fetchall()

    return {
        "results": [
            {
                "docId": row["doc_id"],
                "url": row["url"],
                "canonicalUrl": row["canonical_url"],
                "redirectedUrl": row["redirected_url"],
                "domain": row["domain"],
                "title": row["title"],
                "sourceType": row["source_type"],
                "authority": row["authority"],
                "qualityStatus": row["quality_status"],
                "retrievalAllowed": bool(row["retrieval_allowed"]),
                "airlineName": row["airline_name"],
                "airlineSlug": row["airline_slug"],
                "fetchedAt": row["fetched_at"],
                "contentHash": row["content_hash"],
                "metadata": json.loads(row["metadata_json"] or "null"),
            }
            for row in rows
        ]
    }


def get_sections_for_documents(conn, payload):
    doc_ids = payload.get("docIds") or []
    if not doc_ids:
        return {"results": []}

    placeholders = ", ".join(["?"] * len(doc_ids))
    rows = conn.execute(
        f"""
        SELECT *
        FROM sections
        WHERE doc_id IN ({placeholders})
        ORDER BY doc_id ASC, section_index ASC, part_index ASC
        """,
        doc_ids,
    ).fetchall()

    return {
        "results": [
            {
                "id": row["section_id"],
                "sectionId": row["section_id"],
                "docId": row["doc_id"],
                "url": row["url"],
                "canonicalUrl": row["canonical_url"],
                "redirectedUrl": row["redirected_url"],
                "domain": row["domain"],
                "title": row["title"],
                "sourceType": row["source_type"],
                "authority": row["authority"],
                "qualityStatus": row["quality_status"],
                "retrievalAllowed": bool(row["retrieval_allowed"]),
                "airlineName": row["airline_name"],
                "airlineSlug": row["airline_slug"],
                "fetchedAt": row["fetched_at"],
                "contentHash": row["content_hash"],
                "chunkIndex": row["section_index"],
                "sectionIndex": row["section_index"],
                "partIndex": row["part_index"],
                "sectionTitle": row["section_title"],
                "sectionPath": json.loads(row["section_path_json"] or "[]"),
                "sectionSlug": row["section_slug"],
                "anchorText": row["anchor_text"],
                "text": row["text"],
                "textHash": row["text_hash"],
                "statusCode": row["status_code"],
            }
            for row in rows
        ]
    }


def list_airlines(conn, _payload):
    rows = conn.execute(
        """
        SELECT airline_name, airline_slug FROM airline_registry
        UNION
        SELECT airline_name, airline_slug FROM documents
        WHERE airline_name IS NOT NULL AND airline_slug IS NOT NULL
        ORDER BY airline_name COLLATE NOCASE
        """
    ).fetchall()

    return {
        "results": [
            {
                "airlineName": row["airline_name"],
                "airlineSlug": row["airline_slug"],
            }
            for row in rows
            if row["airline_name"]
        ]
    }


def main():
    if len(sys.argv) < 3:
        raise SystemExit("Usage: sqlite_index.py <action> <db_path>")

    action = sys.argv[1]
    db_path = sys.argv[2]
    payload = load_payload()
    conn = connect(db_path)

    if action == "upsert_document":
        result = upsert_document(conn, payload)
    elif action == "delete_document":
        delete_document(conn, payload["docId"])
        conn.commit()
        result = {"docId": payload["docId"], "deleted": True}
    elif action == "query_sections":
        result = query_sections(conn, payload)
    elif action == "query_facts":
        result = query_facts(conn, payload)
    elif action == "list_documents":
        result = list_documents(conn, payload)
    elif action == "get_sections_for_documents":
        result = get_sections_for_documents(conn, payload)
    elif action == "list_airlines":
        result = list_airlines(conn, payload)
    else:
        raise SystemExit(f"Unsupported action: {action}")

    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # pragma: no cover - surfaced to node wrapper
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        raise
