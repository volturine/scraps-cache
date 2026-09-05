import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from scripts.reset_cloudflare_dev import (
    delete_worker,
    drop_sql,
    is_missing_worker,
    is_transient_d1_failure,
    parse_d1_rows,
    quote_ident,
    run_d1,
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
        self.assertTrue(
            is_missing_worker("This Worker does not exist on this account. [code: 10090]")
        )
        self.assertFalse(is_missing_worker("Unauthorized"))

    def test_transient_d1_failure(self):
        self.assertTrue(is_transient_d1_failure("storage operation exceeded timeout [code: 7429]"))
        self.assertFalse(is_transient_d1_failure("Unauthorized [code: 10000]"))


class D1RetryTests(unittest.TestCase):
    @patch("scripts.reset_cloudflare_dev.time.sleep")
    @patch("scripts.reset_cloudflare_dev.echo")
    @patch("scripts.reset_cloudflare_dev.wrangler")
    def test_retries_storage_timeout(self, wrangler, _echo, sleep):
        wrangler.side_effect = [
            SimpleNamespace(returncode=1, stdout="", stderr="timeout [code: 7429]"),
            SimpleNamespace(returncode=0, stdout="[]", stderr=""),
        ]

        result = run_d1(["d1", "execute"])

        self.assertEqual(result.returncode, 0)
        self.assertEqual(wrangler.call_count, 2)
        sleep.assert_called_once_with(1)

    @patch("scripts.reset_cloudflare_dev.time.sleep")
    @patch("scripts.reset_cloudflare_dev.echo")
    @patch("scripts.reset_cloudflare_dev.wrangler")
    def test_does_not_retry_other_failures(self, wrangler, _echo, sleep):
        wrangler.return_value = SimpleNamespace(returncode=1, stdout="", stderr="Unauthorized")

        result = run_d1(["d1", "execute"])

        self.assertEqual(result.returncode, 1)
        self.assertEqual(wrangler.call_count, 1)
        sleep.assert_not_called()

    @patch("scripts.reset_cloudflare_dev.time.sleep")
    @patch("scripts.reset_cloudflare_dev.echo")
    @patch("scripts.reset_cloudflare_dev.wrangler")
    def test_stops_after_bounded_transient_retries(self, wrangler, _echo, sleep):
        wrangler.return_value = SimpleNamespace(
            returncode=1, stdout="", stderr="timeout [code: 7429]"
        )

        result = run_d1(["d1", "execute"])

        self.assertEqual(result.returncode, 1)
        self.assertEqual(wrangler.call_count, 3)
        self.assertEqual([call.args for call in sleep.call_args_list], [(1,), (2,)])


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
