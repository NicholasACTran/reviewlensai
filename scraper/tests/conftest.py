import json
from pathlib import Path
import pytest

FIX = Path(__file__).parent / "fixtures"

def load(name): return json.loads((FIX / name).read_text(encoding="utf-8"))

@pytest.fixture
def appdetails(): return load("appdetails.json")
@pytest.fixture
def reviews_summary(): return load("appreviews_summary.json")
@pytest.fixture
def reviews_page1(): return load("appreviews_page1.json")
@pytest.fixture
def reviews_page2(): return load("appreviews_page2.json")
@pytest.fixture
def reviews_empty(): return load("appreviews_empty.json")
