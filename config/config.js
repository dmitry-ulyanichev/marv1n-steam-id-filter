// config/config.js
const path = require('path');

// Load environment variables
require('dotenv').config();

// Define configuration
const CONFIG = {
  // File paths
  QUEUE_PATH: path.join(__dirname, '../profiles_queue.json'), // Queue file in project root
  
  // API settings
  PYTHONANYWHERE_API_ENDPOINT: process.env.PYTHONANYWHERE_API_ENDPOINT,
  PYTHONANYWHERE_API_KEY: process.env.PYTHONANYWHERE_API_KEY,
  CHECK_ID_EXISTS_API_ENDPOINT: process.env.CHECK_ID_EXISTS_API_ENDPOINT,
  
  // Server settings
  PORT: process.env.PORT || 3000,
  
  // Processing settings
  BATCH_SIZE: 20,
  CHECK_INTERVAL: 15000, // Check for new queue items every 15 seconds
  PROCESSING_DELAY: 350, // Delay between processing items
  EMPTY_QUEUE_DELAY: 5000, // Delay when queue is empty
  ERROR_DELAY: 30000, // Delay after errors
  MAX_RETRIES: 3, // Max retries for a single API call
  REQUEST_DELAY: 2000, // Delay between Steam API requests
  
  // Environment variables validation
  STEAM_API_KEY: process.env.STEAM_API_KEY,
  LINK_HARVESTER_API_KEY: process.env.LINK_HARVESTER_API_KEY,
};

// Validate that required environment variables are present
const requiredEnvVars = {
  STEAM_API_KEY: CONFIG.STEAM_API_KEY,
  LINK_HARVESTER_API_KEY: CONFIG.LINK_HARVESTER_API_KEY,
  PYTHONANYWHERE_API_KEY: CONFIG.PYTHONANYWHERE_API_KEY
};

for (const [varName, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    console.error(`Please add ${varName}=your_value to your .env file`);
  } else {
    console.log(`✅ Environment variable ${varName} loaded`);
  }
}

// Ensure log directory exists
fs.ensureDirSync(CONFIG.LOG_DIR);

module.exports = CONFIG;