#!/usr/bin/env python3
import json
import os
import sqlite3
import time
from datetime import datetime, timezone

BASE = "/home/mw2-cluster/base_files/data/iw4madmin"
DB_PATH = os.path.join(BASE, "Database", "Database.db")
REQUEST_PATH = os.path.join(BASE, "Logs", "anticheat-iw4m-flag-requests.jsonl")
STATE_PATH = os.path.join(BASE, "Logs", "anticheat-iw4m-flag-worker.state.json")
LOG_PATH = os.path.join(BASE, "Logs", "anticheat-iw4m-flag-worker.log")


def log(message):
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(f"[{stamp}] {message}\n")


def read_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {"offset": 0}


def write_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle)
    os.replace(tmp, STATE_PATH)


def sql_timestamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def insert_change(conn, origin_id, target_id, change_type, comment, current_value, previous_value=None):
    conn.execute(
        """
        INSERT INTO EFChangeHistory
            (Active, OriginEntityId, TargetEntityId, TypeOfChange, TimeChanged, Comment, CurrentValue, PreviousValue, ImpersonationEntityId)
        VALUES
            (1, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (origin_id, target_id, change_type, sql_timestamp(), comment, current_value, previous_value),
    )


def process_request(request):
    action = str(request.get("action") or "").lower()
    profile_id = int(request.get("profileId") or 0)
    flag_type = 2
    unflag_type = 8
    punisher_id = int(request.get("punisherId") or 1)
    reason = str(request.get("reason") or "").strip()

    if profile_id < 1:
        log(f"skip {action}: missing profileId request={request}")
        return

    with sqlite3.connect(DB_PATH, timeout=10) as conn:
        conn.execute("PRAGMA busy_timeout=5000")

        if action == "flag":
            client_row = conn.execute(
                """
                SELECT c.Level, c.NetworkId, a.IPAddress
                FROM EFClients c
                LEFT JOIN EFAlias a ON a.AliasId = c.CurrentAliasId
                WHERE c.ClientId = ?
                LIMIT 1
                """,
                (profile_id,),
            ).fetchone()
            current_level = int(client_row[0]) if client_row else 0
            network_id = int(client_row[1]) if client_row and client_row[1] is not None else 0
            ipv4_address = int(client_row[2]) if client_row and client_row[2] is not None else None

            duplicate = conn.execute(
                """
                SELECT COUNT(1)
                FROM EFPenalties
                WHERE OffenderId = ?
                  AND Type = ?
                  AND Active = 1
                  AND Offense LIKE 'Marked as "Watch"%via Anticheat Panel.%'
                """,
                (profile_id, flag_type),
            ).fetchone()[0]

            if duplicate:
                log(f"flag duplicate profile={profile_id} type={flag_type}")
                return

            if current_level < 1:
                conn.execute(
                    "UPDATE EFClients SET Level = 1 WHERE ClientId = ? AND Level < 1",
                    (profile_id,),
                )
                insert_change(conn, punisher_id, profile_id, 0, "Changed permission level", "Flagged")

            cursor = conn.execute(
                """
                INSERT INTO EFPenalties
                    (Active, AutomatedOffense, Expires, IsEvadedOffense, LinkId, OffenderId, Offense, PunisherId, Type, [When])
                VALUES
                    (1, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?)
                """,
                (profile_id, reason, punisher_id, flag_type, sql_timestamp()),
            )
            penalty_id = cursor.lastrowid
            conn.execute(
                """
                INSERT INTO EFPenaltyIdentifiers
                    (CreatedDateTime, IPv4Address, NetworkId, PenaltyId, UpdatedDateTime)
                VALUES
                    (?, ?, ?, ?, NULL)
                """,
                (sql_timestamp(), ipv4_address, network_id, penalty_id),
            )
            insert_change(conn, punisher_id, profile_id, 2, "Executed command", f"!flag @{profile_id} {reason} ")
            log(f"flag inserted profile={profile_id} type={flag_type}")
            return

        if action == "unflag":
            rows = conn.execute(
                """
                UPDATE EFPenalties
                SET Active = 0
                WHERE OffenderId = ?
                  AND Type = ?
                  AND Active = 1
                  AND Offense LIKE 'Marked as "Watch"%via Anticheat Panel.%'
                """,
                (profile_id, flag_type),
            ).rowcount
            remaining_flags = conn.execute(
                """
                SELECT COUNT(1)
                FROM EFPenalties
                WHERE OffenderId = ?
                  AND Type = ?
                  AND Active = 1
                """,
                (profile_id, flag_type),
            ).fetchone()[0]
            current_level_row = conn.execute(
                "SELECT Level FROM EFClients WHERE ClientId = ? LIMIT 1",
                (profile_id,),
            ).fetchone()
            current_level = int(current_level_row[0]) if current_level_row else 0
            if remaining_flags == 0 and current_level == 1:
                conn.execute(
                    "UPDATE EFClients SET Level = 0 WHERE ClientId = ? AND Level = 1",
                    (profile_id,),
                )
                insert_change(conn, punisher_id, profile_id, 0, "Changed permission level", "User")

            conn.execute(
                """
                INSERT INTO EFPenalties
                    (Active, AutomatedOffense, Expires, IsEvadedOffense, LinkId, OffenderId, Offense, PunisherId, Type, [When])
                VALUES
                    (1, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?)
                """,
                (profile_id, reason, punisher_id, unflag_type, sql_timestamp()),
            )
            insert_change(conn, punisher_id, profile_id, 2, "Executed command", f"!unflag @{profile_id} {reason} ")
            log(f"unflag profile={profile_id} deactivated_type={flag_type} rows={rows} history_type={unflag_type}")
            return

        log(f"skip unknown action={action} request={request}")


def read_new_lines(state):
    if not os.path.exists(REQUEST_PATH):
        return []

    size = os.path.getsize(REQUEST_PATH)
    offset = int(state.get("offset") or 0)
    if offset > size:
        offset = 0

    with open(REQUEST_PATH, "r", encoding="utf-8") as handle:
        handle.seek(offset)
        lines = handle.readlines()
        state["offset"] = handle.tell()
    return lines


def loop():
    log("worker started")
    while True:
        state = read_state()
        try:
            lines = read_new_lines(state)
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    process_request(json.loads(line))
                except Exception as exc:
                    log(f"request failed: {exc} line={line[:500]}")
            write_state(state)
        except Exception as exc:
            log(f"loop failed: {exc}")
        time.sleep(2)


if __name__ == "__main__":
    loop()
