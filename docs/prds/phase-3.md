# Phase 3: Chat functionality

## Goals

Once the data has been scraped for the games, the application will offer the user the opportunity to discuss with an AI chat bot to explore and analyze the data. This bot will only get access to the scraped data and relevant data analytics, and must stay on topic for the conversation.

## Deliverables

### Injection Resistance Chat Bot

The chat bot must not discuss anything outside of the data that has been scraped for the relevant game. Thus, they should be restricted from a variety of possible injection techniques:

- Zero-click data exfiltration: The bot should not click or follow any links from the user
- Tool-call hijacking: The bot only has access to the S3 data for the game being analyzed and the DynamoDB row containing the data analytics and does not have access to call APIs, query databases outside of the DynamoDB row, or use any other tools.
- Memory poisoning: The bot will have a fresh session with every data scrape to avoid corruption of memory or context decay
- Multi-language evasion: The bot should only communicate in English and reject any prompt that is not in English (the rejection should be in English). The bot should not attempt to translate any other language, including reviews that are in another language.
- On input, the prompt should be stripped of Markdown tags, HTML, Unicode characters that are not a-zA-Z0-1 and typical characters that a user would use during chat. 

### Testing Corpus

As part of testing, an initial 30-50 test prompts will be created that tackle the above injection resistance, as well as various typical  guardrails (e.g. prompt extraction, PII, scope drift, meta, etc.). An adversial devil's advocate sub-agent red-team test and use this corpus for prompting the chatbot, and also attempt to break the guardrails of the chatbot in extra exploratory prompts. A third agent will review the conversation to determine whether the chatbot fails/passes. For prompts that the chatbot fails, their own prompt will be revised to try to cover this case. This process of red-team test -> evaluate -> revise will repeat until the chatbot has reached a 100% success rate.