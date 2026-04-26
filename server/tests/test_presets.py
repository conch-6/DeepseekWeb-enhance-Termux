"""Tests for preset marketplace API."""

import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


class TestPresetAPI:
    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from server import app
        return TestClient(app)

    def test_list_presets(self, client):
        response = client.get("/api/presets")
        assert response.status_code == 200
        data = response.json()
        assert "presets" in data
        assert len(data["presets"]) > 0
        # Each preset has required fields
        for p in data["presets"]:
            assert "id" in p
            assert "name" in p
            assert "installed" in p

    def test_install_preset_missing(self, client):
        response = client.post("/api/presets/nonexistent/install", json={})
        assert response.status_code == 404

    def test_install_preset_missing_required_params(self, client):
        """filesystem requires PATH — missing it should fail."""
        response = client.post("/api/presets/filesystem/install", json={})
        assert response.status_code == 400
        assert "Missing" in response.json()["error"]


class TestDangerousPatterns:
    def test_taskkill_blocked(self):
        from tools.shell import execute_command
        result = execute_command("taskkill /F /IM python.exe")
        assert "Security" in result or "blocked" in result

    def test_kill_blocked(self):
        from tools.shell import execute_command
        result = execute_command("kill -9 12345")
        assert "Security" in result or "blocked" in result

    def test_pkill_blocked(self):
        from tools.shell import execute_command
        result = execute_command("pkill python")
        assert "Security" in result or "blocked" in result
