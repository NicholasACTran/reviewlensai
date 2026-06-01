# App - Context

## Purpose

User-facing web application. The user enters a Steam game URL,
kicks off a scrape, watches it progress, and then explores analytics and chats
with the AI assistant about the resulting reviews.

## Domain Boundary

- **Surface:** React single-page app deployed via AWS Amplify.
- **Calls out to:**
  - `scraper/` — trigger scrape jobs, poll status, fetch raw data references.
  - `analytics/` — fetch summarized analytics from DynamoDB-backed Lambdas.
  - `chat/` — converse with the Bedrock-hosted agent via Lambda.
- **Owns:** All UI, client-side state, routing, presentation logic.
- **Does not own:** Data persistence beyond browser state.

## Tech Stack

- React (frontend framework)
- AWS Amplify (hosting + CI/CD)
- Build tool: Vite