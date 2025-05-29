// steam-id-processor/src/proxy-manager.js
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

class ProxyManager {
  constructor(configDir) {
    this.configPath = path.join(configDir, 'config_proxies.json');
    this.config = null;
    this.DEFAULT_COOLDOWN_DURATION = 21900000; // 6 hours + 5 minutes in milliseconds
    this.initializeConfig();
  }

  initializeConfig() {
    try {
      // Check if config exists
      if (fs.existsSync(this.configPath)) {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        logger.info('Proxy configuration loaded');
        
        // Ensure it has the correct structure
        this.ensureConfigStructure();
      } else {
        // Create default config
        this.config = {
          connections: [
            {
              type: 'direct',
              url: null,
              in_cooldown: false,
              cooldown_until: null,
              last_error: null
            }
          ],
          current_index: 0,
          cooldown_duration_ms: this.DEFAULT_COOLDOWN_DURATION
        };
        
        this.saveConfig();
        logger.info('Created default proxy configuration');
      }
    } catch (error) {
      logger.error(`Error initializing proxy configuration: ${error.message}`);
      // Create default config as fallback
      this.config = {
        connections: [
          {
            type: 'direct',
            url: null,
            in_cooldown: false,
            cooldown_until: null,
            last_error: null
          }
        ],
        current_index: 0,
        cooldown_duration_ms: this.DEFAULT_COOLDOWN_DURATION
      };
    }
  }

