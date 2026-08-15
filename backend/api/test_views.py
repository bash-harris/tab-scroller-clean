import json
from unittest.mock import patch, MagicMock
from django.test import TestCase, Client


class ChatEndpointContractTest(TestCase):
    """Phase 1: API contract tests for POST /api/chat."""

    def setUp(self):
        self.client = Client()
        self.url = "/api/chat"
        self.valid_tabs = [
            {"id": 1, "title": "GitHub - React", "url": "https://github.com/facebook/react", "active": False, "pinned": False, "groupId": -1},
            {"id": 2, "title": "GitHub Issues", "url": "https://github.com/issues", "active": False, "pinned": False, "groupId": -1},
            {"id": 3, "title": "Stack Overflow", "url": "https://stackoverflow.com", "active": True, "pinned": True, "groupId": -1},
        ]

    def test_post_with_prompt_and_tabs_returns_200(self):
        """POST /api/chat with prompt and tabs returns 200."""
        mock_ollama_response = {
            "tool": "group_tabs",
            "arguments": {"tabIds": [1, 2], "groupName": "GitHub", "color": "blue"},
            "message": "Grouped 2 tabs",
        }
        with patch("api.views.call_ollama_generate", return_value=json.dumps(mock_ollama_response)):
            response = self.client.post(
                self.url,
                data=json.dumps({"prompt": "group all github tabs", "tabs": self.valid_tabs}),
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 200)

    def test_response_has_required_fields(self):
        """Response contains tool, arguments, message, success fields."""
        mock_ollama_response = {
            "tool": "group_tabs",
            "arguments": {"tabIds": [1, 2], "groupName": "GitHub", "color": "blue"},
            "message": "Grouped 2 tabs",
        }
        with patch("api.views.call_ollama_generate", return_value=json.dumps(mock_ollama_response)):
            response = self.client.post(
                self.url,
                data=json.dumps({"prompt": "group all github tabs", "tabs": self.valid_tabs}),
                content_type="application/json",
            )
        data = response.json()
        self.assertIn("tool", data)
        self.assertIn("arguments", data)
        self.assertIn("message", data)

    def test_response_tool_is_valid(self):
        """Response tool is one of the 5 supported tools."""
        valid_tools = {"group_tabs", "close_tabs", "focus_tab", "bookmark_tabs", "pin_tabs"}
        mock_ollama_response = {"tool": "group_tabs", "arguments": {"tabIds": [1]}, "message": "ok"}
        with patch("api.views.call_ollama_generate", return_value=json.dumps(mock_ollama_response)):
            response = self.client.post(
                self.url,
                data=json.dumps({"prompt": "group github tabs", "tabs": self.valid_tabs}),
                content_type="application/json",
            )
        data = response.json()
        self.assertIn(data["tool"], valid_tools)

    def test_missing_prompt_returns_400(self):
        """POST without prompt returns 400."""
        response = self.client.post(
            self.url,
            data=json.dumps({"tabs": self.valid_tabs}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_missing_tabs_returns_400(self):
        """POST without tabs returns 400."""
        response = self.client.post(
            self.url,
            data=json.dumps({"prompt": "group github tabs"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_invalid_json_returns_400(self):
        """POST with invalid JSON returns 400."""
        response = self.client.post(
            self.url,
            data="not json",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_non_post_returns_405(self):
        """GET returns 405."""
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 405)

    def test_ollama_returns_invalid_json_returns_500(self):
        """When Ollama returns non-JSON, endpoint returns 500."""
        with patch("api.views.call_ollama_generate", return_value="I am not JSON"):
            response = self.client.post(
                self.url,
                data=json.dumps({"prompt": "group github tabs", "tabs": self.valid_tabs}),
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 500)
        data = response.json()
        self.assertIn("error", data)

    def test_ollama_unavailable_returns_500(self):
        """When Ollama is down, endpoint returns 500 with error message."""
        with patch("api.views.call_ollama_generate", side_effect=Exception("Connection refused")):
            response = self.client.post(
                self.url,
                data=json.dumps({"prompt": "group github tabs", "tabs": self.valid_tabs}),
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 500)
        data = response.json()
        self.assertIn("error", data)

    def test_tabs_are_passed_to_prompt(self):
        """Tab metadata is included in the prompt sent to Ollama."""
        mock_ollama_response = {"tool": "close_tabs", "arguments": {"tabIds": [3]}, "message": "Closed 1 tab"}
        with patch("api.views.call_ollama_generate", return_value=json.dumps(mock_ollama_response)) as mock_gen:
            self.client.post(
                self.url,
                data=json.dumps({"prompt": "close the stackoverflow tab", "tabs": self.valid_tabs}),
                content_type="application/json",
            )
            call_args = mock_gen.call_args
            prompt_sent = call_args[1]["prompt"] if "prompt" in call_args[1] else call_args[0][1]
            self.assertIn("GitHub", prompt_sent)
            self.assertIn("stackoverflow.com", prompt_sent)

class GenerateEndpointTest(TestCase):
    """Tests for the Ollama-compatible /api/generate gateway."""

    def setUp(self):
        self.client = Client()
        self.url = "/api/generate"

    def test_missing_prompt_returns_400(self):
        response = self.client.post(self.url, data=json.dumps({}), content_type="application/json")
        self.assertEqual(response.status_code, 400)

    def test_stream_true_rejected(self):
        response = self.client.post(
            self.url,
            data=json.dumps({"prompt": "hi", "stream": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_prompt_too_large_rejected(self):
        response = self.client.post(
            self.url,
            data=json.dumps({"prompt": "x" * 100000}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_happy_path_proxies_and_normalizes(self):
        mock_response = MagicMock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "model": "qwen2.5",
            "response": '{"decision":"final","matches":[]}',
            "prompt_eval_count": 10,
            "eval_count": 5,
        }
        with patch("api.views.requests.post", return_value=mock_response) as mock_post:
            response = self.client.post(
                self.url,
                data=json.dumps({
                    "model": "qwen2.5",
                    "prompt": "test",
                    "stream": False,
                    "format": "json",
                    "keep_alive": -1,
                    "options": {"temperature": 0.1, "num_predict": 2048, "num_ctx": 8192},
                }),
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["response"], '{"decision":"final","matches":[]}')
        self.assertEqual(data["prompt_eval_count"], 10)
        self.assertEqual(data["eval_count"], 5)
        self.assertTrue(data["done"])
        _, kwargs = mock_post.call_args
        sent = kwargs["json"]
        self.assertEqual(sent["model"], "qwen2.5")
        self.assertEqual(sent["stream"], False)
        self.assertEqual(sent["keep_alive"], -1)
        self.assertEqual(sent["options"]["num_predict"], 2048)

    def test_upstream_failure_returns_502(self):
        mock_response = MagicMock()
        mock_response.ok = False
        mock_response.status_code = 500
        mock_response.text = "boom"
        with patch("api.views.requests.post", return_value=mock_response):
            response = self.client.post(
                self.url,
                data=json.dumps({"prompt": "test", "stream": False}),
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 502)


class TabStorageAndFTSTests(TestCase):
    """Test persistent tab storage, URL-hash deduplication, SQLite FTS5 search, and entity queries."""

    def setUp(self):
        self.client = Client()
        self.sample_tabs = [
            {
                "urlHash": "hash_hf_1",
                "url": "https://huggingface.co/CohereLabs/North-Micro-Vision-Instruct",
                "title": "CohereLabs/North-Micro-Vision-Instruct · Hugging Face",
                "domain": "huggingface.co",
                "category": "coding",
                "tags": ["python", "transformers", "pytorch"],
                "keywords": ["vision-language", "open-weight", "multimodal"],
                "pseudoDoc": "CohereLabs North Micro Vision Instruct open weight vision language model fine tuning",
                "mainText": "Apache 2.0 open-weight vision language model designed for prototyping and fine-tuning with PyTorch and Transformers.",
                "embedding": [0.1] * 384,
                "extractionTier": "local_ner",
                "entities": [
                    {"name": "CohereLabs", "type": "org", "confidence": 0.99},
                    {"name": "PyTorch", "type": "tech", "confidence": 0.95}
                ]
            },
            {
                "urlHash": "hash_yt_1",
                "url": "https://www.youtube.com/watch?v=YzWHHNbiHZ4",
                "title": "If you can only watch one sleep video, make it this - YouTube",
                "domain": "youtube.com",
                "category": "video",
                "tags": ["sleep", "health"],
                "keywords": ["circadian", "testosterone", "deep sleep"],
                "pseudoDoc": "Watch one sleep video maximize testosterone deep sleep optimization",
                "mainText": "Achieve 1000+ testosterone in 1:1 coaching and optimize deep REM sleep.",
                "embedding": [0.0] * 384,
                "extractionTier": "local_ner",
                "entities": [
                    {"name": "YouTube", "type": "platform", "confidence": 1.0}
                ]
            },
            {
                "urlHash": "hash_movie_1",
                "url": "https://www.imdb.com/title/tt0402850/",
                "title": "Capote (2005) - IMDb",
                "domain": "imdb.com",
                "category": "entertainment",
                "tags": ["movie", "biography", "drama"],
                "keywords": ["philip seymour hoffman", "oscar", "academy award"],
                "pseudoDoc": "Capote 2005 biography drama starring Philip Seymour Hoffman Academy Award winner",
                "mainText": "In 1959 Truman Capote learns of the murders of a Kansas family and writes In Cold Blood.",
                "embedding": [0.2] * 384,
                "extractionTier": "llm_enriched",
                "entities": [
                    {"name": "Philip Seymour Hoffman", "type": "person", "confidence": 0.98},
                    {"name": "Academy Award", "type": "award", "confidence": 0.95},
                    {"name": "Capote", "type": "movie", "confidence": 0.99}
                ]
            }
        ]

    def test_sync_tabs_bulk_upsert_and_deduplication(self):
        """POST /api/tabs/sync bulk upserts tabs and updates on duplicate hash."""
        # 1. Initial bulk sync
        resp = self.client.post(
            "/api/tabs/sync",
            data=json.dumps({"tabs": self.sample_tabs}),
            content_type="application/json"
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["synced"], 3)
        self.assertEqual(data["total"], 3)

        # 2. Duplicate sync (updates existing rows without inflating total count)
        updated_tabs = [
            {
                "urlHash": "hash_hf_1",
                "url": "https://huggingface.co/CohereLabs/North-Micro-Vision-Instruct",
                "title": "Updated Title - Hugging Face",
                "domain": "huggingface.co",
                "category": "coding",
            }
        ]
        resp2 = self.client.post(
            "/api/tabs/sync",
            data=json.dumps({"tabs": updated_tabs}),
            content_type="application/json"
        )
        data2 = resp2.json()
        self.assertEqual(data2["synced"], 1)
        self.assertEqual(data2["total"], 3)  # Total remains 3

    def test_get_cards_retrieval(self):
        """GET /api/tabs/cards returns stored tab cards."""
        self.client.post("/api/tabs/sync", data=json.dumps({"tabs": self.sample_tabs}), content_type="application/json")

        # Get all
        resp = self.client.get("/api/tabs/cards")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["cards"]), 3)
        self.assertEqual(data["total"], 3)

        # Get specific hashes
        resp2 = self.client.get("/api/tabs/cards?hashes=hash_hf_1,hash_yt_1")
        data2 = resp2.json()
        self.assertEqual(len(data2["cards"]), 2)

    def test_fts_search_bm25_fast_keyword_query(self):
        """GET /api/tabs/fts searches SQLite FTS5 table with BM25 ranking."""
        self.client.post("/api/tabs/sync", data=json.dumps({"tabs": self.sample_tabs}), content_type="application/json")

        # Search for "PyTorch" -> matches HuggingFace card
        resp = self.client.get("/api/tabs/fts?q=PyTorch")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreaterEqual(data["count"], 1)
        self.assertEqual(data["results"][0]["urlHash"], "hash_hf_1")

        # Search for "testosterone" -> matches YouTube card
        resp2 = self.client.get("/api/tabs/fts?q=testosterone")
        data2 = resp2.json()
        self.assertEqual(data2["count"], 1)
        self.assertEqual(data2["results"][0]["urlHash"], "hash_yt_1")

    def test_entity_query_lookup(self):
        """POST /api/tabs/entity_query matches tabs by named entities."""
        self.client.post("/api/tabs/sync", data=json.dumps({"tabs": self.sample_tabs}), content_type="application/json")

        resp = self.client.post(
            "/api/tabs/entity_query",
            data=json.dumps({"entities": ["Philip Seymour Hoffman", "CohereLabs"]}),
            content_type="application/json"
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["count"], 2)
        matched_hashes = {m["urlHash"] for m in data["matches"]}
        self.assertIn("hash_movie_1", matched_hashes)
        self.assertIn("hash_hf_1", matched_hashes)

    def test_get_stats_and_delete(self):
        """GET /api/tabs/stats and POST /api/tabs/delete."""
        self.client.post("/api/tabs/sync", data=json.dumps({"tabs": self.sample_tabs}), content_type="application/json")

        stats_resp = self.client.get("/api/tabs/stats")
        self.assertEqual(stats_resp.status_code, 200)
        stats = stats_resp.json()
        self.assertEqual(stats["totalCards"], 3)
        self.assertTrue(stats["ftsReady"])

        # Delete one
        del_resp = self.client.post(
            "/api/tabs/delete",
            data=json.dumps({"hashes": ["hash_yt_1"]}),
            content_type="application/json"
        )
        self.assertEqual(del_resp.status_code, 200)
        self.assertEqual(del_resp.json()["deleted"], 1)

        # Check total is now 2
        stats_resp2 = self.client.get("/api/tabs/stats")
        self.assertEqual(stats_resp2.json()["totalCards"], 2)

