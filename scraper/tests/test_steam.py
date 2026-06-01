import responses
from reviewlensai_scraper import steam

APPID = "413150"

@responses.activate
def test_fetch_appdetails_success(appdetails):
    responses.get("https://store.steampowered.com/api/appdetails", json=appdetails)
    ok, data = steam.fetch_appdetails(APPID)
    assert ok is True
    assert data["name"]  # has a name

@responses.activate
def test_fetch_appdetails_not_found():
    responses.get("https://store.steampowered.com/api/appdetails", json={APPID: {"success": False}})
    ok, data = steam.fetch_appdetails(APPID)
    assert ok is False and data is None

@responses.activate
def test_fetch_review_summary(reviews_summary):
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=reviews_summary)
    total, positive = steam.fetch_review_summary(APPID)
    assert total == reviews_summary["query_summary"]["total_reviews"]
    assert positive == reviews_summary["query_summary"]["total_positive"]

@responses.activate
def test_paginate_dedups_and_caps(reviews_summary, reviews_page1, reviews_page2, reviews_empty):
    # `responses` replays same-URL mocks in registration order:
    # summary (filter=all) -> page1 -> page2 (1 dup id) -> empty
    for body in (reviews_summary, reviews_page1, reviews_page2, reviews_empty):
        responses.get("https://store.steampowered.com/appreviews/" + APPID, json=body)
    result = steam.scrape_reviews(APPID, max_reviews=1000, delay_s=0)
    ids = [r["recommendationid"] for r in result.reviews]
    assert len(ids) == len(set(ids))                                         # no dups
    assert result.total_reviews == reviews_summary["query_summary"]["total_reviews"]  # from SUMMARY
    assert result.scraped == len(result.reviews)
    assert len(responses.calls) == 4                                          # proves pagination advanced

@responses.activate
def test_paginate_respects_cap(reviews_summary, reviews_page1):
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=reviews_summary)
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=reviews_page1)  # >=2 reviews
    result = steam.scrape_reviews(APPID, max_reviews=2, delay_s=0)
    assert result.scraped == 2

@responses.activate
def test_paginate_stops_on_repeated_cursor(reviews_summary, reviews_page1):
    same = {**reviews_page1, "cursor": "SAMECURSOR"}
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=reviews_summary)
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=same)
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=same)
    result = steam.scrape_reviews(APPID, max_reviews=10_000, delay_s=0)
    ids = [r["recommendationid"] for r in result.reviews]
    assert len(ids) == len(set(ids))                                          # repeated cursor terminates
    assert len(responses.calls) == 3                                          # summary + 2 identical pages

def test_trim_review_keeps_only_contract_fields(reviews_page1):
    raw = reviews_page1["reviews"][0]
    t = steam.trim_review(raw)
    assert set(t.keys()) <= {
        "recommendationid", "language", "review", "timestamp_created", "timestamp_updated",
        "voted_up", "votes_up", "votes_funny", "steam_purchase", "received_for_free",
        "written_during_early_access", "author",
    }
    assert set(t["author"].keys()) <= {"playtime_at_review", "playtime_forever"}
