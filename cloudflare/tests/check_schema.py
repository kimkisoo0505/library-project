"""DB 스키마 검증 (CI 및 로컬 공용, 표준 라이브러리만 사용)

1. migrations/*.sql 을 번호 순으로 적용한 결과와 schema.sql 을 새로 적용한 결과가 같은 구조인지 비교
2. 기존 예약이 있는 상태에서 마이그레이션이 외래 키 오류 없이 적용되는지 확인 (운영 DB 재현)
3. 열람실 3개 x 30석, 라벨, 부분 UNIQUE 인덱스(중복 예약 방지) 동작 확인

실행: python tests/check_schema.py   (cloudflare 디렉터리)
"""
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "database"
MIGRATIONS = sorted((ROOT / "migrations").glob("*.sql"))


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.execute("PRAGMA foreign_keys = ON")  # D1 은 외래 키를 항상 강제한다
    return db


def apply(db: sqlite3.Connection, path: Path) -> None:
    # executescript 는 자체적으로 COMMIT 하므로 문장 단위로 실행해 하나의 트랜잭션으로 묶는다
    db.execute("BEGIN")
    sql = path.read_text(encoding="utf-8")
    for stmt in split_statements(sql):
        db.execute(stmt)
    db.execute("COMMIT")


def split_statements(sql: str) -> list[str]:
    lines = [line for line in sql.splitlines() if not line.strip().startswith("--")]
    statements, buf = [], []
    for line in lines:
        buf.append(line)
        if sqlite3.complete_statement("\n".join(buf)):
            stmt = "\n".join(buf).strip()
            if stmt and stmt != ";":
                statements.append(stmt)
            buf = []
    return statements


def structure(db: sqlite3.Connection) -> dict:
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    result = {}
    for t in tables:
        cols = tuple((c[1], c[2].upper(), c[3], c[5]) for c in db.execute(f"PRAGMA table_info({t})"))
        fks = tuple(sorted((f[2], f[3], f[4]) for f in db.execute(f"PRAGMA foreign_key_list({t})")))
        idx = tuple(sorted((i[1], i[2], i[4]) for i in db.execute(f"PRAGMA index_list({t})") if not i[1].startswith("sqlite_autoindex")))
        result[t] = (cols, fks, idx)
    return result


failures = 0


def check(label: str, cond: bool, detail: object = "") -> None:
    global failures
    print(f"[{'PASS' if cond else 'FAIL'}] {label}" + (f" -> {detail}" if not cond else ""))
    failures += 0 if cond else 1


# 1) 마이그레이션 순차 적용 (중간에 운영과 같은 예약 이력 삽입)
migrated = connect()
for path in MIGRATIONS:
    apply(migrated, path)
    if path.name.startswith("0001"):
        migrated.execute("INSERT INTO students (student_no, display_name, password_hash) VALUES ('TEST-0001', 't', 'x')")
        migrated.execute("UPDATE seats SET status = 'maintenance' WHERE id = 7")
        migrated.execute("""INSERT INTO reservations (seat_id, student_id, status, reserved_at, expires_at)
                            VALUES (1, 1, 'completed', 'a', 'b'), (5, 1, 'reserved', 'a', 'b')""")
check(f"마이그레이션 {len(MIGRATIONS)}개 순차 적용 (기존 예약 존재)", True)
check("외래 키 위반 없음", migrated.execute("PRAGMA foreign_key_check").fetchall() == [])
check("기존 예약 이력 보존", migrated.execute("SELECT count(*) FROM reservations").fetchone()[0] == 2)
check("기존 좌석 관리 상태 보존 (A07 점검)",
      migrated.execute("SELECT status FROM seats WHERE label = 'A07'").fetchone()[0] == "maintenance")

# 2) schema.sql 신규 적용 (2회 적용해도 안전해야 함)
fresh = connect()
schema_path = ROOT / "schema.sql"
apply(fresh, schema_path)
apply(fresh, schema_path)
check("schema.sql 재적용 안전 (IF NOT EXISTS / OR IGNORE)", True)

a, b = structure(migrated), structure(fresh)
check("마이그레이션 결과와 schema.sql 구조 일치", a == b,
      {k: (a.get(k), b.get(k)) for k in set(a) | set(b) if a.get(k) != b.get(k)})

for name, db in (("migrated", migrated), ("schema.sql", fresh)):
    rooms = db.execute("SELECT code, name FROM rooms ORDER BY sort_order").fetchall()
    check(f"[{name}] 열람실 A/B/C", rooms == [("A", "열람실 A"), ("B", "열람실 B"), ("C", "열람실 C")], rooms)
    per_room = db.execute("SELECT r.code, count(*), min(s.seat_no), max(s.seat_no) FROM seats s JOIN rooms r ON r.id = s.room_id GROUP BY r.code ORDER BY r.code").fetchall()
    check(f"[{name}] 열람실별 30석", per_room == [("A", 30, 1, 30), ("B", 30, 1, 30), ("C", 30, 1, 30)], per_room)
    ids = db.execute("SELECT min(id), max(id), count(*) FROM seats").fetchone()
    check(f"[{name}] 좌석 id 1~90", ids == (1, 90, 90), ids)
    labels = db.execute("SELECT label FROM seats WHERE id IN (1, 30, 31, 60, 61, 90) ORDER BY id").fetchall()
    check(f"[{name}] 라벨 A01..C30", [l[0] for l in labels] == ["A01", "A30", "B01", "B30", "C01", "C30"], labels)

# 3) 중복 예약 방지 인덱스가 열람실을 넘어서도 동작하는지 (1인 1좌석, 좌석당 1건)
db = fresh
db.execute("INSERT INTO students (student_no, display_name, password_hash) VALUES ('TEST-0001','t','x'), ('TEST-0002','t','x')")
db.execute("INSERT INTO reservations (seat_id, student_id, status, reserved_at, expires_at) VALUES (31, 1, 'reserved', 'a', 'b')")
for label, args in (("다른 열람실 두 번째 좌석 거부 (1인 1좌석)", (61, 1)), ("같은 좌석 다른 학생 거부", (31, 2))):
    try:
        db.execute("INSERT INTO reservations (seat_id, student_id, status, reserved_at, expires_at) VALUES (?, ?, 'reserved', 'a', 'b')", args)
        check(label, False, "삽입됨")
    except sqlite3.IntegrityError:
        check(label, True)
try:
    db.execute("INSERT INTO seats (id, room_id, seat_no, label) VALUES (91, 1, 1, 'A01X')")
    check("열람실 내 좌석 번호 중복 거부", False, "삽입됨")
except sqlite3.IntegrityError:
    check("열람실 내 좌석 번호 중복 거부", True)

print(f"\n실패 {failures}건")
sys.exit(1 if failures else 0)
