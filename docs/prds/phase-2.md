# Phase 2: Analytics

## Goals

The Frontend app will listen to the DynamoDB row and the updates to that row for analytics. Once the row has been populated with data analytics, the Frontend will display those analytics to the user.

## Deliverables

### Game Analytics

- Sentiment Analysis: Line chart over time that will display the sentiment analysis over time of a game. This chart should be able to have a rolling average over a week, a rolling average over a month, and an all-time measure.

- Word Association: This will display the top 5 adjectives and phrases associated with the game.

- Most Helpful Reviews: Display the top 3 positive and negative user reviews (each review must have at least 1 user who has voted for the review to be helpful (or other positive associated reaction)).