# Phase 1: Basic App Functionality and Setup

## Goals

The React App will be scaffolded and deployed via AWS Amplify. This basic app will provide an entry form for the user to enter in a Steam game URL. Once the scraper in the back is complete, the app will display some nominal information to the user to validate that the scrape succeeded.

## App Deliverables

### URL Box

The URL Box is a straightforward form for the user to enter. This form will be validated via backend processes. Should the URL be invalid for the application, the app will surface up the issue to the user. Some possible errors:

- Not a URL
- Not a Steam URL
- Game does not exist

### Scraper Status Integration

Once the scraper has been kicked off, the App should display an animated waiting screen, while the app waits for the job to succeed/fail. Should the job fail, the app should surface an "Try Again" screen.

For how this integration should be setup, please refer to `/app/docs/ARCHITECTURE.md` and `scraper/docs/API_CONTRACT.md`.

### Nominal Data Screen

Once the reviews have been scraped, the system should show various nominal data:

- The game's name
- Number of reviews 
- Percent of reviews that are positive

## Scraper Deliverables

### URL Validation / Scraper Batch Job Starter Lambda

This will be the main input interface for the app. This Lambda will take in a URL as input params, then will validate that the URL is: 

- a valid URL
- a Steam URL
- fetches a valid game

Once validated, this Lambda will kickoff the AWS Batch scraper job with this URL, add an entry to the DynamoDB table to track job status, and then return the job id.

### Scraper Batch Job

This will be an AWS Batch Job that requires a valid Steam game URL in order to function. Once kicked off:

- The scraper will scrape the game data and review data for that game

The game data that will need to be scraped:

- Name
- Date posted
- Price
- Percent of reviews that are positive
- Number of reviews
- Description
- Rich Text Data (this will be data about the game that is specified per game, like tags, description, etc.)

The review data that will need to be scraped, if possible:

- Rating
- Review Text
- Date posted/edited
- Number of users who found this review helpful
- Hours played
- Country/Location of the Reviewer
  
The Batch Job will put the data into a S3 bucket as a set of JSON. Each JSON will be keyed by game and will contain the game data and all associated reviews.

As the Batch job is running, it will make updates to the DynamoDB table for it's job status. Once the S3 objects have been written, this row will also include the URLs for the S3 objects for the FE to query. (This will be used for validation purposes for Phase 1 and will be deprecated later).