export interface Env {
  KV: KVNamespace;

  TELEGRAM_CHANNEL_ID: string;
  ADMIN_USER_ID: string;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;

  GITHUB_TOKEN: string;
  GITHUB_API_BASE?: string;
  KEYWORD_BLOCKLIST?: string;
}

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
  };
  from?: {
    id: number;
    username?: string;
  };
};

export type GitHubRelease = {
  id: number;
  name: string | null;
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
};
