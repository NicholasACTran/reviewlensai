# Review Lens AI

## Repo Summary

This is a project to create an application for an Online Reputation Management consultancy. The goal is to analyze customer feedback for Steam games to offer strategic analytics and services. The general flow: the user will enter in a url for a Steam game, this will kick off a scraper that will scrape the customer review data for that game. This data will be used to generate surface level analytics. Then, the user can talk to an AI chatbot to find specific trends. This application is divided into four sections:

- `scraper`: A webscraper that will scrape the customer review data for a given game on Steam 
- `app`: The web app that the user will interact with
- `analytics`: Automated data analytics using classical ML techniques
- `chat`: The AI chat service

In each repo, please refer to the individual `/docs/CONTEXT.md` to get context. There is also a top-level `OVERVIEW.md` file to organize the plan for this project.

## Session Transcripts

There is another folder `ai-transcripts` that will be used to document the full AI session transcripts.

## Workflow

For each feature work:

1. The agent will receive an overview via the user or a PRD file
2. The agent will gather context related to the domain from the documentation
3. The agent will brainstorm a spec with the user, asking clarifying questions and presenting multiple options 
   1. This spec will be reviewed by a panel of Devil Advocate reviewers (1 for correctness, 1 for blast radius, 1 for code simplicity), patching the plan with feedback
   2. Step 3.1 repeats until there is no Blockers
4. The agent will write a plan based on this spec
   1. The plan is iteratively reviewed by a panel of Devil Advocate reviewers (1 for correctness, 1 for blast radius, 1 for code simplicity), patching the plan with feedback
   2. Step 4.1 repeats until there is no Blockers
5. The agent will proceed to execute the plan via subagent driven development
   1. A new feature branch is created for the feature
   2. After each file change, the agent will run type checks and linter
   3. After each step in the plan, if there is a code change, the agent will use a devil's advocate code reviewer to review the code for correctness, side effects, and simplicity.
6. Before shepherding a deployment to staging:
   1. The agent will run the full CI locally
   2. The agent will update relevant docs
   3. The agent will run a devil's advocate code reviewer on the whole PR
7. The agent will shepherd to staging and can trigger the deployment themselves
8.  The agent cannot deploy to production without explicit permission (note: since this is a PoC, there is no production environment).
9.  Once the work has been validated, the agent will save the session transcript.

# Repo patterns

- All deployment efforts should utilize GitHub Actions
- There is a documentation repo per sub-repo, and an overall documentation repo for the whole repo
- Each sub-repo has it's own separate deployment
- Screenshots from local Playwright PM agents are saved to `./screenshots` and this folder should be gitignored
- When saving `ai-transcripts`, scrub any keys or secrets