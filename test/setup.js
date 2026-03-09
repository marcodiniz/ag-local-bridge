'use strict';

// Test setup: register a mock for the `vscode` module.
// Node.js extensions can only require('vscode') inside VS Code's extension host.
// This intercepts the require and returns our stub instead.

const Module = require('module');
const path = require('path');

const originalResolveFilename = Module._resolveFilename;
const vscodeMockPath = path.join(__dirname, '__mocks__', 'vscode.js');

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') {
    return vscodeMockPath;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
