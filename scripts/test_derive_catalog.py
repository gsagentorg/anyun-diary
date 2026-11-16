import importlib.util, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('derive_catalog',Path(__file__).with_name('derive-catalog.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class DeriveTests(unittest.TestCase):
 def test_flat_offset_and_stable_id(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp); audio=root/'audio';lyrics=root/'lyrics';audio.mkdir();lyrics.mkdir()
   stem='2000-01-06 23-59-59-00.00.01.000-00.00.11.000-seg1'
   (audio/(stem+'.ogg')).write_bytes(b'fixture');(lyrics/(stem+'.lrc')).write_text('[00:00.000]Fixture',encoding='utf8')
   (audio/'ignore.mkv').write_bytes(b'fixture');(audio/'data.json').write_text('invalid')
   with patch.object(module,'read_tags',return_value=('Fixture','Artist')):
    value=module.derive(audio,lyrics);a=value['audios'][0]
    self.assertEqual(a['startAt'],module.catalog_epoch_ms_of('2000-01-06 23-59-59')+1)
    self.assertEqual(a['monthId'],'2000-01');self.assertEqual(a['duration'],10)
    self.assertNotIn('recordings',value);self.assertNotIn('offsetStart',a)
    self.assertEqual(a['id'],module.derive(audio,lyrics)['audios'][0]['id'])
    (lyrics/(stem+'.lrc')).unlink()
    with self.assertRaises(FileNotFoundError):module.derive(audio,lyrics)
 def test_empty_is_legal(self):
  with tempfile.TemporaryDirectory() as tmp:self.assertEqual(module.derive(tmp,tmp)['audios'],[])
if __name__=='__main__':unittest.main()
