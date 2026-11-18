"""Read only tagged segment media and same-stem LRC; never consult legacy catalog."""
import hashlib, json, sys, re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from tagged_audio import SEG_NAME_RE, hms_ms, catalog_epoch_ms_of, read_tags, apply_song_fmt, parse_lrc

MONTH_BOUNDARY_DAY = int(re.search(r'DATA_PERIOD_START_DAY = ([0-9]+)', (Path(__file__).parent.parent / 'src/lib/month.js').read_text()).group(1))

def month_id(epoch):
    d = datetime.fromtimestamp(epoch, timezone(timedelta(hours=8)))
    y, m = d.year, d.month
    if d.day < MONTH_BOUNDARY_DAY:
        m -= 1
        if not m: y, m = y - 1, 12
    return f'{y:04d}-{m:02d}'

def derive(audio_dir, lrc_dir):
    audios, sources, seen = [], {}, set()
    root, lyrics_root = Path(audio_dir).resolve(strict=True), Path(lrc_dir).resolve(strict=True)
    for path in sorted(root.iterdir()):
        if path.suffix.lower() not in ('.m4a', '.ogg', '.opus'): continue
        if path.resolve().parent != root: raise ValueError('audio symlink escapes tagged directory')
        match = SEG_NAME_RE.fullmatch(path.stem + '.ogg')
        if not match: raise ValueError('invalid segment filename')
        if path.stem in seen: raise ValueError('duplicate audio stem')
        seen.add(path.stem)
        start, end = hms_ms(*match.group(2,3,4,5)), hms_ms(*match.group(6,7,8,9))
        if end <= start: raise ValueError('non-positive audio duration')
        title, artist = read_tags(path)
        if not title: raise ValueError('audio title tag missing')
        lrc = lyrics_root / (path.stem + '.lrc')
        if lrc.resolve(strict=True).parent != lyrics_root: raise ValueError('LRC escapes tagged directory')
        lyrics = parse_lrc(lrc)
        if lyrics[0]['t'] > end - start + .05: raise ValueError('lyrics start beyond audio end')
        absolute = catalog_epoch_ms_of(match.group(1)) + start
        ident = hashlib.sha256(path.stem.encode('utf-8')).hexdigest()
        audios.append(dict(id=ident,file=path.name,opus=path.stem+'.opus',title=apply_song_fmt(title,artist),startAt=absolute,duration=round(end-start,3),lyrics=lyrics,monthId=month_id(absolute)))
        sources[ident] = str(path)
    return dict(audios=audios, sources=sources)

if __name__ == '__main__':
    try: print(json.dumps(derive(*sys.argv[1:]), ensure_ascii=False))
    except Exception: sys.exit('Derivation failed: verify tagged filenames, title tags and same-stem UTF-8 LRC')
