const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/trigger',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
};

console.log('Testing /trigger endpoint...\n');

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`Status Code: ${res.statusCode}`);
    console.log(`Response Headers:`, res.headers);
    console.log('\nResponse Body:');
    try {
      console.log(JSON.stringify(JSON.parse(data), null, 2));
    } catch (e) {
      console.log(data);
    }
  });
});

req.on('error', (error) => {
  console.error(`Error: ${error.message}`);
  console.error('\nMake sure the server is running on port 3000');
  console.error('Start the server with: node index.js');
});

req.end();

