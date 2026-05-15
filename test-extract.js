const msg = 'HTTP 500: {"code":"unknown","message":"INTERNAL (code 500): Internal error encountered."}';
const { extractProviderError } = require('./src/utils.js');
console.log('EX:', extractProviderError(msg));
