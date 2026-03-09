import sqlite3
import os
import json

db_path = os.path.expanduser('~/.openclaw/router/queue.sqlite')
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Query 1: Modified to use actual columns - get first 60 chars of payload message
print('=== QUERY 1: SELECT id, status, substr(payload, 1, 60) as task_summary, tier, created_at FROM jobs ORDER BY created_at DESC LIMIT 10; ===\n')
cursor.execute("SELECT id, status, substr(payload, 1, 60) as task_summary, tier, created_at FROM jobs ORDER BY created_at DESC LIMIT 10;")
rows = cursor.fetchall()
cols = [description[0] for description in cursor.description]
for row in rows:
    print(dict(zip(cols, row)))

# Query 2
print('\n=== QUERY 2: SELECT status, COUNT(*) as count FROM jobs GROUP BY status; ===\n')
cursor.execute("SELECT status, COUNT(*) as count FROM jobs GROUP BY status;")
rows = cursor.fetchall()
cols = [description[0] for description in cursor.description]
for row in rows:
    print(dict(zip(cols, row)))

conn.close()
