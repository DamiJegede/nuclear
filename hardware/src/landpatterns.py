"""Documented land-pattern overrides; pad names preserve the device connections."""
import json
from pathlib import Path

def apply(packages, smd, rect_wires, label_texts):
    data = json.loads(Path(__file__).with_name("landpatterns.json").read_text())
    for name, p in data.items():
        el = [smd(n, x, y, w, h, cream=(n not in p.get("no_cream_pads",[]))) for n, x, y, w, h in p["pads"]]
        for x,y,w,h in p.get("paste_windows",[]):
            el.append(f'<rectangle x1="{x-w/2}" y1="{y-h/2}" x2="{x+w/2}" y2="{y+h/2}" layer="31"/>')
        w,h = p["body"]
        cx,cy=p.get("body_origin",[0,0])
        for n,x,y,drill,diam,shape,rot in p.get("through_pads",[]):
            el.append(f'<pad name="{n}" x="{x}" y="{y}" drill="{drill}" diameter="{diam}" shape="{shape}" rot="R{rot}"/>')
        for x1,y1,x2,y2,width in p.get("slot_paths",[]):
            el.append(f'<wire x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" width="{width}" layer="46"/>')
        el += rect_wires(cx-w/2,cy-h/2,cx+w/2,cy+h/2,.1,51) + label_texts(max(w,h)/2+.3)
        if name == "ESP32C3MINI1_PLACEHOLDER":
            # No copper or vias under the printed antenna on any board copper layer.
            for layer in (41,42,43):
                el.append('<polygon width="0.05" layer="%d"><vertex x="-6.6" y="2.9"/><vertex x="6.6" y="2.9"/><vertex x="6.6" y="8.3"/><vertex x="-6.6" y="8.3"/></polygon>' % layer)
        packages[name] = (p["description"] + " Source: " + p["source"], el)
