'use strict';

// Minimal mock for the `vscode` module so test files can require
// production modules that `require('vscode')` at the top level.
// Only stubs used by utils.js / server.js — extend as needed.

let _mockConfig = {};

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
    getConfiguration: (section) => ({
      get: (key, defaultValue) => {
        if (section && _mockConfig[section] && _mockConfig[section][key] !== undefined) {
          return _mockConfig[section][key];
        }
        if (_mockConfig[key] !== undefined) {
          return _mockConfig[key];
        }
        return defaultValue;
      },
    }),
    __setConfig: (section, key, value) => {
      if (!_mockConfig[section]) _mockConfig[section] = {};
      _mockConfig[section][key] = value;
    },
    __resetConfig: () => {
      _mockConfig = {};
    },
    workspaceFolders: null,
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async () => {},
    getCommands: async () => [],
  },
  extensions: {
    getExtension: () => null,
  },
};
