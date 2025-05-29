// src/index.js
const CONFIG = require('../config/config');
const SteamValidator = require('./steam-validator');
const ApiService = require('./api-service');
const QueueManager = require('./queue-manager');
const ExpressApp = require('./app');
const logger = require('./utils/logger');

// Global state variables
let isProcessing = false;
let expressApp = null;

async function processQueuedProfiles(steamValidator, apiService, queueManager) {
  if (isProcessing) {
    logger.debug('Processing already in progress, skipping');
    return;
  }
  
  isProcessing = true;
  
  try {
    // Check if all connections are in cooldown for rate-limited checks
    const allConnectionsInCooldown = steamValidator.proxyManager.areAllConnectionsInCooldown();
    
    // Only try to process deferred checks if connections are available
    if (!allConnectionsInCooldown) {
      const deferredResult = await steamValidator.processDeferredChecks(queueManager);
      if (deferredResult.processed > 0) {
        logger.info(`Processed ${deferredResult.processed} deferred checks, ${deferredResult.remaining} remaining`);
      }
    }
    
    // Find next processable profile from queue
    const profile = await queueManager.getNextProcessableProfile(allConnectionsInCooldown);
    
    if (!profile) {
      isProcessing = false;
      return;
    }
    
    const steamId = profile.steam_id;
    const username = profile.username;
    logger.info(`Processing queued profile: ${steamId} (user: ${username})`);
    
    // Run checks that are marked "to_check"
    const checksToRun = Object.entries(profile.checks)
      .filter(([_, status]) => status === "to_check")
      .map(([name, _]) => name);
    
    logger.debug(`Profile ${steamId}: Found ${checksToRun.length} checks to run: ${checksToRun.join(', ')}`);
    
    if (checksToRun.length === 0) {
      // No "to_check" checks remaining - see if all are passed
      logger.debug(`Profile ${steamId}: No 'to_check' checks remaining, checking completion status`);
      const completionStatus = await queueManager.getAllChecksComplete(steamId);
      
      if (completionStatus.allComplete) {
        if (completionStatus.allPassed) {
          logger.info(`All checks passed for ${steamId} (user: ${username}), sending to API`);
          
          const apiResult = await apiService.handleNewSteamId(steamId, username);
          
          if (apiResult.success) {
            logger.info(`API submission successful for ${steamId} (user: ${username})`);
            // Remove from queue on success
            await queueManager.removeProfileFromQueue(steamId);
          } else {
            // Check if error is retryable or permanent
            const errorMessage = apiResult.error || '';
            const isRetryableError = 
              errorMessage.includes('Internal server error') ||           // 500 errors
              errorMessage.includes('No response from server') ||        // Network timeouts
              errorMessage.includes('Request setup error') ||            // Connection issues
              errorMessage.includes('Service temporarily unavailable') || // 503 errors
              (apiResult.status >= 500 && apiResult.status < 600);       // Any 5xx error
            
            if (isRetryableError) {
              logger.warn(`API submission failed with retryable error for ${steamId} (user: ${username}): ${apiResult.error}`);
              logger.info(`Profile ${steamId} (user: ${username}) will remain in queue for retry`);
              // Don't remove - will be retried in next processing cycle
            } else {
              // Permanent error or success case
              if (errorMessage.includes('Link already exists')) {
                logger.info(`Steam ID ${steamId} (user: ${username}) already exists on PythonAnywhere - removing from queue`);
              } else {
                logger.error(`API submission failed with permanent error for ${steamId} (user: ${username}): ${apiResult.error}`);
                logger.info(`Removing ${steamId} (user: ${username}) from queue (non-retryable error)`);
              }
              // Remove from queue for permanent errors
              await queueManager.removeProfileFromQueue(steamId);
            }
          }
        } else {
          // Some checks failed validation - remove from queue
          logger.info(`Some checks failed for ${steamId} (user: ${username}), removing from queue`);
          await queueManager.removeProfileFromQueue(steamId);
        }
        
        // Remove from queue regardless of API result
        await queueManager.removeProfileFromQueue(steamId);
      } else {
        // Has deferred checks, will be processed later when connections are available
        logger.info(`Profile ${steamId} (user: ${username}) has deferred checks, will be processed when connections are available`);
      }
      
      isProcessing = false;
      return;
    }
    
    // Flag to track if we've detected a private profile
    let isPrivateProfile = false;
    
    // Run each check in order
    for (let i = 0; i < checksToRun.length; i++) {
      const checkName = checksToRun[i];
      
      // Skip further checks if we've already identified this as a private profile
      // and the current check is either friends or csgo_inventory
      const isRateLimitedCheck = checkName === 'friends' || checkName === 'csgo_inventory';
      if (isPrivateProfile && isRateLimitedCheck) {
        logger.info(`Auto-passing check '${checkName}' for ${steamId} (user: ${username}) (private profile)`);
        await queueManager.updateProfileCheck(steamId, checkName, "passed");
        continue;
      }
      
      // Skip rate-limited checks if all connections are in cooldown
      if (isRateLimitedCheck && allConnectionsInCooldown) {
        logger.info(`⏳ Deferring rate-limited check '${checkName}' for ${steamId} (user: ${username}) - all connections in cooldown`);
        await queueManager.updateProfileCheck(steamId, checkName, "deferred");
        continue; // Skip this check for now, will be retried later
      }
      
      try {
        let checkResult;
        
        // Run the appropriate check
        switch (checkName) {
          case 'animated_avatar':
            checkResult = await steamValidator.checkAnimatedAvatar(steamId);
            break;
          case 'avatar_frame':
            checkResult = await steamValidator.checkAvatarFrame(steamId);
            break;
          case 'mini_profile_background':
            checkResult = await steamValidator.checkMiniProfileBackground(steamId);
            break;
          case 'profile_background':
            checkResult = await steamValidator.checkProfileBackground(steamId);
            break;
          case 'steam_level':
            checkResult = await steamValidator.checkSteamLevel(steamId);
            
            // After steam level check, determine if this is a private profile
            if (checkResult.success && 
                checkResult.details && 
                checkResult.details.note && 
                checkResult.details.note.includes("Empty response from API")) {
              isPrivateProfile = true;
              logger.info(`Private profile detected for ${steamId} (user: ${username}) - will auto-pass remaining private checks`);
            }
            break;
          case 'friends':
            checkResult = await steamValidator.checkFriends(steamId);
            break;
          case 'csgo_inventory':
            checkResult = await steamValidator.checkCsgoInventory(steamId);
            break;
          default:
            logger.error(`Unknown check type: ${checkName}`);
            checkResult = {
              success: false,
              passed: false,
              error: `Unknown check type: ${checkName}`
            };
        }
        
        // Handle check result
        if (!checkResult.success) {
          // Check for deferred status (all connections in cooldown)
          if (checkResult.deferred) {
            logger.warn(`Check '${checkName}' for ${steamId} (user: ${username}) deferred due to all connections in cooldown`);
            await queueManager.updateProfileCheck(steamId, checkName, "deferred");
            const waitTimeMin = Math.ceil((checkResult.nextAvailableIn || 60000) / 60000);
            logger.info(`Will retry when a connection becomes available (est. ${waitTimeMin} minutes)`);
            continue; // Continue to next check, don't exit the loop
          }
          
          // Regular API error - don't mark check as failed, retry later
          logger.warn(`Check '${checkName}' for ${steamId} (user: ${username}) failed with API error: ${checkResult.error}`);
          logger.info(`Will retry ${steamId} (user: ${username}) in next processing cycle`);
          break; // Exit the check loop for this profile, will retry later
        } else if (!checkResult.passed) {
          // Check failed validation - remove from queue
          logger.info(`Check '${checkName}' for ${steamId} (user: ${username}) failed validation, removing from queue`);
          await queueManager.removeProfileFromQueue(steamId);
          break; // Exit the check loop for this profile
        } else {
          // Check passed - update status
          logger.info(`Check '${checkName}' for ${steamId} (user: ${username}) passed`);
          await queueManager.updateProfileCheck(steamId, checkName, "passed");
        }
      } catch (checkError) {
        logger.error(`Error running check '${checkName}' for ${steamId} (user: ${username}): ${checkError.message}`);
        logger.info(`Will retry ${steamId} (user: ${username}) in next processing cycle`);
        break; // Exit the check loop for this profile, will retry later
      }
    }
  } catch (error) {
    logger.error(`Queue processing error: ${error.message}`);
  } finally {
    isProcessing = false;
  }
}

