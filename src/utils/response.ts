import { logger } from '../logger';

/**
 * Sanitize a raw LLM response for Twitch chat: strip markdown, collapse
 * newlines, truncate to the max length (avoiding mid-word cuts).
 */
export function cleanResponse(raw: string, maxLength: number): string {
  // Remove markdown formatting
  let response = raw
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/~~(.*?)~~/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  // Truncate if needed
  if (response.length > maxLength) {
    const originalLength = response.length;
    response = response.substring(0, maxLength);
    // Don't end mid-word
    const lastSpace = response.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.7) {
      response = response.substring(0, lastSpace);
    }
    response = response.trim() + '...';
    logger.responseTruncated(originalLength, response.length, `exceeded ${maxLength} char limit`);
  }

  return response;
}
