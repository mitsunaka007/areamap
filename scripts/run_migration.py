"""1 つの .sql ファイルを DATABASE_URL に対して 1 トランザクションで適用する。

使い方:  python scripts/run_migration.py migrations/001_mapproject_georef.sql
"""
import os
import sys
import pathlib

import psycopg2
from dotenv import load_dotenv

load_dotenv()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python scripts/run_migration.py <path-to.sql>", file=sys.stderr)
        return 2
    sql_path = pathlib.Path(sys.argv[1])
    if not sql_path.is_file():
        print(f"not found: {sql_path}", file=sys.stderr)
        return 2

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2
    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql://", 1)

    sql = sql_path.read_text(encoding="utf-8")
    conn = psycopg2.connect(db_url)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(sql)
        print(f"applied: {sql_path.name}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
