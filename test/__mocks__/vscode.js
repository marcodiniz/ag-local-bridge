'use strict';

// Minimal mock for the `vscode` module so test files can require
// production modules that `require('vscode')` at the top level.
// Only stubs used by utils.js / server.js — extend as needed.

module.exports = {
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
    createStatusBarItem: () => ({
      text: '',
      tooltip: '',
      command: '',
      backgroundColor: undefined,
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, defaultValue) => defaultValue,
    }),
    workspaceFolders: null,
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async () => {},
  },
  extensions: {
    getExtension: () => null,
  },
};
