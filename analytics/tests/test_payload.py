from reviewlensai_analytics.payload import build_payload

MIN_EN = 20

def _doc(reviews, total_reviews=None, game_name="Hollow Knight"):
    return {"game": {"name": game_name}, "summary": {"totalReviews": total_reviews if total_reviews is not None else len(reviews)}, "reviews": reviews}

def test_empty_reviews_hasdata_false(make_review):
    p = build_payload(_doc([]))
    assert p["hasData"] is False and p["sentiment"]["weekly"] == [] and p["helpful"]["positive"] == []

def test_below_english_gate_empties_nlp_keeps_helpful(make_review):
    rv = [make_review(i, "good", True, 100, votes_up=2, lang="schinese") for i in range(30)]
    p = build_payload(_doc(rv))
    assert p["hasData"] is True
    assert p["englishReviewCount"] == 0
    assert p["sentiment"]["weekly"] == [] and p["words"]["overallAdjectives"] == []
    assert len(p["helpful"]["positive"]) == 3   # language-agnostic, still populated

def test_covers_full_history_flag(make_review):
    rv = [make_review(i, "good game brutal gorgeous", True, 100 + i) for i in range(MIN_EN + 5)]
    assert build_payload(_doc(rv, total_reviews=len(rv)))["coversFullHistory"] is True
    assert build_payload(_doc(rv, total_reviews=999999))["coversFullHistory"] is False

def test_english_gate_boundary(make_review):
    # 19 English -> below gate (NLP empty); 20 -> at gate (NLP populated)
    below = [make_review(i, "brutal gorgeous combat great fun", True, 100 + i) for i in range(19)]
    at = below + [make_review(99, "brutal gorgeous combat great fun", True, 999)]
    assert build_payload(_doc(below))["sentiment"]["weekly"] == []
    assert build_payload(_doc(at))["sentiment"]["weekly"] != []

def test_all_positive_empties_complaints(make_review):
    rv = [make_review(i, "brutal gorgeous combat great fun", True, 100 + i) for i in range(25)]
    p = build_payload(_doc(rv))
    assert p["words"]["complaintAdjectives"] == [] and p["words"]["complaintPhrases"] == []
    assert p["words"]["praiseAdjectives"] != []  # praise populated
