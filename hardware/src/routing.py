"""Replay reviewed copper as source data; reject it when placement or netlist changes."""
import hashlib,json
from pathlib import Path
import xml.etree.ElementTree as E

def fingerprint(root):
 b=root.find('.//board')
 els=[]
 for e in b.findall('elements/element'):
  els.append((e.get('name'),e.get('package'),round(float(e.get('x')),4),round(float(e.get('y')),4),e.get('rot','R0')))
 nets=sorted((s.get('name'),sorted((c.get('element'),c.get('pad')) for c in s.findall('contactref'))) for s in b.findall('signals/signal'))
 pkgs=[]
 for lib in b.findall('libraries/library'):
  for p in lib.findall('packages/package'):
   geometry=[]
   for c in p:
    if c.tag in ('smd','pad','hole'):
     attrs=dict(c.attrib)
     if c.tag in ('smd','pad'):attrs.setdefault('rot','R0')
     geometry.append((c.tag,sorted((k,round(float(v),4) if k in ('x','y','dx','dy','drill','diameter') else v) for k,v in attrs.items() if k in ('name','x','y','dx','dy','rot','layer','drill','diameter','shape'))))
   pkgs.append((p.get('name'),geometry))
 data=json.dumps([sorted(els),nets,sorted(pkgs)],sort_keys=True,separators=(',',':'))
 return hashlib.sha256(data.encode()).hexdigest()

def apply(path):
 snapshot=Path(__file__).with_name('routing.json')
 if not snapshot.exists():return
 data=json.loads(snapshot.read_text());r=E.parse(path);root=r.getroot()
 if fingerprint(root)!=data['fingerprint']:
  raise SystemExit('Routing is stale: component placement, pad geometry or netlist changed. Re-route and review before updating routing.json.')
 board=root.find('.//board')
 for tag in ('designrules','classes'):
  if tag in data:
   old=board.find(tag);idx=list(board).index(old);board.remove(old);board.insert(idx,E.fromstring(data[tag]))
 for s in root.findall('.//board/signals/signal'):
  for c in list(s):
   if c.tag in ('wire','via','polygon'):s.remove(c)
  for xml in data['signals'].get(s.get('name'),[]):s.append(E.fromstring(xml))
 r.write(path,encoding='utf-8',xml_declaration=True)
 print('Routing restored from routing.json; native Fusion DRC is required after any routing change.')
