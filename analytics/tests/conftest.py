import nltk
import pytest

# Ensure the exact data packages NLTK >=3.9 needs (no network at runtime in prod;
# tests download once to the user's nltk_data). Names matter: the legacy
# 'punkt'/'averaged_perceptron_tagger' raise LookupError on >=3.8.2.
for pkg, path in [
    ("vader_lexicon", "sentiment/vader_lexicon"),
    ("averaged_perceptron_tagger_eng", "taggers/averaged_perceptron_tagger_eng"),
    ("punkt_tab", "tokenizers/punkt_tab"),
    ("stopwords", "corpora/stopwords"),  # words.py uses the full English stopword set
]:
    try:
        nltk.data.find(path)
    except LookupError:
        nltk.download(pkg)

def _review(rid, text, voted_up, ts, *, lang="english", votes_up=0, votes_funny=0,
            playtime=120, free=False, purchase=True, ea=False):
    return {
        "recommendationid": str(rid), "language": lang, "review": text,
        "timestamp_created": ts, "timestamp_updated": ts, "voted_up": voted_up,
        "votes_up": votes_up, "votes_funny": votes_funny, "steam_purchase": purchase,
        "received_for_free": free, "written_during_early_access": ea,
        "author": {"playtime_at_review": playtime, "playtime_forever": playtime},
    }

@pytest.fixture
def make_review():
    return _review
