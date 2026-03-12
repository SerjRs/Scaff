// Test the full Cortex LLM call path
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = 'C:\\Users\\Temp User\\.openclaw';
process.chdir(root);

// Dynamic import from dist
async function main() {
  try {
    // Test 1: Model resolution
    const { resolveModel } = await import(`file:///${root.replace(/\\/g, '/')}/dist/entry-${getEntryHash()}.js`).catch(() => null) ?? {};
    
    // Better approach: use the actual model-auth module
    console.log('=== Testing model resolution ===');
    
    // Read models.json directly
    const fs = await import('node:fs');
    const models = JSON.parse(fs.readFileSync(`${root}\\agents\\main\\agent\\models.json`, 'utf-8'));
    console.log('Models providers:', Object.keys(models.providers || {}));
    
    // Look for anthropic models
    const anthropicProvider = models.providers?.anthropic;
    if (anthropicProvider) {
      console.log('Anthropic provider config:', JSON.stringify(anthropicProvider).substring(0, 200));
    }
    
    // Look for model entries that match claude-opus-4
    const allModels = Object.values(models).flat ? [models] : [models];
    console.log('Full models.json keys:', Object.keys(models));
    
  } catch(e) {
    console.error('Error:', e.message);
  }
}

function getEntryHash() { return 'status-CAvi_W-J'; }

// Simpler approach
async function simpleTest() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  
  console.log('=== Models.json ===');
  const models = JSON.parse(fs.readFileSync(`${root}\\agents\\main\\agent\\models.json`, 'utf-8'));
  console.log(JSON.stringify(models, null, 2));
  
  console.log('\n=== openclaw.json relevant sections ===');
  const ocl = JSON.parse(fs.readFileSync(`${root}\\openclaw.json`, 'utf-8'));
  console.log('model:', ocl.model);
  console.log('agents.defaults:', JSON.stringify(ocl.agents?.defaults || {}, null, 2));
  console.log('models:', JSON.stringify(ocl.models || {}, null, 2));
}

simpleTest().catch(console.error);
