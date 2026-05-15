const mockVscode = { 
  workspace: { getWorkspaceFolder: () => null, getConfiguration: () => ({ get: () => true }) },
  extensions: { getExtension: () => ({ id: 'google.antigravity', extensionPath: 'C:\\\\Users\\\\User\\\\.antigravity\\\\extensions\\\\google.antigravity-1.1.0' }) }
};
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(name) {
  if (name === 'vscode') return mockVscode;
  return originalRequire.apply(this, arguments);
};

const { discoverSidecar } = require('./src/sidecar/discovery');
const { makeH2JsonCall } = require('./src/sidecar/rpc');

async function test() {
  const info = await discoverSidecar({ workspaceFolders: [] });
  const port = info.actualPorts.find(p => p !== info.extensionServerPort) || info.extensionServerPort;
  const csrf = info.csrfTokens[0];
  const certPath = info.certPath;

  const reqBody = { prompt: '[User]\nCalculate 2+2\n[Assistant]\n<tool_call>{\"name\": \"calc\", \"arguments\": {}}</tool_call>\n<observation>\n[Tool Result: calc]\n4\n</observation>\n', model: 'MODEL_PLACEHOLDER_M16' };
  try {
    const res = await makeH2JsonCall(port, csrf, certPath, 'GetModelResponse', reqBody, 0, 100000);
    console.log('Success! Keys:', Object.keys(res), 'response string len:', res.response?.length);
    console.log('Result payload:', JSON.stringify(res));
  } catch(e) {
    console.error('Failed:', e.message.substring(0, 200));
  }
}
test().catch(console.error);
