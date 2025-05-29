// src/utils/logger.js
const logger = {
  info: (message) => {
    console.log(`[${new Date().toISOString()}] INFO: ${message}`);
  },
  
  warn: (message) => {
    console.warn(`[${new Date().toISOString()}] WARN: ${message}`);
  },
  
  error: (message) => {
    console.error(`[${new Date().toISOString()}] ERROR: ${message}`);
  },
  
  debug: (message) => {
    // Only show debug logs if DEBUG environment variable is set
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] DEBUG: ${message}`);
    }
  }
};

module.exports = logger;