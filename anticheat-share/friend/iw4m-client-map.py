#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
import tempfile


def guid_hex(network_id):
    return format(int(network_id) & ((1 << 64) - 1), "016x")


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: iw4m-client-map.py <Database.db> <output.json>")

    database_path = sys.argv[1]
    output_path = sys.argv[2]

    con = sqlite3.connect(database_path)
    cur = con.cursor()
    rows = cur.execute(
        """
        SELECT c.ClientId, c.NetworkId, COALESCE(a.Name, ''), c.LastConnection
        FROM EFClients c
        LEFT JOIN EFAlias a ON a.AliasId = c.CurrentAliasId
        WHERE c.NetworkId IS NOT NULL
        """
    ).fetchall()
    con.close()

    clients = {}
    for client_id, network_id, name, last_connection in rows:
        clients[guid_hex(network_id)] = {
            "clientId": int(client_id),
            "name": name,
            "lastConnection": last_connection,
        }

    payload = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "clients": clients,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".iw4m-client-map.", dir=os.path.dirname(output_path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        os.replace(tmp_path, output_path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


if __name__ == "__main__":
    main()
