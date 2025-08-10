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
        const data = fs.readFileSync(this.sentTweetsFile, 'utf8');
        const sentTweets: SentTweetTracker[] = JSON.parse(data);
        
        // Clean up old entries (older than 24 hours)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const validTweets = sentTweets.filter(tweet => new Date(tweet.sentAt) > oneDayAgo);
        
        this.sentTweets = new Set(validTweets.map(tweet => tweet.recordId));
        
        // Save cleaned data back
        this.saveSentTweets();
        
        console.log(`📚 Loaded ${this.sentTweets.size} previously sent tweets`);
      }
    } catch (error) {
      console.error('⚠️ Failed to load sent tweets file:', (error as Error).message);
    }
  }

  private saveSentTweets(): void {
    try {
      const data: SentTweetTracker[] = Array.from(this.sentTweets).map(recordId => ({
        recordId,
        sentAt: new Date()
      }));
      
      fs.writeFileSync(this.sentTweetsFile, JSON.stringify(data, null, 2));
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
      
      // Filter out RTs and already sent tweets
      const newTweets = records.filter(record => {
        const text = record.get('Text');
        const isRt = this.isRetweet(text);
        const alreadySent = this.sentTweets.has(record.id);
        
        // Double-check: ensure we never send RT records
        if (isRt) {
          console.log(`🚫 Filtering out RT record: "${text?.substring(0, 30)}..."`);
          return false;
        }
        
        return !alreadySent && text; // Only non-RT, unsent tweets with text
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
   * Delete RT records from Airtable
   */
  public async deleteRetweetRecords(): Promise<void> {
    try {
      console.log('🔍 Starting RT cleanup process...');
      
      const records = await this.table.select({
        fields: ['Text', 'UserName', 'LinkToTweet', 'CreatedAt']
      }).all();
      
      console.log(`📊 Found ${records.length} total records`);
      
      const rtRecords = records.filter(record => {
        const text = record.get('Text');
        return this.isRetweet(text);
      });
      
      console.log(`🔄 Found ${rtRecords.length} RT records to delete`);
      
      if (rtRecords.length === 0) {
        console.log('✅ No RT records found. Database is clean!');
        return;
      }
      
      const batchSize = 10;
      let deletedCount = 0;
      
      for (let i = 0; i < rtRecords.length; i += batchSize) {
        const batch = rtRecords.slice(i, i + batchSize);
        const recordIds = batch.map(record => record.id);
        
        try {
          await this.table.destroy(recordIds);
          deletedCount += recordIds.length;
          console.log(`🗑️  Deleted batch of ${recordIds.length} RT records`);
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          console.error(`❌ Error deleting batch starting at index ${i}:`, (error as Error).message);
        }
      }
      
      console.log(`✅ RT cleanup completed! Deleted ${deletedCount} retweet records.`);
      
    } catch (error) {
      console.error('❌ Error during RT cleanup:', (error as Error).message);
    }
  }

  /**
   * Start the scheduled processes
   */
  public startScheduledProcesses(): void {
    console.log('⏰ Starting scheduled processes every 1 minute...');
    
    cron.schedule('*/1 * * * *', async () => {
      console.log('🔄 Scheduled process triggered');
      
      // First send new tweets
      await this.sendNewTweets();
      
      // Then clean up RT records
      await this.deleteRetweetRecords();
      
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
    await this.deleteRetweetRecords();
    
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