from reviewlensai_analytics.words import top_adjectives, top_phrases

def test_top_adjectives_extracts_jj_and_filters_stopwords_and_gamename():
    texts = ["The combat is brutal but gorgeous", "gorgeous art, brutal difficulty",
             "a brutal, gorgeous masterpiece"]
    adj = top_adjectives(texts, exclude={"hollow", "knight"}, n=5)
    terms = [a["term"] for a in adj]
    assert "brutal" in terms and "gorgeous" in terms
    assert all(a["count"] >= 1 for a in adj)
    assert adj == sorted(adj, key=lambda a: -a["count"])  # desc by count

def test_top_phrases_requires_min_frequency():
    # a one-off rare bigram must NOT outrank a frequent one; the frequent one MUST survive
    texts = ["great game"] * 6 + ["zxqw plooble"]   # 'zxqw plooble' appears once
    phrases = top_phrases(texts, exclude=set(), n=5, min_freq=5)
    joined = [p["term"] for p in phrases]
    assert "great game" in joined          # frequent bigram survives the freq filter
    assert "zxqw plooble" not in joined     # one-off filtered out (would falsely top PMI)
    assert phrases[0]["term"] == "great game" and phrases[0]["count"] == 6

def test_empty_inputs_return_empty():
    assert top_adjectives([], exclude=set()) == []
    assert top_phrases([], exclude=set()) == []
