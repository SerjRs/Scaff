#!/usr/bin/env node
/**
 * Semantic Code Indexer
 * 
 * Walks src/ TypeScript files, chunks by function/class/block,
 * embeds via Ollama nomic-embed-text, stores in sqlite-vec.
 * 
 * Usage:
 *   node scripts/code-index.mjs           # index (incremental)
 *   node scripts/code-index.mjs --full    # re-index everything
 *   node scripts/code-index.mjs --stats   # show index stats
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_DIR = path.join(ROOT, 'scaff-tools');
const DB_PATH = path.join(DB_DIR, 'code-index.sqlite');
const OLLAMA_URL = 'http://127.0.0.1:11434';
const EMBED_MODEL = 'nomic-embed-text';
const EMBED_DIM = 768;

const args = process.argv.slice(2);
const fullReindex = args.includes('--full');
const statsOnly = args.includes('--stats');

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

async function initDb() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });
  
  // Load sqlite-vec extension
  const sqliteVec = await import('sqlite-vec');
  db.enableLoadExtension(true);
  sqliteVec.load(db);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      chunk_type TEXT NOT NULL,
      chunk_name TEXT,
      content TEXT NOT NULL,
      file_mtime REAL NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path);
  `);

  // Create vec table if not exists
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_vec USING vec0(
        embedding float[${EMBED_DIM}]
      );
    `);
  } catch (e) {
    // Already exists
    if (!e.message.includes('already exists')) throw e;
  }

  return db;
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function walkSourceFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', '__tests__', 'test'].includes(entry.name)) continue;
      walkSourceFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function chunkFile(filePath, content) {
  const lines = content.split('\n');
  const chunks = [];
  
  // Strategy: chunk by exported functions, classes, and significant blocks
  // Fall back to fixed-size windows for large files without clear boundaries
  let currentChunk = { lines: [], startLine: 1, type: 'module', name: null };
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    
    // Detect function/class/interface boundaries
    const exportFunc = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    const exportClass = line.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
    const exportInterface = line.match(/^export\s+(?:type\s+)?interface\s+(\w+)/);
    const exportConst = line.match(/^export\s+const\s+(\w+)/);
    const plainFunc = line.match(/^(?:async\s+)?function\s+(\w+)/);
    
    const boundary = exportFunc || exportClass || exportInterface || exportConst || plainFunc;
    
    if (boundary && currentChunk.lines.length > 2) {
      // Save current chunk
      chunks.push({
        content: currentChunk.lines.join('\n'),
        lineStart: currentChunk.startLine,
        lineEnd: lineNum - 1,
        type: currentChunk.type,
        name: currentChunk.name,
      });
      
      // Start new chunk
      const type = exportFunc || plainFunc ? 'function' 
        : exportClass ? 'class' 
        : exportInterface ? 'interface' 
        : 'const';
      currentChunk = { lines: [line], startLine: lineNum, type, name: boundary[1] };
    } else {
      currentChunk.lines.push(line);
      
      // Cap chunk size at ~120 lines — split if too big
      if (currentChunk.lines.length >= 120) {
        chunks.push({
          content: currentChunk.lines.join('\n'),
          lineStart: currentChunk.startLine,
          lineEnd: lineNum,
          type: currentChunk.type,
          name: currentChunk.name,
        });
        currentChunk = { lines: [], startLine: lineNum + 1, type: 'continuation', name: null };
      }
    }
  }
  
  // Don't forget the last chunk
  if (currentChunk.lines.length > 0) {
    chunks.push({
      content: currentChunk.lines.join('\n'),
      lineStart: currentChunk.startLine,
      lineEnd: lines.length,
      type: currentChunk.type,
      name: currentChunk.name,
    });
  }
  
  // Filter out tiny chunks (< 3 lines or < 50 chars)
  return chunks.filter(c => c.content.trim().length >= 50 && (c.lineEnd - c.lineStart) >= 2);
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function embed(text) {
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!resp.ok) throw new Error(`Ollama embed failed: ${resp.status}`);
  const data = await resp.json();
  return data.embedding;
}

async function embedBatch(texts, batchSize = 20) {
  const embeddings = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(t => embed(t)));
    embeddings.push(...results);
    if (i % 100 === 0) {
      process.stdout.write(`  ${i}/${texts.length} embedded\n`);
    }
  }
  return embeddings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const db = await initDb();
  
  if (statsOnly) {
    const chunkCount = db.prepare('SELECT COUNT(*) as c FROM code_chunks').get();
    const fileCount = db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get();
    const vecCount = db.prepare('SELECT COUNT(*) as c FROM code_chunks_vec').get();
    console.log(JSON.stringify({
      files: fileCount.c,
      chunks: chunkCount.c,
      vectors: vecCount.c,
      dbSize: `${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1)}MB`,
    }, null, 2));
    db.close();
    return;
  }
  
  // Walk source files
  const srcDir = path.join(ROOT, 'src');
  const files = walkSourceFiles(srcDir);
  console.log(`Found ${files.length} source files`);
  
  // Check which files need re-indexing
  const filesToIndex = [];
  for (const filePath of files) {
    const relPath = path.relative(ROOT, filePath).replace(/\\/g, '/');
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;
    
    if (!fullReindex) {
      const existing = db.prepare(
        'SELECT file_mtime FROM code_chunks WHERE file_path = ? LIMIT 1'
      ).get(relPath);
      
      if (existing && Math.abs(existing.file_mtime - mtime) < 1000) {
        continue; // File hasn't changed
      }
    }
    
    filesToIndex.push({ filePath, relPath, mtime });
  }
  
  if (filesToIndex.length === 0) {
    console.log('All files up to date. Nothing to index.');
    db.close();
    return;
  }
  
  console.log(`Indexing ${filesToIndex.length} files (${fullReindex ? 'full' : 'incremental'})...`);
  
  // Process files
  let totalChunks = 0;
  const allChunks = [];
  
  for (const { filePath, relPath, mtime } of filesToIndex) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const chunks = chunkFile(relPath, content);
    
    // Delete old entries for this file
    const oldIds = db.prepare('SELECT id FROM code_chunks WHERE file_path = ?').all(relPath);
    for (const { id } of oldIds) {
      db.prepare('DELETE FROM code_chunks_vec WHERE rowid = ?').run(id);
    }
    db.prepare('DELETE FROM code_chunks WHERE file_path = ?').run(relPath);
    
    // Insert new chunks (without embeddings yet)
    for (const chunk of chunks) {
      const result = db.prepare(`
        INSERT INTO code_chunks (file_path, line_start, line_end, chunk_type, chunk_name, content, file_mtime, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(relPath, chunk.lineStart, chunk.lineEnd, chunk.type, chunk.name, chunk.content, mtime, new Date().toISOString());
      
      allChunks.push({
        id: Number(result.lastInsertRowid),
        content: chunk.content,
        relPath,
        name: chunk.name,
      });
    }
    
    totalChunks += chunks.length;
  }
  
  console.log(`Chunked into ${totalChunks} chunks. Embedding in batches of 50...`);
  
  // Embed and insert in small batches (survives crashes, shows progress)
  const insertVec = db.prepare(`INSERT INTO code_chunks_vec (rowid, embedding) VALUES (?, ?)`);
  let embedded = 0;
  
  for (let i = 0; i < allChunks.length; i += 50) {
    const batch = allChunks.slice(i, i + 50);
    const texts = batch.map(c => 
      `File: ${c.relPath}${c.name ? ` | ${c.name}` : ''}\n\n${c.content.substring(0, 2000)}`
    );
    
    // Embed one at a time within batch (Ollama is single-threaded anyway)
    for (let j = 0; j < batch.length; j++) {
      try {
        const vec = await embed(texts[j]);
        const vecBlob = new Float32Array(vec);
        insertVec.run(BigInt(batch[j].id), Buffer.from(vecBlob.buffer));
        embedded++;
      } catch (err) {
        console.error(`  Failed to embed chunk ${batch[j].id}: ${err.message}`);
      }
    }
    
    console.log(`  ${Math.min(i + 50, allChunks.length)}/${allChunks.length} embedded`);
  }
  
  console.log(`Done. Indexed ${filesToIndex.length} files, ${totalChunks} chunks, ${embedded} embeddings.`);
  
  // Stats
  const chunkCount = db.prepare('SELECT COUNT(*) as c FROM code_chunks').get();
  const fileCount = db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get();
  console.log(`Total index: ${fileCount.c} files, ${chunkCount.c} chunks`);
  console.log(`DB size: ${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1)}MB`);
  
  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
