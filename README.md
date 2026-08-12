<div align="center">

# 🤖 Lexis

**An AI-powered Twitch chat bot with memory, personality, and soul.**

[![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Twitch](https://img.shields.io/badge/Twitch-9146FF?logo=twitch&logoColor=white)](https://www.twitch.tv/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

</div>

---

## 🌟 Highlights

Lexis brings an intelligent AI companion to your Twitch stream. It remembers conversations, learns about your community, and responds with a customizable personality — all while running on your own hardware.

- 🧠 **Short-term & long-term memory** — remembers recent chats and important facts about viewers
- 🎭 **Multiple personalities** — switch between friendly, witty, chill, or professional vibes
- 🔐 **Zero secrets in config** — secure OAuth Device Code Flow, no client secrets needed
- 🔄 **Fully autonomous** — auto-reconnects, auto-refreshes tokens, crash-resilient
- 🏠 **Self-hosted LLM ready** — works perfectly with llama.cpp or any OpenAI-compatible endpoint
- 🐍 **Dual account support** — optional separate bot account to keep your main account clean

---

## 📖 Overview

Lexis listens to your Twitch chat via EventSub WebSockets, responds to `!bot` commands using a local or remote LLM, and maintains both short-term conversation context and long-term memory of your community.

It's designed to be **drop-in simple**: authenticate once via browser, configure your LLM endpoint, and let Lexis handle the rest.

### How it works

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Twitch      │───▶│   Lexis      │───▶│   Your LLM   │
│  Chat        │◀───│   Bot        │◀───│  (llama.cpp) │
└──────────────┘    └──────┬───────┘    └──────────────┘
                           │
                    ┌──────┴──────┐
                    │   Memory    │
                    │ Short + Long│
                    └─────────────┘
```

---

## ⚡ Quick Start

### Prerequisites

- **Node.js 20+** ([download](https://nodejs.org/))
- A **Twitch account** (the channel you want Lexis on)
- An **OpenAI-compatible LLM** running locally (e.g., llama.cpp) or remotely

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/lexis.git
cd lexis

# Install dependencies
npm install

# Build the project
npm run build
```

### Configuration

Edit `config.json` with your settings:

```json
{
  "twitch": {
    "channelUserId": "YOUR_CHANNEL_USER_ID"
  },
  "llm": {
    "baseUrl": "http://0.0.0.0:8099/v1",
    "apiKey": "no-key",
    "model": "qwen",
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

> 🔑 **How to find your Channel User ID:** Visit [twitchapps.com/tmi](https://twitchapps.com/tmi/) and enter your channel name.

### Run it

```bash
# Simple mode (uses your broadcaster account for everything)
npm start

# Bot mode (separate bot account for sending messages)
npm start -- --bot
```

On first run, Lexis will display a **Device Code** — open the URL in your browser, enter the code, authorize, and you're done! 🎉

---

## ⚙️ Configuration Reference

All configurable parameters for `config.json`:

### Twitch Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `twitch.channelUserId` | string | — | The User ID of the channel to join (required) |

### LLM Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `llm.baseUrl` | string | `http://0.0.0.0:8099/v1` | Base URL of your OpenAI-compatible endpoint |
| `llm.apiKey` | string | `no-key` | API key (use `no-key` for llama.cpp) |
| `llm.model` | string | `qwen` | Model name to use |
| `llm.temperature` | number | `0.7` | Creativity level (0.0 = deterministic, 1.0 = creative) |
| `llm.maxTokens` | number | `500` | Maximum tokens in LLM response |
| `llm.timeout` | number | `30000` | Request timeout in milliseconds |

### Bot Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `bot.commandPrefix` | string | `!bot` | Command prefix to trigger the bot |
| `bot.maxResponseLength` | number | `400` | Max characters per response (Twitch limit: 500) |
| `bot.rateLimitMs` | number | `2000` | Minimum ms between bot responses |
| `bot.shortTermMemorySize` | number | `20` | Number of recent interactions to remember |
| `bot.longTermMemoryInterval` | number | `50` | Interactions between long-term memory consolidation |
| `bot.systemPromptFile` | string | `friendly` | Personality preset (see below) |

### Personality Presets

| Preset | Description |
|--------|-------------|
| `friendly` | Warm, helpful, enthusiastic with occasional emojis |
| `witty` | Sharp humor, playful banter, clever wordplay |
| `assistant` | Professional, concise, informative |
| `chill` | Relaxed, casual, lowercase vibes |

Create your own by adding a `.txt` file to `prompts/` and referencing it by name.

---

## 🌍 Environment Variables

Environment variables override `config.json` values:

| Variable | Overrides |
|----------|-----------|
| `TWITCH_CLIENT_ID` | Default Twitch Client ID (for forks) |
| `TWITCH_CHANNEL_USER_ID` | `twitch.channelUserId` |
| `LLM_BASE_URL` | `llm.baseUrl` |
| `LLM_API_KEY` | `llm.apiKey` |
| `LLM_MODEL` | `llm.model` |
| `SYSTEM_PROMPT_FILE` | `bot.systemPromptFile` |

---

## 💬 Example Interaction

```
viewer123: !bot what's your favorite color?
Lexis: Hmm, I think I'd go with electric blue — it feels like the color of
       creativity and energy! ⚡ What about you, viewer123?

gamer_pro: !bot I'm a competitive Valorant player, rank Immortal
Lexis: Nice! Immortal is no joke — respect for grinding that hard. What's
       your main agent?

viewer123: !bot tell me a joke
Lexis: Why don't scientists trust atoms? Because they make up everything! 😄
```

---

## 🏗️ Architecture

```
lexis/
├── config.json                # Bot configuration
├── broadcaster_tokens.json    # Broadcaster tokens (auto-generated, .gitignored)
├── bot_tokens.json            # Bot account tokens (auto-generated, optional)
├── MEMORY.md                  # Long-term memory (auto-generated)
├── short_term_memory.json     # Short-term memory (auto-generated)
├── prompts/                   # Personality prompt files
│   ├── friendly.txt
│   ├── witty.txt
│   ├── assistant.txt
│   └── chill.txt
├── src/
│   ├── index.ts               # Entry point + CLI
│   ├── config.ts              # Configuration loader
│   ├── auth/                  # OAuth Device Code Flow
│   ├── twitch/                # EventSub WebSocket + Helix API
│   ├── llm/                   # OpenAI-compatible client
│   ├── memory/                # Short-term & long-term memory
│   ├── prompts/               # Prompt loader
│   └── handlers/              # Command processing
└── package.json
```

---

## 🚀 Running Modes

### Simple Mode (`npm start`)

Only the broadcaster account is authenticated. Lexis reads chat and sends messages using the same account. Perfect for personal use.

### Bot Mode (`npm start -- --bot`)

Two accounts are authenticated:
1. **Broadcaster** — for reading chat
2. **Bot** — a separate account for sending messages

Recommended for production to avoid cluttering your main account's chat history.

---

## 🔁 Reauthentication

If tokens expire (30-day limit for public clients) or you revoke access:

1. Delete the relevant token file(s):
   ```bash
   rm broadcaster_tokens.json bot_tokens.json
   ```
2. Restart Lexis:
   ```bash
   npm start
   ```
3. Follow the Device Code Flow prompts again

---

## 🛠️ Development

```bash
# Watch mode (auto-rebuild on changes)
npm run dev

# Run tests
npm test

# Run integration tests
npm run test:integration
```

---

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

For major changes, please open an issue first to discuss what you'd like to change.

---

## 📄 License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).

---

<div align="center">

Built with ❤️ for streamers and their communities

</div>
