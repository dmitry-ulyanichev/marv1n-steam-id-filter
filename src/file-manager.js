// steam-id-processor\src\file-manager.js
const fs = require('fs-extra');
const path = require('path');

class FileManager {
  constructor(config) {
    this.config = config;
    this.ensureDirectoriesExist();
  }

  ensureDirectoriesExist() {
    // Make sure log directory exists
    fs.ensureDirSync(this.config.LOG_DIR);
  }

  // Helper method for delay
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = FileManager;