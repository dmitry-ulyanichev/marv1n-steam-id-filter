// src/app.js
const express = require('express');
const cors = require('cors');
const logger = require('./utils/logger');

class ExpressApp {
  constructor(queueManager, steamValidator, apiService) {
    this.app = express();
    this.queueManager = queueManager;
    this.steamValidator = steamValidator;
    this.apiService = apiService;
    this.server = null;
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // CORS support
    this.app.use(cors());
    
    // JSON parsing
    this.app.use(express.json());
    
    // URL-encoded parsing
    this.app.use(express.urlencoded({ extended: true }));
    
    // Request logging
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path} from ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/api/health', (req, res) => {
      const status = this.steamValidator.getProxyStatus();
      
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        connections: {
          total: status.totalConnections,
          available: status.availableConnections,
          all_in_cooldown: status.allInCooldown
        },
        uptime: process.uptime()
      });
    });

    // Add Steam ID endpoint
    this.app.post('/api/add-steam-id', async (req, res) => {
      try {
        // Check API key
        const apiKey = req.headers['x-api-key'] || req.query.api_key;
        if (!apiKey || apiKey !== process.env.LINK_HARVESTER_API_KEY) {
          return res.status(401).json({
            success: false,
            error: 'Invalid API key'
          });
        }

        // Get data from request
        const { steam_id, username } = req.body;

        // Validate inputs
        if (!steam_id || !username) {
          return res.status(400).json({
            success: false,
            error: 'Missing required parameters: steam_id and username'
          });
        }

        // Clean and validate Steam ID
        const cleanSteamId = String(steam_id).trim();
        const cleanUsername = String(username).trim();

        if (!cleanSteamId.match(/^\d{17}$/)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid Steam ID format. Must be exactly 17 digits'
          });
        }

        if (!cleanUsername || cleanUsername.length < 1) {
          return res.status(400).json({
            success: false,
            error: 'Invalid username. Must be non-empty string'
          });
        }

        // Check if Steam ID already exists in our API
        const existsResult = await this.apiService.checkSteamIdExists(cleanSteamId);
        
        if (existsResult.success && existsResult.exists) {
          return res.json({
            success: true,
            message: `Steam ID ${cleanSteamId} already exists in database`,
            steam_id: cleanSteamId,
            username: cleanUsername,
            already_exists: true
          });
        }

        // Add to queue
        const queueResult = await this.queueManager.addProfileToQueue(
          cleanSteamId, 
          cleanUsername, 
          this.apiService
        );

        if (queueResult === null) {
          // Already exists in database (checked by queue manager)
          return res.json({
            success: true,
            message: `Steam ID ${cleanSteamId} already exists in database`,
            steam_id: cleanSteamId,
            username: cleanUsername,
            already_exists: true
          });
        }

        if (queueResult) {
          return res.json({
            success: true,
            message: `Steam ID ${cleanSteamId} added to processing queue`,
            steam_id: cleanSteamId,
            username: cleanUsername
          });
        } else {
          return res.status(500).json({
            success: false,
            error: 'Failed to add Steam ID to queue'
          });
        }

      } catch (error) {
        logger.error(`Error in add-steam-id endpoint: ${error.message}`);
        return res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    });

    // GET version of add-steam-id for compatibility
    this.app.get('/api/add-steam-id', async (req, res) => {
      try {
        // Check API key
        const apiKey = req.headers['x-api-key'] || req.query.api_key;
        if (!apiKey || apiKey !== process.env.LINK_HARVESTER_API_KEY) {
          return res.status(401).json({
            success: false,
            error: 'Invalid API key'
          });
        }

        // Get parameters
        const steam_id = req.query.steam_id || req.headers['x-steam-id'];
        const username = req.query.username || req.headers['x-username'];

        // Create request body and call POST handler
        req.body = { steam_id, username };
        
        // Call the POST handler
        return this.app._router.handle({ 
          ...req, 
          method: 'POST', 
          url: '/api/add-steam-id' 
        }, res);

      } catch (error) {
        logger.error(`Error in GET add-steam-id endpoint: ${error.message}`);
        return res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    });

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        service: 'Steam ID Processor',
        status: 'running',
        endpoints: {
          health: 'GET /api/health',
          add_steam_id: 'POST /api/add-steam-id'
        }
      });
    });
  }

  setupErrorHandling() {
    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: 'Endpoint not found'
      });
    });

    // Error handler
    this.app.use((error, req, res, next) => {
      logger.error(`Express error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    });
  }

  start(port = 3000) {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, (error) => {
        if (error) {
          reject(error);
        } else {
          logger.info(`🚀 Server running on port ${port}`);
          resolve();
        }
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = ExpressApp;