  ensureConfigStructure() {
    // Ensure connections is an array
    if (!Array.isArray(this.config.connections)) {
      this.config.connections = [];
    }

    // Ensure direct connection exists
    const directConnectionExists = this.config.connections.some(
      conn => conn.type === 'direct'
    );
    
    if (!directConnectionExists) {
      this.config.connections.unshift({
        type: 'direct',
        url: null,
        in_cooldown: false,
        cooldown_until: null,
        last_error: null
      });
    }

    // Ensure other required properties
    if (typeof this.config.current_index !== 'number') {
      this.config.current_index = 0;
    }

    if (typeof this.config.cooldown_duration_ms !== 'number') {
      this.config.cooldown_duration_ms = this.DEFAULT_COOLDOWN_DURATION;
    }

    // Clean up any old HTTP proxy configurations (legacy cleanup)
    this.config.connections = this.config.connections.filter(conn => 
      conn.type === 'direct' || conn.type === 'socks5'
    );

    // Remove old format properties if they exist
    if (this.config.proxies) {
      delete this.config.proxies;
    }

    // Save changes
    this.saveConfig();
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      logger.error(`Error saving proxy configuration: ${error.message}`);
    }
  }

  addSocks5Proxy(proxyUrl) {
    // Validate SOCKS5 URL format
    if (!proxyUrl.startsWith('socks5://')) {
      logger.error('Invalid SOCKS5 URL format. Must start with socks5://');
      return false;
    }

    // Check if proxy already exists
    const exists = this.config.connections.some(
      conn => conn.type === 'socks5' && conn.url === proxyUrl
    );
    
    if (!exists) {
      this.config.connections.push({
        type: 'socks5',
        url: proxyUrl,
        in_cooldown: false,
        cooldown_until: null,
        last_error: null
      });
      
      this.saveConfig();
      // Log without showing credentials
      const maskedUrl = proxyUrl.replace(/:([^:@]+)@/, ':***@');
      logger.info(`Added new SOCKS5 proxy: ${maskedUrl}`);
      return true;
    }
    
    return false;
  }

  removeSocks5Proxy(proxyUrl) {
    const initialLength = this.config.connections.length;
    
    // Filter out the specified proxy
    this.config.connections = this.config.connections.filter(
      conn => !(conn.type === 'socks5' && conn.url === proxyUrl)
    );
    
    // Adjust current_index if needed
    if (this.config.connections.length < initialLength) {
      if (this.config.current_index >= this.config.connections.length) {
        this.config.current_index = 0;
      }
      
      this.saveConfig();
      const maskedUrl = proxyUrl.replace(/:([^:@]+)@/, ':***@');
      logger.info(`Removed SOCKS5 proxy: ${maskedUrl}`);
      return true;
    }
    
    return false;
  }

  getCurrentConnection() {
    // Reset expired cooldowns first
    this.checkAndResetCooldowns();
    
    // Check if current connection is in cooldown
    const currentConn = this.config.connections[this.config.current_index];
    
    if (currentConn.in_cooldown) {
      const connDesc = currentConn.type === 'direct' ? 'direct' : 'SOCKS5';
      logger.info(`Current connection ${connDesc} is in cooldown, finding next available`);
      
      // Find next available connection
      return this.getNextAvailableConnection();
    }
    
    // Return the current connection
    const connDesc = currentConn.type === 'direct' ? 'direct' : 'SOCKS5';
    logger.debug(`Current connection: ${connDesc} (index: ${this.config.current_index})`);
    
    return currentConn;
  }

  getNextAvailableConnection() {
    // Reset expired cooldowns first
    this.checkAndResetCooldowns();
    
    const startIndex = this.config.current_index;
    let index = startIndex;
    let attemptCount = 0;
    
    // Try to find an available connection
    while (attemptCount < this.config.connections.length) {
      // Move to next connection
      index = (index + 1) % this.config.connections.length;
      
      // Check if this connection is available
      if (!this.config.connections[index].in_cooldown) {
        // Found an available connection, update current index
        this.config.current_index = index;
        this.saveConfig();
        
        const conn = this.config.connections[index];
        const connDesc = conn.type === 'direct' ? 'direct connection' : 'SOCKS5 proxy';
        logger.info(`Switched to ${connDesc} (index: ${index})`);
        
        return conn;
      }
      
      attemptCount++;
    }
    
    // If we get here, all connections are in cooldown
    // Return the one with the earliest expiry
    let earliestConnection = this.config.connections[0];
    let earliestTime = Number.MAX_SAFE_INTEGER;
    let earliestIndex = 0;
    
    for (let i = 0; i < this.config.connections.length; i++) {
      const conn = this.config.connections[i];
      if (conn.cooldown_until && conn.cooldown_until < earliestTime) {
        earliestTime = conn.cooldown_until;
        earliestConnection = conn;
        earliestIndex = i;
      }
    }
    
    // Update current index to the connection with earliest expiry
    this.config.current_index = earliestIndex;
    this.saveConfig();
    
    const connDesc = earliestConnection.type === 'direct' ? 'direct connection' : 'SOCKS5 proxy';
    logger.warn(`All connections in cooldown, using ${connDesc} with earliest expiry`);
    
    return {
      ...earliestConnection,
      _allInCooldown: true,
      _earliestAvailable: earliestTime
    };
  }

  markCurrentAsCooldown(errorType, endpoint, errorMessage) {
    const current = this.config.connections[this.config.current_index];
    
    // Determine cooldown duration based on error type and endpoint
    let cooldownDuration;
    let description;
    
    if (errorType === '429') {
      if (endpoint === 'friends') {
        cooldownDuration = 5 * 60 * 1000; // 5 minutes
        description = 'Rate limited (429) on friends endpoint';
      } else if (endpoint === 'inventory') {
        cooldownDuration = this.config.cooldown_duration_ms; // 6h5m
        description = 'Rate limited (429) on inventory endpoint';
      }
    } else if (errorType === 'connection_error') {
      cooldownDuration = 10 * 60 * 1000; // 10 minutes
      description = `Connection error on ${endpoint} endpoint`;
    } else if (errorType === 'socks_error') {
      cooldownDuration = 15 * 60 * 1000; // 15 minutes
      description = `SOCKS5 error on ${endpoint} endpoint`;
    } else {
      // Fallback for unknown errors
      cooldownDuration = 10 * 60 * 1000; // 10 minutes
      description = `Unknown error on ${endpoint} endpoint`;
    }
    
    const cooldownUntil = Date.now() + cooldownDuration;
    
    current.in_cooldown = true;
    current.cooldown_until = cooldownUntil;
    current.last_error = `${description}: ${errorMessage}`;
    
    this.saveConfig();
    
    // Log with human-readable time and duration
    const cooldownUntilDate = new Date(cooldownUntil);
    const cooldownMinutes = Math.ceil(cooldownDuration / 60000);
    const connType = current.type === 'direct' ? 'direct connection' : 'SOCKS5 proxy';
    
    logger.warn(`🔒 Marked ${connType} as in cooldown for ${cooldownMinutes} minutes until ${cooldownUntilDate.toLocaleString()}`);
    logger.warn(`    Reason: ${description} - ${errorMessage}`);
    
    // Return next available connection
    return this.getNextAvailableConnection();
  }

  checkAndResetCooldowns() {
    const now = Date.now();
    let changeMade = false;
    
    for (const conn of this.config.connections) {
      if (conn.in_cooldown && conn.cooldown_until && conn.cooldown_until <= now) {
        conn.in_cooldown = false;
        conn.cooldown_until = null;
        const connDesc = conn.type === 'direct' ? 'direct connection' : 'SOCKS5 proxy';
        logger.info(`🔓 Cooldown expired for ${connDesc}`);
        changeMade = true;
      }
    }
    
    if (changeMade) {
      this.saveConfig();
    }
  }

  areAllConnectionsInCooldown() {
    this.checkAndResetCooldowns();
    return this.config.connections.every(conn => conn.in_cooldown);
  }

  getConnectionStatus() {
    this.checkAndResetCooldowns();
    
    const now = Date.now();
    const status = {
      totalConnections: this.config.connections.length,
      availableConnections: 0,
      currentConnection: null,
      allInCooldown: false,
      nextAvailableIn: null,
      connections: []
    };
    
    // Count available connections and find earliest cooldown expiry
    let earliestCooldown = Number.MAX_SAFE_INTEGER;
    let currentConnectionInfo = '';
    
    for (let i = 0; i < this.config.connections.length; i++) {
      const conn = this.config.connections[i];
      
      if (!conn.in_cooldown) {
        status.availableConnections++;
      } else if (conn.cooldown_until && conn.cooldown_until < earliestCooldown) {
        earliestCooldown = conn.cooldown_until;
        status.nextAvailableIn = Math.max(0, earliestCooldown - now);
      }
      
      const connStatus = conn.in_cooldown ? 'cooldown' : 'available';
      const cooldownInfo = conn.in_cooldown ? 
        ` (until ${new Date(conn.cooldown_until).toLocaleTimeString()})` : '';
      
      if (i === this.config.current_index) {
        const connType = conn.type === 'direct' ? 'direct' : 'SOCKS5';
        currentConnectionInfo = `${connType} - ${connStatus}${cooldownInfo}`;
      }
      
      status.connections.push({
        type: conn.type,
        url: conn.url,
        status: connStatus,
        cooldownRemaining: conn.in_cooldown ? Math.max(0, conn.cooldown_until - now) : 0,
        lastError: conn.last_error
      });
    }
    
    status.allInCooldown = status.availableConnections === 0;
    status.currentConnection = this.config.connections[this.config.current_index];
    
    // Add nicer logging
    const availableInfo = status.allInCooldown ? 
      `All connections in cooldown! Next available in ${Math.ceil(status.nextAvailableIn / 60000)} mins` :
      `${status.availableConnections}/${status.totalConnections} connections available`;
    
    logger.debug(`Connection status: ${availableInfo}, Current: ${currentConnectionInfo}`);
    
    return status;
  }

  createAxiosInstance(endpoint) {
    // Only use proxy for friends and inventory endpoints
    const needsProxy = endpoint.includes('GetFriendList') || 
                      endpoint.includes('inventory');
    
    if (!needsProxy) {
      // For other endpoints, always use direct connection
      logger.debug(`Using direct connection for non-rate-limited endpoint`);
      return axios.create({
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
        }
      });
    }
    
    // Get current connection for rate-limited endpoints
    const connection = this.getCurrentConnection();
    
    // If direct connection, return normal axios instance
    if (connection.type === 'direct') {
      logger.info(`Using direct connection for rate-limited endpoint`);
      return axios.create({
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
        }
      });
    }
    
    // SOCKS5 proxy configuration
    if (connection.type === 'socks5') {
      try {
        // Validate SOCKS5 URL format
        if (!connection.url || !connection.url.startsWith('socks5://')) {
          throw new Error('Invalid SOCKS5 URL format');
        }
        
        // Log proxy usage (mask credentials for security)
        const maskedUrl = connection.url.replace(/:([^:@]+)@/, ':***@');
        logger.info(`Using SOCKS5 proxy ${maskedUrl} for rate-limited endpoint`);
        
        // Create SOCKS5 agent using the full URL
        const socksAgent = new SocksProxyAgent(connection.url);
        
        // Determine timeout based on endpoint type
        const isInventoryEndpoint = endpoint.includes('inventory');
        const timeout = isInventoryEndpoint ? 25000 : 15000;
        
        const axiosConfig = {
          httpsAgent: socksAgent,
          httpAgent: socksAgent,
          timeout: timeout,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
          },
          maxRedirects: 10,
          validateStatus: function (status) {
            // Accept success codes and redirect codes
            return (status >= 200 && status < 300) || (status >= 300 && status < 400);
          }
        };
        
        // Add inventory-specific headers
        if (isInventoryEndpoint) {
          axiosConfig.headers['Sec-Fetch-Dest'] = 'empty';
          axiosConfig.headers['Sec-Fetch-Mode'] = 'cors';
          axiosConfig.headers['Sec-Fetch-Site'] = 'same-origin';
        }
        
        return axios.create(axiosConfig);
        
      } catch (error) {
        logger.error(`Error creating SOCKS5 proxy configuration: ${error.message}`);
        
        // Mark this proxy as in cooldown due to configuration error
        this.markCurrentAsCooldown('socks_error', 'configuration', error.message);
        
        // Return a standard axios instance as fallback
        logger.info(`Falling back to direct connection due to SOCKS5 configuration error`);
        return axios.create({
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
          }
        });
      }
    }
    
    // Fallback to direct connection
    logger.warn(`Unknown connection type: ${connection.type}, falling back to direct`);
    return axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
      }
    });
  }

  handleRequestError(error, endpoint) {
    // Check if rate limited
    if (error.response && error.response.status === 429) {
      logger.warn(`Rate limit (429) hit for ${endpoint}`);
      
      // Mark current connection as in cooldown
      this.markCurrentAsCooldown('429', endpoint, error.message);
      
      // Return special value indicating rate limit
      return { rateLimited: true, error };
    }
    
    // Check for SOCKS5-specific errors
    if (error.message && error.message.toLowerCase().includes('socks')) {
      logger.warn(`SOCKS5 error for ${endpoint}: ${error.message}`);
      
      // Mark current connection as in cooldown
      this.markCurrentAsCooldown('socks_error', endpoint, error.message);
      
      return { socksError: true, error };
    }
    
    // Handle other connection errors
    if (this.isConnectionError(error)) {
      logger.warn(`Connection error for ${endpoint}: ${error.message}`);
      
      // Mark current connection as in cooldown
      this.markCurrentAsCooldown('connection_error', endpoint, error.message);
      
      return { connectionError: true, error };
    }
    
    // Handle other errors normally
    return { rateLimited: false, error };
  }

  // Helper method to detect connection errors
  isConnectionError(error) {
    const errorMsg = error.message || '';
    
    // Check for common connection error patterns
    return (
      errorMsg.includes('socket disconnected') ||
      errorMsg.includes('socket hang up') ||
      errorMsg.includes('ECONNRESET') ||
      errorMsg.includes('ECONNREFUSED') ||
      errorMsg.includes('ETIMEDOUT') ||
      errorMsg.includes('EHOSTUNREACH') ||
      errorMsg.includes('timeout') ||
      errorMsg.includes('certificate') ||
      errorMsg.includes('SSL') ||
      errorMsg.includes('TLS')
    );
  }
}

module.exports = ProxyManager;