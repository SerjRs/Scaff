// Test the full LLM resolution path
process.chdir('C:\\Users\\Temp User\\.openclaw');
const path = require('path');
const fs = require('fs');

// Simulate what createGatewayLLMCaller does
async function test() {
  // 1. Load cortex config
  const cortexConfig = JSON.parse(fs.readFileSync('cortex/config.json', 'utf-8'));
  console.log('Cortex model:', cortexConfig.model);
  
  // 2. Load the bundled dist to get resolveModel
  // Find the main entry bundle
  const distFiles = fs.readdirSync('dist').filter(f => f.startsWith('entry') && f.endsWith('.js'));
  console.log('Dist entry files:', distFiles);
  
  // 3. Test direct API call with the token
  const authProfiles = JSON.parse(fs.readFileSync('agents/main/agent/auth-profiles.json', 'utf-8'));
  const profile = authProfiles.profiles['anthropic:scaff'];
  const token = profile.token;
  const type = profile.type;
  console.log('Profile type:', type, 'Token prefix:', token ? token.substring(0, 20) + '...' : 'null');
  
  // 4. Make a direct API call to test if token works
  console.log('\n=== Testing direct Anthropic API call ===');
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'say hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    
    const data = await response.json();
    console.log('Status:', response.status);
    if (response.ok) {
      console.log('SUCCESS! Response:', JSON.stringify(data).substring(0, 200));
    } else {
      console.log('ERROR:', JSON.stringify(data).substring(0, 500));
    }
  } catch(e) {
    console.log('Fetch error:', e.message);
  }
}

test().catch(console.error);
