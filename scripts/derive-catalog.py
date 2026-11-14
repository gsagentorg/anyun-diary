"""Derive a standalone catalog using existing filename, tag and LRC rules."""
import json, sys, time
from pathlib import Path
from build_data import SEG_NAME_RE, hms_ms, catalog_epoch_ms_of, read_tags, apply_song_fmt, parse_lrc

def derive(audio_dir, lrc_dir):
    recordings, sources = {}, {}
    trailing = 0
    for path in sorted(Path(audio_dir).iterdir()):
        if path.suffix.lower() not in ('.m4a', '.ogg', '.opus'):
            continue
        match = SEG_NAME_RE.fullmatch(path.stem + '.ogg')
        if not match:
            raise ValueError('audio filename does not encode recording date and segment offsets')
        if path.stem in sources:
            raise ValueError('duplicate audio stem; provide one format per clip')
        start = hms_ms(*match.group(2,3,4,5))
        end = hms_ms(*match.group(6,7,8,9))
        if end <= start:
            raise ValueError('non-positive clip span')
        title, artist = read_tags(path)
        if not title:
            raise ValueError('audio title tag missing or ffprobe unavailable; cannot infer title')
        lyrics = parse_lrc(Path(lrc_dir) / (path.stem + '.lrc'))
        if lyrics[0]['t'] > end - start + .05:
            raise ValueError('lyrics start beyond clip end')
        trailing += sum(x['t'] > end-start+.05 for x in lyrics)
        name = match.group(1)
        rec = recordings.setdefault(name, dict(file=name, start=catalog_epoch_ms_of(name), duration=None, segments=[], clips=[]))
        rec['clips'].append(dict(file=path.name, opus=path.stem+'.opus', offsetStart=start, offsetEnd=end, seg=match.group(10), title=apply_song_fmt(title,artist), lyrics=lyrics))
        sources[path.stem] = str(path.resolve())
    if not recordings:
        raise ValueError('no segment audio found')
    return dict(data=dict(generatedAt=int(time.time()), timezone='Asia/Shanghai', recordings=list(recordings.values())), sources=sources,
                warnings=['Trailing lyric lines preserved: '+str(trailing)] if trailing else [])

if __name__ == '__main__':
    try:
        print(json.dumps(derive(*sys.argv[1:]), ensure_ascii=False))
    except Exception as e:
        sys.exit('Catalog derivation failed: '+str(e))
