import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('derive_catalog', Path(__file__).with_name('derive-catalog.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DeriveTests(unittest.TestCase):
    def test_derive_and_missing_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            audio = root / 'audio'
            lyrics = root / 'lyrics'
            audio.mkdir(); lyrics.mkdir()
            stem = '2000-01-01 00-00-00-00.00.01.000-00.00.11.000-seg1'
            (audio / (stem+'.ogg')).write_bytes(b'YOUR-MEDIA-HERE')
            # Non-slice recordings and old metadata must never become catalog input.
            (audio / 'YOUR-UNSLICED-RECORDING-HERE.mkv').write_bytes(b'YOUR-VIDEO-HERE')
            (audio / 'data.json').write_text('YOUR-INVALID-OLD-METADATA-HERE')
            (lyrics / (stem+'.lrc')).write_text('[00:00.000]YOUR-LYRIC-HERE',encoding='utf8')
            with patch.object(module,'read_tags',return_value=('YOUR-TITLE-HERE','YOUR-ARTIST-HERE')):
                value = module.derive(audio, lyrics)
                rec = value['data']['recordings'][0]
                self.assertIsNone(rec['duration'])
                self.assertEqual(rec['segments'],[])
                self.assertEqual(rec['clips'][0]['offsetStart'],1)
                self.assertEqual(rec['clips'][0]['title'],'YOUR-TITLE-HERE')
                self.assertEqual(value['warnings'],[])
                self.assertEqual(len(value['data']['recordings']),1)
                self.assertEqual(len(value['sources']),1)
                (lyrics/(stem+'.lrc')).write_text('[00:00.000]YOUR-LYRIC-HERE\n[00:12.000]YOUR-TRAILING-LYRIC-HERE',encoding='utf8')
                trailing = module.derive(audio,lyrics)
                self.assertEqual(trailing['warnings'],['Trailing lyric lines preserved: 1'])
                self.assertEqual(len(trailing['data']['recordings'][0]['clips'][0]['lyrics']),2)
                (lyrics/(stem+'.lrc')).unlink()
                with self.assertRaises(FileNotFoundError): module.derive(audio,lyrics)
            with patch.object(module,'read_tags',return_value=('','')):
                with self.assertRaisesRegex(ValueError,'title'): module.derive(audio,lyrics)
    def test_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError,'no segment'): module.derive(tmp,tmp)

if __name__ == '__main__': unittest.main()
