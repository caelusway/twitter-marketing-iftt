import { FieldSet } from 'airtable';

export interface TwitterRecord extends FieldSet {
  Text?: string;
  UserName?: string;
  LinkToTweet?: string;
  TweetEmbedCode?: string;
  CreatedAt?: string;
}

export interface SentTweetTracker {
  recordId: string;
  sentAt: Date;
}