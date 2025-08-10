import TelegramBot from 'node-telegram-bot-api';
import { TwitterRecord } from './types';

export class TelegramService {
  private bot: TelegramBot;
  private chatIds: Set<number> = new Set();

  constructor(token: string) {
    this.bot = new TelegramBot(token, { polling: true });
    this.loadManualChatIds();
    this.initializeBot();
  }

  private loadManualChatIds(): void {
    // Load manual chat IDs from environment variable if provided
    const manualChatIds = process.env.TELEGRAM_CHAT_IDS;
    if (manualChatIds) {
      const chatIds = manualChatIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      chatIds.forEach(chatId => this.chatIds.add(chatId));
      console.log(`📝 Loaded ${chatIds.length} manual chat ID(s) from config`);
    }
  }

  private async initializeBot(): Promise<void> {
    try {
      // Get bot info to verify token
      const botInfo = await this.bot.getMe();
      console.log(`🤖 Telegram bot initialized: @${botInfo.username}`);
      
      // Set up message listeners to detect new chats
      this.setupMessageListeners();
      
      // Get updates to find chat IDs where the bot is a member
      await this.updateChatIds();
      
      console.log(`📋 To activate the bot in your group:`);
      console.log(`   1. Add @${botInfo.username} to your private group`);
      console.log(`   2. Send any message in the group (like /start or "hello")`);
      console.log(`   3. The bot will detect the group and start sending notifications`);
      
    } catch (error) {
      console.error('❌ Failed to initialize Telegram bot:', (error as Error).message);
    }
  }

  private setupMessageListeners(): void {
    // Listen for any message to detect new chats
    this.bot.on('message', (msg) => {
      const chatId = msg.chat.id;
      const chatTitle = msg.chat.title || msg.chat.first_name || 'Unknown';
      
      if (!this.chatIds.has(chatId)) {
        this.chatIds.add(chatId);
        console.log(`✅ New chat detected: "${chatTitle}" (ID: ${chatId})`);
        console.log(`📱 Bot is now active in ${this.chatIds.size} chat(s)`);
      }
    });

    // Handle bot being added to groups
    this.bot.on('new_chat_members', (msg) => {
      const chatId = msg.chat.id;
      const chatTitle = msg.chat.title || 'Unknown Group';
      
      if (!this.chatIds.has(chatId)) {
        this.chatIds.add(chatId);
        console.log(`🎉 Bot added to group: "${chatTitle}" (ID: ${chatId})`);
        console.log(`📱 Bot is now active in ${this.chatIds.size} chat(s)`);
      }
    });

    // Handle errors gracefully
    this.bot.on('error', (error) => {
      console.error('🚨 Telegram bot error:', error.message);
    });
  }

  private async updateChatIds(): Promise<void> {
    try {
      const updates = await this.bot.getUpdates();
      
      updates.forEach(update => {
        if (update.message?.chat) {
          const chatId = update.message.chat.id;
          if (!this.chatIds.has(chatId)) {
            this.chatIds.add(chatId);
            const chatTitle = update.message.chat.title || update.message.chat.first_name || 'Unknown';
            console.log(`📱 Found existing chat: "${chatTitle}" (ID: ${chatId})`);
          }
        } else if (update.channel_post?.chat) {
          const chatId = update.channel_post.chat.id;
          if (!this.chatIds.has(chatId)) {
            this.chatIds.add(chatId);
            const chatTitle = update.channel_post.chat.title || 'Unknown Channel';
            console.log(`📺 Found existing channel: "${chatTitle}" (ID: ${chatId})`);
          }
        }
      });
      
      console.log(`📱 Found ${this.chatIds.size} total chat(s) where bot is active`);
      
      if (this.chatIds.size === 0) {
        console.log(`⚠️ No active chats found. Make sure to:`);
        console.log(`   • Add the bot to your group`);
        console.log(`   • Send a message in the group to activate it`);
      }
    } catch (error) {
      console.error('⚠️ Failed to get chat IDs:', (error as Error).message);
    }
  }

  public formatTweetMessage(tweets: TwitterRecord[]): string {
    if (tweets.length === 0) return '';

    const header = `🐦 **New Tweets (${tweets.length})**\n\n`;
    
    const tweetList = tweets.map((tweet, index) => {
      const text = this.truncateText(tweet.Text || '', 100);
      const username = tweet.UserName ? `@${tweet.UserName}` : 'Unknown';
      const link = tweet.LinkToTweet || '';
      
      return `${index + 1}. **${username}**\n   ${text}${text.length >= 100 ? '...' : ''}\n   🔗 [View Tweet](${link})`;
    }).join('\n\n');

    return header + tweetList;
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength).trim();
  }

  public async sendTweetNotifications(tweets: TwitterRecord[]): Promise<void> {
    if (tweets.length === 0) {
      console.log('📭 No new tweets to send');
      return;
    }

    const message = this.formatTweetMessage(tweets);
    if (!message) return;

    // Update chat IDs before sending
    await this.updateChatIds();

    if (this.chatIds.size === 0) {
      console.log('⚠️ No active chats found. Bot may not be added to any groups/channels.');
      return;
    }

    console.log(`📤 Sending ${tweets.length} tweet(s) to ${this.chatIds.size} chat(s)`);

    const sendPromises = Array.from(this.chatIds).map(async (chatId) => {
      try {
        await this.bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: false
        });
        
        // Rate limiting: wait between messages
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        const err = error as any;
        if (err.code === 'ETELEGRAM' && err.response?.body?.error_code === 403) {
          console.log(`🚫 Bot was removed from chat ${chatId}, removing from active chats`);
          this.chatIds.delete(chatId);
        } else {
          console.error(`❌ Failed to send to chat ${chatId}:`, err.message);
        }
      }
    });

    await Promise.all(sendPromises);
    console.log('✅ Tweet notifications sent successfully');
  }

  public getChatCount(): number {
    return this.chatIds.size;
  }
}