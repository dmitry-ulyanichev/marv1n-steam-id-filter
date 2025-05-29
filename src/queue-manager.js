// src/queue-manager.js
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');

class QueueManager {
  constructor(config) {
    this.config = config;
    // Queue file is now in project root
    this.queuePath = path.join(__dirname, '../profiles_queue.json');
    
    // Ensure queue file exists
    this.ensureQueueFileExists();
  }

  ensureQueueFileExists() {
    // Create queue file if it doesn't exist
    if (!fs.existsSync(this.queuePath)) {
      fs.writeFileSync(this.queuePath, '[]', 'utf8');
      logger.info(`Created empty queue file at: ${this.queuePath}`);
    }
  }

  async withFileOperation(operation, { maxRetries = 3 } = {}) {
    let attempts = 0;

    while (attempts <= maxRetries) {
      attempts++;
      try {
        return await operation();
      } catch (error) {
        if (attempts > maxRetries) {
          logger.error(`File operation failed after ${maxRetries} attempts`);
          throw error;
        }

        const waitTime = Math.min(500 * attempts, 2000); // Max 2 second wait
        logger.debug(`File operation failed (${error.message}). Retrying in ${waitTime}ms...`);
        await this.delay(waitTime);
      }
    }
  }

  async getQueuedProfiles() {
    return this.withFileOperation(async () => {
      try {
        const data = await fs.readFile(this.queuePath, 'utf8');
        return JSON.parse(data);
      } catch (error) {
        logger.error(`Error reading queue file: ${error.message}`);
        return [];
      }
    });
  }

  async saveQueuedProfiles(profiles) {
    return this.withFileOperation(async () => {
      try {
        await fs.writeFile(this.queuePath, JSON.stringify(profiles, null, 2));
        return true;
      } catch (error) {
        logger.error(`Error saving queue file: ${error.message}`);
        return false;
      }
    });
  }

  async addProfileToQueue(steamId, username, apiService = null) {
    return this.withFileOperation(async () => {
      try {
        const profiles = JSON.parse(await fs.readFile(this.queuePath, 'utf8'));
        
        // Check if already in queue
        const existing = profiles.find(p => p.steam_id === steamId);
        if (existing) {
          logger.info(`Profile ${steamId} (user: ${username}) already in queue`);
          return existing;
        }
        
        // Check if ID already exists in database (if apiService provided)
        if (apiService) {
          const existsCheckResult = await apiService.checkSteamIdExists(steamId);
          
          if (existsCheckResult.success && existsCheckResult.exists) {
            logger.info(`Steam ID ${steamId} (user: ${username}) already exists in database, not adding to queue`);
            return null; // Don't add to queue
          }
          
          if (!existsCheckResult.success) {
            logger.warn(`Failed to check if ID ${steamId} (user: ${username}) exists: ${existsCheckResult.error}. Adding to queue anyway.`);
          }
        }
        
        // Validate username
        if (!username || typeof username !== 'string') {
          logger.error(`Invalid username '${username}' for Steam ID ${steamId}. Username must be a non-empty string.`);
          return null;
        }
        
        // Create new profile object with username
        const profile = {
          steam_id: steamId,
          username: username,
          timestamp: Date.now(),
          checks: {
            animated_avatar: "to_check",
            avatar_frame: "to_check",
            mini_profile_background: "to_check",
            profile_background: "to_check",
            steam_level: "to_check",
            friends: "to_check",
            csgo_inventory: "to_check"
          }
        };
        
        // Add to queue
        profiles.push(profile);
        await fs.writeFile(this.queuePath, JSON.stringify(profiles, null, 2));
        logger.info(`Added profile ${steamId} (user: ${username}) to queue`);
        
        return profile;
      } catch (error) {
        logger.error(`Error adding profile to queue: ${error.message}`);
        throw error;
      }
    });
  }

