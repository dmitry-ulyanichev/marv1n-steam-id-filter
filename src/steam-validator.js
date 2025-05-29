// src/steam-validator.js
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');
const ProxyManager = require('./proxy-manager');
const { SocksProxyAgent } = require('socks-proxy-agent');

// Load environment variables
require('dotenv').config();

class SteamValidator {
  constructor(config) {
    this.config = config;
    this.apiKey = null;
    this.lastApiCallTime = 0;
    this.minApiCallInterval = 1000; // 1 second between calls
    this.loadApiKey();
    
    // Initialize the proxy manager - use project root directory
    const projectRoot = path.join(__dirname, '..');
    this.proxyManager = new ProxyManager(projectRoot);
    
    // Add a property to track deferred checks
    this.deferredChecks = new Map();
  }

  loadApiKey() {
    // Load Steam API key from environment variables
    this.apiKey = process.env.STEAM_API_KEY;
    
    if (!this.apiKey) {
      logger.warn('Steam API key not found in environment variables (STEAM_API_KEY)');
      logger.warn('Some Steam API calls (level, friends) will fail without this key');
    } else {
      logger.info('Steam API key loaded successfully from environment');
    }
  }

  async respectRateLimit() {
    const currentTime = Date.now();
    const timeSinceLast = currentTime - this.lastApiCallTime;
    
    if (timeSinceLast < this.minApiCallInterval) {
      const waitTime = this.minApiCallInterval - timeSinceLast;
      logger.debug(`Rate limiting: Waiting ${waitTime}ms before next API call`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastApiCallTime = Date.now();
  }
  
  async makeApiRequest(url, needsProxy = false) {
    await this.respectRateLimit();
    
    // TEMPORARY: For testing cooldown logic - remove after testing
    const SIMULATE_ERRORS = false;
    const SIMULATE_ERROR_TYPE = '429'; // '429', 'connection_error', or 'socks_error'
    
    try {
      let axiosInstance;
      
      // Determine endpoint type for error handling
      const endpoint = url.includes('GetFriendList') ? 'friends' : 
                      url.includes('inventory') ? 'inventory' : 
                      'other';
      
      const endpointName = url.includes('GetFriendList') ? 'friends' : 
                          url.includes('inventory') ? 'inventory' : 
                          url.split('?')[0].split('/').pop();
      
      if (needsProxy) {
        // Log which endpoint is using proxies
        logger.info(`🌐 Making request to rate-limited endpoint: ${endpointName}`);
        
        // Check if all connections are in cooldown
        if (this.proxyManager.areAllConnectionsInCooldown()) {
          const status = this.proxyManager.getConnectionStatus();
          const waitTimeMs = status.nextAvailableIn || 60000;
          const waitTimeMin = Math.ceil(waitTimeMs / 60000);
          
          logger.warn(`⏳ All connections in cooldown for ${endpointName}. Next available in ~${waitTimeMin} minutes.`);
          return {
            allInCooldown: true,
            nextAvailableIn: waitTimeMs
          };
        }
        
        // Get axios instance with current connection (SOCKS5 or direct)
        axiosInstance = this.proxyManager.createAxiosInstance(url);
      } else {
        // For non-proxy endpoints, use default axios
        logger.debug(`Making request to non-rate-limited endpoint: ${endpointName}`);
        axiosInstance = axios.create({
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
          }
        });
      }
      
      const response = await axiosInstance.get(url);
      
      // TEMPORARY: Simulate errors for testing - remove after testing
      if (SIMULATE_ERRORS && needsProxy) {
        const endpoint = url.includes('GetFriendList') ? 'friends' : 'inventory';
        logger.warn(`🧪 TESTING: Simulating ${SIMULATE_ERROR_TYPE} error for ${endpoint} endpoint`);
        
        if (SIMULATE_ERROR_TYPE === '429') {
          const error = new Error('Request failed with status code 429');
          error.response = { status: 429 };
          throw error;
        } else if (SIMULATE_ERROR_TYPE === 'connection_error') {
          const error = new Error('socket hang up');
          error.code = 'ECONNRESET';
          throw error;
        } else if (SIMULATE_ERROR_TYPE === 'socks_error') {
          const error = new Error('SOCKS connection failed');
          throw error;
        }
      }
      
      logger.debug(`✅ ${endpointName} request successful`);
      return { success: true, data: response.data };
      
    } catch (error) {
      const errorStatus = error.response ? error.response.status : 'no status';
      const errorMessage = error.message || 'Unknown error';
      
      // Determine endpoint type for error handling
      const endpoint = url.includes('GetFriendList') ? 'friends' : 
                      url.includes('inventory') ? 'inventory' : 
                      'other';
      
      // Handle rate limiting (429)
      if (error.response && error.response.status === 429) {
        logger.warn(`⚠️ Rate limited (429) received for ${endpoint} endpoint`);
        
        if (needsProxy) {
          // Mark current connection as in cooldown with 429 error type
          this.proxyManager.markCurrentAsCooldown('429', endpoint, errorMessage);
          return this.retryWithNextConnection(url, needsProxy, endpoint);
        }
      }
      // Handle SOCKS5 errors
      else if (needsProxy && this.isSocksError(error)) {
        logger.warn(`⚠️ SOCKS5 error on ${endpoint} endpoint: ${errorMessage}`);
        
        // Mark current connection as in cooldown with SOCKS error type
        this.proxyManager.markCurrentAsCooldown('socks_error', endpoint, errorMessage);
        return this.retryWithNextConnection(url, needsProxy, endpoint);
      }
      // Handle connection errors
      else if (needsProxy && this.isConnectionError(error)) {
        logger.warn(`⚠️ Connection error on ${endpoint} endpoint: ${errorMessage}`);
        
        // Mark current connection as in cooldown with connection error type
        this.proxyManager.markCurrentAsCooldown('connection_error', endpoint, errorMessage);
        return this.retryWithNextConnection(url, needsProxy, endpoint);
      }
      
      // Handle other errors
      logger.error(`❌ Request error (${errorStatus}) on ${endpoint}: ${errorMessage}`);
      return { success: false, error: errorMessage, errorObj: error };
    }
  }

  // Helper method to detect SOCKS5 errors
  isSocksError(error) {
    const errorMsg = error.message || '';
    
    // Check for SOCKS5-specific error patterns
    return (
      errorMsg.toLowerCase().includes('socks') ||
      errorMsg.includes('SOCKS connection') ||
      errorMsg.includes('proxy connection') ||
      (error.code && (
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'EHOSTUNREACH'
      ))
    );
  }

  // Helper method to detect connection errors
  isConnectionError(error) {
    const errorMsg = error.message || '';
    
    // Check for common connection error patterns
    return (
      errorMsg.includes('socket disconnected') ||
      errorMsg.includes('socket hang up') ||
      errorMsg.includes('ECONNRESET') ||
      errorMsg.includes('ETIMEDOUT') ||
      errorMsg.includes('timeout') ||
      errorMsg.includes('certificate') ||
      errorMsg.includes('SSL') ||
      errorMsg.includes('TLS')
    );
  }

  async retryWithNextConnection(url, needsProxy, endpoint) {
    // Check if we have another connection available, retry immediately
    const status = this.proxyManager.getConnectionStatus();
    if (status.availableConnections > 0) {
      const nextConn = this.proxyManager.getNextAvailableConnection();
      if (!nextConn._allInCooldown) {
        const nextType = nextConn.type === 'direct' ? 'direct connection' : 'SOCKS5 proxy';
        
        logger.info(`🔄 Switching to ${nextType} and retrying...`);
        return this.makeApiRequest(url, needsProxy);
      }
    }
    
    // All connections in cooldown
    logger.warn(`❌ All connections in cooldown for ${endpoint}, deferring request`);
    return {
      allInCooldown: true,
      nextAvailableIn: status.nextAvailableIn
    };
  }

  async checkAnimatedAvatar(steamId) {
    try {
      const url = `https://api.steampowered.com/IPlayerService/GetAnimatedAvatar/v1/?steamid=${steamId}`;
      const result = await this.makeApiRequest(url, false); // No proxy needed
      
      if (!result.success) {
        logger.error(`Animated avatar check failed for ${steamId}: ${result.error}`);
        return { success: false, error: result.error };
      }
      
      const data = result.data;
      
      if (data.response && 'avatar' in data.response) {
        // Check if avatar is empty object or empty array
        const hasAnimatedAvatar = data.response.avatar && 
                                Object.keys(data.response.avatar).length > 0;
        return {
          success: true,
          passed: !hasAnimatedAvatar,
          details: hasAnimatedAvatar ? data.response : {}
        };
      }
      
      return { success: false, error: "Unexpected API response" };
    } catch (error) {
      logger.error(`Animated avatar check failed for ${steamId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async checkAvatarFrame(steamId) {
    try {
      const url = `https://api.steampowered.com/IPlayerService/GetAvatarFrame/v1/?steamid=${steamId}`;
      const result = await this.makeApiRequest(url, false); // No proxy needed
      
      if (!result.success) {
        logger.error(`Avatar frame check failed for ${steamId}: ${result.error}`);
        return { success: false, error: result.error };
      }
      
      const data = result.data;
      
      if (data.response && 'avatar_frame' in data.response) {
        // Check if avatar_frame is empty object
        const hasFrame = data.response.avatar_frame && 
                        Object.keys(data.response.avatar_frame).length > 0;
        return {
          success: true,
          passed: !hasFrame,
          details: hasFrame ? data.response : {}
        };
      }
      
      return { success: false, error: "Unexpected API response" };
    } catch (error) {
      logger.error(`Avatar frame check failed for ${steamId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async checkMiniProfileBackground(steamId) {
    try {
      const url = `https://api.steampowered.com/IPlayerService/GetMiniProfileBackground/v1/?steamid=${steamId}`;
      const result = await this.makeApiRequest(url, false); // No proxy needed
      
      if (!result.success) {
        logger.error(`Mini profile background check failed for ${steamId}: ${result.error}`);
        return { success: false, error: result.error };
      }
      
      const data = result.data;
      
      if (data.response && 'profile_background' in data.response) {
        // Check if profile_background is empty object
        const hasBackground = data.response.profile_background && 
                            Object.keys(data.response.profile_background).length > 0;
        return {
          success: true,
          passed: !hasBackground,
          details: hasBackground ? data.response : {}
        };
      }
      
      return { success: false, error: "Unexpected API response" };
    } catch (error) {
      logger.error(`Mini profile background check failed for ${steamId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async checkProfileBackground(steamId) {
    try {
      const url = `https://api.steampowered.com/IPlayerService/GetProfileBackground/v1/?steamid=${steamId}`;
      const result = await this.makeApiRequest(url, false); // No proxy needed
      
      if (!result.success) {
        logger.error(`Profile background check failed for ${steamId}: ${result.error}`);
        return { success: false, error: result.error };
      }
      
      const data = result.data;
      
      if (data.response && 'profile_background' in data.response) {
        // Check if profile_background is empty object
        const hasBackground = data.response.profile_background && 
                            Object.keys(data.response.profile_background).length > 0;
        return {
          success: true,
          passed: !hasBackground,
          details: hasBackground ? data.response : {}
        };
      }
      
      return { success: false, error: "Unexpected API response" };
    } catch (error) {
      logger.error(`Profile background check failed for ${steamId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async checkSteamLevel(steamId) {
    try {
      if (!this.apiKey) {
        return { 
          success: false, 
          error: "Steam API key not available (check STEAM_API_KEY environment variable)" 
        };
      }
      
      const url = `https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/?key=${this.apiKey}&steamid=${steamId}`;
      const result = await this.makeApiRequest(url, false); // No proxy needed
      
      if (!result.success) {
        logger.error(`Steam level check failed for ${steamId}: ${result.error}`);
        return { success: false, error: result.error };
      }
      
      const data = result.data;
      
      if (data.response) {
        // If response is empty, this is a private profile
        if (Object.keys(data.response).length === 0) {
          logger.info(`Private profile detected for ${steamId} (empty GetSteamLevel response)`);
          return {
            success: true,
            passed: true,
            details: { note: "Empty response from API - private profile detected" },
            level: 0,
            isPrivateProfile: true
          };
        }
        
        // Regular case - response contains player_level
        if ('player_level' in data.response) {
          const playerLevel = data.response.player_level;
          return {
            success: true,
            passed: playerLevel <= 13,
            details: { player_level: playerLevel },
            level: playerLevel,
            isPrivateProfile: false
          };
        }
      }
      
      logger.error(`Unexpected API response format for Steam level check: ${JSON.stringify(data)}`);
      return { success: false, error: "Unexpected API response" };
    } catch (error) {
      logger.error(`Steam level check failed for ${steamId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async checkFriends(steamId) {
    try {
      if (!this.apiKey) {
        return { 
          success: false, 
          error: "Steam API key not available (check STEAM_API_KEY environment variable)" 
        };
      }
      
      const url = `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${this.apiKey}&steamid=${steamId}&relationship=friend`;
      const result = await this.makeApiRequest(url, true); // Use proxy if needed
      
      // Check if all connections are in cooldown
      if (result.allInCooldown) {
        logger.warn(`Friends check for ${steamId} deferred - all connections in cooldown`);
        this.addToDeferredChecks(steamId, 'friends');
        return { 
          success: false, 
          deferred: true,
          error: "All connections in cooldown", 
          nextAvailableIn: result.nextAvailableIn 
        };
      }
      
      if (!result.success) {
        // Special case for private profiles (401 error)
        if (result.errorObj && result.errorObj.response && result.errorObj.response.status === 401) {
          return {
            success: true,
            passed: true,
            details: { error: "Private profile - cannot check friends" },
            count: 0
          };
        }
        
        logger.error(`Friends check failed for ${steamId}: ${result.error}`);
        return { success: false, error: result.error };
      }
      
      const data = result.data;
      
      if (data.friendslist && data.friendslist.friends) {
        const friendsCount = data.friendslist.friends.length;
        return {
          success: true,
          passed: friendsCount <= 60,
          details: {
            friends_count: friendsCount,
            sample_friends: data.friendslist.friends.slice(0, 3)
          },
          count: friendsCount
        };
      }
      
      logger.error(`Unexpected API response format for friends check: ${JSON.stringify(data)}`);
      return { success: false, error: "Unexpected API response" };
    } catch (error) {
      // Special case for private profiles (401 error)
      if (error.response && error.response.status === 401) {
        return {
          success: true,
          passed: true,
          details: { error: "Private profile - cannot check friends" },
          count: 0
        };
      }
      
      logger.error(`Friends check failed for ${steamId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async checkCsgoInventory(steamId) {
    try {
      const url = `https://steamcommunity.com/inventory/${steamId}/730/2`;
      const result = await this.makeApiRequest(url, true); // Use proxy if needed
      
      // Check if all connections are in cooldown
      if (result.allInCooldown) {
        logger.warn(`CS:GO inventory check for ${steamId} deferred - all connections in cooldown`);
        this.addToDeferredChecks(steamId, 'csgo_inventory');
        return { 
          success: false, 
          deferred: true,
          error: "All connections in cooldown", 
          nextAvailableIn: result.nextAvailableIn 
        };
      }
      
      if (!result.success) {
        // Special case for private inventories
        if (result.errorObj && result.errorObj.response && 
            (result.errorObj.response.status === 401 || result.errorObj.response.status === 403)) {
          const errorType = result.errorObj.response.status === 401 ? "Unauthorized" : "Private inventory";
          logger.info(`CS:GO inventory check for ${steamId}: ${errorType} - automatically passing`);
          return {
            success: true,
            passed: true,
            details: { error: `${errorType} - cannot check` }
          };
        }
        
        logger.error(`CS:GO inventory check failed for ${steamId}: ${result.error}`);
        return { success: false, error: result.error };
      }
      
      const data = result.data;
      
      // Process results - pass if response is null or empty
      if (data === null || Object.keys(data).length === 0) {
        logger.info(`CS:GO inventory check passed for ${steamId} (empty)`);
        return {
          success: true,
          passed: true,
          details: {}
        };
      }
      
      // Check if inventory is actually empty
      if (typeof data === 'object' && 
          (!data.assets || data.assets.length === 0) && 
          (!data.descriptions || data.descriptions.length === 0)) {
        logger.info(`CS:GO inventory check passed for ${steamId} (empty structure)`);
        return {
          success: true,
          passed: true,
          details: {}
        };
      }
      
      // Inventory exists
      const itemCount = data.assets ? data.assets.length : 0;
      logger.info(`CS:GO inventory check failed for ${steamId} (found ${itemCount} items)`);
      return {
        success: true,
        passed: false,
        details: {
          item_count: itemCount,
          sample_items: data.assets ? data.assets.slice(0, 3) : []
        }
      };
    } catch (error) {
      // Special case for private inventories
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        const errorType = error.response.status === 401 ? "Unauthorized" : "Private inventory";
        logger.info(`CS:GO inventory check for ${steamId}: ${errorType} - automatically passing`);
        return {
          success: true,
          passed: true,
          details: { error: `${errorType} - cannot check` }
        };
      }
      
      logger.error(`CS:GO inventory check failed for ${steamId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // Helper method to add checks to deferred list
  addToDeferredChecks(steamId, checkType) {
    if (!this.deferredChecks.has(steamId)) {
      this.deferredChecks.set(steamId, new Set());
    }
    
    this.deferredChecks.get(steamId).add(checkType);
    
    // Log the number of deferred checks
    const totalDeferred = Array.from(this.deferredChecks.keys()).length;
    logger.info(`Added ${steamId} ${checkType} check to deferred list (total deferred profiles: ${totalDeferred})`);
  }

  // Get all deferred checks
  getDeferredChecks() {
    return this.deferredChecks;
  }

  // Clear a specific deferred check
  clearDeferredCheck(steamId, checkType) {
    if (this.deferredChecks.has(steamId)) {
      const checks = this.deferredChecks.get(steamId);
      checks.delete(checkType);
      
      if (checks.size === 0) {
        this.deferredChecks.delete(steamId);
      }
      
      logger.debug(`Cleared deferred check ${checkType} for ${steamId}`);
    }
  }

  // Method to process deferred checks when connections become available
  async processDeferredChecks(queueManager) {
    const status = this.proxyManager.getConnectionStatus();
    
    if (status.availableConnections === 0) {
      logger.info(`Cannot process deferred checks - all connections still in cooldown`);
      return {
        processed: 0,
        remaining: this.deferredChecks.size
      };
    }
    
    let processed = 0;
    
    // Get a snapshot of current deferred checks (to avoid concurrent modification issues)
    const deferredEntries = Array.from(this.deferredChecks.entries());
    
    for (const [steamId, checkTypes] of deferredEntries) {
      for (const checkType of checkTypes) {
        let result;
        
        // Run the appropriate check
        if (checkType === 'friends') {
          result = await this.checkFriends(steamId);
        } else if (checkType === 'csgo_inventory') {
          result = await this.checkCsgoInventory(steamId);
        }
        
        // If check was successful, update queue and remove from deferred
        if (result.success) {
          await queueManager.updateProfileCheck(steamId, checkType, result.passed ? "passed" : "failed");
          this.clearDeferredCheck(steamId, checkType);
          processed++;
        } else if (result.deferred) {
          // Still in cooldown, keep in deferred list
          logger.debug(`Deferred check ${checkType} for ${steamId} still in cooldown`);
        } else {
          // Other error occurred, log it but remove from deferred list
          logger.error(`Error processing deferred check ${checkType} for ${steamId}: ${result.error}`);
          this.clearDeferredCheck(steamId, checkType);
        }
        
        // If we've hit the cooldown again, stop processing for now
        if (result.deferred) {
          return {
            processed,
            remaining: this.deferredChecks.size,
            nextTryIn: result.nextAvailableIn
          };
        }
      }
    }
    
    return {
      processed,
      remaining: this.deferredChecks.size
    };
  }

  // Helper method to calculate final results
  calculateResults(steamId, checks) {
    // Calculate final results
    const checkResults = Object.values(checks);
    const allSuccessful = checkResults.every(result => result.success);
    const allPassed = checkResults.every(result => result.success && result.passed);
    
    // Create detailed log of check results
    const checkSummary = Object.entries(checks).map(([name, result]) => {
      return `${name}: ${result.success ? (result.passed ? 'PASS' : 'FAIL') : 'ERROR'}`;
    }).join(', ');
    
    logger.info(`Validation summary for ${steamId}: ${checkSummary}`);
    
    // Collect failed checks for detailed reporting
    const failedChecks = Object.entries(checks)
      .filter(([_, result]) => !result.success || !result.passed)
      .map(([name, result]) => ({
        name,
        success: result.success,
        passed: result.passed,
        error: result.error || null
      }));
    
    return {
      steamId,
      allSuccessful,
      allPassed,
      checks,
      failedChecks,
      checkSummary,
      firstFailedCheck: failedChecks.length > 0 ? failedChecks[0].name : null
    };
  }

  // Get the proxy manager status
  getProxyStatus() {
    return this.proxyManager.getConnectionStatus();
  }
  
  async testProxyConnection() {
    try {
      logger.info('Testing SOCKS5 proxy connection...');
      
      // Test with a real inventory endpoint to match actual usage
      // Using a known public Steam ID for testing
      const testSteamId = '76561197960434622'; // Valve's official test account
      const testUrl = `https://steamcommunity.com/inventory/${testSteamId}/730/2`;
      
      // Get current connection
      const connection = this.proxyManager.getCurrentConnection();
      
      let axiosInstance;
      if (connection.type === 'direct') {
        axiosInstance = axios.create({ timeout: 10000 });
      } else if (connection.type === 'socks5') {
        const socksAgent = new SocksProxyAgent(connection.url);
        axiosInstance = axios.create({
          httpsAgent: socksAgent,
          httpAgent: socksAgent,
          timeout: 10000
        });
      } else {
        return false;
      }
      
      const result = await axiosInstance.get(testUrl);
      
      if (result.status === 200) {
        logger.info('✅ Friends endpoint test successful!');
        return true;
      } else {
        logger.warn(`⚠️ Friends endpoint test failed with status: ${result.status}`);
        return false;
      }
      
    } catch (error) {
      // Handle 401 errors as success (means API is working, just private profile)
      if (error.response && error.response.status === 401) {
        logger.info('✅ Friends endpoint test successful (401 expected for test account)!');
        return true;
      }
      
      logger.error(`❌ Friends endpoint test failed: ${error.message}`);
      return false;
    }
  }


  // Test method for friends endpoint (fallback test)
  async testProxyConnectionFallback() {
    try {
      logger.info('Testing SOCKS5 proxy connection with friends endpoint...');
      
      if (!this.apiKey) {
        logger.warn('Cannot test friends endpoint - no API key available');
        return false;
      }
      
      // Test with friends API (requires API key but is simpler)
      const testSteamId = '76561197960434622'; // Valve's official test account
      const testUrl = `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${this.apiKey}&steamid=${testSteamId}&relationship=friend`;
      
      // Get current connection
      const connection = this.proxyManager.getCurrentConnection();
      
      let axiosInstance;
      if (connection.type === 'direct') {
        axiosInstance = axios.create({ timeout: 10000 });
      } else if (connection.type === 'socks5') {
        const socksAgent = new SocksProxyAgent(connection.url);
        axiosInstance = axios.create({
          httpsAgent: socksAgent,
          httpAgent: socksAgent,
          timeout: 10000
        });
      } else {
        return false;
      }
      
      const result = await axiosInstance.get(testUrl);
      
      if (result.status === 200) {
        logger.info('✅ Friends endpoint test successful!');
        return true;
      } else {
        logger.warn(`⚠️ Friends endpoint test failed with status: ${result.status}`);
        return false;
      }
      
    } catch (error) {
      // Handle 401 errors as success (means API is working, just private profile)
      if (error.response && error.response.status === 401) {
        logger.info('✅ Friends endpoint test successful (401 expected for test account)!');
        return true;
      }
      
      logger.error(`❌ Friends endpoint test failed: ${error.message}`);
      return false;
    }
  }
}

module.exports = SteamValidator;