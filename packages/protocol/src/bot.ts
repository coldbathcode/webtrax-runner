/**
 * WebtraxBot identity, as published on https://webtrax.dev/bot.
 *
 * Owned by the runner (it is what the crawler sends); the cloud re-exports it
 * from @webtrax/domain/bot. The v1 crawler (apps/legacy/runner) sends exactly
 * this User-Agent, and a v1 test keeps the two identical. robots.txt groups
 * match the product token, so site owners write `User-agent: WebtraxBot`.
 *
 * No imports: v1 imports this file by path from outside the workspace.
 */
export const BOT_PRODUCT_TOKEN = 'WebtraxBot'
export const BOT_VERSION = '1.0'
export const BOT_INFO_URL = 'https://webtrax.dev/bot'
export const BOT_USER_AGENT = `Mozilla/5.0 (compatible; ${BOT_PRODUCT_TOKEN}/${BOT_VERSION}; +${BOT_INFO_URL})`
export const BOT_CONTACT_EMAIL = 'bot@webtrax.dev'
/** Longest Crawl-delay the crawler honours, in seconds. */
export const BOT_MAX_CRAWL_DELAY_SECONDS = 30
