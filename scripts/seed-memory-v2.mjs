#!/usr/bin/env node
/**
 * seed-memory-v2.mjs — Gate H1.5
 * 
 * Reads markdown memory files, splits by ## sections, sends each section
 * to Haiku for review. Approved sections get inserted into cortex_session
 * with correct timestamps. The Gardener then extracts facts naturally.
 *
 * Usage:
 *   node scripts/seed-memory-v2.mjs                # dry-run
 *   node scripts/seed-memory-v2.mjs --commit       # insert into cortex_session
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const WORKSPACE = ROOT + '/workspace';
const DB_PATH = ROOT + '/cortex/bus.sqlite';

// Auth
const authProfiles = JSON.parse(readFileSync(ROOT + '/agents/main/agent/auth-profiles.json', 'utf8'));
const API_KEY = authProfiles.profiles['anthropic:scaff'].token;

// --- Haiku reviewer ---

async function reviewSection(section, filename, sectionTitle) {
  const prompt = `You are reviewing a memory section from a markdown file for import into a memory database.

File: ${filename}
Section: ${sectionTitle}

Content:
${section}

Your job:
1. If this section contains meaningful, durable knowledge (facts, decisions, preferences, events, people, architecture, lessons), return a cleaned-up version that preserves all important information. Keep it concise but complete.
2. If the section lacks context on its own and needs more content to make sense, respond with exactly: NEED_MORE
3. If the section is noise (table of contents, formatting instructions, empty headers, generic boilerplate), respond with exactly: SKIP

Rules:
- Preserve specific dates, names, numbers, decisions, and technical details
- Don't add information that isn't in the source
- Don't remove important context
- Keep the response as plain text, not markdown`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Haiku ${resp.status}: ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  return data.content[0].text.trim();
}

// --- Parse files into sections ---

function splitSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let currentTitle = '(top)';
  let currentLines = [];

  for (const line of lines) {
    if (line.match(/^#{1,3}\s/)) {
      // Flush previous section
      if (currentLines.length > 0) {
        const text = currentLines.join('\n').trim();
        if (text.length > 0) {
          sections.push({ title: currentTitle, content: text });
        }
      }
      currentTitle = line.replace(/^#+\s*/, '').trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush last section
  if (currentLines.length > 0) {
    const text = currentLines.join('\n').trim();
    if (text.length > 0) {
      sections.push({ title: currentTitle, content: text });
    }
  }

  return sections;
}

function getTimestamp(filename) {
  // Daily logs: 2026-02-03.md → 2026-02-03T12:00:00.000Z
  const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1] + 'T12:00:00.000Z';

  // Long-term shards: use reasonable defaults
  const defaults = {
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

  return defaults[basename(filename)] || '2026-02-15T00:00:00.000Z';
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');

  // Collect files
  const files = [];
  const ltDir = join(WORKSPACE, 'memory', 'long-term');
  for (const f of readdirSync(ltDir).filter(f => f.endsWith('.md'))) {
    files.push({ path: join(ltDir, f), name: f, type: 'long-term' });
  }
  const memDir = join(WORKSPACE, 'memory');
  for (const f of readdirSync(memDir).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))) {
    files.push({ path: join(memDir, f), name: f, type: 'daily' });
  }
  // MEMORY.md
  const memoryMd = join(WORKSPACE, 'MEMORY.md');
  files.push({ path: memoryMd, name: 'MEMORY.md', type: 'index' });

  console.log(`Found ${files.length} memory files\n`);

  let totalSections = 0;
  let approved = 0;
  let skipped = 0;
  let merged = 0;
  let errors = 0;

  const db = commit ? new DatabaseSync(DB_PATH) : null;
  const insert = db?.prepare(
    `INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const file of files) {
    const content = readFileSync(file.path, 'utf8');
    const sections = splitSections(content);
    console.log(`${file.name}: ${sections.length} sections`);

    let pendingMerge = null;

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      totalSections++;

      let textToReview = pendingMerge
        ? pendingMerge + '\n\n---\n\n' + section.content
        : section.content;

      // Skip very short sections
      if (textToReview.trim().length < 20) {
        skipped++;
        continue;
      }

      try {
        const result = await reviewSection(textToReview, file.name, section.title);

        if (result === 'SKIP') {
          skipped++;
          pendingMerge = null;
          continue;
        }

        if (result === 'NEED_MORE') {
          pendingMerge = textToReview;
          merged++;
          continue;
        }

        // Approved — insert into cortex_session
        const timestamp = getTimestamp(file.name);
        
        if (commit) {
          // Check if already inserted (by source file + section title)
          const metaKey = JSON.stringify({ source: file.name, section: section.title, seeded: true });
          const exists = db.prepare("SELECT id FROM cortex_session WHERE metadata = ?").get(metaKey);
          if (exists) {
            approved++;
            pendingMerge = null;
            continue;
          }
          insert.run(
            randomUUID(),           // envelope_id
            'assistant',            // role (Scaff's memory)
            'whatsapp',             // channel
            'scaff',                // sender_id
            result,                 // content (Haiku-cleaned)
            timestamp,              // timestamp
            JSON.stringify({ source: file.name, section: section.title, seeded: true }), // metadata
            'memory-seed'           // issuer
          );
        }

        approved++;
        pendingMerge = null;

        if (!commit) {
          console.log(`  ✓ [${section.title}] ${result.substring(0, 100)}...`);
        }

      } catch (e) {
        errors++;
        console.error(`  ✗ Error: ${e.message}`);
        pendingMerge = null;
      }
    }
  }

  console.log(`\n--- Results ---`);
  console.log(`Total sections: ${totalSections}`);
  console.log(`Approved: ${approved}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Merged (NEED_MORE): ${merged}`);
  console.log(`Errors: ${errors}`);

  if (commit) {
    console.log('\nInserted into cortex_session. Gardener will extract facts on next run.');
  } else {
    console.log('\nDry run. Use --commit to insert.');
  }

  db?.close();
}

await main();
