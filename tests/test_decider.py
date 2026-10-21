import os
import unittest
from unittest import mock

from egghead.decider import PUBLIC_DECIDER_URL, HttpDecider, decider_from_env


class DeciderFromEnvTests(unittest.TestCase):
    def test_public_default(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            d = decider_from_env()
        self.assertIsInstance(d, HttpDecider)
        self.assertEqual(d.url, PUBLIC_DECIDER_URL)

    def test_http_backend(self):
        env = {"EGGHEAD_DECIDER_BACKEND": "http", "EGGHEAD_DECIDER_URL": "http://example:9"}
        with mock.patch.dict(os.environ, env, clear=True):
            d = decider_from_env()
        self.assertEqual(d.url, "http://example:9")

    def test_local_backend(self):
        env = {
            "EGGHEAD_DECIDER_BACKEND": "local",
            "EGGHEAD_DECIDER_CHECKPOINT": "ckpt",
            "EGGHEAD_DECIDER_DEVICE": "mps",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch("egghead.decider.LocalDecider") as cls:
                decider_from_env()
        cls.assert_called_once_with("ckpt", "mps")


class HttpDeciderTests(unittest.TestCase):
    def test_sends_user_agent(self):
        d = HttpDecider("http://127.0.0.1:8000")
        captured: list = []

        def fake_urlopen(req, timeout=0):
            captured.append(req)
            return mock.Mock(
                __enter__=lambda s: mock.Mock(read=lambda: b'{"answers":{}}'),
                __exit__=lambda *a: None,
            )

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            d.ask("state", {"q": {"type": "noul"}})
        self.assertIn("user-agent", {k.lower(): v for k, v in captured[0].header_items()})
