import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from scripts.reset_cloudflare_dev import (
    delete_worker,
    drop_sql,
    is_missing_worker,
    parse_d1_rows,
    quote_ident,
)


class DropSqlTests(unittest.TestCase):
    def test_empty(self):
        self.assertIsNone(drop_sql([]))

    def test_quotes_names_and_drops_views_first(self):
        sql = drop_sql(
            [
                {"type": "table", "name": 'accounts"v1'},
                {"type": "view", "name": "active_accounts"},
                {"type": "table", "name": "d1_migrations"},
            ]
        )
        self.assertEqual(
            sql,
            'PRAGMA defer_foreign_keys = ON; DROP VIEW IF EXISTS "active_accounts"; '
            'DROP TABLE IF EXISTS "accounts""v1"; DROP TABLE IF EXISTS "d1_migrations"',
        )

    def test_ignores_unknown_object_types(self):
        self.assertIsNone(drop_sql([{"type": "index", "name": "accounts_last_seen_at"}]))

    def test_rejects_missing_names(self):
        with self.assertRaises(ValueError):
            drop_sql([{"type": "table"}])


class ParseAndMissingTests(unittest.TestCase):
    def test_quote_ident(self):
        self.assertEqual(quote_ident("accounts"), '"accounts"')
        self.assertEqual(quote_ident('a"b'), '"a""b"')

    def test_parse_d1_rows_flattens_result_blocks(self):
        payload = json.loads(
            '[{"results": [{"type": "table", "name": "accounts"}]}, '
            '{"result": [{"type": "view", "name": "active_accounts"}]}]'
        )
        self.assertEqual(
            parse_d1_rows(payload),
            [
                {"type": "table", "name": "accounts"},
                {"type": "view", "name": "active_accounts"},
            ],
        )

    def test_missing_worker_message(self):
        self.assertTrue(is_missing_worker("Cannot find script 'scrapscache-dev'"))
        self.assertTrue(is_missing_worker("Could not find that Workers Service [code: 10007]"))
        self.assertFalse(is_missing_worker("Unauthorized"))


class DeleteWorkerTests(unittest.TestCase):
    @patch("scripts.reset_cloudflare_dev.echo")
    @patch("scripts.reset_cloudflare_dev.wrangler")
    def test_ignores_missing_worker(self, wrangler, _echo):
        wrangler.return_value = SimpleNamespace(
            returncode=1, stdout="", stderr="Cannot find script 'scrapscache-dev'\n"
        )
        delete_worker(["--env", "dev", "--force"])

    @patch("scripts.reset_cloudflare_dev.echo")
    @patch("scripts.reset_cloudflare_dev.wrangler")
    def test_propagates_other_failures(self, wrangler, _echo):
        wrangler.return_value = SimpleNamespace(returncode=1, stdout="", stderr="Unauthorized\n")
        with self.assertRaises(SystemExit) as raised:
            delete_worker(["--env", "dev", "--force"])
        self.assertEqual(raised.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
