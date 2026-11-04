"""Synthetic fixtures only: no NAS, media, project or production access."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(os.environ.get("BUILD_DATA_MODULE", Path(__file__).with_name("build_data.py")))
spec = importlib.util.spec_from_file_location("build_data", MODULE)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class LyricsRefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.tagged = self.root / "已打标签"
        self.tagged.mkdir()
        self.data = self.root / "data.json"
        self.baseline = {
            "generatedAt": 10, "timezone": "Asia/Shanghai", "custom": {"keep": True},
            "recordings": [{"file": "group-a", "duration": None,
                            "segments": [{"start": 3, "end": 4}],
                            "clips": [{"file": "sample.m4a", "title": "Synthetic title",
                                       "opus": "sample.opus", "offsetStart": 3, "offsetEnd": 13,
                                       "lyrics": [{"t": 1, "text": "old"}]}]},
                           {"file": "empty-group", "custom": 42}],
        }
        self.data.write_text(json.dumps(self.baseline))
        self.lyric = self.tagged / "sample.lrc"
        self.lyric.write_text("[00:01.20]new first\n[00:05.300]new second\n")
        self.original = self.data.read_bytes()

    def test_only_lyrics_and_generation_time_change(self):
        result = builder.refresh_lyrics(self.data, self.tagged)
        actual = json.loads(self.data.read_text())
        self.assertEqual(result["changed_lyrics"], 1)
        self.assertTrue(result["written"])
        self.assertEqual(actual["recordings"][0]["clips"][0]["lyrics"],
                         [{"t": 1.2, "text": "new first"}, {"t": 5.3, "text": "new second"}])
        actual["recordings"][0]["clips"][0]["lyrics"] = self.baseline["recordings"][0]["clips"][0]["lyrics"]
        actual["generatedAt"] = 10
        self.assertEqual(actual, self.baseline)

    def test_no_directory_scans_or_non_lrc_reads(self):
        # Junk siblings intentionally resemble legacy input; all reads outside the
        # existing catalog + selected lyric are rejected, as are directory scans.
        (self.root / "unrelated.mkv").write_text("do not read")
        (self.root / "unrelated-proj.llc").write_text("do not read")
        (self.tagged / "unused.lrc").write_text("invalid and irrelevant")
        real_open = Path.open
        reads = []
        def guarded_open(path, mode="r", *args, **kwargs):
            if "r" in mode:
                reads.append(Path(path))
                if Path(path) not in (self.data, self.lyric):
                    raise AssertionError("unauthorized read: " + str(path))
            return real_open(path, mode, *args, **kwargs)
        with patch.object(Path, "open", guarded_open), \
             patch("os.listdir", side_effect=AssertionError("directory scan forbidden")), \
             patch("os.scandir", side_effect=AssertionError("directory scan forbidden")), \
             patch("subprocess.run", side_effect=AssertionError("media probe forbidden")):
            builder.refresh_lyrics(self.data, self.tagged)
        self.assertEqual(set(reads), {self.data, self.lyric})

    def test_missing_lrc_is_all_or_nothing(self):
        self.lyric.unlink()
        with self.assertRaises(FileNotFoundError):
            builder.refresh_lyrics(self.data, self.tagged)
        self.assertEqual(self.data.read_bytes(), self.original)

    def test_bad_lyrics_never_clear_existing_lyrics(self):
        for text in ("", "[ti:Only metadata]", "not LRC", "[00:60.00]bad seconds",
                     "[00:05.00]later\n[00:01.00]earlier", "[00:01.00]a\n[00:01.00]b",
                     "[offset:2000]\n[00:01.00]negative", "[00:11.00]outside"):
            with self.subTest(text=text):
                self.lyric.write_text(text)
                with self.assertRaises(ValueError):
                    builder.refresh_lyrics(self.data, self.tagged)
                self.assertEqual(self.data.read_bytes(), self.original)

    def test_dry_run_and_no_change_do_not_write(self):
        result = builder.refresh_lyrics(self.data, self.tagged, dry_run=True)
        self.assertFalse(result["written"])
        self.assertEqual(self.data.read_bytes(), self.original)
        builder.refresh_lyrics(self.data, self.tagged)
        before = self.data.read_bytes()
        result = builder.refresh_lyrics(self.data, self.tagged)
        self.assertFalse(result["written"])
        self.assertEqual(self.data.read_bytes(), before)

    def test_missing_baseline_is_error(self):
        self.data.unlink()
        with self.assertRaises(FileNotFoundError):
            builder.refresh_lyrics(self.data, self.tagged)
        self.assertFalse(self.data.exists())

    def test_path_traversal_is_rejected(self):
        for name in ("../sample.m4a", "/sample.m4a", "folder\\sample.m4a"):
            bad = copy.deepcopy(self.baseline)
            bad["recordings"][0]["clips"][0]["file"] = name
            self.data.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                builder.refresh_lyrics(self.data, self.tagged)

    def test_escaping_symlink_is_rejected(self):
        self.lyric.unlink()
        target = self.root / "outside.lrc"
        target.write_text("[00:01.00]outside")
        self.lyric.symlink_to(target)
        with self.assertRaises(ValueError):
            builder.refresh_lyrics(self.data, self.tagged)
        self.assertEqual(self.data.read_bytes(), self.original)

    def test_concurrent_data_edit_is_preserved(self):
        real_read = Path.read_bytes
        calls = 0
        def read(path):
            nonlocal calls
            if path == self.data:
                calls += 1
                if calls == 2:
                    self.data.write_bytes(b'{"concurrent":true}')
            return real_read(path)
        with patch.object(Path, "read_bytes", read), self.assertRaises(RuntimeError):
            builder.refresh_lyrics(self.data, self.tagged)
        self.assertEqual(self.data.read_bytes(), b'{"concurrent":true}')

    def test_source_change_is_rejected(self):
        real_read = Path.read_bytes
        calls = 0
        def read(path):
            nonlocal calls
            if path == self.lyric:
                calls += 1
                if calls == 2:
                    self.lyric.write_text("[00:01.00]concurrently changed")
            return real_read(path)
        with patch.object(Path, "read_bytes", read), self.assertRaises(RuntimeError):
            builder.refresh_lyrics(self.data, self.tagged)
        self.assertEqual(self.data.read_bytes(), self.original)

    def test_atomic_write_failure_preserves_original(self):
        with patch.object(builder.os, "replace", side_effect=OSError("replace failed")), self.assertRaises(OSError):
            builder.refresh_lyrics(self.data, self.tagged)
        self.assertEqual(self.data.read_bytes(), self.original)
        self.assertEqual(list(self.root.glob(".data-*.tmp")), [])

    def test_offset_bom_metadata_and_multi_stamps(self):
        result = builder.parse_lrc_text("\ufeff[ti:Title]\n[offset:100]\n[00:01.20][00:03.300]word")
        self.assertEqual(result, [{"t": 1.1, "text": "word"}, {"t": 3.2, "text": "word"}])

    def test_legacy_env_does_not_scan_parent(self):
        with patch.dict(os.environ, {"AUDIO_ROOT": str(self.root), "TAGGED_DIR": ""}), \
             patch("os.listdir", side_effect=AssertionError("directory scan forbidden")), \
             patch("os.scandir", side_effect=AssertionError("directory scan forbidden")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(builder.main(["--data-file", str(self.data), "--dry-run"]), 0)
        self.assertEqual(json.loads(output.getvalue())["clips"], 1)
        self.assertEqual(self.data.read_bytes(), self.original)


if __name__ == "__main__":
    unittest.main()