async function main() {
  logger.info('Starting Steam ID Processor Service');
  logger.info('===================================');
  
  // Validate environment variables
  if (!CONFIG.STEAM_API_KEY) {
    logger.error('❌ STEAM_API_KEY not found in environment variables');
    logger.error('Please add STEAM_API_KEY=your_key to your .env file');
    process.exit(1);
  }
  
  if (!CONFIG.LINK_HARVESTER_API_KEY) {
    logger.error('❌ LINK_HARVESTER_API_KEY not found in environment variables');
    logger.error('Please add LINK_HARVESTER_API_KEY=your_key to your .env file');
    process.exit(1);
  }
  
  if (!CONFIG.PYTHONANYWHERE_API_KEY) {
    logger.error('❌ PYTHONANYWHERE_API_KEY not found in environment variables');
    logger.error('Please add PYTHONANYWHERE_API_KEY=your_key to your .env file');
    process.exit(1);
  }
  
  // Initialize components
  const steamValidator = new SteamValidator(CONFIG);
  const apiService = new ApiService(CONFIG);
  const queueManager = new QueueManager(CONFIG);
  
  // Initialize Express app
  expressApp = new ExpressApp(queueManager, steamValidator, apiService);
  
  logger.info('Service initialized and ready for processing');

  // Convert any existing deferred checks from previous runs
  queueManager.convertDeferredChecksToToCheck().then(result => {
    if (result.conversions > 0) {
      logger.info(`Startup: Converted ${result.conversions} deferred checks from previous session`);
    }
  });
  
  // Start the HTTP server
  try {
    await expressApp.start(CONFIG.PORT);
    logger.info(`🌐 HTTP API available at http://localhost:${CONFIG.PORT}`);
    logger.info(`📋 Endpoints:`);
    logger.info(`   POST /api/add-steam-id - Add Steam ID to queue`);
    logger.info(`   GET /api/health - Health check`);
  } catch (error) {
    logger.error(`Failed to start HTTP server: ${error.message}`);
    process.exit(1);
  }
  
  // Start the processing loops
  
  // 1. Process queued profiles (main processing loop)
  const processQueue = async () => {
    try {
      await processQueuedProfiles(steamValidator, apiService, queueManager);
    } catch (error) {
      logger.error(`Queue processing error: ${error.message}`);
    }
    
    // Schedule next run with variable delay
    setTimeout(processQueue, isProcessing ? 1000 : CONFIG.PROCESSING_DELAY);
  };

  // 2. Periodically check and log proxy status
  const checkProxyStatus = async () => {
    try {
      const status = steamValidator.getProxyStatus();
      
      // More detailed connection status logging with cooldown reasons
      const connectionDetails = status.connections.map(conn => {
        const connType = conn.type === 'direct' ? 'Direct' : `SOCKS5 ${conn.url?.split('@')[1] || 'proxy'}`;
        
        if (conn.status === 'cooldown') {
          const remainingMin = Math.ceil(conn.cooldownRemaining / 60000);
          const reason = conn.lastError ? ` (${conn.lastError.split(':')[0]})` : '';
          return `${connType}: Cooldown ${remainingMin}m${reason}`;
        } else {
          return `${connType}: Available`;
        }
      }).join(', ');
      
      // Get deferred check statistics
      const deferredStats = await queueManager.getDeferredCheckStats();
      
      // Get queue statistics
      const queueStats = await queueManager.getQueueStats();
      
      // Log current status
      logger.info(`🔌 Connection status: ${status.availableConnections}/${status.totalConnections} available - ${connectionDetails}`);
      logger.info(`📋 Queue status: ${queueStats.totalProfiles} profiles total`);
      
      if (queueStats.totalProfiles > 0) {
        const userSummary = Object.entries(queueStats.byUsername)
          .map(([user, count]) => `${user}:${count}`)
          .join(', ');
        logger.info(`    By user: ${userSummary}`);
      }
      
      if (deferredStats.totalDeferred > 0) {
        logger.info(`📋 Deferred checks: ${deferredStats.totalDeferred} checks across ${deferredStats.profilesWithDeferred} profiles`);
      }
      
      if (status.allInCooldown) {
        const timeRemaining = Math.ceil(status.nextAvailableIn / 60000);
        logger.warn(`⚠️ All connections in cooldown! Next available in ~${timeRemaining} minutes`);
      }
      
      // Convert deferred checks back to "to_check" if connections are available
      if (status.availableConnections > 0 && deferredStats.totalDeferred > 0) {
        logger.info(`🔄 Converting deferred checks back to 'to_check' (connections available)...`);
        const conversionResult = await queueManager.convertDeferredChecksToToCheck();
        if (conversionResult.conversions > 0) {
          logger.info(`✅ Converted ${conversionResult.conversions} deferred checks across ${conversionResult.profilesAffected} profiles`);
        }
      }
      
      // Process any deferred checks if connections are available
      if (status.availableConnections > 0) {
        const deferredChecks = Array.from(steamValidator.getDeferredChecks().entries());
        
        if (deferredChecks.length > 0) {
          logger.info(`🔄 Processing ${deferredChecks.length} deferred checks...`);
          const deferredResult = await steamValidator.processDeferredChecks(queueManager);
          if (deferredResult.processed > 0) {
            logger.info(`✅ Processed ${deferredResult.processed} deferred checks, ${deferredResult.remaining} remaining`);
          } else {
            logger.debug(`No deferred checks were processed`);
          }
        }
      }
    } catch (error) {
      logger.error(`Proxy status check error: ${error.message}`);
    }
    
    // Schedule next check (every minute)
    setTimeout(checkProxyStatus, 60 * 1000);
  };

  // 3. Periodically test proxy connection
  const testProxyConnection = async () => {
    try {
      // Only test if we have at least one proxy configured
      const status = steamValidator.getProxyStatus();
      const hasProxies = status.connections.some(conn => conn.type === 'socks5');
      
      if (hasProxies) {
        logger.info('Running periodic proxy connection test...');
        await steamValidator.testProxyConnection();
      }
    } catch (error) {
      logger.error(`Proxy test error: ${error.message}`);
    }
    
    // Schedule next test (every 15 minutes)
    setTimeout(testProxyConnection, 15 * 60 * 1000);
  };
  
  // Start all processes
  processQueue();
  checkProxyStatus();
  testProxyConnection();
  
  logger.info('All processing loops started');
  logger.info(`Waiting for Steam IDs to be submitted via HTTP API on port ${CONFIG.PORT}...`);
}

// Handle graceful shutdown
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);
  
  // Stop HTTP server
  if (expressApp) {
    await expressApp.stop();
  }
  
  // Allow some time for cleanup
  setTimeout(() => {
    logger.info('Shutdown complete');
    process.exit(0);
  }, 1000);
}

// Start the service
main().catch(error => {
  logger.error(`Service initialization failed: ${error.message}`);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));