  async updateProfileCheck(steamId, checkName, status) {
    return this.withFileOperation(async () => {
      try {
        const profiles = JSON.parse(await fs.readFile(this.queuePath, 'utf8'));
        
        // Find the profile
        const profileIndex = profiles.findIndex(p => p.steam_id === steamId);
        if (profileIndex === -1) {
          logger.warn(`Profile ${steamId} not found in queue`);
          return false;
        }
        
        // Validate status
        const validStatuses = ["to_check", "passed", "failed", "deferred"];
        if (!validStatuses.includes(status)) {
          logger.error(`Invalid status '${status}' for check update. Valid statuses: ${validStatuses.join(', ')}`);
          return false;
        }
        
        // Update the check status
        profiles[profileIndex].checks[checkName] = status;
        await fs.writeFile(this.queuePath, JSON.stringify(profiles, null, 2));
        
        const username = profiles[profileIndex].username || 'unknown';
        logger.debug(`Updated ${steamId} (user: ${username}) check '${checkName}' to '${status}'`);
        return true;
      } catch (error) {
        logger.error(`Error updating profile check: ${error.message}`);
        return false;
      }
    });
  }

  async removeProfileFromQueue(steamId) {
    return this.withFileOperation(async () => {
      try {
        const profiles = JSON.parse(await fs.readFile(this.queuePath, 'utf8'));
        
        // Find the profile to get username for logging
        const profileToRemove = profiles.find(p => p.steam_id === steamId);
        const username = profileToRemove?.username || 'unknown';
        
        // Find and remove the profile
        const filteredProfiles = profiles.filter(p => p.steam_id !== steamId);
        
        if (filteredProfiles.length < profiles.length) {
          await fs.writeFile(this.queuePath, JSON.stringify(filteredProfiles, null, 2));
          logger.info(`Removed profile ${steamId} (user: ${username}) from queue`);
          return true;
        } else {
          logger.warn(`Profile ${steamId} not found in queue to remove`);
          return false;
        }
      } catch (error) {
        logger.error(`Error removing profile from queue: ${error.message}`);
        return false;
      }
    });
  }

  async processNextQueued() {
    const profiles = await this.getQueuedProfiles();
    
    if (profiles.length === 0) {
      return null;
    }
    
    return profiles[0];
  }

  // Get next profile that has checks that can be processed
  async getNextProcessableProfile(allConnectionsInCooldown = false) {
    const profiles = await this.getQueuedProfiles();
    
    if (profiles.length === 0) {
      return null;
    }
    
    // Always check the first profile first
    const firstProfile = profiles[0];
    const firstProfileHasToCheck = Object.values(firstProfile.checks).some(status => status === "to_check");
    const firstProfileHasDeferred = Object.values(firstProfile.checks).some(status => status === "deferred");
    
    // If first profile has no "to_check" checks, determine if it's complete or waiting
    if (!firstProfileHasToCheck) {
      if (!firstProfileHasDeferred) {
        // Actually complete (all passed/failed) - return it for final processing
        return firstProfile;
      } else {
        // Has deferred checks - only return if connections are available
        if (!allConnectionsInCooldown) {
          return firstProfile; // Connections available, can process deferred checks
        }
        // Otherwise, skip to next profile since this one is waiting for connections
      }
    } else {
      // Has "to_check" checks - process normally based on connection availability
      if (!allConnectionsInCooldown) {
        return firstProfile; // Connections available, can process any checks
      }
      // Continue to check if it has non-rate-limited checks below
    }
    
    // If all connections are in cooldown, find profile with non-rate-limited "to_check" checks
    if (allConnectionsInCooldown) {
      for (const profile of profiles) {
        const nonRateLimitedChecks = ['animated_avatar', 'avatar_frame', 'mini_profile_background', 'profile_background', 'steam_level'];
        
        const hasNonRateLimitedToCheck = nonRateLimitedChecks.some(checkName => 
          profile.checks[checkName] === "to_check"
        );
        
        if (hasNonRateLimitedToCheck) {
          return profile;
        }
      }
    }
    
    // If no suitable profiles found, return null to indicate queue processing should wait
    return null;
  }

