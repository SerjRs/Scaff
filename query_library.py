import sqlite3
import json

db_path = r'C:\Users\Temp User\.openclaw\library\library.sqlite'

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

print("=== DATABASE SCHEMA ===\n")
cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name;")
tables = cursor.fetchall()
for table in tables:
    if table[0]:
        print(table[0] + ';')
        print()

print("=== RECORD WITH id=1 ===\n")
try:
    cursor.execute("SELECT * FROM items WHERE id=1;")
    record = cursor.fetchone()
    if record:
        # Convert Row object to dict
        record_dict = dict(record)
        print(json.dumps(record_dict, indent=2, default=str))
    else:
        print("No record found with id=1")
except Exception as e:
    print(f"Error querying items table: {e}")

conn.close()
