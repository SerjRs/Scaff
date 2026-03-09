#!/usr/bin/env node
/**
 * seed-memory.mjs — Gate H1.5
 * Migrates markdown memory files into cortex_hot_memory.
 * 
 * Parses each file into discrete facts, assigns timestamps from source,
 * embeds via Ollama, dedup-checks (cosine >0.85 = skip), inserts.
 * 
 * Usage:
 *   node scripts/seed-memory.mjs                # dry-run (shows facts, no insert)
 *   node scripts/seed-memory.mjs --commit       # actually insert into DB
 *   node scripts/seed-memory.mjs --stats        # show current hot memory stats
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const WORKSPACE = ROOT + '/workspace';
const DB_PATH = ROOT + '/cortex/bus.sqlite';
const OLLAMA = 'http://127.0.0.1:11434';
const COSINE_THRESHOLD = 0.85;

// --- Embedding ---

async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: [text] }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.embeddings[0];
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- Fact Parsing ---

function parseDailyLog(content, filename) {
  // Extract date from filename: 2026-02-03.md → 2026-02-03
  const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
  const timestamp = dateMatch ? dateMatch[1] + 'T12:00:00.000Z' : new Date().toISOString();
  
  const facts = [];
  const lines = content.split('\n');
  let currentSection = '';
  let currentBullet = [];
  
  for (const line of lines) {
    // Track section headers
    if (line.match(/^#{1,3}\s/)) {
      // Flush current bullet
      if (currentBullet.length > 0) {
        const text = currentBullet.join(' ').trim();
        if (text.length > 20 && text.length < 500) {
          facts.push({ text, timestamp, source: filename, section: currentSection });
        }
        currentBullet = [];
      }
      currentSection = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    
    // Bullet points are facts
    if (line.match(/^[-*]\s/) || line.match(/^\d+\.\s/)) {
      // Flush previous bullet
      if (currentBullet.length > 0) {
        const text = currentBullet.join(' ').trim();
        if (text.length > 20 && text.length < 500) {
          facts.push({ text, timestamp, source: filename, section: currentSection });
        }
      }
      currentBullet = [line.replace(/^[-*\d.]+\s*/, '').trim()];
    } else if (line.trim() && currentBullet.length > 0) {
      // Continuation of previous bullet
      currentBullet.push(line.trim());
    } else if (line.trim() === '' && currentBullet.length > 0) {
      // Blank line ends bullet
      const text = currentBullet.join(' ').trim();
      if (text.length > 20 && text.length < 500) {
        facts.push({ text, timestamp, source: filename, section: currentSection });
      }
      currentBullet = [];
    }
  }
  
  // Flush remaining
  if (currentBullet.length > 0) {
    const text = currentBullet.join(' ').trim();
    if (text.length > 20 && text.length < 500) {
      facts.push({ text, timestamp, source: filename, section: currentSection });
    }
  }
  
  return facts;
}

