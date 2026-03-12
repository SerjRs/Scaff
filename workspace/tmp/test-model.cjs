// Test model resolution - same path as createGatewayLLMCaller
async function test() {
  // Simulate what gateway-bridge does
  process.chdir('C:\\Users\\Temp User\\.openclaw');
  
  const { resolveModel } = await import('file:///C:/Users/Temp%20User/.openclaw/dist/entry.js')
    .catch(() => null) ?? {};
  
  // Try direct require
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    
    // Read agent config
    const agentDir = 'C:\\Users\\Temp User\\.openclaw\\agents\\main\\agent';
    const configPath = path.join(agentDir, 'config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      console.log('Agent config model:', cfg.model);
    } else {
      console.log('No agent config at:', configPath);
    }
    
    // Read auth profiles
    const authPath = path.join(agentDir, 'auth-profiles.json');
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      console.log('Auth profiles:', Object.keys(auth.profiles || {}));
      console.log('Last good:', auth.lastGood);
    } else {
      console.log('No auth profiles at:', authPath);
    }
    
    // Read openclaw.json
    const oclPath = 'C:\\Users\\Temp User\\.openclaw\\openclaw.json';
    if (fs.existsSync(oclPath)) {
      const ocl = JSON.parse(fs.readFileSync(oclPath, 'utf-8'));
      console.log('openclaw.json model:', ocl.model || ocl.agents?.defaults?.model);
      console.log('openclaw.json agents:', JSON.stringify(ocl.agents?.defaults || {}).substring(0, 200));
    }
    
  } catch(e) {
    console.error('Error:', e.message);
  }
}

test().catch(console.error);
