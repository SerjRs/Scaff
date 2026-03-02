import https from 'https';

https.get('https://api.github.com', (res) => {
  let data = '';
  
  console.log('Status Code:', res.statusCode);
  console.log('x-ratelimit-limit:', res.headers['x-ratelimit-limit']);
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('Response Body (first 200 chars):', data.substring(0, 200));
  });
}).on('error', (e) => {
  console.error(e);
});
