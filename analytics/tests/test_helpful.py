from reviewlensai_analytics.helpful import helpful_reviews

def test_top3_pos_neg_by_votes_up_min1(make_review):
    rv = [
        make_review(1, "good", True, 100, votes_up=10),
        make_review(2, "good2", True, 100, votes_up=5),
        make_review(3, "good3", True, 100, votes_up=1),
        make_review(4, "good4-ignored", True, 100, votes_up=0),  # 0 votes -> excluded
        make_review(5, "bad", False, 100, votes_up=8),
    ]
    pos, neg = helpful_reviews(rv)
    assert [r["votesUp"] for r in pos] == [10, 5, 1]   # top3 desc, votes_up>=1
    assert len(neg) == 1 and neg[0]["votesUp"] == 8
    assert pos[0]["votedUp"] is True and neg[0]["votedUp"] is False

def test_text_capped_and_playtime_hours(make_review):
    long = "x" * 5000
    pos, _ = helpful_reviews([make_review(1, long, True, 100, votes_up=3, playtime=180)])
    assert len(pos[0]["text"]) == 1000
    assert pos[0]["playtimeForeverHours"] == 3.0   # 180 min / 60


def test_tiebreak_by_votes_funny_then_newer(make_review):
    rv = [make_review(1, "a", True, 200, votes_up=5, votes_funny=2),
          make_review(2, "b", True, 100, votes_up=5, votes_funny=1)]
    pos, _ = helpful_reviews(rv)
    assert pos[0]["votesFunny"] == 2                      # higher votes_funny wins the tie
    rv2 = [make_review(3, "c", True, 300, votes_up=5, votes_funny=0),
           make_review(4, "d", True, 100, votes_up=5, votes_funny=0)]
    pos2, _ = helpful_reviews(rv2)
    assert pos2[0]["createdAt"] == 300                    # newer wins when votes equal
