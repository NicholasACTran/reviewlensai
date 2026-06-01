import type { AnalyticsPayload, HelpfulReview } from "../../types/analytics";

function ReviewCard({ review }: { review: HelpfulReview }) {
  return (
    <li className="review-card">
      <p className="review-text">{review.text}</p>
      <div className="review-meta">
        <span className="review-votes">▲ {review.votesUp}</span>
        {review.votesFunny > 0 && <span className="review-funny">😄 {review.votesFunny}</span>}
        {review.playtimeForeverHours != null && (
          <span className="review-playtime">{review.playtimeForeverHours}h</span>
        )}
        {review.language !== "english" && <span className="review-language chip">{review.language}</span>}
      </div>
    </li>
  );
}

function Column({ title, reviews }: { title: string; reviews: HelpfulReview[] }) {
  return (
    <div className="review-column">
      <h4>{title}</h4>
      {reviews.length === 0 ? (
        <p className="review-empty">No reviews</p>
      ) : (
        <ul className="review-list">
          {reviews.map((r, i) => (
            <ReviewCard key={`${r.createdAt}-${i}`} review={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function HelpfulReviews({ helpful }: { helpful: AnalyticsPayload["helpful"] }) {
  return (
    <div className="helpful-reviews">
      <h3>Most helpful reviews</h3>
      <div className="review-columns">
        <Column title="👍 Positive" reviews={helpful.positive} />
        <Column title="👎 Negative" reviews={helpful.negative} />
      </div>
    </div>
  );
}
