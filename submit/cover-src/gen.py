import math
W,H=1600,900
# rays
cx,cy=1190,450
rays=[]
for i in range(140):
    a=i/140*2*math.pi
    r0=250+ (i%3)*8
    r1=330+ (37*i%11)*18
    rays.append(f'<line x1="{cx+r0*math.cos(a):.1f}" y1="{cy+r0*math.sin(a):.1f}" x2="{cx+r1*math.cos(a):.1f}" y2="{cy+r1*math.sin(a):.1f}"/>')
# bundles
for k,base in enumerate([-2.35,-0.7,0.75,2.45]):
    for j in range(22):
        a=base+(j-11)*0.012
        r0=200; r1=520+(j*29%7)*20
        rays.append(f'<line x1="{cx+r0*math.cos(a):.1f}" y1="{cy+r0*math.sin(a):.1f}" x2="{cx+r1*math.cos(a):.1f}" y2="{cy+r1*math.sin(a):.1f}" stroke-width="0.9"/>')
# hatching across the egg
hatch=[]
y=-200
while y<230:
    hatch.append(f'<line x1="-200" y1="{y}" x2="200" y2="{y-30}"/>')
    y+=5.5
egg="M0,-185 C 125,-185 160,25 160,70 C160,160 92,205 0,205 C -92,205 -160,160 -160,70 C -160,25 -125,-185 0,-185 Z"
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
 <radialGradient id="shade" cx="0.68" cy="0.72" r="0.75"><stop offset="0" stop-color="#fff"/><stop offset="0.55" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
 <mask id="m"><path d="{egg}" fill="url(#shade)"/></mask>
 <clipPath id="c"><path d="{egg}"/></clipPath>
 <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 -0.35"/></filter>
</defs>
<g stroke="#f2f2f2" stroke-width="1.3" opacity="0.85">{''.join(rays)}</g>
<circle cx="{cx}" cy="{cy}" r="236" fill="#0000f2"/>
<g transform="translate({cx},{cy+5})">
 <path d="{egg}" fill="#0000f2"/>
 <g clip-path="url(#c)" mask="url(#m)" stroke="#f2f2f2" stroke-width="2.6">{''.join(hatch)}</g>
 <g clip-path="url(#c)" stroke="#f2f2f2" stroke-width="0.7" opacity="0.6">{''.join(hatch[::2])}</g>
 <path d="{egg}" fill="none" stroke="#f2f2f2" stroke-width="2"/>
</g>
<rect width="{W}" height="{H}" filter="url(#grain)" opacity="0.16"/>
</svg>'''
open('/tmp/cover/art.svg','w').write(svg)
