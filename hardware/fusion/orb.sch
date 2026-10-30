<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE eagle SYSTEM "eagle.dtd">
<eagle version="9.6.2">
<drawing>
<settings><setting alwaysvectorfont="no"/><setting verticaltext="up"/></settings>
<grid distance="0.1" unitdist="inch" unit="inch" style="lines" multiple="1" display="no" altdistance="0.01" altunitdist="inch" altunit="inch"/>
<layers>
<layer number="2" name="Route2" color="1" fill="1" visible="yes" active="yes"/>
<layer number="15" name="Route15" color="3" fill="1" visible="yes" active="yes"/>
<layer number="1" name="Top" color="4" fill="1" visible="yes" active="yes"/>
<layer number="16" name="Bottom" color="1" fill="1" visible="yes" active="yes"/>
<layer number="17" name="Pads" color="2" fill="1" visible="yes" active="yes"/>
<layer number="18" name="Vias" color="2" fill="1" visible="yes" active="yes"/>
<layer number="19" name="Unrouted" color="6" fill="1" visible="yes" active="yes"/>
<layer number="20" name="Dimension" color="15" fill="1" visible="yes" active="yes"/>
<layer number="21" name="tPlace" color="7" fill="1" visible="yes" active="yes"/>
<layer number="22" name="bPlace" color="7" fill="1" visible="yes" active="yes"/>
<layer number="25" name="tNames" color="7" fill="1" visible="yes" active="yes"/>
<layer number="26" name="bNames" color="7" fill="1" visible="yes" active="yes"/>
<layer number="27" name="tValues" color="7" fill="1" visible="yes" active="yes"/>
<layer number="28" name="bValues" color="7" fill="1" visible="yes" active="yes"/>
<layer number="29" name="tStop" color="7" fill="3" visible="no" active="yes"/>
<layer number="30" name="bStop" color="7" fill="6" visible="no" active="yes"/>
<layer number="31" name="tCream" color="7" fill="4" visible="no" active="yes"/>
<layer number="32" name="bCream" color="7" fill="5" visible="no" active="yes"/>
<layer number="39" name="tKeepout" color="4" fill="11" visible="yes" active="yes"/>
<layer number="40" name="bKeepout" color="1" fill="11" visible="yes" active="yes"/>
<layer number="41" name="tRestrict" color="4" fill="10" visible="yes" active="yes"/>
<layer number="42" name="bRestrict" color="1" fill="10" visible="yes" active="yes"/>
<layer number="43" name="vRestrict" color="2" fill="10" visible="yes" active="yes"/>
<layer number="44" name="Drills" color="7" fill="1" visible="no" active="yes"/>
<layer number="45" name="Holes" color="7" fill="1" visible="no" active="yes"/>
<layer number="46" name="Milling" color="3" fill="1" visible="yes" active="yes"/>
<layer number="51" name="tDocu" color="7" fill="1" visible="yes" active="yes"/>
<layer number="52" name="bDocu" color="7" fill="1" visible="yes" active="yes"/>
<layer number="91" name="Nets" color="2" fill="1" visible="yes" active="yes"/>
<layer number="92" name="Busses" color="1" fill="1" visible="yes" active="yes"/>
<layer number="93" name="Pins" color="2" fill="1" visible="no" active="yes"/>
<layer number="94" name="Symbols" color="4" fill="1" visible="yes" active="yes"/>
<layer number="95" name="Names" color="7" fill="1" visible="yes" active="yes"/>
<layer number="96" name="Values" color="7" fill="1" visible="yes" active="yes"/>
<layer number="97" name="Info" color="7" fill="1" visible="yes" active="yes"/>
<layer number="98" name="Guide" color="6" fill="1" visible="yes" active="yes"/>
</layers>
<schematic xreflabel="%F%N/%S.%C%R" xrefpart="/%S.%C%R">
<libraries>
<library name="orb">
<description>Orb main board parts: symbols from the datasheets, packages generic or PLACEHOLDER (see hardware/README.md)</description>
<packages>
<package name="ABM8_3225">
<description>Abracon ABM8 3225 crystal, four-pad prototype lands; verify supplier recommended layout before fabrication Source: https://www.mouser.com/pdfDocs/abracon-abm8-data.pdf</description>
<smd name="1" x="-1.1" y="-0.85" dx="1.2" dy="1.1" layer="1"/>
<smd name="2" x="1.1" y="-0.85" dx="1.2" dy="1.1" layer="1"/>
<smd name="3" x="1.1" y="0.85" dx="1.2" dy="1.1" layer="1"/>
<smd name="4" x="-1.1" y="0.85" dx="1.2" dy="1.1" layer="1"/>
<wire x1="-1.6" y1="-1.25" x2="1.6" y2="-1.25" width="0.1" layer="51"/>
<wire x1="1.6" y1="-1.25" x2="1.6" y2="1.25" width="0.1" layer="51"/>
<wire x1="1.6" y1="1.25" x2="-1.6" y2="1.25" width="0.1" layer="51"/>
<wire x1="-1.6" y1="1.25" x2="-1.6" y2="-1.25" width="0.1" layer="51"/>
<text x="-1.9" y="2.7" size="0.8" layer="25">&gt;NAME</text>
<text x="-1.9" y="-3.5" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="C0402">
<description>0402 chip, IPC nominal</description>
<smd name="1" x="-0.5" y="0" dx="0.6" dy="0.6" layer="1"/>
<smd name="2" x="0.5" y="0" dx="0.6" dy="0.6" layer="1"/>
<wire x1="-0.5" y1="-0.25" x2="0.5" y2="-0.25" width="0.1" layer="51"/>
<wire x1="0.5" y1="-0.25" x2="0.5" y2="0.25" width="0.1" layer="51"/>
<wire x1="0.5" y1="0.25" x2="-0.5" y2="0.25" width="0.1" layer="51"/>
<wire x1="-0.5" y1="0.25" x2="-0.5" y2="-0.25" width="0.1" layer="51"/>
<text x="-0.8" y="1.6" size="0.8" layer="25">&gt;NAME</text>
<text x="-0.8" y="-2.4" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="C0603">
<description>0603 chip, IPC nominal</description>
<smd name="1" x="-0.8" y="0" dx="0.9" dy="0.95" layer="1"/>
<smd name="2" x="0.8" y="0" dx="0.9" dy="0.95" layer="1"/>
<wire x1="-0.8" y1="-0.4" x2="0.8" y2="-0.4" width="0.1" layer="51"/>
<wire x1="0.8" y1="-0.4" x2="0.8" y2="0.4" width="0.1" layer="51"/>
<wire x1="0.8" y1="0.4" x2="-0.8" y2="0.4" width="0.1" layer="51"/>
<wire x1="-0.8" y1="0.4" x2="-0.8" y2="-0.4" width="0.1" layer="51"/>
<text x="-1.1" y="1.9" size="0.8" layer="25">&gt;NAME</text>
<text x="-1.1" y="-2.7" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="CPOL7343">
<description>7343 (D case) polymer/tantalum, generic land pattern</description>
<smd name="1" x="-3" y="0" dx="2.4" dy="2.4" layer="1"/>
<smd name="2" x="3" y="0" dx="2.4" dy="2.4" layer="1"/>
<wire x1="-3.65" y1="-2.15" x2="3.65" y2="-2.15" width="0.1" layer="51"/>
<wire x1="3.65" y1="-2.15" x2="3.65" y2="2.15" width="0.1" layer="51"/>
<wire x1="3.65" y1="2.15" x2="-3.65" y2="2.15" width="0.1" layer="51"/>
<wire x1="-3.65" y1="2.15" x2="-3.65" y2="-2.15" width="0.1" layer="51"/>
<text x="-3.95" y="4.75" size="0.8" layer="25">&gt;NAME</text>
<text x="-3.95" y="-5.55" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="ESP32C3_QFN32">
<description>ESP32-C3FH4X QFN32: nominal prototype lands derived from 5x5 package drawing, 0.5 pitch, 3.7 exposed pad. Confirm against manufacturer DXF and stencil before release. Source: https://documentation.espressif.com/esp32-c3_datasheet_en.html</description>
<smd name="1" x="-2.45" y="1.75" dx="0.7" dy="0.25" layer="1"/>
<smd name="2" x="-2.45" y="1.25" dx="0.7" dy="0.25" layer="1"/>
<smd name="3" x="-2.45" y="0.75" dx="0.7" dy="0.25" layer="1"/>
<smd name="4" x="-2.45" y="0.25" dx="0.7" dy="0.25" layer="1"/>
<smd name="5" x="-2.45" y="-0.25" dx="0.7" dy="0.25" layer="1"/>
<smd name="6" x="-2.45" y="-0.75" dx="0.7" dy="0.25" layer="1"/>
<smd name="7" x="-2.45" y="-1.25" dx="0.7" dy="0.25" layer="1"/>
<smd name="8" x="-2.45" y="-1.75" dx="0.7" dy="0.25" layer="1"/>
<smd name="9" x="-1.75" y="-2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="10" x="-1.25" y="-2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="11" x="-0.75" y="-2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="12" x="-0.25" y="-2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="13" x="0.25" y="-2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="14" x="0.75" y="-2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="15" x="1.25" y="-2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="16" x="1.75" y="-2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="17" x="2.45" y="-1.75" dx="0.7" dy="0.25" layer="1"/>
<smd name="18" x="2.45" y="-1.25" dx="0.7" dy="0.25" layer="1"/>
<smd name="19" x="2.45" y="-0.75" dx="0.7" dy="0.25" layer="1"/>
<smd name="20" x="2.45" y="-0.25" dx="0.7" dy="0.25" layer="1"/>
<smd name="21" x="2.45" y="0.25" dx="0.7" dy="0.25" layer="1"/>
<smd name="22" x="2.45" y="0.75" dx="0.7" dy="0.25" layer="1"/>
<smd name="23" x="2.45" y="1.25" dx="0.7" dy="0.25" layer="1"/>
<smd name="24" x="2.45" y="1.75" dx="0.7" dy="0.25" layer="1"/>
<smd name="25" x="1.75" y="2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="26" x="1.25" y="2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="27" x="0.75" y="2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="28" x="0.25" y="2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="29" x="-0.25" y="2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="30" x="-0.75" y="2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="31" x="-1.25" y="2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="32" x="-1.75" y="2.45" dx="0.25" dy="0.7" layer="1"/>
<smd name="33" x="0" y="0" dx="3.7" dy="3.7" layer="1" cream="no"/>
<rectangle x1="-1.6" y1="-1.6" x2="-0.20000000000000007" y2="-0.20000000000000007" layer="31"/>
<rectangle x1="-1.6" y1="0.20000000000000007" x2="-0.20000000000000007" y2="1.6" layer="31"/>
<rectangle x1="0.20000000000000007" y1="-1.6" x2="1.6" y2="-0.20000000000000007" layer="31"/>
<rectangle x1="0.20000000000000007" y1="0.20000000000000007" x2="1.6" y2="1.6" layer="31"/>
<wire x1="-2.5" y1="-2.5" x2="2.5" y2="-2.5" width="0.1" layer="51"/>
<wire x1="2.5" y1="-2.5" x2="2.5" y2="2.5" width="0.1" layer="51"/>
<wire x1="2.5" y1="2.5" x2="-2.5" y2="2.5" width="0.1" layer="51"/>
<wire x1="-2.5" y1="2.5" x2="-2.5" y2="-2.5" width="0.1" layer="51"/>
<text x="-2.8" y="3.6" size="0.8" layer="25">&gt;NAME</text>
<text x="-2.8" y="-4.4" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="FPC4_PLACEHOLDER">
<description>Hirose FH19C-4S-0.5SH(10), EDC3-155218-02 sheets 1 and 3: bottom contact, 0.2 mm tail, mouth +Y. Pad order rotated 180 degrees from vendor drawing. Metal fitting lands M1/M2 are ground. Source: https://www.hirose.com/en/product/p/CL0580-0410-1-10</description>
<smd name="1" x="0.75" y="-1.25" dx="0.3" dy="0.8" layer="1"/>
<smd name="2" x="0.25" y="-1.25" dx="0.3" dy="0.8" layer="1"/>
<smd name="3" x="-0.25" y="-1.25" dx="0.3" dy="0.8" layer="1"/>
<smd name="4" x="-0.75" y="-1.25" dx="0.3" dy="0.8" layer="1"/>
<smd name="M1" x="-1.75" y="1.25" dx="0.4" dy="0.8" layer="1"/>
<smd name="M2" x="1.75" y="1.25" dx="0.4" dy="0.8" layer="1"/>
<wire x1="-2" y1="-1.5" x2="2" y2="-1.5" width="0.1" layer="51"/>
<wire x1="2" y1="-1.5" x2="2" y2="1.5" width="0.1" layer="51"/>
<wire x1="2" y1="1.5" x2="-2" y2="1.5" width="0.1" layer="51"/>
<wire x1="-2" y1="1.5" x2="-2" y2="-1.5" width="0.1" layer="51"/>
<text x="-2.3" y="3.1" size="0.8" layer="25">&gt;NAME</text>
<text x="-2.3" y="-3.9" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="HVQFN40_6X6">
<description>HVQFN40 6 x 6 mm, 0.5 mm pitch, exposed pad 4.5 x 4.5 (SOT618-1). IPC-style pads: verify against the NXP land pattern</description>
<smd name="1" x="-3.1" y="2.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="2" x="-3.1" y="1.75" dx="0.85" dy="0.25" layer="1"/>
<smd name="3" x="-3.1" y="1.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="4" x="-3.1" y="0.75" dx="0.85" dy="0.25" layer="1"/>
<smd name="5" x="-3.1" y="0.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="6" x="-3.1" y="-0.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="7" x="-3.1" y="-0.75" dx="0.85" dy="0.25" layer="1"/>
<smd name="8" x="-3.1" y="-1.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="9" x="-3.1" y="-1.75" dx="0.85" dy="0.25" layer="1"/>
<smd name="10" x="-3.1" y="-2.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="11" x="-2.25" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="12" x="-1.75" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="13" x="-1.25" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="14" x="-0.75" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="15" x="-0.25" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="16" x="0.25" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="17" x="0.75" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="18" x="1.25" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="19" x="1.75" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="20" x="2.25" y="-3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="21" x="3.1" y="-2.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="22" x="3.1" y="-1.75" dx="0.85" dy="0.25" layer="1"/>
<smd name="23" x="3.1" y="-1.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="24" x="3.1" y="-0.75" dx="0.85" dy="0.25" layer="1"/>
<smd name="25" x="3.1" y="-0.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="26" x="3.1" y="0.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="27" x="3.1" y="0.75" dx="0.85" dy="0.25" layer="1"/>
<smd name="28" x="3.1" y="1.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="29" x="3.1" y="1.75" dx="0.85" dy="0.25" layer="1"/>
<smd name="30" x="3.1" y="2.25" dx="0.85" dy="0.25" layer="1"/>
<smd name="31" x="2.25" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="32" x="1.75" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="33" x="1.25" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="34" x="0.75" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="35" x="0.25" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="36" x="-0.25" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="37" x="-0.75" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="38" x="-1.25" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="39" x="-1.75" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="40" x="-2.25" y="3.1" dx="0.25" dy="0.85" layer="1"/>
<smd name="41" x="0" y="0" dx="4.5" dy="4.5" layer="1" cream="no"/>
<wire x1="-3" y1="-3" x2="3" y2="-3" width="0.1" layer="51"/>
<wire x1="3" y1="-3" x2="3" y2="3" width="0.1" layer="51"/>
<wire x1="3" y1="3" x2="-3" y2="3" width="0.1" layer="51"/>
<wire x1="-3" y1="3" x2="-3" y2="-3" width="0.1" layer="51"/>
<wire x1="-3" y1="2.4" x2="-2.4" y2="3" width="0.1" layer="21"/>
<text x="-3.5" y="4.3" size="0.8" layer="25">&gt;NAME</text>
<text x="-3.5" y="-5.1" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="JOHANSON_2450AT18D">
<description>Johanson 2450AT18D0100001E Rev5 thin-edge pads: 1x0.6 mm, column centres 3 mm, row centres 1.3 mm. Pad1 feed, 2/4 GND, 3 tuning return. Source: https://www.johansontechnology.com/docs/3791/Antenna-2450AT18D0100001E-Rev5.0.pdf</description>
<smd name="1" x="-1.5" y="-0.65" dx="1" dy="0.6" layer="1"/>
<smd name="2" x="1.5" y="-0.65" dx="1" dy="0.6" layer="1"/>
<smd name="3" x="1.5" y="0.65" dx="1" dy="0.6" layer="1"/>
<smd name="4" x="-1.5" y="0.65" dx="1" dy="0.6" layer="1"/>
<wire x1="-1.6" y1="-0.8" x2="1.6" y2="-0.8" width="0.1" layer="51"/>
<wire x1="1.6" y1="-0.8" x2="1.6" y2="0.8" width="0.1" layer="51"/>
<wire x1="1.6" y1="0.8" x2="-1.6" y2="0.8" width="0.1" layer="51"/>
<wire x1="-1.6" y1="0.8" x2="-1.6" y2="-0.8" width="0.1" layer="51"/>
<text x="-1.9" y="2.7" size="0.8" layer="25">&gt;NAME</text>
<text x="-1.9" y="-3.5" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="JST_S2B_PH_SM4_TB">
<description>JST PH S2B-PH-SM4-TB land pattern from KiCad, derived from JST PH drawing. 1/2 signal lands 1 x 3.5 mm, mechanical lands 1.5 x 3.4 mm. Verify pin-1 polarity against the assembled cable. Source: https://www.jst-mfg.com/product/pdf/eng/ePH.pdf</description>
<smd name="1" x="-1" y="2.85" dx="1" dy="3.5" layer="1"/>
<smd name="2" x="1" y="2.85" dx="1" dy="3.5" layer="1"/>
<smd name="S1" x="-3.35" y="-2.9" dx="1.5" dy="3.4" layer="1"/>
<smd name="S2" x="3.35" y="-2.9" dx="1.5" dy="3.4" layer="1"/>
<wire x1="-3.95" y1="-3.8" x2="3.95" y2="-3.8" width="0.1" layer="51"/>
<wire x1="3.95" y1="-3.8" x2="3.95" y2="3.8" width="0.1" layer="51"/>
<wire x1="3.95" y1="3.8" x2="-3.95" y2="3.8" width="0.1" layer="51"/>
<wire x1="-3.95" y1="3.8" x2="-3.95" y2="-3.8" width="0.1" layer="51"/>
<text x="-4.25" y="5.05" size="0.8" layer="25">&gt;NAME</text>
<text x="-4.25" y="-5.85" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="L0402">
<description>0402 chip, IPC nominal</description>
<smd name="1" x="-0.5" y="0" dx="0.6" dy="0.6" layer="1"/>
<smd name="2" x="0.5" y="0" dx="0.6" dy="0.6" layer="1"/>
<wire x1="-0.5" y1="-0.25" x2="0.5" y2="-0.25" width="0.1" layer="51"/>
<wire x1="0.5" y1="-0.25" x2="0.5" y2="0.25" width="0.1" layer="51"/>
<wire x1="0.5" y1="0.25" x2="-0.5" y2="0.25" width="0.1" layer="51"/>
<wire x1="-0.5" y1="0.25" x2="-0.5" y2="-0.25" width="0.1" layer="51"/>
<text x="-0.8" y="1.6" size="0.8" layer="25">&gt;NAME</text>
<text x="-0.8" y="-2.4" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="L2016">
<description>2.0 x 1.6 mm power inductor, generic land pattern (replace with the chosen part's)</description>
<smd name="1" x="-0.95" y="0" dx="1" dy="1.6" layer="1"/>
<smd name="2" x="0.95" y="0" dx="1" dy="1.6" layer="1"/>
<wire x1="-1" y1="-0.8" x2="1" y2="-0.8" width="0.1" layer="51"/>
<wire x1="1" y1="-0.8" x2="1" y2="0.8" width="0.1" layer="51"/>
<wire x1="1" y1="0.8" x2="-1" y2="0.8" width="0.1" layer="51"/>
<wire x1="-1" y1="0.8" x2="-1" y2="-0.8" width="0.1" layer="51"/>
<text x="-1.3" y="2.1" size="0.8" layer="25">&gt;NAME</text>
<text x="-1.3" y="-2.9" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="R0402">
<description>0402 chip, IPC nominal</description>
<smd name="1" x="-0.5" y="0" dx="0.6" dy="0.6" layer="1"/>
<smd name="2" x="0.5" y="0" dx="0.6" dy="0.6" layer="1"/>
<wire x1="-0.5" y1="-0.25" x2="0.5" y2="-0.25" width="0.1" layer="51"/>
<wire x1="0.5" y1="-0.25" x2="0.5" y2="0.25" width="0.1" layer="51"/>
<wire x1="0.5" y1="0.25" x2="-0.5" y2="0.25" width="0.1" layer="51"/>
<wire x1="-0.5" y1="0.25" x2="-0.5" y2="-0.25" width="0.1" layer="51"/>
<text x="-0.8" y="1.6" size="0.8" layer="25">&gt;NAME</text>
<text x="-0.8" y="-2.4" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="SOT23_5">
<description>SOT-23-5, 0.95 mm pitch (JEDEC MO-178), generic land pattern</description>
<smd name="1" x="-0.95" y="-1.25" dx="0.6" dy="1.1" layer="1"/>
<smd name="2" x="0" y="-1.25" dx="0.6" dy="1.1" layer="1"/>
<smd name="3" x="0.95" y="-1.25" dx="0.6" dy="1.1" layer="1"/>
<smd name="4" x="0.95" y="1.25" dx="0.6" dy="1.1" layer="1"/>
<smd name="5" x="-0.95" y="1.25" dx="0.6" dy="1.1" layer="1"/>
<wire x1="-1.5" y1="-0.8" x2="1.5" y2="-0.8" width="0.1" layer="51"/>
<wire x1="1.5" y1="-0.8" x2="1.5" y2="0.8" width="0.1" layer="51"/>
<wire x1="1.5" y1="0.8" x2="-1.5" y2="0.8" width="0.1" layer="51"/>
<wire x1="-1.5" y1="0.8" x2="-1.5" y2="-0.8" width="0.1" layer="51"/>
<text x="-2.2" y="3" size="0.8" layer="25">&gt;NAME</text>
<text x="-2.2" y="-3.8" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="SOT23_6">
<description>SOT-23-6, 0.95 mm pitch (JEDEC MO-178), generic land pattern</description>
<smd name="1" x="-0.95" y="-1.25" dx="0.6" dy="1.1" layer="1"/>
<smd name="2" x="0" y="-1.25" dx="0.6" dy="1.1" layer="1"/>
<smd name="3" x="0.95" y="-1.25" dx="0.6" dy="1.1" layer="1"/>
<smd name="4" x="0.95" y="1.25" dx="0.6" dy="1.1" layer="1"/>
<smd name="5" x="0" y="1.25" dx="0.6" dy="1.1" layer="1"/>
<smd name="6" x="-0.95" y="1.25" dx="0.6" dy="1.1" layer="1"/>
<wire x1="-1.5" y1="-0.8" x2="1.5" y2="-0.8" width="0.1" layer="51"/>
<wire x1="1.5" y1="-0.8" x2="1.5" y2="0.8" width="0.1" layer="51"/>
<wire x1="1.5" y1="0.8" x2="-1.5" y2="0.8" width="0.1" layer="51"/>
<wire x1="-1.5" y1="0.8" x2="-1.5" y2="-0.8" width="0.1" layer="51"/>
<text x="-2.2" y="3" size="0.8" layer="25">&gt;NAME</text>
<text x="-2.2" y="-3.8" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="SPK_PADS">
<description>CMS-151103-088SP board-mounted 15 x 11 mm body; adhesive mounting and short hand-soldered leads to accessible pads, not reflow SMT</description>
<smd name="1" x="-8.5" y="0" dx="1.5" dy="2" layer="1"/>
<smd name="2" x="8.5" y="0" dx="1.5" dy="2" layer="1"/>
<wire x1="-7.5" y1="-5.5" x2="7.5" y2="-5.5" width="0.1" layer="51"/>
<wire x1="7.5" y1="-5.5" x2="7.5" y2="5.5" width="0.1" layer="51"/>
<wire x1="7.5" y1="5.5" x2="-7.5" y2="5.5" width="0.1" layer="51"/>
<wire x1="-7.5" y1="5.5" x2="-7.5" y2="-5.5" width="0.1" layer="51"/>
<text x="-7.8" y="8.6" size="0.8" layer="25">&gt;NAME</text>
<text x="-7.8" y="-9.4" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="TDFN8_2X2">
<description>TDFN-8 2 x 2 mm, 0.5 mm pitch, exposed pad. IPC-style pads: verify against the Analog Devices land pattern (pad 9 = EP)</description>
<smd name="1" x="-0.95" y="0.75" dx="0.55" dy="0.28" layer="1"/>
<smd name="2" x="-0.95" y="0.25" dx="0.55" dy="0.28" layer="1"/>
<smd name="3" x="-0.95" y="-0.25" dx="0.55" dy="0.28" layer="1"/>
<smd name="4" x="-0.95" y="-0.75" dx="0.55" dy="0.28" layer="1"/>
<smd name="5" x="0.95" y="-0.75" dx="0.55" dy="0.28" layer="1"/>
<smd name="6" x="0.95" y="-0.25" dx="0.55" dy="0.28" layer="1"/>
<smd name="7" x="0.95" y="0.25" dx="0.55" dy="0.28" layer="1"/>
<smd name="8" x="0.95" y="0.75" dx="0.55" dy="0.28" layer="1"/>
<smd name="9" x="0" y="0" dx="0.9" dy="1.5" layer="1" cream="no"/>
<wire x1="-1" y1="-1" x2="1" y2="-1" width="0.1" layer="51"/>
<wire x1="1" y1="-1" x2="1" y2="1" width="0.1" layer="51"/>
<wire x1="1" y1="1" x2="-1" y2="1" width="0.1" layer="51"/>
<wire x1="-1" y1="1" x2="-1" y2="-1" width="0.1" layer="51"/>
<wire x1="-1" y1="0.6" x2="-0.6" y2="1" width="0.1" layer="21"/>
<text x="-1.5" y="2.3" size="0.8" layer="25">&gt;NAME</text>
<text x="-1.5" y="-3.1" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="TP1MM">
<description>1 mm test pad</description>
<smd name="1" x="0" y="0" dx="1" dy="1" layer="1" cream="no"/>
<text x="-1" y="1.8" size="0.8" layer="25">&gt;NAME</text>
<text x="-1" y="-2.6" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="TQFN16_3X3">
<description>TQFN-16 3 x 3 mm, 0.5 mm pitch, exposed pad 1.7 x 1.7. IPC-style pads: verify against the Analog Devices land pattern</description>
<smd name="1" x="-1.6" y="0.75" dx="0.6" dy="0.28" layer="1"/>
<smd name="2" x="-1.6" y="0.25" dx="0.6" dy="0.28" layer="1"/>
<smd name="3" x="-1.6" y="-0.25" dx="0.6" dy="0.28" layer="1"/>
<smd name="4" x="-1.6" y="-0.75" dx="0.6" dy="0.28" layer="1"/>
<smd name="5" x="-0.75" y="-1.6" dx="0.28" dy="0.6" layer="1"/>
<smd name="6" x="-0.25" y="-1.6" dx="0.28" dy="0.6" layer="1"/>
<smd name="7" x="0.25" y="-1.6" dx="0.28" dy="0.6" layer="1"/>
<smd name="8" x="0.75" y="-1.6" dx="0.28" dy="0.6" layer="1"/>
<smd name="9" x="1.6" y="-0.75" dx="0.6" dy="0.28" layer="1"/>
<smd name="10" x="1.6" y="-0.25" dx="0.6" dy="0.28" layer="1"/>
<smd name="11" x="1.6" y="0.25" dx="0.6" dy="0.28" layer="1"/>
<smd name="12" x="1.6" y="0.75" dx="0.6" dy="0.28" layer="1"/>
<smd name="13" x="0.75" y="1.6" dx="0.28" dy="0.6" layer="1"/>
<smd name="14" x="0.25" y="1.6" dx="0.28" dy="0.6" layer="1"/>
<smd name="15" x="-0.25" y="1.6" dx="0.28" dy="0.6" layer="1"/>
<smd name="16" x="-0.75" y="1.6" dx="0.28" dy="0.6" layer="1"/>
<smd name="17" x="0" y="0" dx="1.7" dy="1.7" layer="1" cream="no"/>
<wire x1="-1.5" y1="-1.5" x2="1.5" y2="-1.5" width="0.1" layer="51"/>
<wire x1="1.5" y1="-1.5" x2="1.5" y2="1.5" width="0.1" layer="51"/>
<wire x1="1.5" y1="1.5" x2="-1.5" y2="1.5" width="0.1" layer="51"/>
<wire x1="-1.5" y1="1.5" x2="-1.5" y2="-1.5" width="0.1" layer="51"/>
<wire x1="-1.5" y1="0.9" x2="-0.9" y2="1.5" width="0.1" layer="21"/>
<text x="-2" y="2.8" size="0.8" layer="25">&gt;NAME</text>
<text x="-2" y="-3.6" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="USBC24_TE2345986">
<description>TE 2345986-1 drawing ENG_CD_2345986_C, recommended PCB land pattern rotated to mouth +Y. Origin is the manufacturer PCB-edge/front-face reference; pad rows -7.875/-6.525 mm. Slotted mount representation uses plated drill anchors plus layer-46 milling; fabricator must verify L-slot/annular geometry before release. Rear ground copper deliberately enlarged for slot annulus. Source: https://www.te.com/en/product-2345986-1.html</description>
<smd name="A1" x="2.625" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A2" x="2.125" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A3" x="1.625" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A4" x="1.125" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A5" x="0.625" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A6" x="0.125" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A7" x="-0.375" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A8" x="-0.875" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A9" x="-1.375" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A10" x="-1.875" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A11" x="-2.375" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="A12" x="-2.875" y="-7.875" dx="0.3" dy="0.95" layer="1"/>
<smd name="B1" x="-2.625" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B2" x="-2.125" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B3" x="-1.625" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B4" x="-1.125" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B5" x="-0.625" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B6" x="-0.125" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B7" x="0.375" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B8" x="0.875" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B9" x="1.375" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B10" x="1.875" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B11" x="2.375" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<smd name="B12" x="2.875" y="-6.525" dx="0.3" dy="0.85" layer="1"/>
<pad name="S1" x="-4.32" y="-7.25" drill="0.6" diameter="2.7" shape="square" rot="R0"/>
<pad name="S2" x="4.32" y="-7.25" drill="0.6" diameter="2.7" shape="square" rot="R0"/>
<pad name="S3" x="-4.32" y="-2.7" drill="0.6" diameter="1.075" shape="long" rot="R90"/>
<pad name="S4" x="4.32" y="-2.7" drill="0.6" diameter="1.075" shape="long" rot="R90"/>
<wire x1="-4.32" y1="-7.75" x2="-4.32" y2="-6.75" width="0.6" layer="46"/>
<wire x1="4.32" y1="-7.75" x2="4.32" y2="-6.75" width="0.6" layer="46"/>
<wire x1="-4.32" y1="-6.75" x2="-3.4" y2="-6.75" width="0.6" layer="46"/>
<wire x1="4.32" y1="-6.75" x2="3.4" y2="-6.75" width="0.6" layer="46"/>
<wire x1="-4.32" y1="-3.35" x2="-4.32" y2="-2.05" width="0.6" layer="46"/>
<wire x1="4.32" y1="-3.35" x2="4.32" y2="-2.05" width="0.6" layer="46"/>
<wire x1="-4.47" y1="-7.9" x2="4.47" y2="-7.9" width="0.1" layer="51"/>
<wire x1="4.47" y1="-7.9" x2="4.47" y2="0" width="0.1" layer="51"/>
<wire x1="4.47" y1="0" x2="-4.47" y2="0" width="0.1" layer="51"/>
<wire x1="-4.47" y1="0" x2="-4.47" y2="-7.9" width="0.1" layer="51"/>
<text x="-4.77" y="5.57" size="0.8" layer="25">&gt;NAME</text>
<text x="-4.77" y="-6.37" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="VQFN16_3X3">
<description>TI BQ24074 RGT0016C land pattern, drawing 4222419/E, July 2025. Exposed pad requires a production stencil and thermal-via review. Source: https://www.ti.com/lit/ds/symlink/bq24074.pdf</description>
<smd name="1" x="-1.4" y="0.75" dx="0.6" dy="0.24" layer="1"/>
<smd name="5" x="-0.75" y="-1.4" dx="0.24" dy="0.6" layer="1"/>
<smd name="9" x="1.4" y="-0.75" dx="0.6" dy="0.24" layer="1"/>
<smd name="13" x="0.75" y="1.4" dx="0.24" dy="0.6" layer="1"/>
<smd name="2" x="-1.4" y="0.25" dx="0.6" dy="0.24" layer="1"/>
<smd name="6" x="-0.25" y="-1.4" dx="0.24" dy="0.6" layer="1"/>
<smd name="10" x="1.4" y="-0.25" dx="0.6" dy="0.24" layer="1"/>
<smd name="14" x="0.25" y="1.4" dx="0.24" dy="0.6" layer="1"/>
<smd name="3" x="-1.4" y="-0.25" dx="0.6" dy="0.24" layer="1"/>
<smd name="7" x="0.25" y="-1.4" dx="0.24" dy="0.6" layer="1"/>
<smd name="11" x="1.4" y="0.25" dx="0.6" dy="0.24" layer="1"/>
<smd name="15" x="-0.25" y="1.4" dx="0.24" dy="0.6" layer="1"/>
<smd name="4" x="-1.4" y="-0.75" dx="0.6" dy="0.24" layer="1"/>
<smd name="8" x="0.75" y="-1.4" dx="0.24" dy="0.6" layer="1"/>
<smd name="12" x="1.4" y="0.75" dx="0.6" dy="0.24" layer="1"/>
<smd name="16" x="-0.75" y="1.4" dx="0.24" dy="0.6" layer="1"/>
<smd name="17" x="0" y="0" dx="1.68" dy="1.68" layer="1"/>
<wire x1="-1.5" y1="-1.5" x2="1.5" y2="-1.5" width="0.1" layer="51"/>
<wire x1="1.5" y1="-1.5" x2="1.5" y2="1.5" width="0.1" layer="51"/>
<wire x1="1.5" y1="1.5" x2="-1.5" y2="1.5" width="0.1" layer="51"/>
<wire x1="-1.5" y1="1.5" x2="-1.5" y2="-1.5" width="0.1" layer="51"/>
<text x="-1.8" y="2.6" size="0.8" layer="25">&gt;NAME</text>
<text x="-1.8" y="-3.4" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="VSON10_2X3">
<description>TI TPS63802 DLA0010A, drawing 4223750/D land pattern. 2 x 3 mm body; asymmetric ten-lead package, no pad 11. Source: https://www.ti.com/lit/ds/symlink/tps63802.pdf</description>
<smd name="1" x="-0.9" y="1" dx="0.6" dy="0.25" layer="1"/>
<smd name="2" x="-0.9" y="0.5" dx="0.6" dy="0.25" layer="1"/>
<smd name="3" x="-0.9" y="0" dx="0.6" dy="0.25" layer="1"/>
<smd name="4" x="-0.9" y="-0.5" dx="0.6" dy="0.25" layer="1"/>
<smd name="5" x="-0.9" y="-1" dx="0.6" dy="0.25" layer="1"/>
<smd name="6" x="0.75" y="-1" dx="0.9" dy="0.25" layer="1"/>
<smd name="7" x="0.75" y="-0.5" dx="0.9" dy="0.25" layer="1"/>
<smd name="8" x="0.55" y="0" dx="1.3" dy="0.25" layer="1"/>
<smd name="9" x="0.75" y="0.5" dx="0.9" dy="0.25" layer="1"/>
<smd name="10" x="0.75" y="1" dx="0.9" dy="0.25" layer="1"/>
<wire x1="-1" y1="-1.5" x2="1" y2="-1.5" width="0.1" layer="51"/>
<wire x1="1" y1="-1.5" x2="1" y2="1.5" width="0.1" layer="51"/>
<wire x1="1" y1="1.5" x2="-1" y2="1.5" width="0.1" layer="51"/>
<wire x1="-1" y1="1.5" x2="-1" y2="-1.5" width="0.1" layer="51"/>
<text x="-1.8" y="2.6" size="0.8" layer="25">&gt;NAME</text>
<text x="-1.8" y="-3.4" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="WS2812B_5050">
<description>WS2812B 5050 4-pad PLCC (KiCad-style pad order: 1 VDD top-left, 2 DOUT bottom-left, 3 GND bottom-right, 4 DIN top-right). VERIFY against the datasheet and revision</description>
<smd name="1" x="-2.45" y="1.6" dx="1.5" dy="0.9" layer="1"/>
<smd name="2" x="-2.45" y="-1.6" dx="1.5" dy="0.9" layer="1"/>
<smd name="3" x="2.45" y="-1.6" dx="1.5" dy="0.9" layer="1"/>
<smd name="4" x="2.45" y="1.6" dx="1.5" dy="0.9" layer="1"/>
<wire x1="-2.5" y1="-2.5" x2="2.5" y2="-2.5" width="0.1" layer="51"/>
<wire x1="2.5" y1="-2.5" x2="2.5" y2="2.5" width="0.1" layer="51"/>
<wire x1="2.5" y1="2.5" x2="-2.5" y2="2.5" width="0.1" layer="51"/>
<wire x1="-2.5" y1="2.5" x2="-2.5" y2="-2.5" width="0.1" layer="51"/>
<wire x1="-2.5" y1="2.5" x2="2.5" y2="2.5" width="0.12" layer="21"/>
<wire x1="-2.5" y1="-2.5" x2="2.5" y2="-2.5" width="0.12" layer="21"/>
<wire x1="-2.5" y1="2.5" x2="-1.5" y2="2.5" width="0.3" layer="21"/>
<text x="-3.2" y="4" size="0.8" layer="25">&gt;NAME</text>
<text x="-3.2" y="-4.8" size="0.8" layer="27">&gt;VALUE</text>
</package>
<package name="XTAL2016">
<description>2.0 x 1.6 mm 4-pad crystal, generic land pattern (replace with the chosen crystal's)</description>
<smd name="1" x="-0.7" y="-0.55" dx="0.9" dy="0.7" layer="1"/>
<smd name="2" x="0.7" y="-0.55" dx="0.9" dy="0.7" layer="1"/>
<smd name="3" x="0.7" y="0.55" dx="0.9" dy="0.7" layer="1"/>
<smd name="4" x="-0.7" y="0.55" dx="0.9" dy="0.7" layer="1"/>
<wire x1="-1" y1="-0.8" x2="1" y2="-0.8" width="0.1" layer="51"/>
<wire x1="1" y1="-0.8" x2="1" y2="0.8" width="0.1" layer="51"/>
<wire x1="1" y1="0.8" x2="-1" y2="0.8" width="0.1" layer="51"/>
<wire x1="-1" y1="0.8" x2="-1" y2="-0.8" width="0.1" layer="51"/>
<text x="-1.2" y="2" size="0.8" layer="25">&gt;NAME</text>
<text x="-1.2" y="-2.8" size="0.8" layer="27">&gt;VALUE</text>
</package>
</packages>
<symbols>
<symbol name="R">
<wire x1="-2.54" y1="-2.54" x2="2.54" y2="-2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="-2.54" x2="2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="2.54" x2="-2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="-2.54" y1="2.54" x2="-2.54" y2="-2.54" width="0.254" layer="94"/>
<pin name="1" x="-7.62" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="2" x="7.62" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-2.54" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<text x="-2.54" y="-6.35" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="C">
<wire x1="-2.54" y1="-2.54" x2="2.54" y2="-2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="-2.54" x2="2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="2.54" x2="-2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="-2.54" y1="2.54" x2="-2.54" y2="-2.54" width="0.254" layer="94"/>
<pin name="1" x="-7.62" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="2" x="7.62" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-2.54" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<text x="-2.54" y="-6.35" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="C0603">
<wire x1="-2.54" y1="-2.54" x2="2.54" y2="-2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="-2.54" x2="2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="2.54" x2="-2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="-2.54" y1="2.54" x2="-2.54" y2="-2.54" width="0.254" layer="94"/>
<pin name="1" x="-7.62" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="2" x="7.62" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-2.54" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<text x="-2.54" y="-6.35" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="CPOL">
<wire x1="-2.54" y1="-2.54" x2="2.54" y2="-2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="-2.54" x2="2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="2.54" x2="-2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="-2.54" y1="2.54" x2="-2.54" y2="-2.54" width="0.254" layer="94"/>
<pin name="P" x="-7.62" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="N" x="7.62" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-2.54" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<text x="-2.54" y="-6.35" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="L">
<wire x1="-2.54" y1="-2.54" x2="2.54" y2="-2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="-2.54" x2="2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="2.54" x2="-2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="-2.54" y1="2.54" x2="-2.54" y2="-2.54" width="0.254" layer="94"/>
<pin name="1" x="-7.62" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="2" x="7.62" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-2.54" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<text x="-2.54" y="-6.35" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="L_PWR">
<wire x1="-2.54" y1="-2.54" x2="2.54" y2="-2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="-2.54" x2="2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="2.54" x2="-2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="-2.54" y1="2.54" x2="-2.54" y2="-2.54" width="0.254" layer="94"/>
<pin name="1" x="-7.62" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="2" x="7.62" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-2.54" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<text x="-2.54" y="-6.35" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="TP">
<wire x1="-2.54" y1="-2.54" x2="2.54" y2="-2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="-2.54" x2="2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="2.54" x2="-2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="-2.54" y1="2.54" x2="-2.54" y2="-2.54" width="0.254" layer="94"/>
<pin name="TP" x="-7.62" y="0" visible="pin" length="middle" direction="pas"/>
<text x="-2.54" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<text x="-2.54" y="-6.35" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="XTAL">
<wire x1="-7.62" y1="-5.08" x2="7.62" y2="-5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="-5.08" x2="7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="5.08" x2="-7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="-7.62" y1="5.08" x2="-7.62" y2="-5.08" width="0.254" layer="94"/>
<pin name="1" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="GND_B" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="GND_A" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="2" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-8.89" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="ESP32C3FH4X">
<wire x1="-7.62" y1="-20.32" x2="7.62" y2="-20.32" width="0.254" layer="94"/>
<wire x1="7.62" y1="-20.32" x2="7.62" y2="20.32" width="0.254" layer="94"/>
<wire x1="7.62" y1="20.32" x2="-7.62" y2="20.32" width="0.254" layer="94"/>
<wire x1="-7.62" y1="20.32" x2="-7.62" y2="-20.32" width="0.254" layer="94"/>
<pin name="LNA_IN" x="-12.7" y="17.78" visible="pin" length="middle" direction="pas"/>
<pin name="VDD_RF" x="-12.7" y="15.24" visible="pin" length="middle" direction="pas"/>
<pin name="IO2" x="-12.7" y="12.7" visible="pin" length="middle" direction="pas"/>
<pin name="EN" x="-12.7" y="10.16" visible="pin" length="middle" direction="pas"/>
<pin name="IO3" x="-12.7" y="7.62" visible="pin" length="middle" direction="pas"/>
<pin name="VDD_RTC" x="-12.7" y="5.08" visible="pin" length="middle" direction="pas"/>
<pin name="VDD_CPU" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="VDD_SPI" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="VDDA" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="GND" x="-12.7" y="-5.08" visible="pin" length="middle" direction="pas"/>
<pin name="IO0" x="12.7" y="17.78" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO1" x="12.7" y="15.24" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO4" x="12.7" y="12.7" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO5" x="12.7" y="10.16" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO6" x="12.7" y="7.62" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO7" x="12.7" y="5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO8" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO9" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO10" x="12.7" y="-2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO18" x="12.7" y="-5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO19" x="12.7" y="-7.62" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="RXD0_IO20" x="12.7" y="-10.16" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="TXD0_IO21" x="12.7" y="-12.7" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="XTAL_N" x="12.7" y="-15.24" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="XTAL_P" x="12.7" y="-17.78" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="21.59" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-24.13" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="XTAL40">
<wire x1="-7.62" y1="-5.08" x2="7.62" y2="-5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="-5.08" x2="7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="5.08" x2="-7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="-7.62" y1="5.08" x2="-7.62" y2="-5.08" width="0.254" layer="94"/>
<pin name="1" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="GND_B" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="GND_A" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="2" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-8.89" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="ANT24">
<wire x1="-7.62" y1="-5.08" x2="7.62" y2="-5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="-5.08" x2="7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="5.08" x2="-7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="-7.62" y1="5.08" x2="-7.62" y2="-5.08" width="0.254" layer="94"/>
<pin name="FEED" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="GND" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="TUNE" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-8.89" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="PN7161">
<wire x1="-7.62" y1="-25.4" x2="7.62" y2="-25.4" width="0.254" layer="94"/>
<wire x1="7.62" y1="-25.4" x2="7.62" y2="25.4" width="0.254" layer="94"/>
<wire x1="7.62" y1="25.4" x2="-7.62" y2="25.4" width="0.254" layer="94"/>
<wire x1="-7.62" y1="25.4" x2="-7.62" y2="-25.4" width="0.254" layer="94"/>
<pin name="I2C_ADR0" x="-12.7" y="22.86" visible="pin" length="middle" direction="pas"/>
<pin name="DWL_REQ" x="-12.7" y="20.32" visible="pin" length="middle" direction="pas"/>
<pin name="I2C_ADR1" x="-12.7" y="17.78" visible="pin" length="middle" direction="pas"/>
<pin name="VSS_PAD" x="-12.7" y="15.24" visible="pin" length="middle" direction="pas"/>
<pin name="SDA" x="-12.7" y="12.7" visible="pin" length="middle" direction="pas"/>
<pin name="VDD_PAD" x="-12.7" y="10.16" visible="pin" length="middle" direction="pas"/>
<pin name="SCL" x="-12.7" y="7.62" visible="pin" length="middle" direction="pas"/>
<pin name="IRQ" x="-12.7" y="5.08" visible="pin" length="middle" direction="pas"/>
<pin name="VSS_A" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="VEN" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="VBAT2" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="VDD_UP" x="-12.7" y="-5.08" visible="pin" length="middle" direction="pas"/>
<pin name="WKUP_REQ" x="-12.7" y="-7.62" visible="pin" length="middle" direction="pas"/>
<pin name="CLK_REQ" x="-12.7" y="-10.16" visible="pin" length="middle" direction="pas"/>
<pin name="VSS" x="-12.7" y="-12.7" visible="pin" length="middle" direction="pas"/>
<pin name="VDD_TX" x="12.7" y="22.86" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="RXN" x="12.7" y="20.32" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="RXP" x="12.7" y="17.78" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VDD_VMID" x="12.7" y="15.24" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="TVDD_IN" x="12.7" y="12.7" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="TX2" x="12.7" y="10.16" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VSS_TX" x="12.7" y="7.62" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="TX1" x="12.7" y="5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="TVDD_IN2" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="ANT1" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="ANT2" x="12.7" y="-2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VDD_HF" x="12.7" y="-5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VDD_A" x="12.7" y="-7.62" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VDD" x="12.7" y="-10.16" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VBAT" x="12.7" y="-12.7" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="XTAL2" x="12.7" y="-15.24" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="XTAL1" x="12.7" y="-17.78" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VDD_D" x="12.7" y="-20.32" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="DCDC_EN" x="12.7" y="-22.86" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="26.67" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-29.21" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="MAX17048">
<wire x1="-7.62" y1="-7.62" x2="7.62" y2="-7.62" width="0.254" layer="94"/>
<wire x1="7.62" y1="-7.62" x2="7.62" y2="7.62" width="0.254" layer="94"/>
<wire x1="7.62" y1="7.62" x2="-7.62" y2="7.62" width="0.254" layer="94"/>
<wire x1="-7.62" y1="7.62" x2="-7.62" y2="-7.62" width="0.254" layer="94"/>
<pin name="CTG" x="-12.7" y="5.08" visible="pin" length="middle" direction="pas"/>
<pin name="CELL" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="VDD" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="GND" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="ALRT" x="12.7" y="5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="QSTRT" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="SCL" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="SDA" x="12.7" y="-2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="8.89" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-11.43" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="BQ24074">
<wire x1="-7.62" y1="-15.24" x2="7.62" y2="-15.24" width="0.254" layer="94"/>
<wire x1="7.62" y1="-15.24" x2="7.62" y2="15.24" width="0.254" layer="94"/>
<wire x1="7.62" y1="15.24" x2="-7.62" y2="15.24" width="0.254" layer="94"/>
<wire x1="-7.62" y1="15.24" x2="-7.62" y2="-15.24" width="0.254" layer="94"/>
<pin name="TS" x="-12.7" y="12.7" visible="pin" length="middle" direction="pas"/>
<pin name="CE" x="-12.7" y="10.16" visible="pin" length="middle" direction="pas"/>
<pin name="EN2" x="-12.7" y="7.62" visible="pin" length="middle" direction="pas"/>
<pin name="EN1" x="-12.7" y="5.08" visible="pin" length="middle" direction="pas"/>
<pin name="VSS" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="ILIM" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="IN" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="TMR" x="-12.7" y="-5.08" visible="pin" length="middle" direction="pas"/>
<pin name="ITERM" x="-12.7" y="-7.62" visible="pin" length="middle" direction="pas"/>
<pin name="ISET" x="-12.7" y="-10.16" visible="pin" length="middle" direction="pas"/>
<pin name="BAT" x="12.7" y="12.7" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="PGOOD" x="12.7" y="10.16" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="CHG" x="12.7" y="7.62" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="OUT" x="12.7" y="5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="16.51" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-19.05" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="TPS63802">
<wire x1="-7.62" y1="-10.16" x2="7.62" y2="-10.16" width="0.254" layer="94"/>
<wire x1="7.62" y1="-10.16" x2="7.62" y2="10.16" width="0.254" layer="94"/>
<wire x1="7.62" y1="10.16" x2="-7.62" y2="10.16" width="0.254" layer="94"/>
<wire x1="-7.62" y1="10.16" x2="-7.62" y2="-10.16" width="0.254" layer="94"/>
<pin name="EN" x="-12.7" y="7.62" visible="pin" length="middle" direction="pas"/>
<pin name="MODE" x="-12.7" y="5.08" visible="pin" length="middle" direction="pas"/>
<pin name="AGND" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="GND" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="L1" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="VIN" x="-12.7" y="-5.08" visible="pin" length="middle" direction="pas"/>
<pin name="FB" x="12.7" y="7.62" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="PG" x="12.7" y="5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VOUT" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="L2" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="11.43" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-13.97" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="MAX98357A">
<wire x1="-7.62" y1="-10.16" x2="7.62" y2="-10.16" width="0.254" layer="94"/>
<wire x1="7.62" y1="-10.16" x2="7.62" y2="10.16" width="0.254" layer="94"/>
<wire x1="7.62" y1="10.16" x2="-7.62" y2="10.16" width="0.254" layer="94"/>
<wire x1="-7.62" y1="10.16" x2="-7.62" y2="-10.16" width="0.254" layer="94"/>
<pin name="DIN" x="-12.7" y="7.62" visible="pin" length="middle" direction="pas"/>
<pin name="GAIN_SLOT" x="-12.7" y="5.08" visible="pin" length="middle" direction="pas"/>
<pin name="GND" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="SD_MODE" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="LRCLK" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="BCLK" x="-12.7" y="-5.08" visible="pin" length="middle" direction="pas"/>
<pin name="VDD" x="12.7" y="7.62" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="OUTP" x="12.7" y="5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="OUTN" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="11.43" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-13.97" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="TPS22918">
<wire x1="-7.62" y1="-5.08" x2="7.62" y2="-5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="-5.08" x2="7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="5.08" x2="-7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="-7.62" y1="5.08" x2="-7.62" y2="-5.08" width="0.254" layer="94"/>
<pin name="VIN" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="GND" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="ON" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="CT" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="QOD" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VOUT" x="12.7" y="-2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-8.89" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="SN74LV1T34">
<wire x1="-7.62" y1="-5.08" x2="7.62" y2="-5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="-5.08" x2="7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="5.08" x2="-7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="-7.62" y1="5.08" x2="-7.62" y2="-5.08" width="0.254" layer="94"/>
<pin name="A" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="GND" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="Y" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VCC" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-8.89" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="USBLC6">
<wire x1="-7.62" y1="-5.08" x2="7.62" y2="-5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="-5.08" x2="7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="5.08" x2="-7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="-7.62" y1="5.08" x2="-7.62" y2="-5.08" width="0.254" layer="94"/>
<pin name="IO1_A" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="GND" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="IO2_A" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="IO2_B" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="VBUS" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="IO1_B" x="12.7" y="-2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-8.89" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="WS2812B">
<wire x1="-7.62" y1="-5.08" x2="7.62" y2="-5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="-5.08" x2="7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="5.08" x2="-7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="-7.62" y1="5.08" x2="-7.62" y2="-5.08" width="0.254" layer="94"/>
<pin name="VDD" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="VSS" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="DIN" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="DOUT" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-8.89" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="USBC">
<wire x1="-7.62" y1="-7.62" x2="7.62" y2="-7.62" width="0.254" layer="94"/>
<wire x1="7.62" y1="-7.62" x2="7.62" y2="7.62" width="0.254" layer="94"/>
<wire x1="7.62" y1="7.62" x2="-7.62" y2="7.62" width="0.254" layer="94"/>
<wire x1="-7.62" y1="7.62" x2="-7.62" y2="-7.62" width="0.254" layer="94"/>
<pin name="GND" x="-12.7" y="5.08" visible="pin" length="middle" direction="pas"/>
<pin name="VBUS" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="CC1" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="CC2" x="-12.7" y="-2.54" visible="pin" length="middle" direction="pas"/>
<pin name="DP" x="12.7" y="5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="DN" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="SBU1" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="SBU2" x="12.7" y="-2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="SHIELD" x="12.7" y="-5.08" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="8.89" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-11.43" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="JST_BAT">
<wire x1="-7.62" y1="-5.08" x2="7.62" y2="-5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="-5.08" x2="7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="5.08" x2="-7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="-7.62" y1="5.08" x2="-7.62" y2="-5.08" width="0.254" layer="94"/>
<pin name="BAT_P" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="BAT_N" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="MECH" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-8.89" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="FPC4">
<wire x1="-7.62" y1="-5.08" x2="7.62" y2="-5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="-5.08" x2="7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="7.62" y1="5.08" x2="-7.62" y2="5.08" width="0.254" layer="94"/>
<wire x1="-7.62" y1="5.08" x2="-7.62" y2="-5.08" width="0.254" layer="94"/>
<pin name="1" x="-12.7" y="2.54" visible="pin" length="middle" direction="pas"/>
<pin name="2" x="-12.7" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="3" x="12.7" y="2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="4" x="12.7" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<pin name="MECH" x="12.7" y="-2.54" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-7.62" y="6.35" size="1.778" layer="95">&gt;NAME</text>
<text x="-7.62" y="-8.89" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
<symbol name="SPK">
<wire x1="-2.54" y1="-2.54" x2="2.54" y2="-2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="-2.54" x2="2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="2.54" y1="2.54" x2="-2.54" y2="2.54" width="0.254" layer="94"/>
<wire x1="-2.54" y1="2.54" x2="-2.54" y2="-2.54" width="0.254" layer="94"/>
<pin name="P" x="-7.62" y="0" visible="pin" length="middle" direction="pas"/>
<pin name="N" x="7.62" y="0" visible="pin" length="middle" direction="pas" rot="R180"/>
<text x="-2.54" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<text x="-2.54" y="-6.35" size="1.778" layer="96">&gt;VALUE</text>
</symbol>
</symbols><devicesets>
<deviceset name="R" prefix="R"><description>Resistor</description><gates><gate name="G$1" symbol="R" x="0" y="0"/></gates><devices>
<device name="" package="R0402"><connects>
<connect gate="G$1" pin="1" pad="1"/>
<connect gate="G$1" pin="2" pad="2"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="C" prefix="C"><description>Capacitor</description><gates><gate name="G$1" symbol="C" x="0" y="0"/></gates><devices>
<device name="" package="C0402"><connects>
<connect gate="G$1" pin="1" pad="1"/>
<connect gate="G$1" pin="2" pad="2"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="C0603" prefix="C"><description>Capacitor</description><gates><gate name="G$1" symbol="C0603" x="0" y="0"/></gates><devices>
<device name="" package="C0603"><connects>
<connect gate="G$1" pin="1" pad="1"/>
<connect gate="G$1" pin="2" pad="2"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="CPOL" prefix="C"><description>Polymer capacitor</description><gates><gate name="G$1" symbol="CPOL" x="0" y="0"/></gates><devices>
<device name="" package="CPOL7343"><connects>
<connect gate="G$1" pin="P" pad="1"/>
<connect gate="G$1" pin="N" pad="2"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="L" prefix="L"><description>Inductor</description><gates><gate name="G$1" symbol="L" x="0" y="0"/></gates><devices>
<device name="" package="L0402"><connects>
<connect gate="G$1" pin="1" pad="1"/>
<connect gate="G$1" pin="2" pad="2"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="L_PWR" prefix="L"><description>Power inductor</description><gates><gate name="G$1" symbol="L_PWR" x="0" y="0"/></gates><devices>
<device name="" package="L2016"><connects>
<connect gate="G$1" pin="1" pad="1"/>
<connect gate="G$1" pin="2" pad="2"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="TP" prefix="TP"><description>Test pad</description><gates><gate name="G$1" symbol="TP" x="0" y="0"/></gates><devices>
<device name="" package="TP1MM"><connects>
<connect gate="G$1" pin="TP" pad="1"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="XTAL" prefix="Y"><description>Crystal</description><gates><gate name="G$1" symbol="XTAL" x="0" y="0"/></gates><devices>
<device name="" package="XTAL2016"><connects>
<connect gate="G$1" pin="1" pad="1"/>
<connect gate="G$1" pin="GND_A" pad="2"/>
<connect gate="G$1" pin="2" pad="3"/>
<connect gate="G$1" pin="GND_B" pad="4"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="ESP32C3FH4X" prefix="U"><description>Espressif ESP32-C3FH4X, 4 MB in-package flash, QFN32 5 x 5 mm</description><gates><gate name="G$1" symbol="ESP32C3FH4X" x="0" y="0"/></gates><devices>
<device name="" package="ESP32C3_QFN32"><connects>
<connect gate="G$1" pin="LNA_IN" pad="1"/>
<connect gate="G$1" pin="VDD_RF" pad="2 3"/>
<connect gate="G$1" pin="IO0" pad="4"/>
<connect gate="G$1" pin="IO1" pad="5"/>
<connect gate="G$1" pin="IO2" pad="6"/>
<connect gate="G$1" pin="EN" pad="7"/>
<connect gate="G$1" pin="IO3" pad="8"/>
<connect gate="G$1" pin="IO4" pad="9"/>
<connect gate="G$1" pin="IO5" pad="10"/>
<connect gate="G$1" pin="VDD_RTC" pad="11"/>
<connect gate="G$1" pin="IO6" pad="12"/>
<connect gate="G$1" pin="IO7" pad="13"/>
<connect gate="G$1" pin="IO8" pad="14"/>
<connect gate="G$1" pin="IO9" pad="15"/>
<connect gate="G$1" pin="IO10" pad="16"/>
<connect gate="G$1" pin="VDD_CPU" pad="17"/>
<connect gate="G$1" pin="VDD_SPI" pad="18"/>
<connect gate="G$1" pin="IO18" pad="25"/>
<connect gate="G$1" pin="IO19" pad="26"/>
<connect gate="G$1" pin="RXD0_IO20" pad="27"/>
<connect gate="G$1" pin="TXD0_IO21" pad="28"/>
<connect gate="G$1" pin="XTAL_N" pad="29"/>
<connect gate="G$1" pin="XTAL_P" pad="30"/>
<connect gate="G$1" pin="VDDA" pad="31 32"/>
<connect gate="G$1" pin="GND" pad="33"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="XTAL40" prefix="Y"><description>Abracon ABM8 3.2 x 2.5 mm 40 MHz crystal</description><gates><gate name="G$1" symbol="XTAL40" x="0" y="0"/></gates><devices>
<device name="" package="ABM8_3225"><connects>
<connect gate="G$1" pin="1" pad="1"/>
<connect gate="G$1" pin="GND_A" pad="2"/>
<connect gate="G$1" pin="2" pad="3"/>
<connect gate="G$1" pin="GND_B" pad="4"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="ANT24" prefix="ANT"><description>Johanson 2450AT18D0100001E 2.4 GHz SMT antenna, thin-edge reference layout</description><gates><gate name="G$1" symbol="ANT24" x="0" y="0"/></gates><devices>
<device name="" package="JOHANSON_2450AT18D"><connects>
<connect gate="G$1" pin="FEED" pad="1"/>
<connect gate="G$1" pin="GND" pad="2 4"/>
<connect gate="G$1" pin="TUNE" pad="3"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="PN7161" prefix="U"><description>NXP PN7161A1HN NFC controller (I2C)</description><gates><gate name="G$1" symbol="PN7161" x="0" y="0"/></gates><devices>
<device name="" package="HVQFN40_6X6"><connects>
<connect gate="G$1" pin="I2C_ADR0" pad="1"/>
<connect gate="G$1" pin="DWL_REQ" pad="2"/>
<connect gate="G$1" pin="I2C_ADR1" pad="3"/>
<connect gate="G$1" pin="VSS_PAD" pad="4"/>
<connect gate="G$1" pin="SDA" pad="5"/>
<connect gate="G$1" pin="VDD_PAD" pad="6"/>
<connect gate="G$1" pin="SCL" pad="7"/>
<connect gate="G$1" pin="IRQ" pad="8"/>
<connect gate="G$1" pin="VSS_A" pad="9"/>
<connect gate="G$1" pin="VEN" pad="10"/>
<connect gate="G$1" pin="VBAT2" pad="12"/>
<connect gate="G$1" pin="VDD_UP" pad="13"/>
<connect gate="G$1" pin="VDD_TX" pad="14"/>
<connect gate="G$1" pin="RXN" pad="15"/>
<connect gate="G$1" pin="RXP" pad="16"/>
<connect gate="G$1" pin="VDD_VMID" pad="17"/>
<connect gate="G$1" pin="TVDD_IN" pad="18"/>
<connect gate="G$1" pin="TX2" pad="19"/>
<connect gate="G$1" pin="VSS_TX" pad="20"/>
<connect gate="G$1" pin="TX1" pad="21"/>
<connect gate="G$1" pin="TVDD_IN2" pad="22"/>
<connect gate="G$1" pin="ANT1" pad="23"/>
<connect gate="G$1" pin="ANT2" pad="24"/>
<connect gate="G$1" pin="VDD_HF" pad="25"/>
<connect gate="G$1" pin="VDD_A" pad="26"/>
<connect gate="G$1" pin="VDD" pad="27"/>
<connect gate="G$1" pin="VBAT" pad="28"/>
<connect gate="G$1" pin="XTAL2" pad="29"/>
<connect gate="G$1" pin="XTAL1" pad="30"/>
<connect gate="G$1" pin="VDD_D" pad="31"/>
<connect gate="G$1" pin="DCDC_EN" pad="37"/>
<connect gate="G$1" pin="WKUP_REQ" pad="39"/>
<connect gate="G$1" pin="CLK_REQ" pad="40"/>
<connect gate="G$1" pin="VSS" pad="41"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="MAX17048" prefix="U"><description>Analog/Maxim MAX17048G+T10 fuel gauge (TDFN-8)</description><gates><gate name="G$1" symbol="MAX17048" x="0" y="0"/></gates><devices>
<device name="" package="TDFN8_2X2"><connects>
<connect gate="G$1" pin="CTG" pad="1"/>
<connect gate="G$1" pin="CELL" pad="2"/>
<connect gate="G$1" pin="VDD" pad="3"/>
<connect gate="G$1" pin="GND" pad="4 9"/>
<connect gate="G$1" pin="ALRT" pad="5"/>
<connect gate="G$1" pin="QSTRT" pad="6"/>
<connect gate="G$1" pin="SCL" pad="7"/>
<connect gate="G$1" pin="SDA" pad="8"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="BQ24074" prefix="U"><description>TI BQ24074RGTR charger and power path (VQFN-16)</description><gates><gate name="G$1" symbol="BQ24074" x="0" y="0"/></gates><devices>
<device name="" package="VQFN16_3X3"><connects>
<connect gate="G$1" pin="TS" pad="1"/>
<connect gate="G$1" pin="BAT" pad="2 3"/>
<connect gate="G$1" pin="CE" pad="4"/>
<connect gate="G$1" pin="EN2" pad="5"/>
<connect gate="G$1" pin="EN1" pad="6"/>
<connect gate="G$1" pin="PGOOD" pad="7"/>
<connect gate="G$1" pin="VSS" pad="8 17"/>
<connect gate="G$1" pin="CHG" pad="9"/>
<connect gate="G$1" pin="OUT" pad="10 11"/>
<connect gate="G$1" pin="ILIM" pad="12"/>
<connect gate="G$1" pin="IN" pad="13"/>
<connect gate="G$1" pin="TMR" pad="14"/>
<connect gate="G$1" pin="ITERM" pad="15"/>
<connect gate="G$1" pin="ISET" pad="16"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="TPS63802" prefix="U"><description>TI TPS63802DLAR buck-boost 3.3 V (VSON-10)</description><gates><gate name="G$1" symbol="TPS63802" x="0" y="0"/></gates><devices>
<device name="" package="VSON10_2X3"><connects>
<connect gate="G$1" pin="EN" pad="1"/>
<connect gate="G$1" pin="MODE" pad="2"/>
<connect gate="G$1" pin="AGND" pad="3"/>
<connect gate="G$1" pin="FB" pad="4"/>
<connect gate="G$1" pin="PG" pad="5"/>
<connect gate="G$1" pin="VOUT" pad="6"/>
<connect gate="G$1" pin="L2" pad="7"/>
<connect gate="G$1" pin="GND" pad="8"/>
<connect gate="G$1" pin="L1" pad="9"/>
<connect gate="G$1" pin="VIN" pad="10"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="MAX98357A" prefix="U"><description>Analog/Maxim MAX98357AETE+T I2S Class D amplifier (TQFN-16)</description><gates><gate name="G$1" symbol="MAX98357A" x="0" y="0"/></gates><devices>
<device name="" package="TQFN16_3X3"><connects>
<connect gate="G$1" pin="DIN" pad="1"/>
<connect gate="G$1" pin="GAIN_SLOT" pad="2"/>
<connect gate="G$1" pin="GND" pad="3 11 15 17"/>
<connect gate="G$1" pin="SD_MODE" pad="4"/>
<connect gate="G$1" pin="VDD" pad="7 8"/>
<connect gate="G$1" pin="OUTP" pad="9"/>
<connect gate="G$1" pin="OUTN" pad="10"/>
<connect gate="G$1" pin="LRCLK" pad="14"/>
<connect gate="G$1" pin="BCLK" pad="16"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="TPS22918" prefix="U"><description>TI TPS22918DBVR load switch (SOT-23-6)</description><gates><gate name="G$1" symbol="TPS22918" x="0" y="0"/></gates><devices>
<device name="" package="SOT23_6"><connects>
<connect gate="G$1" pin="VIN" pad="1"/>
<connect gate="G$1" pin="GND" pad="2"/>
<connect gate="G$1" pin="ON" pad="3"/>
<connect gate="G$1" pin="CT" pad="4"/>
<connect gate="G$1" pin="QOD" pad="5"/>
<connect gate="G$1" pin="VOUT" pad="6"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="SN74LV1T34" prefix="U"><description>TI SN74LV1T34DBVR level-shifting buffer (SOT-23-5)</description><gates><gate name="G$1" symbol="SN74LV1T34" x="0" y="0"/></gates><devices>
<device name="" package="SOT23_5"><connects>
<connect gate="G$1" pin="A" pad="2"/>
<connect gate="G$1" pin="GND" pad="3"/>
<connect gate="G$1" pin="Y" pad="4"/>
<connect gate="G$1" pin="VCC" pad="5"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="USBLC6" prefix="D"><description>ST USBLC6-2SC6 USB ESD protection (SOT-23-6)</description><gates><gate name="G$1" symbol="USBLC6" x="0" y="0"/></gates><devices>
<device name="" package="SOT23_6"><connects>
<connect gate="G$1" pin="IO1_A" pad="1"/>
<connect gate="G$1" pin="GND" pad="2"/>
<connect gate="G$1" pin="IO2_A" pad="3"/>
<connect gate="G$1" pin="IO2_B" pad="4"/>
<connect gate="G$1" pin="VBUS" pad="5"/>
<connect gate="G$1" pin="IO1_B" pad="6"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="WS2812B" prefix="LED"><description>WS2812B addressable LED (5050; revision TBC)</description><gates><gate name="G$1" symbol="WS2812B" x="0" y="0"/></gates><devices>
<device name="" package="WS2812B_5050"><connects>
<connect gate="G$1" pin="VDD" pad="1"/>
<connect gate="G$1" pin="DOUT" pad="2"/>
<connect gate="G$1" pin="VSS" pad="3"/>
<connect gate="G$1" pin="DIN" pad="4"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="USBC" prefix="J"><description>TE Connectivity 2345986-1 USB-C receptacle (24 pads, USB 3.1 top mount, dual row SMT; only the USB 2.0 pads are used)</description><gates><gate name="G$1" symbol="USBC" x="0" y="0"/></gates><devices>
<device name="" package="USBC24_TE2345986"><connects>
<connect gate="G$1" pin="GND" pad="A1 B12 A12 B1"/>
<connect gate="G$1" pin="VBUS" pad="A4 B9 A9 B4"/>
<connect gate="G$1" pin="CC1" pad="A5"/>
<connect gate="G$1" pin="CC2" pad="B5"/>
<connect gate="G$1" pin="DP" pad="A6 B6"/>
<connect gate="G$1" pin="DN" pad="A7 B7"/>
<connect gate="G$1" pin="SBU1" pad="A8"/>
<connect gate="G$1" pin="SBU2" pad="B8"/>
<connect gate="G$1" pin="SHIELD" pad="S1 S2 S3 S4"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="JST_BAT" prefix="J"><description>JST S2B-PH-SM4-TB battery header</description><gates><gate name="G$1" symbol="JST_BAT" x="0" y="0"/></gates><devices>
<device name="" package="JST_S2B_PH_SM4_TB"><connects>
<connect gate="G$1" pin="BAT_P" pad="1"/>
<connect gate="G$1" pin="BAT_N" pad="2"/>
<connect gate="G$1" pin="MECH" pad="S1 S2"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="FPC4" prefix="J"><description>Hirose FH19C-4S-0.5SH(10), 0.5 mm pitch, 0.2 mm bottom-contact FPC</description><gates><gate name="G$1" symbol="FPC4" x="0" y="0"/></gates><devices>
<device name="" package="FPC4_PLACEHOLDER"><connects>
<connect gate="G$1" pin="1" pad="1"/>
<connect gate="G$1" pin="2" pad="2"/>
<connect gate="G$1" pin="3" pad="3"/>
<connect gate="G$1" pin="4" pad="4"/>
<connect gate="G$1" pin="MECH" pad="M1 M2"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="SPK" prefix="SPK"><description>Speaker CMS-151103-088SP (wire or pad connection)</description><gates><gate name="G$1" symbol="SPK" x="0" y="0"/></gates><devices>
<device name="" package="SPK_PADS"><connects>
<connect gate="G$1" pin="P" pad="1"/>
<connect gate="G$1" pin="N" pad="2"/>
</connects><technologies><technology name=""/></technologies></device></devices></deviceset>
</devicesets>
</library>
</libraries>
<attributes/>
<variantdefs/>
<classes><class number="0" name="signal" width="0.15" drill="0.2"/><class number="1" name="power" width="0.15" drill="0.2"/><class number="2" name="LED-power" width="0.15" drill="0.2"/><class number="3" name="3V3" width="0.15" drill="0.2"/><class number="4" name="RF" width="0.15" drill="0.2"/><class number="5" name="USB" width="0.15" drill="0.2"/></classes>
<parts>
<part name="U1" library="orb" deviceset="ESP32C3FH4X" device="" value="ESP32-C3FH4X"/>
<part name="C1" library="orb" deviceset="C0603" device="" value="10uF"/>
<part name="C2" library="orb" deviceset="C" device="" value="100nF"/>
<part name="R1" library="orb" deviceset="R" device="" value="10k"/>
<part name="C3" library="orb" deviceset="C" device="" value="1uF"/>
<part name="R3" library="orb" deviceset="R" device="" value="100k"/>
<part name="TP1" library="orb" deviceset="TP" device="" value="EN"/>
<part name="TP2" library="orb" deviceset="TP" device="" value="BOOT"/>
<part name="TP3" library="orb" deviceset="TP" device="" value="3V3"/>
<part name="TP4" library="orb" deviceset="TP" device="" value="GND"/>
<part name="TP5" library="orb" deviceset="TP" device="" value="VSYS"/>
<part name="TP6" library="orb" deviceset="TP" device="" value="VBAT"/>
<part name="L4" library="orb" deviceset="L" device="" value="2nH"/>
<part name="C34" library="orb" deviceset="C" device="" value="1uF"/>
<part name="C35" library="orb" deviceset="C" device="" value="100nF"/>
<part name="C36" library="orb" deviceset="C" device="" value="100nF"/>
<part name="C37" library="orb" deviceset="C" device="" value="1uF"/>
<part name="C38" library="orb" deviceset="C" device="" value="1uF"/>
<part name="C39" library="orb" deviceset="C" device="" value="10nF"/>
<part name="Y2" library="orb" deviceset="XTAL40" device="" value="40MHz"/>
<part name="L5" library="orb" deviceset="L" device="" value="24nH"/>
<part name="C40" library="orb" deviceset="C" device="" value="16pF"/>
<part name="C41" library="orb" deviceset="C" device="" value="16pF"/>
<part name="L6" library="orb" deviceset="L" device="" value="2.4nH"/>
<part name="C42" library="orb" deviceset="C" device="" value="1pF"/>
<part name="C43" library="orb" deviceset="C" device="" value="1pF"/>
<part name="R22" library="orb" deviceset="R" device="" value="0"/>
<part name="C44" library="orb" deviceset="C" device="" value="1pF"/>
<part name="C45" library="orb" deviceset="C" device="" value="1pF"/>
<part name="ANT1" library="orb" deviceset="ANT24" device="" value="2450AT18D0100001E"/>
<part name="R23" library="orb" deviceset="R" device="" value="0"/>
<part name="J1" library="orb" deviceset="USBC" device="" value="USB-C"/>
<part name="R4" library="orb" deviceset="R" device="" value="5.1k"/>
<part name="R5" library="orb" deviceset="R" device="" value="5.1k"/>
<part name="D1" library="orb" deviceset="USBLC6" device="" value="USBLC6-2SC6"/>
<part name="R6" library="orb" deviceset="R" device="" value="120k"/>
<part name="R7" library="orb" deviceset="R" device="" value="220k"/>
<part name="J2" library="orb" deviceset="JST_BAT" device="" value="BAT"/>
<part name="U4" library="orb" deviceset="BQ24074" device="" value="BQ24074RGTR"/>
<part name="R8" library="orb" deviceset="R" device="" value="1.8k"/>
<part name="R9" library="orb" deviceset="R" device="" value="1.13k"/>
<part name="R10" library="orb" deviceset="R" device="" value="10k"/>
<part name="C4" library="orb" deviceset="C0603" device="" value="4.7uF"/>
<part name="C5" library="orb" deviceset="C0603" device="" value="10uF"/>
<part name="C6" library="orb" deviceset="C0603" device="" value="10uF"/>
<part name="U3" library="orb" deviceset="MAX17048" device="" value="MAX17048G+T10"/>
<part name="C7" library="orb" deviceset="C" device="" value="100nF"/>
<part name="U5" library="orb" deviceset="TPS63802" device="" value="TPS63802DLAR"/>
<part name="L1" library="orb" deviceset="L_PWR" device="" value="0.47uH"/>
<part name="R11" library="orb" deviceset="R" device="" value="560k"/>
<part name="R12" library="orb" deviceset="R" device="" value="100k"/>
<part name="C8" library="orb" deviceset="C0603" device="" value="10uF"/>
<part name="C9" library="orb" deviceset="C0603" device="" value="10uF"/>
<part name="C10" library="orb" deviceset="C0603" device="" value="10uF"/>
<part name="R13" library="orb" deviceset="R" device="" value="2.2k"/>
<part name="R14" library="orb" deviceset="R" device="" value="2.2k"/>
<part name="U2" library="orb" deviceset="PN7161" device="" value="PN7161A1HN/C101E"/>
<part name="C11" library="orb" deviceset="C" device="" value="100nF"/>
<part name="C12" library="orb" deviceset="C0603" device="" value="4.7uF"/>
<part name="C13" library="orb" deviceset="C0603" device="" value="4.7uF"/>
<part name="C14" library="orb" deviceset="C" device="" value="100nF"/>
<part name="C15" library="orb" deviceset="C" device="" value="1uF"/>
<part name="C16" library="orb" deviceset="C" device="" value="100nF"/>
<part name="C17" library="orb" deviceset="C" device="" value="100nF"/>
<part name="C18" library="orb" deviceset="C" device="" value="100nF"/>
<part name="C19" library="orb" deviceset="C" device="" value="100nF"/>
<part name="Y1" library="orb" deviceset="XTAL" device="" value="27.12MHz"/>
<part name="C20" library="orb" deviceset="C" device="" value="12pF"/>
<part name="C21" library="orb" deviceset="C" device="" value="12pF"/>
<part name="L2" library="orb" deviceset="L" device="" value="TBD"/>
<part name="L3" library="orb" deviceset="L" device="" value="TBD"/>
<part name="C22" library="orb" deviceset="C" device="" value="TBD"/>
<part name="C23" library="orb" deviceset="C" device="" value="TBD"/>
<part name="C24" library="orb" deviceset="C" device="" value="TBD"/>
<part name="C25" library="orb" deviceset="C" device="" value="TBD"/>
<part name="C26" library="orb" deviceset="C" device="" value="TBD"/>
<part name="C27" library="orb" deviceset="C" device="" value="TBD"/>
<part name="C28" library="orb" deviceset="C" device="" value="TBD"/>
<part name="R15" library="orb" deviceset="R" device="" value="TBD"/>
<part name="R16" library="orb" deviceset="R" device="" value="TBD"/>
<part name="J3" library="orb" deviceset="FPC4" device="" value="NFC antenna"/>
<part name="U6" library="orb" deviceset="MAX98357A" device="" value="MAX98357AETE+T"/>
<part name="R17" library="orb" deviceset="R" device="" value="2k"/>
<part name="R18" library="orb" deviceset="R" device="" value="100k"/>
<part name="C29" library="orb" deviceset="C0603" device="" value="10uF"/>
<part name="C30" library="orb" deviceset="C" device="" value="100nF"/>
<part name="SPK1" library="orb" deviceset="SPK" device="" value="CMS-151103-088SP"/>
<part name="U7" library="orb" deviceset="TPS22918" device="" value="TPS22918DBVR"/>
<part name="R19" library="orb" deviceset="R" device="" value="100k"/>
<part name="C31" library="orb" deviceset="C0603" device="" value="10uF"/>
<part name="C32" library="orb" deviceset="CPOL" device="" value="100uF"/>
<part name="C33" library="orb" deviceset="CPOL" device="" value="100uF"/>
<part name="U8" library="orb" deviceset="SN74LV1T34" device="" value="SN74LV1T34DBVR"/>
<part name="R20" library="orb" deviceset="R" device="" value="100k"/>
<part name="R21" library="orb" deviceset="R" device="" value="33"/>
<part name="LED1" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C101" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED2" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C102" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED3" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C103" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED4" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C104" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED5" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C105" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED6" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C106" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED7" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C107" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED8" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C108" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED9" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C109" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED10" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C110" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED11" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C111" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED12" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C112" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED13" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C113" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED14" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C114" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED15" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C115" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED16" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C116" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED17" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C117" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED18" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C118" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED19" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C119" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED20" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C120" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED21" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C121" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED22" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C122" library="orb" deviceset="C" device="" value="100nF"/>
<part name="LED23" library="orb" deviceset="WS2812B" device="" value="WS2812B"/>
<part name="C123" library="orb" deviceset="C" device="" value="100nF"/>
</parts>
<sheets><sheet>
<plain>
<text x="0" y="20" size="3" layer="97">Orb main board: generated from hardware/src/design.py, do not edit by hand</text>
</plain>
<instances>
<instance part="U1" gate="G$1" x="21.59" y="-25.4"/>
<instance part="C1" gate="G$1" x="59.69" y="-7.62"/>
<instance part="C2" gate="G$1" x="92.71" y="-7.62"/>
<instance part="R1" gate="G$1" x="125.73" y="-7.62"/>
<instance part="C3" gate="G$1" x="158.75" y="-7.62"/>
<instance part="R3" gate="G$1" x="191.77" y="-7.62"/>
<instance part="TP1" gate="G$1" x="16.51" y="-73.66"/>
<instance part="TP2" gate="G$1" x="49.53" y="-73.66"/>
<instance part="TP3" gate="G$1" x="82.55" y="-73.66"/>
<instance part="TP4" gate="G$1" x="115.57" y="-73.66"/>
<instance part="TP5" gate="G$1" x="148.59" y="-73.66"/>
<instance part="TP6" gate="G$1" x="181.61" y="-73.66"/>
<instance part="L4" gate="G$1" x="16.51" y="-104.14"/>
<instance part="C34" gate="G$1" x="49.53" y="-104.14"/>
<instance part="C35" gate="G$1" x="82.55" y="-104.14"/>
<instance part="C36" gate="G$1" x="115.57" y="-104.14"/>
<instance part="C37" gate="G$1" x="148.59" y="-104.14"/>
<instance part="C38" gate="G$1" x="181.61" y="-104.14"/>
<instance part="C39" gate="G$1" x="16.51" y="-134.62"/>
<instance part="Y2" gate="G$1" x="54.61" y="-137.16"/>
<instance part="L5" gate="G$1" x="92.71" y="-134.62"/>
<instance part="C40" gate="G$1" x="125.73" y="-134.62"/>
<instance part="C41" gate="G$1" x="158.75" y="-134.62"/>
<instance part="L6" gate="G$1" x="16.51" y="-185.42"/>
<instance part="C42" gate="G$1" x="49.53" y="-185.42"/>
<instance part="C43" gate="G$1" x="82.55" y="-185.42"/>
<instance part="R22" gate="G$1" x="115.57" y="-185.42"/>
<instance part="C44" gate="G$1" x="148.59" y="-185.42"/>
<instance part="C45" gate="G$1" x="181.61" y="-185.42"/>
<instance part="ANT1" gate="G$1" x="21.59" y="-218.44"/>
<instance part="R23" gate="G$1" x="59.69" y="-215.9"/>
<instance part="J1" gate="G$1" x="21.59" y="-271.78"/>
<instance part="R4" gate="G$1" x="59.69" y="-266.7"/>
<instance part="R5" gate="G$1" x="92.71" y="-266.7"/>
<instance part="D1" gate="G$1" x="130.81" y="-269.24"/>
<instance part="R6" gate="G$1" x="168.91" y="-266.7"/>
<instance part="R7" gate="G$1" x="201.93" y="-266.7"/>
<instance part="J2" gate="G$1" x="21.59" y="-325.12"/>
<instance part="U4" gate="G$1" x="64.77" y="-335.28"/>
<instance part="R8" gate="G$1" x="102.87" y="-322.58"/>
<instance part="R9" gate="G$1" x="135.89" y="-322.58"/>
<instance part="R10" gate="G$1" x="168.91" y="-322.58"/>
<instance part="C4" gate="G$1" x="201.93" y="-322.58"/>
<instance part="C5" gate="G$1" x="16.51" y="-378.46"/>
<instance part="C6" gate="G$1" x="49.53" y="-378.46"/>
<instance part="U3" gate="G$1" x="87.63" y="-383.54"/>
<instance part="C7" gate="G$1" x="125.73" y="-378.46"/>
<instance part="U5" gate="G$1" x="163.83" y="-386.08"/>
<instance part="L1" gate="G$1" x="201.93" y="-378.46"/>
<instance part="R11" gate="G$1" x="16.51" y="-424.18"/>
<instance part="R12" gate="G$1" x="49.53" y="-424.18"/>
<instance part="C8" gate="G$1" x="82.55" y="-424.18"/>
<instance part="C9" gate="G$1" x="115.57" y="-424.18"/>
<instance part="C10" gate="G$1" x="148.59" y="-424.18"/>
<instance part="R13" gate="G$1" x="16.51" y="-469.9"/>
<instance part="R14" gate="G$1" x="49.53" y="-469.9"/>
<instance part="U2" gate="G$1" x="21.59" y="-538.48"/>
<instance part="C11" gate="G$1" x="59.69" y="-515.62"/>
<instance part="C12" gate="G$1" x="92.71" y="-515.62"/>
<instance part="C13" gate="G$1" x="125.73" y="-515.62"/>
<instance part="C14" gate="G$1" x="158.75" y="-515.62"/>
<instance part="C15" gate="G$1" x="191.77" y="-515.62"/>
<instance part="C16" gate="G$1" x="16.51" y="-591.82"/>
<instance part="C17" gate="G$1" x="49.53" y="-591.82"/>
<instance part="C18" gate="G$1" x="82.55" y="-591.82"/>
<instance part="C19" gate="G$1" x="115.57" y="-591.82"/>
<instance part="Y1" gate="G$1" x="153.67" y="-594.36"/>
<instance part="C20" gate="G$1" x="191.77" y="-591.82"/>
<instance part="C21" gate="G$1" x="16.51" y="-627.38"/>
<instance part="L2" gate="G$1" x="49.53" y="-627.38"/>
<instance part="L3" gate="G$1" x="82.55" y="-627.38"/>
<instance part="C22" gate="G$1" x="115.57" y="-627.38"/>
<instance part="C23" gate="G$1" x="148.59" y="-627.38"/>
<instance part="C24" gate="G$1" x="181.61" y="-627.38"/>
<instance part="C25" gate="G$1" x="16.51" y="-657.86"/>
<instance part="C26" gate="G$1" x="49.53" y="-657.86"/>
<instance part="C27" gate="G$1" x="82.55" y="-657.86"/>
<instance part="C28" gate="G$1" x="115.57" y="-657.86"/>
<instance part="R15" gate="G$1" x="148.59" y="-657.86"/>
<instance part="R16" gate="G$1" x="181.61" y="-657.86"/>
<instance part="J3" gate="G$1" x="21.59" y="-690.88"/>
<instance part="U6" gate="G$1" x="21.59" y="-746.76"/>
<instance part="R17" gate="G$1" x="59.69" y="-739.14"/>
<instance part="R18" gate="G$1" x="92.71" y="-739.14"/>
<instance part="C29" gate="G$1" x="125.73" y="-739.14"/>
<instance part="C30" gate="G$1" x="158.75" y="-739.14"/>
<instance part="SPK1" gate="G$1" x="191.77" y="-739.14"/>
<instance part="U7" gate="G$1" x="21.59" y="-802.64"/>
<instance part="R19" gate="G$1" x="59.69" y="-800.1"/>
<instance part="C31" gate="G$1" x="92.71" y="-800.1"/>
<instance part="C32" gate="G$1" x="125.73" y="-800.1"/>
<instance part="C33" gate="G$1" x="158.75" y="-800.1"/>
<instance part="U8" gate="G$1" x="196.85" y="-802.64"/>
<instance part="R20" gate="G$1" x="16.51" y="-835.66"/>
<instance part="R21" gate="G$1" x="49.53" y="-835.66"/>
<instance part="LED1" gate="G$1" x="21.59" y="-883.92"/>
<instance part="C101" gate="G$1" x="59.69" y="-881.38"/>
<instance part="LED2" gate="G$1" x="97.79" y="-883.92"/>
<instance part="C102" gate="G$1" x="135.89" y="-881.38"/>
<instance part="LED3" gate="G$1" x="173.99" y="-883.92"/>
<instance part="C103" gate="G$1" x="212.09" y="-881.38"/>
<instance part="LED4" gate="G$1" x="250.19" y="-883.92"/>
<instance part="C104" gate="G$1" x="288.29" y="-881.38"/>
<instance part="LED5" gate="G$1" x="326.39" y="-883.92"/>
<instance part="C105" gate="G$1" x="364.49" y="-881.38"/>
<instance part="LED6" gate="G$1" x="402.59" y="-883.92"/>
<instance part="C106" gate="G$1" x="440.69" y="-881.38"/>
<instance part="LED7" gate="G$1" x="478.79" y="-883.92"/>
<instance part="C107" gate="G$1" x="516.89" y="-881.38"/>
<instance part="LED8" gate="G$1" x="21.59" y="-919.48"/>
<instance part="C108" gate="G$1" x="59.69" y="-916.94"/>
<instance part="LED9" gate="G$1" x="97.79" y="-919.48"/>
<instance part="C109" gate="G$1" x="135.89" y="-916.94"/>
<instance part="LED10" gate="G$1" x="173.99" y="-919.48"/>
<instance part="C110" gate="G$1" x="212.09" y="-916.94"/>
<instance part="LED11" gate="G$1" x="250.19" y="-919.48"/>
<instance part="C111" gate="G$1" x="288.29" y="-916.94"/>
<instance part="LED12" gate="G$1" x="326.39" y="-919.48"/>
<instance part="C112" gate="G$1" x="364.49" y="-916.94"/>
<instance part="LED13" gate="G$1" x="402.59" y="-919.48"/>
<instance part="C113" gate="G$1" x="440.69" y="-916.94"/>
<instance part="LED14" gate="G$1" x="478.79" y="-919.48"/>
<instance part="C114" gate="G$1" x="516.89" y="-916.94"/>
<instance part="LED15" gate="G$1" x="21.59" y="-955.04"/>
<instance part="C115" gate="G$1" x="59.69" y="-952.5"/>
<instance part="LED16" gate="G$1" x="97.79" y="-955.04"/>
<instance part="C116" gate="G$1" x="135.89" y="-952.5"/>
<instance part="LED17" gate="G$1" x="173.99" y="-955.04"/>
<instance part="C117" gate="G$1" x="212.09" y="-952.5"/>
<instance part="LED18" gate="G$1" x="250.19" y="-955.04"/>
<instance part="C118" gate="G$1" x="288.29" y="-952.5"/>
<instance part="LED19" gate="G$1" x="326.39" y="-955.04"/>
<instance part="C119" gate="G$1" x="364.49" y="-952.5"/>
<instance part="LED20" gate="G$1" x="402.59" y="-955.04"/>
<instance part="C120" gate="G$1" x="440.69" y="-952.5"/>
<instance part="LED21" gate="G$1" x="478.79" y="-955.04"/>
<instance part="C121" gate="G$1" x="516.89" y="-952.5"/>
<instance part="LED22" gate="G$1" x="21.59" y="-990.6"/>
<instance part="C122" gate="G$1" x="59.69" y="-988.06"/>
<instance part="LED23" gate="G$1" x="97.79" y="-990.6"/>
<instance part="C123" gate="G$1" x="135.89" y="-988.06"/>
</instances>
<busses/>
<nets>
<net name="ESP_VDD_RF" class="3"><segment><pinref part="U1" gate="G$1" pin="VDD_RF"/><wire x1="8.89" y1="-10.16" x2="3.81" y2="-10.16" width="0.1524" layer="91"/><label x="3.81" y="-10.16" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="L4" gate="G$1" pin="2"/><wire x1="24.13" y1="-104.14" x2="29.21" y2="-104.14" width="0.1524" layer="91"/><label x="29.21" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C34" gate="G$1" pin="1"/><wire x1="41.91" y1="-104.14" x2="36.83" y2="-104.14" width="0.1524" layer="91"/><label x="36.83" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="3V3" class="3"><segment><pinref part="U1" gate="G$1" pin="VDD_RTC"/><wire x1="8.89" y1="-20.32" x2="3.81" y2="-20.32" width="0.1524" layer="91"/><label x="3.81" y="-20.32" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U1" gate="G$1" pin="VDD_CPU"/><wire x1="8.89" y1="-22.86" x2="3.81" y2="-22.86" width="0.1524" layer="91"/><label x="3.81" y="-22.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U1" gate="G$1" pin="VDDA"/><wire x1="8.89" y1="-27.94" x2="3.81" y2="-27.94" width="0.1524" layer="91"/><label x="3.81" y="-27.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C1" gate="G$1" pin="1"/><wire x1="52.07" y1="-7.62" x2="46.99" y2="-7.62" width="0.1524" layer="91"/><label x="46.99" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C2" gate="G$1" pin="1"/><wire x1="85.09" y1="-7.62" x2="80.01" y2="-7.62" width="0.1524" layer="91"/><label x="80.01" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R1" gate="G$1" pin="1"/><wire x1="118.11" y1="-7.62" x2="113.03" y2="-7.62" width="0.1524" layer="91"/><label x="113.03" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R3" gate="G$1" pin="1"/><wire x1="184.15" y1="-7.62" x2="179.07" y2="-7.62" width="0.1524" layer="91"/><label x="179.07" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="TP3" gate="G$1" pin="TP"/><wire x1="74.93" y1="-73.66" x2="69.85" y2="-73.66" width="0.1524" layer="91"/><label x="69.85" y="-73.66" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="L4" gate="G$1" pin="1"/><wire x1="8.89" y1="-104.14" x2="3.81" y2="-104.14" width="0.1524" layer="91"/><label x="3.81" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C35" gate="G$1" pin="1"/><wire x1="74.93" y1="-104.14" x2="69.85" y2="-104.14" width="0.1524" layer="91"/><label x="69.85" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C36" gate="G$1" pin="1"/><wire x1="107.95" y1="-104.14" x2="102.87" y2="-104.14" width="0.1524" layer="91"/><label x="102.87" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C38" gate="G$1" pin="1"/><wire x1="173.99" y1="-104.14" x2="168.91" y2="-104.14" width="0.1524" layer="91"/><label x="168.91" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C39" gate="G$1" pin="1"/><wire x1="8.89" y1="-134.62" x2="3.81" y2="-134.62" width="0.1524" layer="91"/><label x="3.81" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U5" gate="G$1" pin="VOUT"/><wire x1="176.53" y1="-383.54" x2="181.61" y2="-383.54" width="0.1524" layer="91"/><label x="181.61" y="-383.54" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R11" gate="G$1" pin="1"/><wire x1="8.89" y1="-424.18" x2="3.81" y2="-424.18" width="0.1524" layer="91"/><label x="3.81" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C9" gate="G$1" pin="1"/><wire x1="107.95" y1="-424.18" x2="102.87" y2="-424.18" width="0.1524" layer="91"/><label x="102.87" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C10" gate="G$1" pin="1"/><wire x1="140.97" y1="-424.18" x2="135.89" y2="-424.18" width="0.1524" layer="91"/><label x="135.89" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R13" gate="G$1" pin="1"/><wire x1="8.89" y1="-469.9" x2="3.81" y2="-469.9" width="0.1524" layer="91"/><label x="3.81" y="-469.9" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R14" gate="G$1" pin="1"/><wire x1="41.91" y1="-469.9" x2="36.83" y2="-469.9" width="0.1524" layer="91"/><label x="36.83" y="-469.9" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VDD_PAD"/><wire x1="8.89" y1="-528.32" x2="3.81" y2="-528.32" width="0.1524" layer="91"/><label x="3.81" y="-528.32" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C19" gate="G$1" pin="1"/><wire x1="107.95" y1="-591.82" x2="102.87" y2="-591.82" width="0.1524" layer="91"/><label x="102.87" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="ESP_VDD_SPI" class="0"><segment><pinref part="U1" gate="G$1" pin="VDD_SPI"/><wire x1="8.89" y1="-25.4" x2="3.81" y2="-25.4" width="0.1524" layer="91"/><label x="3.81" y="-25.4" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C37" gate="G$1" pin="1"/><wire x1="140.97" y1="-104.14" x2="135.89" y2="-104.14" width="0.1524" layer="91"/><label x="135.89" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="ESP_RF_CHIP" class="4"><segment><pinref part="U1" gate="G$1" pin="LNA_IN"/><wire x1="8.89" y1="-7.62" x2="3.81" y2="-7.62" width="0.1524" layer="91"/><label x="3.81" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="L6" gate="G$1" pin="1"/><wire x1="8.89" y1="-185.42" x2="3.81" y2="-185.42" width="0.1524" layer="91"/><label x="3.81" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C42" gate="G$1" pin="1"/><wire x1="41.91" y1="-185.42" x2="36.83" y2="-185.42" width="0.1524" layer="91"/><label x="36.83" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="ESP_XTAL_N" class="0"><segment><pinref part="U1" gate="G$1" pin="XTAL_N"/><wire x1="34.29" y1="-40.64" x2="39.37" y2="-40.64" width="0.1524" layer="91"/><label x="39.37" y="-40.64" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="Y2" gate="G$1" pin="2"/><wire x1="67.31" y1="-137.16" x2="72.39" y2="-137.16" width="0.1524" layer="91"/><label x="72.39" y="-137.16" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C41" gate="G$1" pin="1"/><wire x1="151.13" y1="-134.62" x2="146.05" y2="-134.62" width="0.1524" layer="91"/><label x="146.05" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="ESP_XTAL_P" class="0"><segment><pinref part="U1" gate="G$1" pin="XTAL_P"/><wire x1="34.29" y1="-43.18" x2="39.37" y2="-43.18" width="0.1524" layer="91"/><label x="39.37" y="-43.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="L5" gate="G$1" pin="1"/><wire x1="85.09" y1="-134.62" x2="80.01" y2="-134.62" width="0.1524" layer="91"/><label x="80.01" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="GND" class="0"><segment><pinref part="U1" gate="G$1" pin="GND"/><wire x1="8.89" y1="-30.48" x2="3.81" y2="-30.48" width="0.1524" layer="91"/><label x="3.81" y="-30.48" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C1" gate="G$1" pin="2"/><wire x1="67.31" y1="-7.62" x2="72.39" y2="-7.62" width="0.1524" layer="91"/><label x="72.39" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C2" gate="G$1" pin="2"/><wire x1="100.33" y1="-7.62" x2="105.41" y2="-7.62" width="0.1524" layer="91"/><label x="105.41" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C3" gate="G$1" pin="2"/><wire x1="166.37" y1="-7.62" x2="171.45" y2="-7.62" width="0.1524" layer="91"/><label x="171.45" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="TP4" gate="G$1" pin="TP"/><wire x1="107.95" y1="-73.66" x2="102.87" y2="-73.66" width="0.1524" layer="91"/><label x="102.87" y="-73.66" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C34" gate="G$1" pin="2"/><wire x1="57.15" y1="-104.14" x2="62.23" y2="-104.14" width="0.1524" layer="91"/><label x="62.23" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C35" gate="G$1" pin="2"/><wire x1="90.17" y1="-104.14" x2="95.25" y2="-104.14" width="0.1524" layer="91"/><label x="95.25" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C36" gate="G$1" pin="2"/><wire x1="123.19" y1="-104.14" x2="128.27" y2="-104.14" width="0.1524" layer="91"/><label x="128.27" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C37" gate="G$1" pin="2"/><wire x1="156.21" y1="-104.14" x2="161.29" y2="-104.14" width="0.1524" layer="91"/><label x="161.29" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C38" gate="G$1" pin="2"/><wire x1="189.23" y1="-104.14" x2="194.31" y2="-104.14" width="0.1524" layer="91"/><label x="194.31" y="-104.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C39" gate="G$1" pin="2"/><wire x1="24.13" y1="-134.62" x2="29.21" y2="-134.62" width="0.1524" layer="91"/><label x="29.21" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="Y2" gate="G$1" pin="GND_A"/><wire x1="67.31" y1="-134.62" x2="72.39" y2="-134.62" width="0.1524" layer="91"/><label x="72.39" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="Y2" gate="G$1" pin="GND_B"/><wire x1="41.91" y1="-137.16" x2="36.83" y2="-137.16" width="0.1524" layer="91"/><label x="36.83" y="-137.16" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C40" gate="G$1" pin="2"/><wire x1="133.35" y1="-134.62" x2="138.43" y2="-134.62" width="0.1524" layer="91"/><label x="138.43" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C41" gate="G$1" pin="2"/><wire x1="166.37" y1="-134.62" x2="171.45" y2="-134.62" width="0.1524" layer="91"/><label x="171.45" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C42" gate="G$1" pin="2"/><wire x1="57.15" y1="-185.42" x2="62.23" y2="-185.42" width="0.1524" layer="91"/><label x="62.23" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C43" gate="G$1" pin="2"/><wire x1="90.17" y1="-185.42" x2="95.25" y2="-185.42" width="0.1524" layer="91"/><label x="95.25" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C44" gate="G$1" pin="2"/><wire x1="156.21" y1="-185.42" x2="161.29" y2="-185.42" width="0.1524" layer="91"/><label x="161.29" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C45" gate="G$1" pin="2"/><wire x1="189.23" y1="-185.42" x2="194.31" y2="-185.42" width="0.1524" layer="91"/><label x="194.31" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="ANT1" gate="G$1" pin="GND"/><wire x1="8.89" y1="-218.44" x2="3.81" y2="-218.44" width="0.1524" layer="91"/><label x="3.81" y="-218.44" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R23" gate="G$1" pin="2"/><wire x1="67.31" y1="-215.9" x2="72.39" y2="-215.9" width="0.1524" layer="91"/><label x="72.39" y="-215.9" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="J1" gate="G$1" pin="GND"/><wire x1="8.89" y1="-266.7" x2="3.81" y2="-266.7" width="0.1524" layer="91"/><label x="3.81" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="J1" gate="G$1" pin="SHIELD"/><wire x1="34.29" y1="-276.86" x2="39.37" y2="-276.86" width="0.1524" layer="91"/><label x="39.37" y="-276.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R4" gate="G$1" pin="2"/><wire x1="67.31" y1="-266.7" x2="72.39" y2="-266.7" width="0.1524" layer="91"/><label x="72.39" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R5" gate="G$1" pin="2"/><wire x1="100.33" y1="-266.7" x2="105.41" y2="-266.7" width="0.1524" layer="91"/><label x="105.41" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="D1" gate="G$1" pin="GND"/><wire x1="118.11" y1="-269.24" x2="113.03" y2="-269.24" width="0.1524" layer="91"/><label x="113.03" y="-269.24" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R7" gate="G$1" pin="2"/><wire x1="209.55" y1="-266.7" x2="214.63" y2="-266.7" width="0.1524" layer="91"/><label x="214.63" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="J2" gate="G$1" pin="BAT_N"/><wire x1="8.89" y1="-325.12" x2="3.81" y2="-325.12" width="0.1524" layer="91"/><label x="3.81" y="-325.12" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="J2" gate="G$1" pin="MECH"/><wire x1="34.29" y1="-322.58" x2="39.37" y2="-322.58" width="0.1524" layer="91"/><label x="39.37" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U4" gate="G$1" pin="VSS"/><wire x1="52.07" y1="-332.74" x2="46.99" y2="-332.74" width="0.1524" layer="91"/><label x="46.99" y="-332.74" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U4" gate="G$1" pin="CE"/><wire x1="52.07" y1="-325.12" x2="46.99" y2="-325.12" width="0.1524" layer="91"/><label x="46.99" y="-325.12" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U4" gate="G$1" pin="EN1"/><wire x1="52.07" y1="-330.2" x2="46.99" y2="-330.2" width="0.1524" layer="91"/><label x="46.99" y="-330.2" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R8" gate="G$1" pin="2"/><wire x1="110.49" y1="-322.58" x2="115.57" y2="-322.58" width="0.1524" layer="91"/><label x="115.57" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R9" gate="G$1" pin="2"/><wire x1="143.51" y1="-322.58" x2="148.59" y2="-322.58" width="0.1524" layer="91"/><label x="148.59" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R10" gate="G$1" pin="2"/><wire x1="176.53" y1="-322.58" x2="181.61" y2="-322.58" width="0.1524" layer="91"/><label x="181.61" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C4" gate="G$1" pin="2"/><wire x1="209.55" y1="-322.58" x2="214.63" y2="-322.58" width="0.1524" layer="91"/><label x="214.63" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C5" gate="G$1" pin="2"/><wire x1="24.13" y1="-378.46" x2="29.21" y2="-378.46" width="0.1524" layer="91"/><label x="29.21" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C6" gate="G$1" pin="2"/><wire x1="57.15" y1="-378.46" x2="62.23" y2="-378.46" width="0.1524" layer="91"/><label x="62.23" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U3" gate="G$1" pin="CTG"/><wire x1="74.93" y1="-378.46" x2="69.85" y2="-378.46" width="0.1524" layer="91"/><label x="69.85" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U3" gate="G$1" pin="GND"/><wire x1="74.93" y1="-386.08" x2="69.85" y2="-386.08" width="0.1524" layer="91"/><label x="69.85" y="-386.08" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U3" gate="G$1" pin="QSTRT"/><wire x1="100.33" y1="-381" x2="105.41" y2="-381" width="0.1524" layer="91"/><label x="105.41" y="-381" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C7" gate="G$1" pin="2"/><wire x1="133.35" y1="-378.46" x2="138.43" y2="-378.46" width="0.1524" layer="91"/><label x="138.43" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U5" gate="G$1" pin="MODE"/><wire x1="151.13" y1="-381" x2="146.05" y2="-381" width="0.1524" layer="91"/><label x="146.05" y="-381" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U5" gate="G$1" pin="AGND"/><wire x1="151.13" y1="-383.54" x2="146.05" y2="-383.54" width="0.1524" layer="91"/><label x="146.05" y="-383.54" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U5" gate="G$1" pin="GND"/><wire x1="151.13" y1="-386.08" x2="146.05" y2="-386.08" width="0.1524" layer="91"/><label x="146.05" y="-386.08" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R12" gate="G$1" pin="2"/><wire x1="57.15" y1="-424.18" x2="62.23" y2="-424.18" width="0.1524" layer="91"/><label x="62.23" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C8" gate="G$1" pin="2"/><wire x1="90.17" y1="-424.18" x2="95.25" y2="-424.18" width="0.1524" layer="91"/><label x="95.25" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C9" gate="G$1" pin="2"/><wire x1="123.19" y1="-424.18" x2="128.27" y2="-424.18" width="0.1524" layer="91"/><label x="128.27" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C10" gate="G$1" pin="2"/><wire x1="156.21" y1="-424.18" x2="161.29" y2="-424.18" width="0.1524" layer="91"/><label x="161.29" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="I2C_ADR0"/><wire x1="8.89" y1="-515.62" x2="3.81" y2="-515.62" width="0.1524" layer="91"/><label x="3.81" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="I2C_ADR1"/><wire x1="8.89" y1="-520.7" x2="3.81" y2="-520.7" width="0.1524" layer="91"/><label x="3.81" y="-520.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="DWL_REQ"/><wire x1="8.89" y1="-518.16" x2="3.81" y2="-518.16" width="0.1524" layer="91"/><label x="3.81" y="-518.16" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VSS_PAD"/><wire x1="8.89" y1="-523.24" x2="3.81" y2="-523.24" width="0.1524" layer="91"/><label x="3.81" y="-523.24" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VSS_A"/><wire x1="8.89" y1="-535.94" x2="3.81" y2="-535.94" width="0.1524" layer="91"/><label x="3.81" y="-535.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VSS_TX"/><wire x1="34.29" y1="-530.86" x2="39.37" y2="-530.86" width="0.1524" layer="91"/><label x="39.37" y="-530.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VSS"/><wire x1="8.89" y1="-551.18" x2="3.81" y2="-551.18" width="0.1524" layer="91"/><label x="3.81" y="-551.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="WKUP_REQ"/><wire x1="8.89" y1="-546.1" x2="3.81" y2="-546.1" width="0.1524" layer="91"/><label x="3.81" y="-546.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C11" gate="G$1" pin="2"/><wire x1="67.31" y1="-515.62" x2="72.39" y2="-515.62" width="0.1524" layer="91"/><label x="72.39" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C12" gate="G$1" pin="2"/><wire x1="100.33" y1="-515.62" x2="105.41" y2="-515.62" width="0.1524" layer="91"/><label x="105.41" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C13" gate="G$1" pin="2"/><wire x1="133.35" y1="-515.62" x2="138.43" y2="-515.62" width="0.1524" layer="91"/><label x="138.43" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C14" gate="G$1" pin="2"/><wire x1="166.37" y1="-515.62" x2="171.45" y2="-515.62" width="0.1524" layer="91"/><label x="171.45" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C15" gate="G$1" pin="2"/><wire x1="199.39" y1="-515.62" x2="204.47" y2="-515.62" width="0.1524" layer="91"/><label x="204.47" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C16" gate="G$1" pin="2"/><wire x1="24.13" y1="-591.82" x2="29.21" y2="-591.82" width="0.1524" layer="91"/><label x="29.21" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C17" gate="G$1" pin="2"/><wire x1="57.15" y1="-591.82" x2="62.23" y2="-591.82" width="0.1524" layer="91"/><label x="62.23" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C18" gate="G$1" pin="2"/><wire x1="90.17" y1="-591.82" x2="95.25" y2="-591.82" width="0.1524" layer="91"/><label x="95.25" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C19" gate="G$1" pin="2"/><wire x1="123.19" y1="-591.82" x2="128.27" y2="-591.82" width="0.1524" layer="91"/><label x="128.27" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="Y1" gate="G$1" pin="GND_A"/><wire x1="166.37" y1="-591.82" x2="171.45" y2="-591.82" width="0.1524" layer="91"/><label x="171.45" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="Y1" gate="G$1" pin="GND_B"/><wire x1="140.97" y1="-594.36" x2="135.89" y2="-594.36" width="0.1524" layer="91"/><label x="135.89" y="-594.36" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C20" gate="G$1" pin="2"/><wire x1="199.39" y1="-591.82" x2="204.47" y2="-591.82" width="0.1524" layer="91"/><label x="204.47" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C21" gate="G$1" pin="2"/><wire x1="24.13" y1="-627.38" x2="29.21" y2="-627.38" width="0.1524" layer="91"/><label x="29.21" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C22" gate="G$1" pin="2"/><wire x1="123.19" y1="-627.38" x2="128.27" y2="-627.38" width="0.1524" layer="91"/><label x="128.27" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C23" gate="G$1" pin="2"/><wire x1="156.21" y1="-627.38" x2="161.29" y2="-627.38" width="0.1524" layer="91"/><label x="161.29" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="J3" gate="G$1" pin="MECH"/><wire x1="34.29" y1="-693.42" x2="39.37" y2="-693.42" width="0.1524" layer="91"/><label x="39.37" y="-693.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U6" gate="G$1" pin="GND"/><wire x1="8.89" y1="-744.22" x2="3.81" y2="-744.22" width="0.1524" layer="91"/><label x="3.81" y="-744.22" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R18" gate="G$1" pin="2"/><wire x1="100.33" y1="-739.14" x2="105.41" y2="-739.14" width="0.1524" layer="91"/><label x="105.41" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C29" gate="G$1" pin="2"/><wire x1="133.35" y1="-739.14" x2="138.43" y2="-739.14" width="0.1524" layer="91"/><label x="138.43" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C30" gate="G$1" pin="2"/><wire x1="166.37" y1="-739.14" x2="171.45" y2="-739.14" width="0.1524" layer="91"/><label x="171.45" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U7" gate="G$1" pin="GND"/><wire x1="8.89" y1="-802.64" x2="3.81" y2="-802.64" width="0.1524" layer="91"/><label x="3.81" y="-802.64" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R19" gate="G$1" pin="2"/><wire x1="67.31" y1="-800.1" x2="72.39" y2="-800.1" width="0.1524" layer="91"/><label x="72.39" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C31" gate="G$1" pin="2"/><wire x1="100.33" y1="-800.1" x2="105.41" y2="-800.1" width="0.1524" layer="91"/><label x="105.41" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C32" gate="G$1" pin="N"/><wire x1="133.35" y1="-800.1" x2="138.43" y2="-800.1" width="0.1524" layer="91"/><label x="138.43" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C33" gate="G$1" pin="N"/><wire x1="166.37" y1="-800.1" x2="171.45" y2="-800.1" width="0.1524" layer="91"/><label x="171.45" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U8" gate="G$1" pin="GND"/><wire x1="184.15" y1="-802.64" x2="179.07" y2="-802.64" width="0.1524" layer="91"/><label x="179.07" y="-802.64" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R20" gate="G$1" pin="2"/><wire x1="24.13" y1="-835.66" x2="29.21" y2="-835.66" width="0.1524" layer="91"/><label x="29.21" y="-835.66" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED1" gate="G$1" pin="VSS"/><wire x1="8.89" y1="-883.92" x2="3.81" y2="-883.92" width="0.1524" layer="91"/><label x="3.81" y="-883.92" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C101" gate="G$1" pin="2"/><wire x1="67.31" y1="-881.38" x2="72.39" y2="-881.38" width="0.1524" layer="91"/><label x="72.39" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED2" gate="G$1" pin="VSS"/><wire x1="85.09" y1="-883.92" x2="80.01" y2="-883.92" width="0.1524" layer="91"/><label x="80.01" y="-883.92" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C102" gate="G$1" pin="2"/><wire x1="143.51" y1="-881.38" x2="148.59" y2="-881.38" width="0.1524" layer="91"/><label x="148.59" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED3" gate="G$1" pin="VSS"/><wire x1="161.29" y1="-883.92" x2="156.21" y2="-883.92" width="0.1524" layer="91"/><label x="156.21" y="-883.92" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C103" gate="G$1" pin="2"/><wire x1="219.71" y1="-881.38" x2="224.79" y2="-881.38" width="0.1524" layer="91"/><label x="224.79" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED4" gate="G$1" pin="VSS"/><wire x1="237.49" y1="-883.92" x2="232.41" y2="-883.92" width="0.1524" layer="91"/><label x="232.41" y="-883.92" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C104" gate="G$1" pin="2"/><wire x1="295.91" y1="-881.38" x2="300.99" y2="-881.38" width="0.1524" layer="91"/><label x="300.99" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED5" gate="G$1" pin="VSS"/><wire x1="313.69" y1="-883.92" x2="308.61" y2="-883.92" width="0.1524" layer="91"/><label x="308.61" y="-883.92" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C105" gate="G$1" pin="2"/><wire x1="372.11" y1="-881.38" x2="377.19" y2="-881.38" width="0.1524" layer="91"/><label x="377.19" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED6" gate="G$1" pin="VSS"/><wire x1="389.89" y1="-883.92" x2="384.81" y2="-883.92" width="0.1524" layer="91"/><label x="384.81" y="-883.92" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C106" gate="G$1" pin="2"/><wire x1="448.31" y1="-881.38" x2="453.39" y2="-881.38" width="0.1524" layer="91"/><label x="453.39" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED7" gate="G$1" pin="VSS"/><wire x1="466.09" y1="-883.92" x2="461.01" y2="-883.92" width="0.1524" layer="91"/><label x="461.01" y="-883.92" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C107" gate="G$1" pin="2"/><wire x1="524.51" y1="-881.38" x2="529.59" y2="-881.38" width="0.1524" layer="91"/><label x="529.59" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED8" gate="G$1" pin="VSS"/><wire x1="8.89" y1="-919.48" x2="3.81" y2="-919.48" width="0.1524" layer="91"/><label x="3.81" y="-919.48" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C108" gate="G$1" pin="2"/><wire x1="67.31" y1="-916.94" x2="72.39" y2="-916.94" width="0.1524" layer="91"/><label x="72.39" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED9" gate="G$1" pin="VSS"/><wire x1="85.09" y1="-919.48" x2="80.01" y2="-919.48" width="0.1524" layer="91"/><label x="80.01" y="-919.48" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C109" gate="G$1" pin="2"/><wire x1="143.51" y1="-916.94" x2="148.59" y2="-916.94" width="0.1524" layer="91"/><label x="148.59" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED10" gate="G$1" pin="VSS"/><wire x1="161.29" y1="-919.48" x2="156.21" y2="-919.48" width="0.1524" layer="91"/><label x="156.21" y="-919.48" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C110" gate="G$1" pin="2"/><wire x1="219.71" y1="-916.94" x2="224.79" y2="-916.94" width="0.1524" layer="91"/><label x="224.79" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED11" gate="G$1" pin="VSS"/><wire x1="237.49" y1="-919.48" x2="232.41" y2="-919.48" width="0.1524" layer="91"/><label x="232.41" y="-919.48" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C111" gate="G$1" pin="2"/><wire x1="295.91" y1="-916.94" x2="300.99" y2="-916.94" width="0.1524" layer="91"/><label x="300.99" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED12" gate="G$1" pin="VSS"/><wire x1="313.69" y1="-919.48" x2="308.61" y2="-919.48" width="0.1524" layer="91"/><label x="308.61" y="-919.48" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C112" gate="G$1" pin="2"/><wire x1="372.11" y1="-916.94" x2="377.19" y2="-916.94" width="0.1524" layer="91"/><label x="377.19" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED13" gate="G$1" pin="VSS"/><wire x1="389.89" y1="-919.48" x2="384.81" y2="-919.48" width="0.1524" layer="91"/><label x="384.81" y="-919.48" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C113" gate="G$1" pin="2"/><wire x1="448.31" y1="-916.94" x2="453.39" y2="-916.94" width="0.1524" layer="91"/><label x="453.39" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED14" gate="G$1" pin="VSS"/><wire x1="466.09" y1="-919.48" x2="461.01" y2="-919.48" width="0.1524" layer="91"/><label x="461.01" y="-919.48" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C114" gate="G$1" pin="2"/><wire x1="524.51" y1="-916.94" x2="529.59" y2="-916.94" width="0.1524" layer="91"/><label x="529.59" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED15" gate="G$1" pin="VSS"/><wire x1="8.89" y1="-955.04" x2="3.81" y2="-955.04" width="0.1524" layer="91"/><label x="3.81" y="-955.04" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C115" gate="G$1" pin="2"/><wire x1="67.31" y1="-952.5" x2="72.39" y2="-952.5" width="0.1524" layer="91"/><label x="72.39" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED16" gate="G$1" pin="VSS"/><wire x1="85.09" y1="-955.04" x2="80.01" y2="-955.04" width="0.1524" layer="91"/><label x="80.01" y="-955.04" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C116" gate="G$1" pin="2"/><wire x1="143.51" y1="-952.5" x2="148.59" y2="-952.5" width="0.1524" layer="91"/><label x="148.59" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED17" gate="G$1" pin="VSS"/><wire x1="161.29" y1="-955.04" x2="156.21" y2="-955.04" width="0.1524" layer="91"/><label x="156.21" y="-955.04" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C117" gate="G$1" pin="2"/><wire x1="219.71" y1="-952.5" x2="224.79" y2="-952.5" width="0.1524" layer="91"/><label x="224.79" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED18" gate="G$1" pin="VSS"/><wire x1="237.49" y1="-955.04" x2="232.41" y2="-955.04" width="0.1524" layer="91"/><label x="232.41" y="-955.04" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C118" gate="G$1" pin="2"/><wire x1="295.91" y1="-952.5" x2="300.99" y2="-952.5" width="0.1524" layer="91"/><label x="300.99" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED19" gate="G$1" pin="VSS"/><wire x1="313.69" y1="-955.04" x2="308.61" y2="-955.04" width="0.1524" layer="91"/><label x="308.61" y="-955.04" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C119" gate="G$1" pin="2"/><wire x1="372.11" y1="-952.5" x2="377.19" y2="-952.5" width="0.1524" layer="91"/><label x="377.19" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED20" gate="G$1" pin="VSS"/><wire x1="389.89" y1="-955.04" x2="384.81" y2="-955.04" width="0.1524" layer="91"/><label x="384.81" y="-955.04" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C120" gate="G$1" pin="2"/><wire x1="448.31" y1="-952.5" x2="453.39" y2="-952.5" width="0.1524" layer="91"/><label x="453.39" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED21" gate="G$1" pin="VSS"/><wire x1="466.09" y1="-955.04" x2="461.01" y2="-955.04" width="0.1524" layer="91"/><label x="461.01" y="-955.04" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C121" gate="G$1" pin="2"/><wire x1="524.51" y1="-952.5" x2="529.59" y2="-952.5" width="0.1524" layer="91"/><label x="529.59" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED22" gate="G$1" pin="VSS"/><wire x1="8.89" y1="-990.6" x2="3.81" y2="-990.6" width="0.1524" layer="91"/><label x="3.81" y="-990.6" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C122" gate="G$1" pin="2"/><wire x1="67.31" y1="-988.06" x2="72.39" y2="-988.06" width="0.1524" layer="91"/><label x="72.39" y="-988.06" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED23" gate="G$1" pin="VSS"/><wire x1="85.09" y1="-990.6" x2="80.01" y2="-990.6" width="0.1524" layer="91"/><label x="80.01" y="-990.6" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C123" gate="G$1" pin="2"/><wire x1="143.51" y1="-988.06" x2="148.59" y2="-988.06" width="0.1524" layer="91"/><label x="148.59" y="-988.06" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="EN" class="0"><segment><pinref part="U1" gate="G$1" pin="EN"/><wire x1="8.89" y1="-15.24" x2="3.81" y2="-15.24" width="0.1524" layer="91"/><label x="3.81" y="-15.24" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R1" gate="G$1" pin="2"/><wire x1="133.35" y1="-7.62" x2="138.43" y2="-7.62" width="0.1524" layer="91"/><label x="138.43" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C3" gate="G$1" pin="1"/><wire x1="151.13" y1="-7.62" x2="146.05" y2="-7.62" width="0.1524" layer="91"/><label x="146.05" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="TP1" gate="G$1" pin="TP"/><wire x1="8.89" y1="-73.66" x2="3.81" y2="-73.66" width="0.1524" layer="91"/><label x="3.81" y="-73.66" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_IRQ" class="0"><segment><pinref part="U1" gate="G$1" pin="IO0"/><wire x1="34.29" y1="-7.62" x2="39.37" y2="-7.62" width="0.1524" layer="91"/><label x="39.37" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="IRQ"/><wire x1="8.89" y1="-533.4" x2="3.81" y2="-533.4" width="0.1524" layer="91"/><label x="3.81" y="-533.4" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_VEN" class="0"><segment><pinref part="U1" gate="G$1" pin="IO1"/><wire x1="34.29" y1="-10.16" x2="39.37" y2="-10.16" width="0.1524" layer="91"/><label x="39.37" y="-10.16" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VEN"/><wire x1="8.89" y1="-538.48" x2="3.81" y2="-538.48" width="0.1524" layer="91"/><label x="3.81" y="-538.48" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="CHG_STATUS" class="0"><segment><pinref part="U1" gate="G$1" pin="IO2"/><wire x1="8.89" y1="-12.7" x2="3.81" y2="-12.7" width="0.1524" layer="91"/><label x="3.81" y="-12.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R3" gate="G$1" pin="2"/><wire x1="199.39" y1="-7.62" x2="204.47" y2="-7.62" width="0.1524" layer="91"/><label x="204.47" y="-7.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U4" gate="G$1" pin="CHG"/><wire x1="77.47" y1="-327.66" x2="82.55" y2="-327.66" width="0.1524" layer="91"/><label x="82.55" y="-327.66" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_EN" class="0"><segment><pinref part="U1" gate="G$1" pin="IO3"/><wire x1="8.89" y1="-17.78" x2="3.81" y2="-17.78" width="0.1524" layer="91"/><label x="3.81" y="-17.78" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U7" gate="G$1" pin="ON"/><wire x1="8.89" y1="-805.18" x2="3.81" y2="-805.18" width="0.1524" layer="91"/><label x="3.81" y="-805.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R19" gate="G$1" pin="1"/><wire x1="52.07" y1="-800.1" x2="46.99" y2="-800.1" width="0.1524" layer="91"/><label x="46.99" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="I2C_SDA" class="0"><segment><pinref part="U1" gate="G$1" pin="IO4"/><wire x1="34.29" y1="-12.7" x2="39.37" y2="-12.7" width="0.1524" layer="91"/><label x="39.37" y="-12.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U3" gate="G$1" pin="SDA"/><wire x1="100.33" y1="-386.08" x2="105.41" y2="-386.08" width="0.1524" layer="91"/><label x="105.41" y="-386.08" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R13" gate="G$1" pin="2"/><wire x1="24.13" y1="-469.9" x2="29.21" y2="-469.9" width="0.1524" layer="91"/><label x="29.21" y="-469.9" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="SDA"/><wire x1="8.89" y1="-525.78" x2="3.81" y2="-525.78" width="0.1524" layer="91"/><label x="3.81" y="-525.78" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="I2C_SCL" class="0"><segment><pinref part="U1" gate="G$1" pin="IO5"/><wire x1="34.29" y1="-15.24" x2="39.37" y2="-15.24" width="0.1524" layer="91"/><label x="39.37" y="-15.24" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U3" gate="G$1" pin="SCL"/><wire x1="100.33" y1="-383.54" x2="105.41" y2="-383.54" width="0.1524" layer="91"/><label x="105.41" y="-383.54" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R14" gate="G$1" pin="2"/><wire x1="57.15" y1="-469.9" x2="62.23" y2="-469.9" width="0.1524" layer="91"/><label x="62.23" y="-469.9" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="SCL"/><wire x1="8.89" y1="-530.86" x2="3.81" y2="-530.86" width="0.1524" layer="91"/><label x="3.81" y="-530.86" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_DATA_3V3" class="0"><segment><pinref part="U1" gate="G$1" pin="IO6"/><wire x1="34.29" y1="-17.78" x2="39.37" y2="-17.78" width="0.1524" layer="91"/><label x="39.37" y="-17.78" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U8" gate="G$1" pin="A"/><wire x1="184.15" y1="-800.1" x2="179.07" y2="-800.1" width="0.1524" layer="91"/><label x="179.07" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R20" gate="G$1" pin="1"/><wire x1="8.89" y1="-835.66" x2="3.81" y2="-835.66" width="0.1524" layer="91"/><label x="3.81" y="-835.66" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="I2S_BCLK" class="0"><segment><pinref part="U1" gate="G$1" pin="IO7"/><wire x1="34.29" y1="-20.32" x2="39.37" y2="-20.32" width="0.1524" layer="91"/><label x="39.37" y="-20.32" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U6" gate="G$1" pin="BCLK"/><wire x1="8.89" y1="-751.84" x2="3.81" y2="-751.84" width="0.1524" layer="91"/><label x="3.81" y="-751.84" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="VBUS_SENSE" class="0"><segment><pinref part="U1" gate="G$1" pin="IO8"/><wire x1="34.29" y1="-22.86" x2="39.37" y2="-22.86" width="0.1524" layer="91"/><label x="39.37" y="-22.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R6" gate="G$1" pin="2"/><wire x1="176.53" y1="-266.7" x2="181.61" y2="-266.7" width="0.1524" layer="91"/><label x="181.61" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R7" gate="G$1" pin="1"/><wire x1="194.31" y1="-266.7" x2="189.23" y2="-266.7" width="0.1524" layer="91"/><label x="189.23" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="BOOT" class="0"><segment><pinref part="U1" gate="G$1" pin="IO9"/><wire x1="34.29" y1="-25.4" x2="39.37" y2="-25.4" width="0.1524" layer="91"/><label x="39.37" y="-25.4" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="TP2" gate="G$1" pin="TP"/><wire x1="41.91" y1="-73.66" x2="36.83" y2="-73.66" width="0.1524" layer="91"/><label x="36.83" y="-73.66" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="I2S_LRCLK" class="0"><segment><pinref part="U1" gate="G$1" pin="IO10"/><wire x1="34.29" y1="-27.94" x2="39.37" y2="-27.94" width="0.1524" layer="91"/><label x="39.37" y="-27.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U6" gate="G$1" pin="LRCLK"/><wire x1="8.89" y1="-749.3" x2="3.81" y2="-749.3" width="0.1524" layer="91"/><label x="3.81" y="-749.3" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="USB_DN" class="5"><segment><pinref part="U1" gate="G$1" pin="IO18"/><wire x1="34.29" y1="-30.48" x2="39.37" y2="-30.48" width="0.1524" layer="91"/><label x="39.37" y="-30.48" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="D1" gate="G$1" pin="IO2_B"/><wire x1="143.51" y1="-266.7" x2="148.59" y2="-266.7" width="0.1524" layer="91"/><label x="148.59" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="USB_DP" class="5"><segment><pinref part="U1" gate="G$1" pin="IO19"/><wire x1="34.29" y1="-33.02" x2="39.37" y2="-33.02" width="0.1524" layer="91"/><label x="39.37" y="-33.02" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="D1" gate="G$1" pin="IO1_B"/><wire x1="143.51" y1="-271.78" x2="148.59" y2="-271.78" width="0.1524" layer="91"/><label x="148.59" y="-271.78" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="I2S_DIN" class="0"><segment><pinref part="U1" gate="G$1" pin="RXD0_IO20"/><wire x1="34.29" y1="-35.56" x2="39.37" y2="-35.56" width="0.1524" layer="91"/><label x="39.37" y="-35.56" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U6" gate="G$1" pin="DIN"/><wire x1="8.89" y1="-739.14" x2="3.81" y2="-739.14" width="0.1524" layer="91"/><label x="3.81" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="AMP_SD" class="0"><segment><pinref part="U1" gate="G$1" pin="TXD0_IO21"/><wire x1="34.29" y1="-38.1" x2="39.37" y2="-38.1" width="0.1524" layer="91"/><label x="39.37" y="-38.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R17" gate="G$1" pin="1"/><wire x1="52.07" y1="-739.14" x2="46.99" y2="-739.14" width="0.1524" layer="91"/><label x="46.99" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="VSYS" class="1"><segment><pinref part="TP5" gate="G$1" pin="TP"/><wire x1="140.97" y1="-73.66" x2="135.89" y2="-73.66" width="0.1524" layer="91"/><label x="135.89" y="-73.66" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U4" gate="G$1" pin="OUT"/><wire x1="77.47" y1="-330.2" x2="82.55" y2="-330.2" width="0.1524" layer="91"/><label x="82.55" y="-330.2" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U4" gate="G$1" pin="EN2"/><wire x1="52.07" y1="-327.66" x2="46.99" y2="-327.66" width="0.1524" layer="91"/><label x="46.99" y="-327.66" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C5" gate="G$1" pin="1"/><wire x1="8.89" y1="-378.46" x2="3.81" y2="-378.46" width="0.1524" layer="91"/><label x="3.81" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U5" gate="G$1" pin="VIN"/><wire x1="151.13" y1="-391.16" x2="146.05" y2="-391.16" width="0.1524" layer="91"/><label x="146.05" y="-391.16" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U5" gate="G$1" pin="EN"/><wire x1="151.13" y1="-378.46" x2="146.05" y2="-378.46" width="0.1524" layer="91"/><label x="146.05" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C8" gate="G$1" pin="1"/><wire x1="74.93" y1="-424.18" x2="69.85" y2="-424.18" width="0.1524" layer="91"/><label x="69.85" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VBAT"/><wire x1="34.29" y1="-551.18" x2="39.37" y2="-551.18" width="0.1524" layer="91"/><label x="39.37" y="-551.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VBAT2"/><wire x1="8.89" y1="-541.02" x2="3.81" y2="-541.02" width="0.1524" layer="91"/><label x="3.81" y="-541.02" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VDD_UP"/><wire x1="8.89" y1="-543.56" x2="3.81" y2="-543.56" width="0.1524" layer="91"/><label x="3.81" y="-543.56" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C11" gate="G$1" pin="1"/><wire x1="52.07" y1="-515.62" x2="46.99" y2="-515.62" width="0.1524" layer="91"/><label x="46.99" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C12" gate="G$1" pin="1"/><wire x1="85.09" y1="-515.62" x2="80.01" y2="-515.62" width="0.1524" layer="91"/><label x="80.01" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U6" gate="G$1" pin="VDD"/><wire x1="34.29" y1="-739.14" x2="39.37" y2="-739.14" width="0.1524" layer="91"/><label x="39.37" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C29" gate="G$1" pin="1"/><wire x1="118.11" y1="-739.14" x2="113.03" y2="-739.14" width="0.1524" layer="91"/><label x="113.03" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C30" gate="G$1" pin="1"/><wire x1="151.13" y1="-739.14" x2="146.05" y2="-739.14" width="0.1524" layer="91"/><label x="146.05" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U7" gate="G$1" pin="VIN"/><wire x1="8.89" y1="-800.1" x2="3.81" y2="-800.1" width="0.1524" layer="91"/><label x="3.81" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C31" gate="G$1" pin="1"/><wire x1="85.09" y1="-800.1" x2="80.01" y2="-800.1" width="0.1524" layer="91"/><label x="80.01" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="VBAT" class="1"><segment><pinref part="TP6" gate="G$1" pin="TP"/><wire x1="173.99" y1="-73.66" x2="168.91" y2="-73.66" width="0.1524" layer="91"/><label x="168.91" y="-73.66" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="J2" gate="G$1" pin="BAT_P"/><wire x1="8.89" y1="-322.58" x2="3.81" y2="-322.58" width="0.1524" layer="91"/><label x="3.81" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U4" gate="G$1" pin="BAT"/><wire x1="77.47" y1="-322.58" x2="82.55" y2="-322.58" width="0.1524" layer="91"/><label x="82.55" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C6" gate="G$1" pin="1"/><wire x1="41.91" y1="-378.46" x2="36.83" y2="-378.46" width="0.1524" layer="91"/><label x="36.83" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U3" gate="G$1" pin="CELL"/><wire x1="74.93" y1="-381" x2="69.85" y2="-381" width="0.1524" layer="91"/><label x="69.85" y="-381" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U3" gate="G$1" pin="VDD"/><wire x1="74.93" y1="-383.54" x2="69.85" y2="-383.54" width="0.1524" layer="91"/><label x="69.85" y="-383.54" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C7" gate="G$1" pin="1"/><wire x1="118.11" y1="-378.46" x2="113.03" y2="-378.46" width="0.1524" layer="91"/><label x="113.03" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="ESP_XTAL_DRIVE" class="0"><segment><pinref part="Y2" gate="G$1" pin="1"/><wire x1="41.91" y1="-134.62" x2="36.83" y2="-134.62" width="0.1524" layer="91"/><label x="36.83" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="L5" gate="G$1" pin="2"/><wire x1="100.33" y1="-134.62" x2="105.41" y2="-134.62" width="0.1524" layer="91"/><label x="105.41" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C40" gate="G$1" pin="1"/><wire x1="118.11" y1="-134.62" x2="113.03" y2="-134.62" width="0.1524" layer="91"/><label x="113.03" y="-134.62" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="RF_50OHM" class="4"><segment><pinref part="L6" gate="G$1" pin="2"/><wire x1="24.13" y1="-185.42" x2="29.21" y2="-185.42" width="0.1524" layer="91"/><label x="29.21" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C43" gate="G$1" pin="1"/><wire x1="74.93" y1="-185.42" x2="69.85" y2="-185.42" width="0.1524" layer="91"/><label x="69.85" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R22" gate="G$1" pin="1"/><wire x1="107.95" y1="-185.42" x2="102.87" y2="-185.42" width="0.1524" layer="91"/><label x="102.87" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C44" gate="G$1" pin="1"/><wire x1="140.97" y1="-185.42" x2="135.89" y2="-185.42" width="0.1524" layer="91"/><label x="135.89" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="ANT_FEED" class="4"><segment><pinref part="R22" gate="G$1" pin="2"/><wire x1="123.19" y1="-185.42" x2="128.27" y2="-185.42" width="0.1524" layer="91"/><label x="128.27" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C45" gate="G$1" pin="1"/><wire x1="173.99" y1="-185.42" x2="168.91" y2="-185.42" width="0.1524" layer="91"/><label x="168.91" y="-185.42" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="ANT1" gate="G$1" pin="FEED"/><wire x1="8.89" y1="-215.9" x2="3.81" y2="-215.9" width="0.1524" layer="91"/><label x="3.81" y="-215.9" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="ANT_GND_TUNE" class="4"><segment><pinref part="ANT1" gate="G$1" pin="TUNE"/><wire x1="34.29" y1="-215.9" x2="39.37" y2="-215.9" width="0.1524" layer="91"/><label x="39.37" y="-215.9" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R23" gate="G$1" pin="1"/><wire x1="52.07" y1="-215.9" x2="46.99" y2="-215.9" width="0.1524" layer="91"/><label x="46.99" y="-215.9" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="VBUS" class="1"><segment><pinref part="J1" gate="G$1" pin="VBUS"/><wire x1="8.89" y1="-269.24" x2="3.81" y2="-269.24" width="0.1524" layer="91"/><label x="3.81" y="-269.24" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="D1" gate="G$1" pin="VBUS"/><wire x1="143.51" y1="-269.24" x2="148.59" y2="-269.24" width="0.1524" layer="91"/><label x="148.59" y="-269.24" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R6" gate="G$1" pin="1"/><wire x1="161.29" y1="-266.7" x2="156.21" y2="-266.7" width="0.1524" layer="91"/><label x="156.21" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U4" gate="G$1" pin="IN"/><wire x1="52.07" y1="-337.82" x2="46.99" y2="-337.82" width="0.1524" layer="91"/><label x="46.99" y="-337.82" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C4" gate="G$1" pin="1"/><wire x1="194.31" y1="-322.58" x2="189.23" y2="-322.58" width="0.1524" layer="91"/><label x="189.23" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="CC1" class="0"><segment><pinref part="J1" gate="G$1" pin="CC1"/><wire x1="8.89" y1="-271.78" x2="3.81" y2="-271.78" width="0.1524" layer="91"/><label x="3.81" y="-271.78" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R4" gate="G$1" pin="1"/><wire x1="52.07" y1="-266.7" x2="46.99" y2="-266.7" width="0.1524" layer="91"/><label x="46.99" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="CC2" class="0"><segment><pinref part="J1" gate="G$1" pin="CC2"/><wire x1="8.89" y1="-274.32" x2="3.81" y2="-274.32" width="0.1524" layer="91"/><label x="3.81" y="-274.32" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R5" gate="G$1" pin="1"/><wire x1="85.09" y1="-266.7" x2="80.01" y2="-266.7" width="0.1524" layer="91"/><label x="80.01" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="USB_DP_J" class="5"><segment><pinref part="J1" gate="G$1" pin="DP"/><wire x1="34.29" y1="-266.7" x2="39.37" y2="-266.7" width="0.1524" layer="91"/><label x="39.37" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="D1" gate="G$1" pin="IO1_A"/><wire x1="118.11" y1="-266.7" x2="113.03" y2="-266.7" width="0.1524" layer="91"/><label x="113.03" y="-266.7" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="USB_DN_J" class="5"><segment><pinref part="J1" gate="G$1" pin="DN"/><wire x1="34.29" y1="-269.24" x2="39.37" y2="-269.24" width="0.1524" layer="91"/><label x="39.37" y="-269.24" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="D1" gate="G$1" pin="IO2_A"/><wire x1="118.11" y1="-271.78" x2="113.03" y2="-271.78" width="0.1524" layer="91"/><label x="113.03" y="-271.78" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="ILIM" class="0"><segment><pinref part="U4" gate="G$1" pin="ILIM"/><wire x1="52.07" y1="-335.28" x2="46.99" y2="-335.28" width="0.1524" layer="91"/><label x="46.99" y="-335.28" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R8" gate="G$1" pin="1"/><wire x1="95.25" y1="-322.58" x2="90.17" y2="-322.58" width="0.1524" layer="91"/><label x="90.17" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="ISET" class="0"><segment><pinref part="U4" gate="G$1" pin="ISET"/><wire x1="52.07" y1="-345.44" x2="46.99" y2="-345.44" width="0.1524" layer="91"/><label x="46.99" y="-345.44" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R9" gate="G$1" pin="1"/><wire x1="128.27" y1="-322.58" x2="123.19" y2="-322.58" width="0.1524" layer="91"/><label x="123.19" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="TS" class="0"><segment><pinref part="U4" gate="G$1" pin="TS"/><wire x1="52.07" y1="-322.58" x2="46.99" y2="-322.58" width="0.1524" layer="91"/><label x="46.99" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R10" gate="G$1" pin="1"/><wire x1="161.29" y1="-322.58" x2="156.21" y2="-322.58" width="0.1524" layer="91"/><label x="156.21" y="-322.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="SW1" class="0"><segment><pinref part="U5" gate="G$1" pin="L1"/><wire x1="151.13" y1="-388.62" x2="146.05" y2="-388.62" width="0.1524" layer="91"/><label x="146.05" y="-388.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="L1" gate="G$1" pin="1"/><wire x1="194.31" y1="-378.46" x2="189.23" y2="-378.46" width="0.1524" layer="91"/><label x="189.23" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="SW2" class="0"><segment><pinref part="U5" gate="G$1" pin="L2"/><wire x1="176.53" y1="-386.08" x2="181.61" y2="-386.08" width="0.1524" layer="91"/><label x="181.61" y="-386.08" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="L1" gate="G$1" pin="2"/><wire x1="209.55" y1="-378.46" x2="214.63" y2="-378.46" width="0.1524" layer="91"/><label x="214.63" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="FB_3V3" class="0"><segment><pinref part="U5" gate="G$1" pin="FB"/><wire x1="176.53" y1="-378.46" x2="181.61" y2="-378.46" width="0.1524" layer="91"/><label x="181.61" y="-378.46" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R11" gate="G$1" pin="2"/><wire x1="24.13" y1="-424.18" x2="29.21" y2="-424.18" width="0.1524" layer="91"/><label x="29.21" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R12" gate="G$1" pin="1"/><wire x1="41.91" y1="-424.18" x2="36.83" y2="-424.18" width="0.1524" layer="91"/><label x="36.83" y="-424.18" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="VDD_TX" class="0"><segment><pinref part="U2" gate="G$1" pin="VDD_TX"/><wire x1="34.29" y1="-515.62" x2="39.37" y2="-515.62" width="0.1524" layer="91"/><label x="39.37" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="TVDD_IN"/><wire x1="34.29" y1="-525.78" x2="39.37" y2="-525.78" width="0.1524" layer="91"/><label x="39.37" y="-525.78" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="TVDD_IN2"/><wire x1="34.29" y1="-535.94" x2="39.37" y2="-535.94" width="0.1524" layer="91"/><label x="39.37" y="-535.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C13" gate="G$1" pin="1"/><wire x1="118.11" y1="-515.62" x2="113.03" y2="-515.62" width="0.1524" layer="91"/><label x="113.03" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C14" gate="G$1" pin="1"/><wire x1="151.13" y1="-515.62" x2="146.05" y2="-515.62" width="0.1524" layer="91"/><label x="146.05" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_TX1" class="0"><segment><pinref part="U2" gate="G$1" pin="TX1"/><wire x1="34.29" y1="-533.4" x2="39.37" y2="-533.4" width="0.1524" layer="91"/><label x="39.37" y="-533.4" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="L2" gate="G$1" pin="1"/><wire x1="41.91" y1="-627.38" x2="36.83" y2="-627.38" width="0.1524" layer="91"/><label x="36.83" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_TX2" class="0"><segment><pinref part="U2" gate="G$1" pin="TX2"/><wire x1="34.29" y1="-528.32" x2="39.37" y2="-528.32" width="0.1524" layer="91"/><label x="39.37" y="-528.32" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="L3" gate="G$1" pin="1"/><wire x1="74.93" y1="-627.38" x2="69.85" y2="-627.38" width="0.1524" layer="91"/><label x="69.85" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_RXP" class="0"><segment><pinref part="U2" gate="G$1" pin="RXP"/><wire x1="34.29" y1="-520.7" x2="39.37" y2="-520.7" width="0.1524" layer="91"/><label x="39.37" y="-520.7" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R15" gate="G$1" pin="2"/><wire x1="156.21" y1="-657.86" x2="161.29" y2="-657.86" width="0.1524" layer="91"/><label x="161.29" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_RXN" class="0"><segment><pinref part="U2" gate="G$1" pin="RXN"/><wire x1="34.29" y1="-518.16" x2="39.37" y2="-518.16" width="0.1524" layer="91"/><label x="39.37" y="-518.16" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R16" gate="G$1" pin="2"/><wire x1="189.23" y1="-657.86" x2="194.31" y2="-657.86" width="0.1524" layer="91"/><label x="194.31" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_VMID" class="0"><segment><pinref part="U2" gate="G$1" pin="VDD_VMID"/><wire x1="34.29" y1="-523.24" x2="39.37" y2="-523.24" width="0.1524" layer="91"/><label x="39.37" y="-523.24" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C17" gate="G$1" pin="1"/><wire x1="41.91" y1="-591.82" x2="36.83" y2="-591.82" width="0.1524" layer="91"/><label x="36.83" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_VDDHF" class="0"><segment><pinref part="U2" gate="G$1" pin="VDD_HF"/><wire x1="34.29" y1="-543.56" x2="39.37" y2="-543.56" width="0.1524" layer="91"/><label x="39.37" y="-543.56" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C18" gate="G$1" pin="1"/><wire x1="74.93" y1="-591.82" x2="69.85" y2="-591.82" width="0.1524" layer="91"/><label x="69.85" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_VDD" class="0"><segment><pinref part="U2" gate="G$1" pin="VDD_A"/><wire x1="34.29" y1="-546.1" x2="39.37" y2="-546.1" width="0.1524" layer="91"/><label x="39.37" y="-546.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VDD"/><wire x1="34.29" y1="-548.64" x2="39.37" y2="-548.64" width="0.1524" layer="91"/><label x="39.37" y="-548.64" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U2" gate="G$1" pin="VDD_D"/><wire x1="34.29" y1="-558.8" x2="39.37" y2="-558.8" width="0.1524" layer="91"/><label x="39.37" y="-558.8" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C15" gate="G$1" pin="1"/><wire x1="184.15" y1="-515.62" x2="179.07" y2="-515.62" width="0.1524" layer="91"/><label x="179.07" y="-515.62" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C16" gate="G$1" pin="1"/><wire x1="8.89" y1="-591.82" x2="3.81" y2="-591.82" width="0.1524" layer="91"/><label x="3.81" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_XTAL1" class="0"><segment><pinref part="U2" gate="G$1" pin="XTAL1"/><wire x1="34.29" y1="-556.26" x2="39.37" y2="-556.26" width="0.1524" layer="91"/><label x="39.37" y="-556.26" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="Y1" gate="G$1" pin="1"/><wire x1="140.97" y1="-591.82" x2="135.89" y2="-591.82" width="0.1524" layer="91"/><label x="135.89" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C20" gate="G$1" pin="1"/><wire x1="184.15" y1="-591.82" x2="179.07" y2="-591.82" width="0.1524" layer="91"/><label x="179.07" y="-591.82" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_XTAL2" class="0"><segment><pinref part="U2" gate="G$1" pin="XTAL2"/><wire x1="34.29" y1="-553.72" x2="39.37" y2="-553.72" width="0.1524" layer="91"/><label x="39.37" y="-553.72" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="Y1" gate="G$1" pin="2"/><wire x1="166.37" y1="-594.36" x2="171.45" y2="-594.36" width="0.1524" layer="91"/><label x="171.45" y="-594.36" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C21" gate="G$1" pin="1"/><wire x1="8.89" y1="-627.38" x2="3.81" y2="-627.38" width="0.1524" layer="91"/><label x="3.81" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_EMC1" class="0"><segment><pinref part="L2" gate="G$1" pin="2"/><wire x1="57.15" y1="-627.38" x2="62.23" y2="-627.38" width="0.1524" layer="91"/><label x="62.23" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C22" gate="G$1" pin="1"/><wire x1="107.95" y1="-627.38" x2="102.87" y2="-627.38" width="0.1524" layer="91"/><label x="102.87" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C24" gate="G$1" pin="1"/><wire x1="173.99" y1="-627.38" x2="168.91" y2="-627.38" width="0.1524" layer="91"/><label x="168.91" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_EMC2" class="0"><segment><pinref part="L3" gate="G$1" pin="2"/><wire x1="90.17" y1="-627.38" x2="95.25" y2="-627.38" width="0.1524" layer="91"/><label x="95.25" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C23" gate="G$1" pin="1"/><wire x1="140.97" y1="-627.38" x2="135.89" y2="-627.38" width="0.1524" layer="91"/><label x="135.89" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C25" gate="G$1" pin="1"/><wire x1="8.89" y1="-657.86" x2="3.81" y2="-657.86" width="0.1524" layer="91"/><label x="3.81" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_ANT_P" class="0"><segment><pinref part="C24" gate="G$1" pin="2"/><wire x1="189.23" y1="-627.38" x2="194.31" y2="-627.38" width="0.1524" layer="91"/><label x="194.31" y="-627.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C26" gate="G$1" pin="1"/><wire x1="41.91" y1="-657.86" x2="36.83" y2="-657.86" width="0.1524" layer="91"/><label x="36.83" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C27" gate="G$1" pin="1"/><wire x1="74.93" y1="-657.86" x2="69.85" y2="-657.86" width="0.1524" layer="91"/><label x="69.85" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="J3" gate="G$1" pin="2"/><wire x1="8.89" y1="-690.88" x2="3.81" y2="-690.88" width="0.1524" layer="91"/><label x="3.81" y="-690.88" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_ANT_N" class="0"><segment><pinref part="C25" gate="G$1" pin="2"/><wire x1="24.13" y1="-657.86" x2="29.21" y2="-657.86" width="0.1524" layer="91"/><label x="29.21" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C26" gate="G$1" pin="2"/><wire x1="57.15" y1="-657.86" x2="62.23" y2="-657.86" width="0.1524" layer="91"/><label x="62.23" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C28" gate="G$1" pin="1"/><wire x1="107.95" y1="-657.86" x2="102.87" y2="-657.86" width="0.1524" layer="91"/><label x="102.87" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="J3" gate="G$1" pin="3"/><wire x1="34.29" y1="-688.34" x2="39.37" y2="-688.34" width="0.1524" layer="91"/><label x="39.37" y="-688.34" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_RXC1" class="0"><segment><pinref part="C27" gate="G$1" pin="2"/><wire x1="90.17" y1="-657.86" x2="95.25" y2="-657.86" width="0.1524" layer="91"/><label x="95.25" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R15" gate="G$1" pin="1"/><wire x1="140.97" y1="-657.86" x2="135.89" y2="-657.86" width="0.1524" layer="91"/><label x="135.89" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="NFC_RXC2" class="0"><segment><pinref part="C28" gate="G$1" pin="2"/><wire x1="123.19" y1="-657.86" x2="128.27" y2="-657.86" width="0.1524" layer="91"/><label x="128.27" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R16" gate="G$1" pin="1"/><wire x1="173.99" y1="-657.86" x2="168.91" y2="-657.86" width="0.1524" layer="91"/><label x="168.91" y="-657.86" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="AMP_SD_R" class="0"><segment><pinref part="U6" gate="G$1" pin="SD_MODE"/><wire x1="8.89" y1="-746.76" x2="3.81" y2="-746.76" width="0.1524" layer="91"/><label x="3.81" y="-746.76" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R17" gate="G$1" pin="2"/><wire x1="67.31" y1="-739.14" x2="72.39" y2="-739.14" width="0.1524" layer="91"/><label x="72.39" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R18" gate="G$1" pin="1"/><wire x1="85.09" y1="-739.14" x2="80.01" y2="-739.14" width="0.1524" layer="91"/><label x="80.01" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="SPK_P" class="0"><segment><pinref part="U6" gate="G$1" pin="OUTP"/><wire x1="34.29" y1="-741.68" x2="39.37" y2="-741.68" width="0.1524" layer="91"/><label x="39.37" y="-741.68" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="SPK1" gate="G$1" pin="P"/><wire x1="184.15" y1="-739.14" x2="179.07" y2="-739.14" width="0.1524" layer="91"/><label x="179.07" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="SPK_N" class="0"><segment><pinref part="U6" gate="G$1" pin="OUTN"/><wire x1="34.29" y1="-744.22" x2="39.37" y2="-744.22" width="0.1524" layer="91"/><label x="39.37" y="-744.22" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="SPK1" gate="G$1" pin="N"/><wire x1="199.39" y1="-739.14" x2="204.47" y2="-739.14" width="0.1524" layer="91"/><label x="204.47" y="-739.14" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="VLED" class="2"><segment><pinref part="U7" gate="G$1" pin="VOUT"/><wire x1="34.29" y1="-805.18" x2="39.37" y2="-805.18" width="0.1524" layer="91"/><label x="39.37" y="-805.18" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U7" gate="G$1" pin="QOD"/><wire x1="34.29" y1="-802.64" x2="39.37" y2="-802.64" width="0.1524" layer="91"/><label x="39.37" y="-802.64" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C32" gate="G$1" pin="P"/><wire x1="118.11" y1="-800.1" x2="113.03" y2="-800.1" width="0.1524" layer="91"/><label x="113.03" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C33" gate="G$1" pin="P"/><wire x1="151.13" y1="-800.1" x2="146.05" y2="-800.1" width="0.1524" layer="91"/><label x="146.05" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="U8" gate="G$1" pin="VCC"/><wire x1="209.55" y1="-802.64" x2="214.63" y2="-802.64" width="0.1524" layer="91"/><label x="214.63" y="-802.64" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED1" gate="G$1" pin="VDD"/><wire x1="8.89" y1="-881.38" x2="3.81" y2="-881.38" width="0.1524" layer="91"/><label x="3.81" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C101" gate="G$1" pin="1"/><wire x1="52.07" y1="-881.38" x2="46.99" y2="-881.38" width="0.1524" layer="91"/><label x="46.99" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED2" gate="G$1" pin="VDD"/><wire x1="85.09" y1="-881.38" x2="80.01" y2="-881.38" width="0.1524" layer="91"/><label x="80.01" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C102" gate="G$1" pin="1"/><wire x1="128.27" y1="-881.38" x2="123.19" y2="-881.38" width="0.1524" layer="91"/><label x="123.19" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED3" gate="G$1" pin="VDD"/><wire x1="161.29" y1="-881.38" x2="156.21" y2="-881.38" width="0.1524" layer="91"/><label x="156.21" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C103" gate="G$1" pin="1"/><wire x1="204.47" y1="-881.38" x2="199.39" y2="-881.38" width="0.1524" layer="91"/><label x="199.39" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED4" gate="G$1" pin="VDD"/><wire x1="237.49" y1="-881.38" x2="232.41" y2="-881.38" width="0.1524" layer="91"/><label x="232.41" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C104" gate="G$1" pin="1"/><wire x1="280.67" y1="-881.38" x2="275.59" y2="-881.38" width="0.1524" layer="91"/><label x="275.59" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED5" gate="G$1" pin="VDD"/><wire x1="313.69" y1="-881.38" x2="308.61" y2="-881.38" width="0.1524" layer="91"/><label x="308.61" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C105" gate="G$1" pin="1"/><wire x1="356.87" y1="-881.38" x2="351.79" y2="-881.38" width="0.1524" layer="91"/><label x="351.79" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED6" gate="G$1" pin="VDD"/><wire x1="389.89" y1="-881.38" x2="384.81" y2="-881.38" width="0.1524" layer="91"/><label x="384.81" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C106" gate="G$1" pin="1"/><wire x1="433.07" y1="-881.38" x2="427.99" y2="-881.38" width="0.1524" layer="91"/><label x="427.99" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED7" gate="G$1" pin="VDD"/><wire x1="466.09" y1="-881.38" x2="461.01" y2="-881.38" width="0.1524" layer="91"/><label x="461.01" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C107" gate="G$1" pin="1"/><wire x1="509.27" y1="-881.38" x2="504.19" y2="-881.38" width="0.1524" layer="91"/><label x="504.19" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED8" gate="G$1" pin="VDD"/><wire x1="8.89" y1="-916.94" x2="3.81" y2="-916.94" width="0.1524" layer="91"/><label x="3.81" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C108" gate="G$1" pin="1"/><wire x1="52.07" y1="-916.94" x2="46.99" y2="-916.94" width="0.1524" layer="91"/><label x="46.99" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED9" gate="G$1" pin="VDD"/><wire x1="85.09" y1="-916.94" x2="80.01" y2="-916.94" width="0.1524" layer="91"/><label x="80.01" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C109" gate="G$1" pin="1"/><wire x1="128.27" y1="-916.94" x2="123.19" y2="-916.94" width="0.1524" layer="91"/><label x="123.19" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED10" gate="G$1" pin="VDD"/><wire x1="161.29" y1="-916.94" x2="156.21" y2="-916.94" width="0.1524" layer="91"/><label x="156.21" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C110" gate="G$1" pin="1"/><wire x1="204.47" y1="-916.94" x2="199.39" y2="-916.94" width="0.1524" layer="91"/><label x="199.39" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED11" gate="G$1" pin="VDD"/><wire x1="237.49" y1="-916.94" x2="232.41" y2="-916.94" width="0.1524" layer="91"/><label x="232.41" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C111" gate="G$1" pin="1"/><wire x1="280.67" y1="-916.94" x2="275.59" y2="-916.94" width="0.1524" layer="91"/><label x="275.59" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED12" gate="G$1" pin="VDD"/><wire x1="313.69" y1="-916.94" x2="308.61" y2="-916.94" width="0.1524" layer="91"/><label x="308.61" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C112" gate="G$1" pin="1"/><wire x1="356.87" y1="-916.94" x2="351.79" y2="-916.94" width="0.1524" layer="91"/><label x="351.79" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED13" gate="G$1" pin="VDD"/><wire x1="389.89" y1="-916.94" x2="384.81" y2="-916.94" width="0.1524" layer="91"/><label x="384.81" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C113" gate="G$1" pin="1"/><wire x1="433.07" y1="-916.94" x2="427.99" y2="-916.94" width="0.1524" layer="91"/><label x="427.99" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED14" gate="G$1" pin="VDD"/><wire x1="466.09" y1="-916.94" x2="461.01" y2="-916.94" width="0.1524" layer="91"/><label x="461.01" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C114" gate="G$1" pin="1"/><wire x1="509.27" y1="-916.94" x2="504.19" y2="-916.94" width="0.1524" layer="91"/><label x="504.19" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED15" gate="G$1" pin="VDD"/><wire x1="8.89" y1="-952.5" x2="3.81" y2="-952.5" width="0.1524" layer="91"/><label x="3.81" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C115" gate="G$1" pin="1"/><wire x1="52.07" y1="-952.5" x2="46.99" y2="-952.5" width="0.1524" layer="91"/><label x="46.99" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED16" gate="G$1" pin="VDD"/><wire x1="85.09" y1="-952.5" x2="80.01" y2="-952.5" width="0.1524" layer="91"/><label x="80.01" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C116" gate="G$1" pin="1"/><wire x1="128.27" y1="-952.5" x2="123.19" y2="-952.5" width="0.1524" layer="91"/><label x="123.19" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED17" gate="G$1" pin="VDD"/><wire x1="161.29" y1="-952.5" x2="156.21" y2="-952.5" width="0.1524" layer="91"/><label x="156.21" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C117" gate="G$1" pin="1"/><wire x1="204.47" y1="-952.5" x2="199.39" y2="-952.5" width="0.1524" layer="91"/><label x="199.39" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED18" gate="G$1" pin="VDD"/><wire x1="237.49" y1="-952.5" x2="232.41" y2="-952.5" width="0.1524" layer="91"/><label x="232.41" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C118" gate="G$1" pin="1"/><wire x1="280.67" y1="-952.5" x2="275.59" y2="-952.5" width="0.1524" layer="91"/><label x="275.59" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED19" gate="G$1" pin="VDD"/><wire x1="313.69" y1="-952.5" x2="308.61" y2="-952.5" width="0.1524" layer="91"/><label x="308.61" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C119" gate="G$1" pin="1"/><wire x1="356.87" y1="-952.5" x2="351.79" y2="-952.5" width="0.1524" layer="91"/><label x="351.79" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED20" gate="G$1" pin="VDD"/><wire x1="389.89" y1="-952.5" x2="384.81" y2="-952.5" width="0.1524" layer="91"/><label x="384.81" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C120" gate="G$1" pin="1"/><wire x1="433.07" y1="-952.5" x2="427.99" y2="-952.5" width="0.1524" layer="91"/><label x="427.99" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED21" gate="G$1" pin="VDD"/><wire x1="466.09" y1="-952.5" x2="461.01" y2="-952.5" width="0.1524" layer="91"/><label x="461.01" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C121" gate="G$1" pin="1"/><wire x1="509.27" y1="-952.5" x2="504.19" y2="-952.5" width="0.1524" layer="91"/><label x="504.19" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED22" gate="G$1" pin="VDD"/><wire x1="8.89" y1="-988.06" x2="3.81" y2="-988.06" width="0.1524" layer="91"/><label x="3.81" y="-988.06" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C122" gate="G$1" pin="1"/><wire x1="52.07" y1="-988.06" x2="46.99" y2="-988.06" width="0.1524" layer="91"/><label x="46.99" y="-988.06" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED23" gate="G$1" pin="VDD"/><wire x1="85.09" y1="-988.06" x2="80.01" y2="-988.06" width="0.1524" layer="91"/><label x="80.01" y="-988.06" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="C123" gate="G$1" pin="1"/><wire x1="128.27" y1="-988.06" x2="123.19" y2="-988.06" width="0.1524" layer="91"/><label x="123.19" y="-988.06" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_DATA_BUF" class="0"><segment><pinref part="U8" gate="G$1" pin="Y"/><wire x1="209.55" y1="-800.1" x2="214.63" y2="-800.1" width="0.1524" layer="91"/><label x="214.63" y="-800.1" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="R21" gate="G$1" pin="1"/><wire x1="41.91" y1="-835.66" x2="36.83" y2="-835.66" width="0.1524" layer="91"/><label x="36.83" y="-835.66" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_DATA_0" class="0"><segment><pinref part="R21" gate="G$1" pin="2"/><wire x1="57.15" y1="-835.66" x2="62.23" y2="-835.66" width="0.1524" layer="91"/><label x="62.23" y="-835.66" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED1" gate="G$1" pin="DIN"/><wire x1="8.89" y1="-886.46" x2="3.81" y2="-886.46" width="0.1524" layer="91"/><label x="3.81" y="-886.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_1" class="0"><segment><pinref part="LED1" gate="G$1" pin="DOUT"/><wire x1="34.29" y1="-881.38" x2="39.37" y2="-881.38" width="0.1524" layer="91"/><label x="39.37" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED2" gate="G$1" pin="DIN"/><wire x1="85.09" y1="-886.46" x2="80.01" y2="-886.46" width="0.1524" layer="91"/><label x="80.01" y="-886.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_2" class="0"><segment><pinref part="LED2" gate="G$1" pin="DOUT"/><wire x1="110.49" y1="-881.38" x2="115.57" y2="-881.38" width="0.1524" layer="91"/><label x="115.57" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED3" gate="G$1" pin="DIN"/><wire x1="161.29" y1="-886.46" x2="156.21" y2="-886.46" width="0.1524" layer="91"/><label x="156.21" y="-886.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_3" class="0"><segment><pinref part="LED3" gate="G$1" pin="DOUT"/><wire x1="186.69" y1="-881.38" x2="191.77" y2="-881.38" width="0.1524" layer="91"/><label x="191.77" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED4" gate="G$1" pin="DIN"/><wire x1="237.49" y1="-886.46" x2="232.41" y2="-886.46" width="0.1524" layer="91"/><label x="232.41" y="-886.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_4" class="0"><segment><pinref part="LED4" gate="G$1" pin="DOUT"/><wire x1="262.89" y1="-881.38" x2="267.97" y2="-881.38" width="0.1524" layer="91"/><label x="267.97" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED5" gate="G$1" pin="DIN"/><wire x1="313.69" y1="-886.46" x2="308.61" y2="-886.46" width="0.1524" layer="91"/><label x="308.61" y="-886.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_5" class="0"><segment><pinref part="LED5" gate="G$1" pin="DOUT"/><wire x1="339.09" y1="-881.38" x2="344.17" y2="-881.38" width="0.1524" layer="91"/><label x="344.17" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED6" gate="G$1" pin="DIN"/><wire x1="389.89" y1="-886.46" x2="384.81" y2="-886.46" width="0.1524" layer="91"/><label x="384.81" y="-886.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_6" class="0"><segment><pinref part="LED6" gate="G$1" pin="DOUT"/><wire x1="415.29" y1="-881.38" x2="420.37" y2="-881.38" width="0.1524" layer="91"/><label x="420.37" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED7" gate="G$1" pin="DIN"/><wire x1="466.09" y1="-886.46" x2="461.01" y2="-886.46" width="0.1524" layer="91"/><label x="461.01" y="-886.46" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_7" class="0"><segment><pinref part="LED7" gate="G$1" pin="DOUT"/><wire x1="491.49" y1="-881.38" x2="496.57" y2="-881.38" width="0.1524" layer="91"/><label x="496.57" y="-881.38" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED8" gate="G$1" pin="DIN"/><wire x1="8.89" y1="-922.02" x2="3.81" y2="-922.02" width="0.1524" layer="91"/><label x="3.81" y="-922.02" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_8" class="0"><segment><pinref part="LED8" gate="G$1" pin="DOUT"/><wire x1="34.29" y1="-916.94" x2="39.37" y2="-916.94" width="0.1524" layer="91"/><label x="39.37" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED9" gate="G$1" pin="DIN"/><wire x1="85.09" y1="-922.02" x2="80.01" y2="-922.02" width="0.1524" layer="91"/><label x="80.01" y="-922.02" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_9" class="0"><segment><pinref part="LED9" gate="G$1" pin="DOUT"/><wire x1="110.49" y1="-916.94" x2="115.57" y2="-916.94" width="0.1524" layer="91"/><label x="115.57" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED10" gate="G$1" pin="DIN"/><wire x1="161.29" y1="-922.02" x2="156.21" y2="-922.02" width="0.1524" layer="91"/><label x="156.21" y="-922.02" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_10" class="0"><segment><pinref part="LED10" gate="G$1" pin="DOUT"/><wire x1="186.69" y1="-916.94" x2="191.77" y2="-916.94" width="0.1524" layer="91"/><label x="191.77" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED11" gate="G$1" pin="DIN"/><wire x1="237.49" y1="-922.02" x2="232.41" y2="-922.02" width="0.1524" layer="91"/><label x="232.41" y="-922.02" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_11" class="0"><segment><pinref part="LED11" gate="G$1" pin="DOUT"/><wire x1="262.89" y1="-916.94" x2="267.97" y2="-916.94" width="0.1524" layer="91"/><label x="267.97" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED12" gate="G$1" pin="DIN"/><wire x1="313.69" y1="-922.02" x2="308.61" y2="-922.02" width="0.1524" layer="91"/><label x="308.61" y="-922.02" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_12" class="0"><segment><pinref part="LED12" gate="G$1" pin="DOUT"/><wire x1="339.09" y1="-916.94" x2="344.17" y2="-916.94" width="0.1524" layer="91"/><label x="344.17" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED13" gate="G$1" pin="DIN"/><wire x1="389.89" y1="-922.02" x2="384.81" y2="-922.02" width="0.1524" layer="91"/><label x="384.81" y="-922.02" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_13" class="0"><segment><pinref part="LED13" gate="G$1" pin="DOUT"/><wire x1="415.29" y1="-916.94" x2="420.37" y2="-916.94" width="0.1524" layer="91"/><label x="420.37" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED14" gate="G$1" pin="DIN"/><wire x1="466.09" y1="-922.02" x2="461.01" y2="-922.02" width="0.1524" layer="91"/><label x="461.01" y="-922.02" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_14" class="0"><segment><pinref part="LED14" gate="G$1" pin="DOUT"/><wire x1="491.49" y1="-916.94" x2="496.57" y2="-916.94" width="0.1524" layer="91"/><label x="496.57" y="-916.94" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED15" gate="G$1" pin="DIN"/><wire x1="8.89" y1="-957.58" x2="3.81" y2="-957.58" width="0.1524" layer="91"/><label x="3.81" y="-957.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_15" class="0"><segment><pinref part="LED15" gate="G$1" pin="DOUT"/><wire x1="34.29" y1="-952.5" x2="39.37" y2="-952.5" width="0.1524" layer="91"/><label x="39.37" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED16" gate="G$1" pin="DIN"/><wire x1="85.09" y1="-957.58" x2="80.01" y2="-957.58" width="0.1524" layer="91"/><label x="80.01" y="-957.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_16" class="0"><segment><pinref part="LED16" gate="G$1" pin="DOUT"/><wire x1="110.49" y1="-952.5" x2="115.57" y2="-952.5" width="0.1524" layer="91"/><label x="115.57" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED17" gate="G$1" pin="DIN"/><wire x1="161.29" y1="-957.58" x2="156.21" y2="-957.58" width="0.1524" layer="91"/><label x="156.21" y="-957.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_17" class="0"><segment><pinref part="LED17" gate="G$1" pin="DOUT"/><wire x1="186.69" y1="-952.5" x2="191.77" y2="-952.5" width="0.1524" layer="91"/><label x="191.77" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED18" gate="G$1" pin="DIN"/><wire x1="237.49" y1="-957.58" x2="232.41" y2="-957.58" width="0.1524" layer="91"/><label x="232.41" y="-957.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_18" class="0"><segment><pinref part="LED18" gate="G$1" pin="DOUT"/><wire x1="262.89" y1="-952.5" x2="267.97" y2="-952.5" width="0.1524" layer="91"/><label x="267.97" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED19" gate="G$1" pin="DIN"/><wire x1="313.69" y1="-957.58" x2="308.61" y2="-957.58" width="0.1524" layer="91"/><label x="308.61" y="-957.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_19" class="0"><segment><pinref part="LED19" gate="G$1" pin="DOUT"/><wire x1="339.09" y1="-952.5" x2="344.17" y2="-952.5" width="0.1524" layer="91"/><label x="344.17" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED20" gate="G$1" pin="DIN"/><wire x1="389.89" y1="-957.58" x2="384.81" y2="-957.58" width="0.1524" layer="91"/><label x="384.81" y="-957.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_20" class="0"><segment><pinref part="LED20" gate="G$1" pin="DOUT"/><wire x1="415.29" y1="-952.5" x2="420.37" y2="-952.5" width="0.1524" layer="91"/><label x="420.37" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED21" gate="G$1" pin="DIN"/><wire x1="466.09" y1="-957.58" x2="461.01" y2="-957.58" width="0.1524" layer="91"/><label x="461.01" y="-957.58" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_21" class="0"><segment><pinref part="LED21" gate="G$1" pin="DOUT"/><wire x1="491.49" y1="-952.5" x2="496.57" y2="-952.5" width="0.1524" layer="91"/><label x="496.57" y="-952.5" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED22" gate="G$1" pin="DIN"/><wire x1="8.89" y1="-993.14" x2="3.81" y2="-993.14" width="0.1524" layer="91"/><label x="3.81" y="-993.14" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
<net name="LED_CHAIN_22" class="0"><segment><pinref part="LED22" gate="G$1" pin="DOUT"/><wire x1="34.29" y1="-988.06" x2="39.37" y2="-988.06" width="0.1524" layer="91"/><label x="39.37" y="-988.06" size="1.27" layer="95" rot="R0" xref="no"/></segment><segment><pinref part="LED23" gate="G$1" pin="DIN"/><wire x1="85.09" y1="-993.14" x2="80.01" y2="-993.14" width="0.1524" layer="91"/><label x="80.01" y="-993.14" size="1.27" layer="95" rot="R0" xref="no"/></segment></net>
</nets>
</sheet></sheets>
</schematic>
</drawing>
</eagle>
