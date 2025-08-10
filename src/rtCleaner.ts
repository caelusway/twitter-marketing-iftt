import dotenv from 'dotenv';
import Airtable from 'airtable';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { TelegramService } from './telegramService';
import { TwitterRecord, SentTweetTracker } from './types';

dotenv.config();

class RTCleaner {
  private base: Airtable.Base;
  private table: Airtable.Table<TwitterRecord>;
  private telegramService: TelegramService | null = null;
  private sentTweetsFile: string;
  private sentTweets: Set<string> = new Set();

  constructor() {
    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_TABLE_NAME) {
      throw new Error('Missing required Airtable environment variables');
    }

    this.base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
      .base(process.env.AIRTABLE_BASE_ID);
    
    this.table = this.base(process.env.AIRTABLE_TABLE_NAME);
    this.sentTweetsFile = path.join(process.cwd(), 'sent-tweets.json');
    
    // Initialize Telegram service if token is provided
    if (process.env.TELEGRAM_BOT_TOKEN) {
      this.telegramService = new TelegramService(process.env.TELEGRAM_BOT_TOKEN);
    }
    
    this.loadSentTweets();
  }

  private loadSentTweets(): void {
    try {
      if (fs.existsSync(this.sentTweetsFile)) {
        const stats = fs.statSync(this.sentTweetsFile);
        const fileSizeMB = stats.size / (1024 * 1024);
        
        console.log(`📊 Sent tweets file size: ${fileSizeMB.toFixed(2)} MB`);
        
        // If file is too large (>10MB), rotate it
        if (fileSizeMB > 10) {
          this.rotateSentTweetsFile();
        }
        
        const data = fs.readFileSync(this.sentTweetsFile, 'utf8');
        const sentTweets: SentTweetTracker[] = JSON.parse(data);
        
        // More aggressive cleanup: only keep last 6 hours to reduce memory usage
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const validTweets = sentTweets.filter(tweet => new Date(tweet.sentAt) > sixHoursAgo);
        
        // If we removed more than 50% of entries, save the cleaned data
        if (validTweets.length < sentTweets.length * 0.5) {
          console.log(`🧹 Cleaned up ${sentTweets.length - validTweets.length} old entries`);
          this.sentTweets = new Set(validTweets.map(tweet => tweet.recordId));
          this.saveSentTweets();
        } else {
          this.sentTweets = new Set(validTweets.map(tweet => tweet.recordId));
        }
        
        console.log(`📚 Loaded ${this.sentTweets.size} recent sent tweets (last 6 hours)`);
      }
    } catch (error) {
      console.error('⚠️ Failed to load sent tweets file:', (error as Error).message);
      // Start fresh if file is corrupted
      this.sentTweets = new Set();
    }
  }

  private rotateSentTweetsFile(): void {
    try {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const archiveFile = `sent-tweets-${timestamp}.json`;
      
      console.log(`🔄 Rotating large sent tweets file to: ${archiveFile}`);
      fs.renameSync(this.sentTweetsFile, archiveFile);
      
      // Clean up old archive files (keep only last 5)
      const archivePattern = /^sent-tweets-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/;
      const files = fs.readdirSync(process.cwd())
        .filter(file => archivePattern.test(file))
        .sort()
        .reverse();
      
      // Remove old archives, keep only 5 most recent
      files.slice(5).forEach(file => {
        console.log(`🗑️ Removing old archive: ${file}`);
        fs.unlinkSync(file);
      });
      
    } catch (error) {
      console.error('⚠️ Failed to rotate sent tweets file:', (error as Error).message);
    }
  }

  private saveSentTweets(): void {
    try {
      // Only save recent tweets (last 6 hours) to keep file small
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const recentData: SentTweetTracker[] = Array.from(this.sentTweets).map(recordId => ({
        recordId,
        sentAt: new Date()
      })).filter(tweet => tweet.sentAt > sixHoursAgo);
      
      // Use compact JSON format (no pretty printing) to save space
      fs.writeFileSync(this.sentTweetsFile, JSON.stringify(recentData));
      
      // Log file size periodically for monitoring
      if (Math.random() < 0.1) { // 10% chance to log
        const stats = fs.statSync(this.sentTweetsFile);
        const fileSizeKB = (stats.size / 1024).toFixed(1);
        console.log(`💾 Sent tweets file: ${fileSizeKB} KB, ${recentData.length} entries`);
      }
      
    } catch (error) {
      console.error('⚠️ Failed to save sent tweets file:', (error as Error).message);
    }
  }

  /**
   * Checks if a text starts with RT pattern
   */
  private isRetweet(text: string | undefined): boolean {
    if (!text) return false;
    
    const cleanText = text.trim();
    
    const rtPatterns: RegExp[] = [
      /^RT\s*@\w+:/i,                    // RT @username: or RT@username:
      /^RT\s+@\w+\s*:/i,                 // RT @username : (with spaces)
      /^rt\s*@\w+:/i,                    // rt @username: (lowercase)
      /^rt\s+@\w+\s*:/i,                 // rt @username : (lowercase with spaces)
      /^RT\s*@[\w_]+:/i,                 // RT @user_name: (with underscores)
      /^rt\s*@[\w_]+:/i,                 // rt @user_name: (lowercase with underscores)
      /^RT\s*@\w+\s+/i,                  // RT @username (without colon)
      /^rt\s*@\w+\s+/i                   // rt @username (lowercase without colon)
    ];
    
    const isRt = rtPatterns.some(pattern => pattern.test(cleanText));
    
    if (isRt) {
      console.log(`🚫 Detected RT pattern in: "${cleanText.substring(0, 50)}..."`);
    }
    
    return isRt;
  }

  /**
   * Checks if a tweet is a reply based on text content
   */
  private isReply(text: string | undefined): boolean {
    if (!text) return false;
    
    const cleanText = text.trim();
    
    // Primary indicator: starts with @username
    const replyPatterns: RegExp[] = [
      /^@\w+/i,                          // @username
      /^@[\w_]+/i,                       // @user_name (with underscores)
      /^@\w+\s/i,                        // @username followed by space
      /^@[\w_]+\s/i                      // @user_name followed by space
    ];
    
    const isReplyByMention = replyPatterns.some(pattern => pattern.test(cleanText));
    
    // Secondary indicators in text content
    const replyIndicators = [
      'replying to',
      'in reply to', 
      'responding to'
    ];
    
    const hasReplyIndicator = replyIndicators.some(indicator => 
      cleanText.toLowerCase().includes(indicator)
    );
    
    const isReplyTweet = isReplyByMention || hasReplyIndicator;
    
    if (isReplyTweet) {
      console.log(`💬 Detected reply pattern in: "${cleanText.substring(0, 50)}..."`);
    }
    
    return isReplyTweet;
  }

  /**
   * Send new tweets via Telegram
   */
  private async sendNewTweets(): Promise<void> {
    if (!this.telegramService) {
      console.log('📱 Telegram service not configured, skipping notifications');
      return;
    }

    try {
      console.log('🔍 Checking for new tweets to send...');
      
      const records = await this.table.select({
        fields: ['Text', 'UserName', 'LinkToTweet', 'CreatedAt'],
        sort: [{ field: 'CreatedAt', direction: 'desc' }]
      }).all();
      
      // Filter out RTs, replies, and already sent tweets
      const newTweets = records.filter(record => {
        const text = record.get('Text');
        const isRt = this.isRetweet(text);
        const isReplyTweet = this.isReply(text);
        const alreadySent = this.sentTweets.has(record.id);
        
        // Double-check: ensure we never send RT or reply records
        if (isRt) {
          console.log(`🚫 Filtering out RT record: "${text?.substring(0, 30)}..."`);
          return false;
        }
        
        if (isReplyTweet) {
          console.log(`💬 Filtering out reply record: "${text?.substring(0, 30)}..."`);
          return false;
        }
        
        return !alreadySent && text; // Only original, unsent tweets with text
      });
      
      if (newTweets.length === 0) {
        console.log('📭 No new tweets to send');
        return;
      }
      
      console.log(`📤 Found ${newTweets.length} new tweet(s) to send`);
      
      // Convert to TwitterRecord format
      const tweetsToSend: TwitterRecord[] = newTweets.map(record => ({
        Text: record.get('Text'),
        UserName: record.get('UserName'),
        LinkToTweet: record.get('LinkToTweet'),
        CreatedAt: record.get('CreatedAt')
      }));
      
      // Send tweets
      await this.telegramService.sendTweetNotifications(tweetsToSend);
      
      // Mark as sent
      newTweets.forEach(record => {
        this.sentTweets.add(record.id);
      });
      
      this.saveSentTweets();
      
    } catch (error) {
      console.error('❌ Error sending new tweets:', (error as Error).message);
    }
  }

  /**
   * Delete RT and reply records from Airtable
   */
  public async deleteRetweetAndReplyRecords(): Promise<void> {
    try {
      console.log('🔍 Starting RT and reply cleanup process...');
      
      const records = await this.table.select({
        fields: ['Text', 'UserName', 'LinkToTweet', 'CreatedAt']
      }).all();
      
      console.log(`📊 Found ${records.length} total records`);
      
      // Filter RT records
      const rtRecords = records.filter(record => {
        const text = record.get('Text');
        return this.isRetweet(text);
      });
      
      // Filter reply records
      const replyRecords = records.filter(record => {
        const text = record.get('Text');
        return this.isReply(text) && !this.isRetweet(text); // Avoid double-counting RT replies
      });
      
      const allRecordsToDelete = [...rtRecords, ...replyRecords];
      
      console.log(`🔄 Found ${rtRecords.length} RT records to delete`);
      console.log(`💬 Found ${replyRecords.length} reply records to delete`);
      console.log(`📝 Total records to delete: ${allRecordsToDelete.length}`);
      
      if (allRecordsToDelete.length === 0) {
        console.log('✅ No RT or reply records found. Database is clean!');
        return;
      }
      
      const batchSize = 10;
      let deletedCount = 0;
      
      for (let i = 0; i < allRecordsToDelete.length; i += batchSize) {
        const batch = allRecordsToDelete.slice(i, i + batchSize);
        const recordIds = batch.map(record => record.id);
        
        try {
          await this.table.destroy(recordIds);
          deletedCount += recordIds.length;
          console.log(`🗑️  Deleted batch of ${recordIds.length} RT/reply records`);
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          console.error(`❌ Error deleting batch starting at index ${i}:`, (error as Error).message);
        }
      }
      
      console.log(`✅ Cleanup completed! Deleted ${deletedCount} RT/reply records.`);
      
    } catch (error) {
      console.error('❌ Error during RT/reply cleanup:', (error as Error).message);
    }
  }

  /**
   * Start the scheduled processes
   */
  public startScheduledProcesses(): void {
    console.log('⏰ Starting scheduled processes every 1 minute...');
    
    cron.schedule('*/1 * * * *', async () => {
      console.log('🔄 Scheduled process triggered');
      
      // First send new tweets (original tweets only)
      await this.sendNewTweets();
      
      // Then clean up RT and reply records
      await this.deleteRetweetAndReplyRecords();
      
    }, {
      scheduled: true,
      timezone: "America/New_York"
    });
  }

  /**
   * Run manual operations
   */
  public async runManualOperations(): Promise<void> {
    console.log('🚀 Running manual operations...');
    
    // Only send new tweets, don't process historical data
    await this.sendNewTweets();
    await this.deleteRetweetAndReplyRecords();
    
    console.log('🏁 Manual operations finished.');
  }
}

async function main(): Promise<void> {
  try {
    const cleaner = new RTCleaner();
    
    // Run manual operations first (but don't send historical tweets)
    await cleaner.runManualOperations();
    
    // Start scheduled processes
    cleaner.startScheduledProcesses();
    
    console.log('📋 Script is now running with scheduled processes...');
    console.log('⏰ Tweet notifications & RT cleanup: Every 1 minute');
    console.log('📱 Telegram notifications enabled');
    console.log('🛑 Press Ctrl+C to stop');
    
    // Keep the process alive
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down Twitter marketing bot...');
      process.exit(0);
    });
    
  } catch (error) {
    console.error('❌ Failed to start Twitter marketing bot:', (error as Error).message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { RTCleaner };