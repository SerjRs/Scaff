#!/usr/bin/env node
/**
 * Import & Dependency Graph Analyzer
 * Uses TypeScript Compiler API to answer:
 *   - What files import this module?
 *   - What does this module import?
 *   - Impact analysis: if I change X, what else might break?
 * 
 * Usage:
 *   node scripts/import-graph.mjs --importers src/cortex/hippocampus.ts
 *   node scripts/import-graph.mjs --imports src/cortex/index.ts
 *   node scripts/import-graph.mjs --impact src/cortex/gardener.ts
 *   node scripts/import-graph.mjs --startup    # show startup wiring chain
 */

import ts from 'typescript';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0]; // --importers, --imports, --impact, --startup
const targetFile = args[1];

// Build the project
const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
if (!configPath) { console.error('tsconfig.json not found'); process.exit(1); }

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);

// Create program
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const sourceFiles = program.getSourceFiles().filter(sf => !sf.isDeclarationFile && !sf.fileName.includes('node_modules'));

// Build import graph
const importGraph = new Map(); // file -> Set<imported files>
const importerGraph = new Map(); // file -> Set<files that import it>

for (const sf of sourceFiles) {
  const rel = path.relative(ROOT, sf.fileName).replace(/\\/g, '/');
  if (!importGraph.has(rel)) importGraph.set(rel, new Set());
  
  ts.forEachChild(sf, (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith('.')) {
        // Resolve relative import
        const dir = path.dirname(sf.fileName);
        let resolved = path.resolve(dir, specifier);
        
        // Try extensions
        for (const ext of ['.ts', '.js', '/index.ts', '/index.js', '']) {
          const full = resolved + ext;
          if (fs.existsSync(full)) { resolved = full; break; }
        }
        
        // Strip .js extension and try .ts
        if (!fs.existsSync(resolved) && resolved.endsWith('.js')) {
          const tsVersion = resolved.replace(/\.js$/, '.ts');
          if (fs.existsSync(tsVersion)) resolved = tsVersion;
        }
        
        const relImport = path.relative(ROOT, resolved).replace(/\\/g, '/');
        importGraph.get(rel).add(relImport);
        
        if (!importerGraph.has(relImport)) importerGraph.set(relImport, new Set());
        importerGraph.get(relImport).add(rel);
      }
    }
  });
}

function normalize(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function findFile(target) {
  const norm = normalize(target);
  // Try exact match
  if (importGraph.has(norm)) return norm;
  // Try with .ts extension
  if (importGraph.has(norm + '.ts')) return norm + '.ts';
  // Try without .ts
  const noExt = norm.replace(/\.ts$/, '');
  for (const key of importGraph.keys()) {
    if (key.endsWith(noExt + '.ts') || key === noExt) return key;
  }
  // Partial match
  for (const key of importGraph.keys()) {
    if (key.includes(norm)) return key;
  }
  return null;
}

if (command === '--importers') {
  const key = findFile(targetFile);
  if (!key) { console.error(`File not found: ${targetFile}`); process.exit(1); }
  
  const importers = importerGraph.get(key) || new Set();
  console.log(JSON.stringify({
    file: key,
    importedBy: [...importers].sort(),
    count: importers.size,
  }, null, 2));

} else if (command === '--imports') {
  const key = findFile(targetFile);
  if (!key) { console.error(`File not found: ${targetFile}`); process.exit(1); }
  
  const imports = importGraph.get(key) || new Set();
  console.log(JSON.stringify({
    file: key,
    imports: [...imports].sort(),
    count: imports.size,
  }, null, 2));

} else if (command === '--impact') {
  const key = findFile(targetFile);
  if (!key) { console.error(`File not found: ${targetFile}`); process.exit(1); }
  
  // BFS to find all transitively affected files
  const affected = new Set();
  const queue = [key];
  while (queue.length > 0) {
    const current = queue.shift();
    const importers = importerGraph.get(current) || new Set();
    for (const imp of importers) {
      if (!affected.has(imp)) {
        affected.add(imp);
        queue.push(imp);
      }
    }
  }
  
  console.log(JSON.stringify({
    file: key,
    directImporters: [...(importerGraph.get(key) || [])].sort(),
    transitiveImpact: [...affected].sort(),
    impactCount: affected.size,
  }, null, 2));

} else if (command === '--startup') {
  // Find the startup chain: server-startup.ts → what it imports → what those import
  const startupFile = findFile('server-startup');
  if (!startupFile) { console.error('server-startup.ts not found'); process.exit(1); }
  
  const imports = importGraph.get(startupFile) || new Set();
  const chain = {};
  for (const imp of imports) {
    chain[imp] = [...(importGraph.get(imp) || [])].sort();
  }
  
  console.log(JSON.stringify({
    startupFile,
    directImports: [...imports].sort(),
    chain,
  }, null, 2));

} else {
  // Summary stats
  console.log(JSON.stringify({
    totalFiles: importGraph.size,
    totalEdges: [...importGraph.values()].reduce((s, set) => s + set.size, 0),
    topImported: [...importerGraph.entries()]
      .map(([file, importers]) => ({ file, importerCount: importers.size }))
      .sort((a, b) => b.importerCount - a.importerCount)
      .slice(0, 15),
  }, null, 2));
}
