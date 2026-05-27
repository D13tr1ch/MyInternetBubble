"""Shared fixtures for digital-fingerprint tests."""

import sys
import types
import pytest

# Stub out 'requests' before importing server so tests don't need network deps
# at import time. Tests that exercise HTTP routes don't call external URLs.
if "requests" not in sys.modules:
    mock_req = types.ModuleType("requests")
    mock_req.get = lambda *a, **kw: None  # type: ignore
    sys.modules["requests"] = mock_req

import server  # noqa: E402  (after stub)


@pytest.fixture
def client():
    """Flask test client."""
    server.app.config["TESTING"] = True
    with server.app.test_client() as c:
        yield c