function parseLongTermFile(content, filename) {
  // Use file content dates if present, otherwise use a reasonable default
  const dateDefaults = {
    'identity.md': '2026-02-01T00:00:00.000Z',
    'people.md': '2026-02-01T00:00:00.000Z',
    'security.md': '2026-02-10T00:00:00.000Z',
    'infrastructure.md': '2026-02-15T00:00:00.000Z',
    'preferences.md': '2026-02-01T00:00:00.000Z',
    'testing.md': '2026-02-12T00:00:00.000Z',
    'mortality-review.md': '2026-02-10T00:00:00.000Z',
    'architecture-state.md': '2026-03-07T00:00:00.000Z',
    'archived-reports-feb2026.md': '2026-02-28T00:00:00.000Z',
    'MEMORY_old_backup.md': '2026-02-20T00:00:00.000Z',
  };
  
  const timestamp = dateDefaults[basename(filename)] || new Date().toISOString();
  
  // Same parsing logic
  return parseDailyLog(content, filename).map(f => ({ ...f, timestamp }));
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const stats = args.includes('--stats');
  
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });
  const sv = await import('sqlite-vec');
  db.enableLoadExtension(true);
  sv.load(db);
  
  if (stats) {
    const count = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
    console.log(`Hot memory: ${count.c} facts`);
    db.close();
    return;
  }
  
  // Collect all source files
  const files = [];
  
  // Long-term shards
  const ltDir = join(WORKSPACE, 'memory', 'long-term');
  for (const f of readdirSync(ltDir).filter(f => f.endsWith('.md'))) {
    files.push({ path: join(ltDir, f), type: 'long-term', name: f });
  }
  
  // Daily logs
  const memDir = join(WORKSPACE, 'memory');
  for (const f of readdirSync(memDir).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))) {
    files.push({ path: join(memDir, f), type: 'daily', name: f });
  }
  
  console.log(`Found ${files.length} memory files`);
  
  // Parse all facts
  let allFacts = [];
  for (const file of files) {
    const content = readFileSync(file.path, 'utf8');
    const facts = file.type === 'daily' 
      ? parseDailyLog(content, file.name)
      : parseLongTermFile(content, file.name);
    console.log(`  ${file.name}: ${facts.length} facts`);
    allFacts.push(...facts);
  }
  
  console.log(`\nTotal parsed: ${allFacts.length} facts`);
  
  // Filter out low-quality facts
  allFacts = allFacts.filter(f => {
    // Skip pure markdown formatting
    if (f.text.match(/^[#|\-\*`]/)) return false;
    // Skip very short
    if (f.text.length < 25) return false;
    // Skip checkbox-only lines
    if (f.text.match(/^\[[ x~]\]/i) && f.text.length < 40) return false;
    return true;
  });
  
  console.log(`After filtering: ${allFacts.length} facts`);
  
  if (!commit) {
    console.log('\n--- DRY RUN (use --commit to insert) ---\n');
    for (let i = 0; i < Math.min(allFacts.length, 30); i++) {
      console.log(`  [${allFacts[i].timestamp.substring(0,10)}] ${allFacts[i].source}: ${allFacts[i].text.substring(0, 120)}`);
    }
    if (allFacts.length > 30) console.log(`  ... and ${allFacts.length - 30} more`);
    db.close();
    return;
  }
  
  // Load existing facts for dedup
  const existing = db.prepare('SELECT id, fact_text FROM cortex_hot_memory').all();
  console.log(`\nExisting facts: ${existing.length}`);
  
  // Embed existing facts for dedup comparison
  console.log('Embedding existing facts for dedup...');
  const existingVecs = [];
  for (const e of existing) {
    const vec = await embed(e.fact_text);
    existingVecs.push({ id: e.id, text: e.fact_text, vec });
  }
  
  // Process new facts
  const insert = db.prepare(
    'INSERT INTO cortex_hot_memory (id, fact_text, created_at, last_accessed_at, hit_count) VALUES (?, ?, ?, ?, 0)'
  );
  
  let inserted = 0;
  let skippedDup = 0;
  let skippedErr = 0;
  
  for (let i = 0; i < allFacts.length; i++) {
    const fact = allFacts[i];
    
    try {
      const vec = await embed(fact.text);
      
      // Dedup: check cosine similarity against all existing + already-inserted
      let isDup = false;
      for (const ev of existingVecs) {
        if (cosine(vec, ev.vec) > COSINE_THRESHOLD) {
          isDup = true;
          break;
        }
      }
      
      if (isDup) {
        skippedDup++;
        continue;
      }
      
      const id = randomUUID();
      insert.run(id, fact.text, fact.timestamp, fact.timestamp);
      existingVecs.push({ id, text: fact.text, vec }); // Add to dedup pool
      inserted++;
      
      if (inserted % 20 === 0) {
        console.log(`  ${i + 1}/${allFacts.length} processed, ${inserted} inserted, ${skippedDup} deduped`);
      }
    } catch (e) {
      skippedErr++;
      if (skippedErr <= 3) console.error(`  Error: ${e.message}`);
    }
  }
  
  const total = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
  console.log(`\nDone. Inserted: ${inserted}, Deduped: ${skippedDup}, Errors: ${skippedErr}`);
  console.log(`Total facts in hot memory: ${total.c}`);
  
  db.close();
}

await main();