  async getAllChecksPassed(steamId) {
    const profiles = await this.getQueuedProfiles();
    const profile = profiles.find(p => p.steam_id === steamId);
    
    if (!profile) {
      logger.warn(`Profile ${steamId} not found in queue when checking status`);
      return false;
    }
    
    // Check if all checks are passed (ignore deferred checks for now)
    const allPassed = Object.values(profile.checks).every(status => status === "passed");
    return allPassed;
  }

  // Convert all deferred checks back to "to_check"
  async convertDeferredChecksToToCheck() {
    return this.withFileOperation(async () => {
      try {
        const profiles = JSON.parse(await fs.readFile(this.queuePath, 'utf8'));
        let conversionsCount = 0;
        let profilesAffected = 0;
        
        for (const profile of profiles) {
          let profileChanged = false;
          
          for (const [checkName, status] of Object.entries(profile.checks)) {
            if (status === "deferred") {
              profile.checks[checkName] = "to_check";
              conversionsCount++;
              profileChanged = true;
            }
          }
          
          if (profileChanged) {
            profilesAffected++;
            const username = profile.username || 'unknown';
            logger.debug(`Converted deferred checks for ${profile.steam_id} (user: ${username})`);
          }
        }
        
        if (conversionsCount > 0) {
          await fs.writeFile(this.queuePath, JSON.stringify(profiles, null, 2));
          logger.info(`Converted ${conversionsCount} deferred checks to 'to_check' across ${profilesAffected} profiles`);
        } else {
          logger.debug('No deferred checks found to convert');
        }
        
        return {
          conversions: conversionsCount,
          profilesAffected: profilesAffected
        };
      } catch (error) {
        logger.error(`Error converting deferred checks: ${error.message}`);
        return {
          conversions: 0,
          profilesAffected: 0
        };
      }
    });
  }

  // Get count of deferred checks across all profiles
  async getDeferredCheckStats() {
    const profiles = await this.getQueuedProfiles();
    let totalDeferred = 0;
    let profilesWithDeferred = 0;
    
    for (const profile of profiles) {
      let profileDeferredCount = 0;
      
      for (const status of Object.values(profile.checks)) {
        if (status === "deferred") {
          totalDeferred++;
          profileDeferredCount++;
        }
      }
      
      if (profileDeferredCount > 0) {
        profilesWithDeferred++;
      }
    }
    
    return {
      totalDeferred,
      profilesWithDeferred,
      totalProfiles: profiles.length
    };
  }

  // Check if all checks are complete (passed or failed, not deferred)
  async getAllChecksComplete(steamId) {
    const profiles = await this.getQueuedProfiles();
    const profile = profiles.find(p => p.steam_id === steamId);
    
    if (!profile) {
      logger.warn(`Profile ${steamId} not found in queue when checking completion status`);
      return { allComplete: false, allPassed: false };
    }
    
    // Check if all checks are either passed or failed (no to_check or deferred)
    const allComplete = Object.values(profile.checks).every(status => 
      status === "passed" || status === "failed"
    );
    
    const allPassed = Object.values(profile.checks).every(status => status === "passed");
    
    return {
      allComplete,
      allPassed
    };
  }

  // Get queue statistics including usernames
  async getQueueStats() {
    const profiles = await this.getQueuedProfiles();
    
    const stats = {
      totalProfiles: profiles.length,
      byUsername: {},
      byStatus: {
        to_check: 0,
        passed: 0,
        failed: 0,
        deferred: 0
      }
    };
    
    for (const profile of profiles) {
      const username = profile.username || 'unknown';
      
      // Count by username
      if (!stats.byUsername[username]) {
        stats.byUsername[username] = 0;
      }
      stats.byUsername[username]++;
      
      // Count check statuses
      for (const status of Object.values(profile.checks)) {
        if (stats.byStatus[status] !== undefined) {
          stats.byStatus[status]++;
        }
      }
    }
    
    return stats;
  }

  // Get profile by Steam ID (useful for debugging)
  async getProfileBySteamId(steamId) {
    const profiles = await this.getQueuedProfiles();
    return profiles.find(p => p.steam_id === steamId) || null;
  }

  // Utility method for delay
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = QueueManager;