from pathlib import Path
import xml.etree.ElementTree as E,math,sys,json
HERE=Path(__file__).resolve().parent; ROOT=HERE.parent
sys.path.insert(0,str(HERE));import layout as L,design as D
root=E.parse(ROOT/'fusion/orb.brd').getroot();pk={p.get('name'):p for p in root.iter('package')};nets={(c.get('element'),c.get('pad')):s.get('name') for s in root.iter('signal') for c in s.findall('contactref')};pads=[]
for el in root.iter('element'):
 a=el.get('rot');mirror='M' in a;rot=float(a.replace('M','').replace('R',''));co=math.cos(math.radians(rot));si=math.sin(math.radians(rot));ex=float(el.get('x'));ey=float(el.get('y'))
 for p in list(pk[el.get('package')].findall('smd'))+list(pk[el.get('package')].findall('pad')):
  x=float(p.get('x'));y=float(p.get('y'));pr=float(p.get('rot','R0')[1:]);w=float(p.get('dx',p.get('diameter','0')));h=float(p.get('dy',p.get('diameter','0')));w=w*2 if p.get('shape')=='long' else w;poly=L.rect(x,y,pr,w,h)
  poly=[(ex+((-x if mirror else x)*co-y*si),ey+((-x if mirror else x)*si+y*co)) for x,y in poly]
  pads.append(dict(ref=el.get('name'),pad=p.get('name'),side=(0 if p.tag=='pad' else (16 if mirror else 1)),net=nets.get((el.get('name'),p.get('name'))),poly=poly))
def sd(p,a,b):
 x,y=p;u,v=a;w,z=b;dx=w-u;dy=z-v;t=max(0,min(1,((x-u)*dx+(y-v)*dy)/(dx*dx+dy*dy)));return math.hypot(x-u-t*dx,y-v-t*dy)
def distance(a,b):
 if L.overlap(a,b,-1e-7):return 0.0
 return min(sd(p,q,r) for aa,bb in [(a,b),(b,a)] for p in aa for q,r in zip(bb,bb[1:]+bb[:1]))
clashes=[];minled=100.;ledpair=None
for i,a in enumerate(pads):
 for b in pads[i+1:]:
  if a['side'] and b['side'] and a['side']!=b['side']:continue
  # Only close pads need the exact polygon check.
  if min(x for x,y in a['poly']) > max(x for x,y in b['poly'])+1 or min(x for x,y in b['poly'])>max(x for x,y in a['poly'])+1:continue
  if min(y for x,y in a['poly']) > max(y for x,y in b['poly'])+1 or min(y for x,y in b['poly'])>max(y for x,y in a['poly'])+1:continue
  d=distance(a['poly'],b['poly'])
  if a['ref'].startswith('LED') and b['ref'].startswith('LED') and a['ref']!=b['ref'] and d<minled:minled=d;ledpair=[a['ref'],b['ref']]
  if d<.127-1e-5 and not(a['net'] and a['net']==b['net']):clashes.append([a['ref'],a['pad'],b['ref'],b['pad'],round(d,4)])
leds=[e for e in root.iter('element') if e.get('name').startswith('LED')];assert len(leds)==23
assert sum(float(e.get('y'))>0 and float(e.get('x'))>0 for e in leds)==5
assert sum(float(e.get('y'))>0 and float(e.get('x'))<0 for e in leds)==5
assert sum(float(e.get('y'))<0 for e in leds)==13
assert minled>=.25,(minled,ledpair)
assert not clashes,clashes[:20]
edge=min(34.5-math.hypot(x,y) for p in pads for x,y in p['poly']);assert edge>=.25,edge
assert not L.check()[0],L.check()[0]
# Detect recurrence of the fictional DLA exposed pad that shorted the former footprint.
assert {p.get('name') for p in pk['VSON10_2X3'].findall('smd')} == {str(i) for i in range(1,11)}
out={'led_count':23,'upper_right':5,'upper_left':5,'lower':13,'radii_mm':[27.5,31.5],'minimum_led_pad_gap_mm':minled,'minimum_gap_pair':ledpair,'different_net_pad_clearance_below_0_127_mm':clashes,'minimum_pad_edge_clearance_mm':edge,'courtyard_check':'passed','speaker_reserved_mm':list(L.SIZE['SPK_PADS']),'u5_pad_count':10,'note':'Geometric source-file audit only; Fusion DRC, routing, slot geometry and production verification still required.'}
(ROOT/'design/geometry-audit.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
