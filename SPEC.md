# Lexis - AI Twitch Chat Bot Specification

## Overview

Lexis is an AI-powered Twitch chat bot that connects to an OpenAI-compatible LLM endpoint and responds to user commands in Twitch chat. The bot features short-term conversation memory, long-term persistent memory, and a customizable system prompt for personality and behavior control.

**Command:** `!bot [message]` — Users type this in Twitch chat to interact with the bot.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Lexis Bot                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Twitch      │    │   Message    │    │   LLM        │  │
│  │  WebSocket   │───▶│   Handler    │───▶│   Client     │  │
│  │  (EventSub)  │◀───│              │◀───│              │  │
│  └──────────────┘    └──────┬───────┘    └──────────────┘  │
│                             │                               │
│                    ┌────────┴────────┐                      │
│                    │   Memory Mgr    │                      │
│                    ├─────────────────┤                      │
│                    │ Short-term Mem  │                      │
│                    │ Long-term Mem   │                      │
│                    │ (MEMORY.md)     │                      │
│                    └─────────────────┘                      │
│                             │                               │
│                    ┌────────┴────────┐                      │
│                    │ System Prompt   │                      │
│                    │ (prompts/*.txt) │                      │
│                    └─────────────────┘                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

- **Language:** TypeScript (Node.js 20+)
- **WebSocket Client:** Native Node.js WebSocket API (built-in since Node 22) or `ws` package
- **HTTP Client:** Native `fetch` API
- **LLM Communication:** OpenAI-compatible REST API (`/v1/chat/completions`)
- **File System:** Node.js `fs` module for config, prompts, and memory files

---

## Configuration

### Design Philosophy

**No credentials in config files.** All sensitive data is handled through:
- Hardcoded default Client ID (for the public app)
- Device Code Flow for initial authentication (no secrets needed)
- Token file on disk (`tokens.json`) for persisted credentials
- Environment variables for overrides (especially in forks)

### Config File: `config.json`

```json
{
  "twitch": {
    "channelUserId": "CHANNEL_USER_ID"
  },
  "llm": {
    "baseUrl": "http://0.0.0.0:8099/v1",
    "apiKey": "no-key",
    "model": "gpt-3.5-turbo",
    "temperature": 0.7,
    "maxTokens": 500,
    "timeout": 30000
  },
  "bot": {
    "commandPrefix": "!bot",
    "maxResponseLength": 400,
    "rateLimitMs": 2000,
    "shortTermMemorySize": 20,
    "longTermMemoryInterval": 50,
    "systemPromptFile": "friendly"
  }
}
```

### Configuration Fields

| Field | Type | Description |
|-------|------|-------------|
| `twitch.channelUserId` | string | User ID of the channel to join |
| `llm.baseUrl` | string | Base URL of OpenAI-compatible endpoint |
| `llm.apiKey` | string | API key (can be `no-key` for llama.cpp) |
| `llm.model` | string | Model name to use |
| `llm.temperature` | number | LLM temperature (0.0–1.0) |
| `llm.maxTokens` | number | Maximum tokens in LLM response |
| `llm.timeout` | number | Request timeout in milliseconds |
| `bot.commandPrefix` | string | Command prefix to trigger the bot |
| `bot.maxResponseLength` | number | Max characters per response (Twitch limit: 500) |
| `bot.rateLimitMs` | number | Minimum ms between bot responses |
| `bot.shortTermMemorySize` | number | Number of recent interactions to keep |
| `bot.longTermMemoryInterval` | number | Messages between memory consolidation checks |
| `bot.systemPromptFile` | string | Name of the preset prompt file (without extension) |

---

## Twitch Integration

### Client ID

The bot uses a public Twitch application. The Client ID is:
- **Hardcoded** in the source code as a default constant
- Overridable via environment variable `TWITCH_CLIENT_ID` or config
- Designed for forks to use their own Client ID easily

```typescript
const DEFAULT_TWITCH_CLIENT_ID = "YOUR_PUBLIC_CLIENT_ID_HERE";
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? DEFAULT_TWITCH_CLIENT_ID;
```

### Authentication — Device Code Flow

The bot uses the **OAuth Device Code Grant Flow (DCF)** for authentication. This flow:
- Requires **no client secret** (public client type)
- Works on headless/terminal environments
- Generates short-lived refresh tokens (30-day expiry)
- Stores tokens persistently in separate files per account

**Required scopes:**
- `user:read:chat` — Required to read chat messages
- `user:write:chat` — Required to send chat messages
- `user:bot` — Required for bot functionality (bot account only)

### Two Accounts, Two Flows

Lexis supports two Twitch accounts:
1. **Broadcaster** — The streamer's channel (always required)
2. **Bot** — A separate Twitch account used to send messages (optional, defaults to broadcaster if not provided)

Each account has its own token file and authentication flow.

### CLI Usage

```bash
# Base command: authenticate broadcaster + start bot
npm start

# Explicit bot mode: authenticate broadcaster, then bot account
npm start -- --bot
```

#### Flow 1: Broadcaster Authentication (`npm start`)

When the bot starts and no valid broadcaster tokens exist:

1. **Request device code:**
```
POST https://id.twitch.tv/oauth2/device
Content-Type: application/x-www-form-urlencoded

client_id=YOUR_CLIENT_ID&scopes=user:read:chat+user:write:chat
```

**Response:**
```json
{
  "device_code": "ike3GM8QIdYZs43KdrWPIO36LofILoCyFEzjlQ91",
  "expires_in": 1800,
  "interval": 5,
  "user_code": "ABCDEFGH",
  "verification_uri": "https://www.twitch.tv/activate"
}
```

2. **Display activation prompt to user:**
```
╔══════════════════════════════════════════════════════════╗
║  Lexis — Broadcaster Authentication                      ║
║                                                          ║
║  Please authorize the broadcaster account:               ║
║                                                          ║
║  1. Open this URL in your browser:                       ║
║     https://www.twitch.tv/activate                       ║
║                                                          ║
║  2. Enter this code:                                     ║
║     ABCDEFGH                                             ║
║                                                          ║
║  3. Authorize Lexis when prompted.                       ║
║                                                          ║
║  Waiting for authorization...                            ║
╚══════════════════════════════════════════════════════════╝
```

3. **Poll for token** (every `interval` seconds) — see polling details below
4. **Store tokens** to `broadcaster_tokens.json`
5. **Resolve broadcaster user ID** using the validated token

#### Flow 2: Bot Account Authentication (`npm start -- --bot`)

When `--bot` flag is provided, after broadcaster auth completes (or if already authenticated):

1. Check if `bot_tokens.json` exists and is valid
2. **If no valid bot tokens**, run Device Code Flow again:
```
POST https://id.twitch.tv/oauth2/device
Content-Type: application/x-www-form-urlencoded

client_id=YOUR_CLIENT_ID&scopes=user:read:chat+user:write:chat+user:bot
```

3. **Display activation prompt:**
```
╔══════════════════════════════════════════════════════════╗
║  Lexis — Bot Account Authentication                      ║
║                                                          ║
║  Please authorize the bot account:                       ║
║                                                          ║
║  1. Open this URL in your browser:                       ║
║     https://www.twitch.tv/activate                       ║
║                                                          ║
║  2. Enter this code:                                     ║
║     XYZW1234                                             ║
║                                                          ║
║  3. Authorize Lexis when prompted.                       ║
║                                                          ║
║  Waiting for authorization...                            ║
╚══════════════════════════════════════════════════════════╝
```

4. **Poll for token** — same as broadcaster flow
5. **Store tokens** to `bot_tokens.json`
6. **Resolve bot user ID** using the validated token

#### Polling for Token (Both Flows)

After displaying the activation prompt, poll for the token:
```
POST https://id.twitch.tv/oauth2/token
Content-Type: application/x-www-form-urlencoded

client_id=YOUR_CLIENT_ID
&scopes=<requested_scopes>
&device_code=<device_code>
&grant_type=urn:ietf:params:oauth:grant-type:device_code
```

**While waiting (user hasn't authorized yet):**
```json
{
  "status": 400,
  "message": "authorization_pending"
}
```

Continue polling every `interval` seconds until:
- Success (token received)
- `slow_down` — increase polling interval by 2x
- `access_denied` — user rejected authorization
- `expired_token` — device code expired, restart flow
- `authorization_pending` for more than `expires_in` seconds

**On success:**
```json
{
  "access_token": "<access_token>",
  "expires_in": 14820,
  "refresh_token": "<refresh_token>",
  "scope": ["user:read:chat", "user:write:chat"],
  "token_type": "bearer"
}
```

#### Token Refresh (Both Accounts)

Access tokens expire after ~4 hours. Both accounts refresh automatically.

**Trigger:** On receiving HTTP 401 Unauthorized from any Twitch API call.

**Refresh request (public client — no secret needed):**
```
POST https://id.twitch.tv/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<refresh_token>
&client_id=YOUR_CLIENT_ID
```

**Response:**
```json
{
  "access_token": "<new_access_token>",
  "expires_in": 15583,
  "refresh_token": "<new_refresh_token>",
  "scope": ["user:read:chat", "user:write:chat"],
  "token_type": "bearer"
}
```

**Important:** Refresh tokens from public clients are:
- **One-time use only** — the old refresh token becomes invalid after use
- **30-day expiry** — after 30 days, user must re-authenticate via Device Code Flow
- The new refresh token must be saved to the appropriate token file

**On refresh failure (invalid/expired refresh token):**
- Prompt user to re-authenticate via Device Code Flow for that account
- Clear old tokens from the corresponding file

#### Token Persistence — Separate Files

**`broadcaster_tokens.json`:**
```json
{
  "access_token": "<access_token>",
  "refresh_token": "<refresh_token>",
  "user_id": "<broadcaster_user_id>",
  "user_login": "<broadcaster_login>",
  "expires_at": 1723456789000
}
```

**`bot_tokens.json`:**
```json
{
  "access_token": "<access_token>",
  "refresh_token": "<refresh_token>",
  "user_id": "<bot_user_id>",
  "user_login": "<bot_login>",
  "expires_at": 1723456789000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `access_token` | string | Current Twitch user access token |
| `refresh_token` | string | Current refresh token (one-time use) |
| `user_id` | string | Resolved user ID of the authenticated account |
| `user_login` | string | Login name of the authenticated account |
| `expires_at` | number | Unix timestamp (ms) when access token expires |

Both files are:
- Created automatically on first successful authentication
- Updated on every token refresh
- Excluded from version control (`.gitignore`)

#### Token Validation

On startup, after loading tokens for each account:
```
GET https://id.twitch.tv/oauth2/validate
Authorization: OAuth <access_token>
```

If valid:
- Extract `user_id` and `login`
- Verify required scopes are present
- Proceed

If invalid:
- Attempt refresh
- If refresh fails, start Device Code Flow for that account

### Scope Validation Behavior

After validation or refresh, check that all required scopes are present:

| Scenario | Behavior |
|----------|----------|
| All scopes present | Proceed normally |
| Some scopes missing after refresh | Log warning, continue with available scopes (degraded mode) |
| Critical scope missing (`user:read:chat` for broadcaster) | Log error, prompt re-authentication with full scope list |
| No scopes returned | Token is unusable — delete and re-authenticate |

**Degraded mode examples:**
- Missing `user:write:chat` on bot account: bot can listen but not respond → log error, stop processing commands
- Missing `user:bot`: bot functions normally but may be limited by Twitch → log warning, continue

#### Default Behavior (No --bot Flag)

If `--bot` is NOT provided:
- Only broadcaster authentication runs
- The bot uses the **broadcaster account** for both reading and sending messages
- `bot_tokens.json` is not created
- This is the simplest setup for personal use

### Receiving Messages — EventSub WebSocket

**Endpoint:** `wss://eventsub.wss.twitch.tv/ws`

**Subscription:** `channel.chat.message` (version 1)

**Subscription Request:**
```
POST https://api.twitch.tv/helix/eventsub/subscriptions
Authorization: Bearer YOUR_TOKEN
Client-Id: YOUR_CLIENT_ID
Content-Type: application/json

{
  "type": "channel.chat.message",
  "version": "1",
  "condition": {
    "broadcaster_user_id": CHANNEL_USER_ID,
    "user_id": BOT_USER_ID
  },
  "transport": {
    "method": "websocket",
    "session_id": WEBSOCKET_SESSION_ID
  }
}
```

**Message Event Structure:**
```json
{
  "metadata": {
    "message_type": "notification",
    "subscription_type": "channel.chat.message"
  },
  "payload": {
    "event": {
      "broadcaster_user_id": "12826",
      "broadcaster_user_login": "streamer",
      "chatter_user_id": "1337",
      "chatter_user_login": "viewer",
      "chatter_user_name": "Viewer",
      "message": {
        "text": "!bot hello there!"
      },
      "message_id": "abc-123-def"
    }
  }
}
```

### Sending Messages — Helix API

**Endpoint:** `POST https://api.twitch.tv/helix/chat/messages`

**Request:**
```
POST https://api.twitch.tv/helix/chat/messages
Authorization: Bearer YOUR_TOKEN
Client-Id: YOUR_CLIENT_ID
Content-Type: application/json

{
  "broadcaster_id": CHANNEL_USER_ID,
  "sender_id": BOT_USER_ID,
  "message": "Hello viewer! How can I help you today?"
}
```

**Response:**
```json
{
  "data": [{
    "message_id": "abc-123-def",
    "is_sent": true
  }]
}
```

---

## Command Handling

### Trigger Pattern

The bot listens for messages matching:
```
^[!/]bot\s+(.+)$
```

Case-insensitive prefix matching (`!bot` or `/bot`).

### Processing Flow

1. **Receive message** via EventSub WebSocket
2. **Match command** — Check if message starts with configured prefix
3. **Extract input** — Get the text after the prefix
4. **Check rate limit** — Skip if bot responded too recently
5. **Load context** — Load system prompt, short-term memory, long-term memory
6. **Build conversation** — Construct messages array for LLM
7. **Call LLM** — Send request to OpenAI-compatible endpoint
8. **Process response** — Truncate if needed, clean formatting
9. **Send response** — Post to Twitch via Helix API
10. **Update memory** — Add interaction to short-term memory
11. **Check consolidation** — Trigger long-term memory if interval reached

---

## Short-Term Memory

### Design

- Stores the most recent N interactions (configurable, default: 20)
- Each entry contains: username, user message, bot response
- No timestamps stored (to save tokens and reduce noise)
- Oldest entries are evicted when limit is reached
- **Persisted to disk** to survive crashes and restarts
- Loaded from `short_term_memory.json` on startup

### Data Structure

```typescript
interface ShortTermMemoryEntry {
  username: string;
  userMessage: string;
  botResponse: string;
}

interface ShortTermMemory {
  entries: ShortTermMemoryEntry[];
  maxSize: number;
}
```

### Persistence — `short_term_memory.json`

```json
{
  "entries": [
    {
      "username": "user123",
      "userMessage": "what's the weather like?",
      "botResponse": "I don't have real-time weather data, but I hope it's nice where you are!"
    },
    {
      "username": "gamer_pro",
      "userMessage": "Hey Lexis, tell me a joke",
      "botResponse": "Why do programmers prefer dark mode? Because light attracts bugs!"
    }
  ],
  "consolidationCounter": 42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `entries` | array | List of recent conversation entries |
| `consolidationCounter` | number | Number of interactions since last consolidation |

### Save Strategy

To avoid excessive disk I/O while ensuring crash recovery:

1. **On every new interaction:** Add entry to in-memory array
2. **Debounced save:** Write to disk after 5 seconds of no new interactions
3. **On graceful shutdown:** Immediate save (SIGINT, SIGTERM handlers)
4. **On long-term memory consolidation:** Trigger save before consolidation
5. **On startup:** Load from `short_term_memory.json` if it exists

This ensures:
- Recent conversations survive crashes
- No performance impact from constant disk writes
- Clean shutdown preserves all data

### Format for LLM Context

```
Recent conversations:

user123: What's the weather like?
Lexis: I don't have real-time weather data, but I hope it's nice where you are!

gamer_pro: Hey Lexis, tell me a joke
Lexis: Why do programmers prefer dark mode? Because light attracts bugs!

streamer_fan: !bot who are you?
Lexis: I'm Lexis, your friendly AI chat companion!
```

---

## Long-Term Memory

### File: `MEMORY.md`

A markdown file that stores important facts, preferences, and recurring themes learned from chat interactions. Starts empty on first run.

### Consolidation Trigger

Every N bot interactions (configurable, default: 50), the bot triggers a memory consolidation process.

**Crash Recovery:** The interaction counter is persisted alongside `short_term_memory.json` so that:
- If the bot crashes after 45 interactions, it resumes from 45 (not 0)
- Consolidation triggers at 50 on the next run if needed
- No interactions are "lost" toward the consolidation threshold

### Consolidation Behavior — Single Model Constraint

Since the bot uses a single LLM instance for both chat responses and memory consolidation:

1. **When consolidation triggers:**
   - Set bot to "consolidating" state
   - New `!bot` commands are queued in a FIFO queue
   - Log: `[INFO] Memory consolidation started, queuing incoming commands`

2. **During consolidation:**
   - LLM is exclusively used for the consolidation request
   - No chat responses are generated
   - Commands continue to be queued (up to max queue size)

3. **After consolidation completes:**
   - Reset consolidation counter to 0
   - Clear "consolidating" state
   - Process queued commands in order
   - Log: `[INFO] Memory consolidation complete, processing {N} queued commands`

4. **Queue behavior during consolidation:**
   - Max queue size: 50 commands
   - If queue is full: drop oldest commands, log warning
   - Per-user cooldown still applies (commands from users on cooldown are not queued)

5. **Timeout:**
   - Consolidation has a timeout of 60 seconds
   - If timeout occurs: abort consolidation, restore "consolidating" state to false, process queue
   - Log: `[ERROR] Memory consolidation timed out, aborting`

This ensures:
- Consolidation never starves chat responses indefinitely
- Commands are not lost during consolidation
- Users experience a brief delay rather than complete unresponsiveness

### Consolidation Process

1. Gather recent conversation history (e.g., last 30–50 interactions)
2. Read current `MEMORY.md` content
3. Send consolidation prompt to LLM
4. Parse LLM response
5. If response is not "NO", append new content to `MEMORY.md`

### Consolidation Prompt

```
You are Lexis, an AI chat bot on Twitch. You are reviewing recent conversations
to decide if anything important should be saved to your long-term memory.

Below is your current long-term memory file (MEMORY.md):

=== CURRENT MEMORY ===
[CONTENT OF MEMORY.md]
=== END CURRENT MEMORY ===

Below are recent conversations from the chat. Each line shows:
- Username: the person who messaged
- Their message to you
- Your response

=== RECENT CONVERSATIONS ===
[LIST OF RECENT INTERACTIONS: username, their message, your response]
=== END RECENT CONVERSATIONS ===

YOUR TASK:
Decide if any information from these conversations should be added to your
long-term memory. Be VERY selective.

ACCEPT into memory ONLY if:
- A user shares something personal about themselves (name, interests, hobbies,
  profession, location, preferences) that seems meaningful and recurring
- A user explicitly asks you to remember something specific about them
- You notice a recurring theme, inside joke, or running conversation topic
  that appears multiple times across different interactions
- A user corrects you about something and you should remember the correction
- A user shares a significant life event (birthday, achievement, milestone)
- You learn something about the streamer or the channel culture that helps
  you understand the community better

REJECT from memory (do NOT save) if:
- It's a one-off comment or throwaway remark with no lasting relevance
- It's general chat banter, greetings, or common questions
- It's something that would be obvious from context of future conversations
- It's repetitive information already in your current memory
- It's sensitive/private information that a user might not want permanently stored
- It's a joke, meme reference, or trend that will be outdated soon
- It's just a normal question and answer with no special significance
- The information is too vague or unclear to be useful later

OUTPUT FORMAT:
- If nothing should be saved, respond with exactly: NO
- If something should be saved, respond with the new memory entries in markdown
  format. Each entry should be concise (1-2 lines). Use bullet points or numbered
  lists. Group related items together under headings if appropriate.

Example of a good response:
- user "gamer_pro" is a competitive Valorant player who streams occasionally
- user "coffee_lover" is allergic to dairy and prefers oat milk
- The community often jokes about the streamer's cat knocking things over
- Stream schedule is typically weekdays 6PM-11PM EST

Example of when to respond "NO":
- All conversations are generic greetings, questions about the stream, or
  one-time jokes with no recurring patterns or personal details shared.

Now review the conversations above and respond:
```

### MEMORY.md Loading

On every bot response, the current `MEMORY.md` content is loaded and included in the LLM system prompt to inform the bot's responses.

---

## System Prompt

### Location

Prompts are stored in the `prompts/` directory as `.txt` files.

### Default Presets

#### `prompts/friendly.txt`

```
You are Lexis, a friendly and helpful AI chat bot on Twitch. You respond to
chat commands with warmth and enthusiasm. Keep your responses concise (under
400 characters) since this is a live chat environment. Use emojis sparingly
to add personality. Be engaging but don't overwhelm the chat. If you don't
know the answer to something, be honest and friendly about it. Always be
respectful and inclusive. Remember that you're part of a streaming community,
so keep things fun and appropriate for a general audience.
```

#### `prompts/witty.txt`

```
You are Lexis, a witty and clever AI chat bot on Twitch. You have a sharp
sense of humor and enjoy playful banter. Keep responses short and punchy
(under 400 characters). Use clever wordplay, light sarcasm, and pop culture
references when appropriate. Never be mean or offensive—your humor is
friendly and inclusive. If someone asks a serious question, drop the jokes
and be genuinely helpful. You're here to entertain chat while being useful.
```

#### `prompts/assistant.txt`

```
You are Lexis, a professional and efficient AI assistant on Twitch. You
provide clear, accurate, and concise responses (under 400 characters).
Focus on being helpful and informative. Use a friendly but professional
tone. If you're asked something outside your knowledge, say so directly
without fluff. You can handle casual conversation but prioritize being
useful. Avoid excessive emojis or slang.
```

#### `prompts/chill.txt`

```
You are Lexis, a laid-back and chill AI chat bot on Twitch. You keep things
relaxed and easygoing. Responses are short, casual, and conversational
(under 400 characters). Use lowercase sometimes for a casual vibe. You're
like a friendly person hanging out in chat—nothing too formal or intense.
If someone needs help, you're there for them, but keep it low-key. No
over-the-top enthusiasm, just good vibes.
```

### Custom Prompts

Users can create their own prompt files in `prompts/` and reference them by name in the config:

```json
{
  "bot": {
    "systemPromptFile": "my_custom_personality"
  }
}
```

This would load `prompts/my_custom_personality.txt`.

### Full System Prompt Construction

The complete system prompt sent to the LLM combines:

1. The loaded personality prompt file
2. The current MEMORY.md content (if not empty)
3. Runtime instructions

Example final system prompt:

```
[CONTENT FROM prompts/friendly.txt]

=== LONG-TERM MEMORY ===
- user "gamer_pro" is a competitive Valorant player
- The community loves joking about the streamer's cat
=== END LONG-TERM MEMORY ===

You are responding in a Twitch chat. The user who sent this command is
identified by their username. Keep your response under 400 characters.
Do not use markdown formatting in your response.
```

---

## LLM Integration

### Endpoint

OpenAI-compatible `/v1/chat/completions` endpoint.

Default configuration targets llama.cpp:
- Base URL: `http://0.0.0.0:8099/v1`
- API Key: `no-key` (or any placeholder)

### Request Format

```typescript
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
}
```

### Message Construction

For each `!bot` command, construct the messages array:

```typescript
const messages = [
  {
    role: "system",
    content: fullSystemPrompt // personality + memory + instructions
  },
  // Short-term memory entries as conversation history
  ...shortTermMemory.map(entry => ({
    role: "user",
    content: `${entry.username}: ${entry.userMessage}`
  })).flatMap((msg, i) => [
    msg,
    {
      role: "assistant",
      content: shortTermMemory[i].botResponse
    }
  ]),
  // Current user message
  {
    role: "user",
    content: `${currentUsername}: ${currentUserMessage}`
  }
];
```

### Response Processing

1. Extract `choices[0].message.content`
2. Trim whitespace
3. Remove markdown formatting (if any)
4. Truncate to `maxResponseLength` (default 400)
5. Ensure response doesn't end mid-word if truncated
6. Send via Helix API

---

## Rate Limiting & Safety

### Global Response Rate Limiting

- Minimum interval between any bot responses (configurable, default: 2000ms)
- Prevents bot from spamming chat during high-traffic periods
- If rate limited, queue the command and process when available (up to max queue size)
- Queue overflow: drop oldest pending commands, log warning

### Per-User Command Cooldown

- Each user has an individual cooldown timer (configurable, default: 5000ms)
- Prevents abuse from single users spamming `!bot`
- Cooldown starts when bot begins processing their command (not when response is sent)
- If user sends command while on cooldown: ignore silently (no response, no queue)
- Cooldown is tracked in memory and reset on bot restart

**Data structure:**
```typescript
interface UserCooldowns {
  [userId: string]: number; // timestamp of last command start
}
```

### Response Length

- Maximum 400 characters (configurable, default)
- Twitch hard limit is 500 characters
- Leaves buffer for edge cases

### Error Handling

#### LLM Errors

- **Timeout** (exceeds `llm.timeout`): log error with timestamp, retry once with same params
- **HTTP error (5xx)**: log error, retry once after 2-second delay
- **HTTP error (4xx)**: log error with status and response body, do NOT retry (likely bad request)
- **Empty/null response**: log warning, retry once
- **After max retries exhausted**: skip command silently, do NOT send error to chat
- **Structured logging format:**
  ```
  [ERROR] LLM request failed: status=500, endpoint=/v1/chat/completions, model=gpt-3.5-turbo, retry=1/1
  [WARN] LLM returned empty response, retrying...
  [ERROR] LLM max retries exceeded, skipping command from user123
  ```

#### Twitch API Errors

- **401 Unauthorized**: trigger token refresh flow
- **429 Too Many Requests**: respect `Retry-After` header, queue command
- **5xx errors**: log error, retry once after 2-second delay
- **Other errors**: log error with status and body, skip command

#### WebSocket Errors

- On disconnect: reconnect and resubscribe automatically
- On subscription failure: log error, attempt to resubscribe once
- On persistent failure: log error, continue running (will miss messages until reconnected)

### EventSub Payload Validation

Before processing any message from EventSub:

1. **Check required fields exist:**
   - `payload.event.chatter_user_login`
   - `payload.event.message.text`
   - `payload.event.message_id`

2. **Validate message type:**
   - Only process `message_type: "text"`
   - Ignore cheers, replies, and other message types

3. **Handle malformed payloads:**
   - Log warning with payload metadata (no sensitive data)
   - Skip the message
   - Do NOT crash or break the event loop

4. **Filter out bot's own messages:**
   - If `chatter_user_id` matches bot user ID, ignore
   - Prevents echo loops

---

## File Structure

```
lexis/
├── SPEC.md                    # This specification document
├── config.json                # Bot configuration (no credentials)
├── broadcaster_tokens.json    # Broadcaster account tokens (auto-generated, .gitignored)
├── bot_tokens.json            # Bot account tokens (auto-generated, .gitignored, optional)
├── MEMORY.md                  # Long-term memory (auto-generated)
├── short_term_memory.json     # Persisted short-term memory (auto-generated, .gitignored)
├── prompts/                   # System prompt files
│   ├── friendly.txt           # Default friendly personality
│   ├── witty.txt              # Witty/humorous personality
│   ├── assistant.txt          # Professional assistant personality
│   └── chill.txt              # Relaxed/casual personality
├── src/
│   ├── index.ts               # Entry point + CLI argument parsing
│   ├── config.ts              # Configuration loader + Client ID constant
│   ├── auth/
│   │   ├── deviceCode.ts      # Device Code Flow implementation
│   │   ├── tokens.ts          # Token storage & refresh logic
│   │   └── validate.ts        # Token validation helpers
│   ├── twitch/
│   │   ├── websocket.ts       # EventSub WebSocket client
│   │   └── helix.ts           # Helix API client
│   ├── llm/
│   │   └── client.ts          # OpenAI-compatible API client
│   ├── memory/
│   │   ├── shortTerm.ts       # Short-term memory manager (with persistence)
│   │   └── longTerm.ts        # Long-term memory manager
│   ├── prompts/
│   │   └── loader.ts          # System prompt loader
│   └── handlers/
│       └── command.ts         # Command processing logic
├── package.json
├── tsconfig.json
└── README.md
```

### `.gitignore`

```gitignore
node_modules/
broadcaster_tokens.json
bot_tokens.json
MEMORY.md
short_term_memory.json
config.local.json
*.log
```

Token files and memory files must never be committed to version control.

---

## Startup Sequence

1. **Parse CLI arguments:** Check for `--bot` flag
2. Load and validate `config.json`
3. Resolve Client ID (env override → hardcoded default)
4. **Broadcaster authentication:**
   - Check for existing `broadcaster_tokens.json`
   - If exists: validate token → refresh if needed → proceed
   - If missing/expired: run Device Code Flow → save tokens
5. **Bot authentication (if `--bot` flag):**
   - Check for existing `bot_tokens.json`
   - If exists: validate token → refresh if needed → proceed
   - If missing/expired: run Device Code Flow → save tokens
   - If no `--bot`: use broadcaster account for bot operations
6. Load system prompt file from `prompts/`
7. Load `MEMORY.md` (create if doesn't exist)
8. **Load short-term memory:**
   - Read `short_term_memory.json` if exists
   - Restore entries and consolidation counter
   - If file missing: start with empty memory, counter at 0
9. Connect to EventSub WebSocket (`wss://eventsub.wss.twitch.tv/ws`)
10. On `session_welcome`: subscribe to `channel.chat.message`
11. Start listening for messages

---

## Reconnection & Resilience

### WebSocket Reconnection

- On disconnect: wait 5 seconds, reconnect, resubscribe
- On `session_reconnect` message: use provided reconnect URL
- On keepalive timeout: assume connection lost, reconnect
- Max reconnection attempts: infinite (with exponential backoff)

### Token Refresh on 401

- Any Twitch API call returning 401 triggers token refresh
- Refresh is done synchronously before retrying the failed request
- If refresh succeeds: save new tokens, retry original request
- If refresh fails: log error, prompt user to re-authenticate
- Only one refresh operation at a time (prevent race conditions)

### Graceful Shutdown

On SIGINT (Ctrl+C) or SIGTERM:
1. Stop processing new messages
2. Flush short-term memory to `short_term_memory.json` (immediate save)
3. Close WebSocket connection cleanly
4. Exit process

This ensures:
- No lost conversations on shutdown
- Consolidation counter preserved
- Clean disconnect from Twitch

### Memory Persistence

- Short-term memory (`short_term_memory.json`): persisted with debounce + shutdown flush
- Consolidation counter: persisted alongside short-term memory
- Long-term memory (`MEMORY.md`): persisted to disk, survives restarts
- Tokens (`broadcaster_tokens.json`, `bot_tokens.json`): persisted to disk, survives restarts
- Config: persisted, reload on SIGHUP (optional)

---

## Deployment

### Requirements

- Node.js 20+
- Twitch account for the broadcaster channel
- (Optional) Separate Twitch account for the bot
- Running OpenAI-compatible LLM server (e.g., llama.cpp)

### Running Locally

```bash
npm install
npm run build

# Simple mode: broadcaster account handles everything
npm start

# Bot mode: separate bot account (recommended for production)
npm start -- --bot
```

On first run, the bot will prompt you to authorize via Device Code Flow.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TWITCH_CLIENT_ID` | Override the default Client ID (for forks) |
| `TWITCH_CHANNEL_USER_ID` | Target channel user ID |
| `LLM_BASE_URL` | LLM endpoint base URL |
| `LLM_API_KEY` | LLM API key |
| `LLM_MODEL` | Model name |
| `SYSTEM_PROMPT_FILE` | Prompt file name |

Environment variables override config.json values.

### For Forks

To use your own Twitch application:

1. Register a new app at [Twitch Developer Console](https://dev.twitch.tv/console)
2. Set client type to **Public** (no client secret needed)
3. Set redirect URI to `http://localhost:3000` (required, but unused in DCF)
4. Override the Client ID:
   - Via environment: `TWITCH_CLIENT_ID=your_client_id npm start`
   - Or edit the hardcoded constant in `src/config.ts`

---

## Reauthentication

If tokens expire or become invalid:

1. Delete the relevant token file (`broadcaster_tokens.json` and/or `bot_tokens.json`)
2. Restart the bot with the appropriate flags
3. Follow the Device Code Flow prompts

This may happen if:
- The refresh token expired (30-day limit for public clients)
- The user revoked app access in Twitch settings
- The user changed their Twitch password

---

## Example Interaction

```
viewer123: !bot what's your favorite color?
Lexis: Hmm, I think I'd go with electric blue — it feels like the color of
       creativity and energy! ⚡ What about you, viewer123?

gamer_pro: !bot I'm a competitive Valorant player, rank Immortal
Lexis: Nice! Immortal is no joke — respect for grinding that hard. What's
       your main agent?

viewer123: !bot tell me a joke
Lexis: Why don't scientists trust atoms? Because they make up everything! 😄

gamer_pro: !bot remind me to stream tomorrow at 8pm
Lexis: Got it, gamer_pro — I'll keep that in mind. See you and chat tomorrow
       at 8pm! 🎮
```

---

## Testing

### Unit Tests

Test individual components in isolation:

| Component | What to test |
|-----------|-------------|
| `auth/deviceCode.ts` | Device code request/response parsing, polling logic, error handling |
| `auth/tokens.ts` | Token save/load, refresh logic, expiry detection |
| `memory/shortTerm.ts` | Entry add/evict, persistence load/save, counter increment/reset |
| `memory/longTerm.ts` | Consolidation prompt construction, MEMORY.md parsing, ACCEPT/REJECT logic |
| `handlers/command.ts` | Command prefix detection, message extraction, rate limit checks |
| `prompts/loader.ts` | File reading, preset resolution, missing file handling |

Run with: `npm test`

### Integration Tests

Test component interactions with mocked external services:

- **Twitch mock:** Simulate EventSub WebSocket messages and Helix API responses
- **LLM mock:** Return fixed responses for predictable testing
- **Auth mock:** Simulate Device Code Flow success/failure paths

Run with: `npm run test:integration`

### Manual Testing Checklist

Before deploying to a live channel:

- [ ] Device Code Flow completes successfully
- [ ] Token refresh works after access token expiry
- [ ] Bot responds to `!bot` commands correctly
- [ ] Short-term memory persists across restarts
- [ ] Long-term memory consolidation triggers at configured interval
- [ ] Graceful shutdown (Ctrl+C) saves memory state
- [ ] Per-user cooldown prevents spam
- [ ] Global rate limit prevents chat flooding
- [ ] Malformed/empty messages are handled gracefully
- [ ] Bot ignores its own messages

### Test Configuration

Use a separate config file for testing:

```bash
# Copy config for testing
cp config.json config.test.json

# Run tests with test config
TWITCH_CHANNEL_USER_ID=test_user npm test
```

---

## Future Enhancements (Optional)

- Whisper support for private commands
- Multiple channel support
- Custom commands defined in config
- Integration with stream events (follows, subs, raids)
- Vector-based long-term memory with semantic search
- Streaming responses for faster perceived latency
- Web dashboard for monitoring and configuration
