import React, { useEffect, useState } from "react";
import { formatTokens, formatCost } from "../build-share-card-data";
import { VARIANT_SIZES } from "../share-card-constants";

const CARD_W = VARIANT_SIZES["annual-report"].width;

// Neon share card — distilled dark design.
// Hero: 12-month heatmap. Supporting: two stats + two facts. Brand: one footer line.

const BG = "#0a0820";
const WHITE = "#ffffffee";
const DIM = "rgba(255,255,255,0.45)";
const ACCENT = "#a78bfa";
const GRID = "rgba(70,55,180,0.10)";

// Glass — heatmap card: subtle layered inset glow
const GLASS = {
  background: "rgba(20,15,50,0.38)",
  backdropFilter: "blur(40px)",
  WebkitBackdropFilter: "blur(40px)",
  border: "1px solid rgba(255,255,255,0.05)",
  boxShadow: [
    "0 39px 56px -36px rgba(255,255,255,0.10) inset",
    "0 7px 11px -4px rgba(255,255,255,0.06) inset",
    "0 -82px 68px -64px rgba(101,67,149,0.08) inset",
    "0 98px 100px -48px rgba(208,171,255,0.06) inset",
    "0 4px 18px 0 rgba(156,146,215,0.06) inset",
    "0 1px 40px 0 rgba(228,222,255,0.04) inset",
  ].join(", "),
};

// Glass — small bars: subtle border + minimal glow
const GLASS_SM = {
  background: "rgba(20,15,50,0.38)",
  backdropFilter: "blur(32px)",
  WebkitBackdropFilter: "blur(32px)",
  border: "1px solid rgba(255,255,255,0.06)",
  boxShadow: "0 1px 8px 0 rgba(228,222,255,0.06) inset",
};

const F = '"Space Grotesk", "Inter Tight", sans-serif';
const F_NUM = '"Inter Tight", sans-serif';

const EMPTY = "rgba(255,255,255,0.06)";
const PAL = [EMPTY, "#4a3d8f", "#6b5cbe", "#9060e0", "#d946ef"];

// Layout — cells sized to fill card width tightly.
const PAD = 48;
const CP = 28; // card padding
const CG = 4;  // cell gap
const MG = 20; // month column gap
const INNER = CARD_W - PAD * 2 - CP * 2;
const CW_RAW = (INNER - MG * 2) / 3;
const CS = Math.min(Math.floor((CW_RAW - CG * 6) / 7), 40);
const CW = CS * 7 + CG * 6;

// ── Helpers ──

function rebucket(weeks) {
  if (!Array.isArray(weeks)) return weeks;
  const vals = [];
  for (const w of weeks) if (Array.isArray(w)) for (const c of w)
    if (c?.day && !c.future && c.value > 0) vals.push(c.value);
  if (!vals.length) return weeks;
  vals.sort((a, b) => a - b);
  const q = (f) => { const n = vals.length, p = (n-1)*f, b = Math.floor(p); return Math.round((vals[b]??0)+((vals[Math.min(n-1,b+1)]??0)-(vals[b]??0))*(p-b)); };
  const t1 = q(.5), t2 = q(.75), t3 = q(.9);
  const lv = (v) => !v||v<=0?0:v<=t1?1:v<=t2?2:v<=t3?3:4;
  return weeks.map(w => Array.isArray(w) ? w.map(c => c?.day&&!c.future&&typeof c.value==="number"?{...c,level:lv(c.value)}:c) : w);
}

function groupMonths(weeks) {
  if (!Array.isArray(weeks)) return [];
  const m = {}, rb = rebucket(weeks);
  for (const w of rb) if (Array.isArray(w)) for (const c of w) {
    if (!c?.day||c.future) continue;
    const p = c.day.split("-"); if (p.length<2) continue;
    const k = `${p[0]}-${p[1]}`; (m[k]??=[]).push(c);
  }
  return Object.entries(m).sort(([a],[b])=>a.localeCompare(b)).slice(-12)
    .map(([k,cells])=>({month:parseInt(k.split("-")[1],10),cells}));
}

function monthGrid(cells) {
  if (!cells.length) return [];
  const s = [...cells].sort((a,b)=>a.day.localeCompare(b.day));
  let dow = new Date(`${s[0].day}T00:00:00Z`).getUTCDay(); // 0=Sun, matches weekStartsOn="sun"
  const g = Array(dow).fill(null).concat(s), rows=[];
  for (let i=0;i<g.length;i+=7) rows.push(g.slice(i,i+7));
  const last=rows[rows.length-1]; while(last&&last.length<7)last.push(null);
  return rows.slice(0,6);
}

const MN=["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function streak(weeks) {
  if (!Array.isArray(weeks)) return 0;
  const d=[]; for(const w of weeks)if(Array.isArray(w))for(const c of w)if(c?.day&&!c.future)d.push(c);
  d.sort((a,b)=>a.day.localeCompare(b.day));
  let mx=0,cur=0; for(const x of d){if((x.level||0)>0){cur++;if(cur>mx)mx=cur;}else cur=0;} return mx;
}

// Convert remote URL to same-origin data URL to avoid canvas CORS taint in html-to-image.
function useDataUrl(src) {
  const [dataUrl, setDataUrl] = useState(null);
  useEffect(() => {
    if (!src) { setDataUrl(null); return; }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        setDataUrl(c.toDataURL("image/png"));
      } catch { setDataUrl(null); }
    };
    img.onerror = () => { if (!cancelled) setDataUrl(null); };
    img.src = src;
    return () => { cancelled = true; };
  }, [src]);
  return dataUrl;
}

// ── Components ──

function Month({ data: md }) {
  const g = monthGrid(md.cells);
  return (
    <div>
      <div style={{fontSize:16,fontWeight:600,color:DIM,fontFamily:F,marginBottom:4}}>{MN[md.month]}</div>
      <div style={{display:"flex",flexDirection:"column",gap:CG}}>
        {g.map((r,ri)=><div key={ri} style={{display:"flex",gap:CG}}>
          {r.map((c,ci)=>{const l=c?Math.min(4,Math.max(0,c.level||0)):-1;return<div key={ci} style={{width:CS,height:CS,borderRadius:4,background:l<0?"transparent":PAL[l]}}/>;})}</div>)}
      </div>
    </div>
  );
}

// ── Main ──

export function AnnualReportCard({ data }) {
  const months = groupMonths(data.heatmapWeeks);
  const str = streak(data.heatmapWeeks);
  const top = data.topModels[0];
  const rawUrl = data.avatarUrl || null;
  const url = useDataUrl(rawUrl); // same-origin data URL, safe for html-to-image
  const bgUrl = useDataUrl("/neon_bg.png"); // inline bg for html-to-image capture
  const ini = (data.handle||"?")[0].toUpperCase();
  const GAP = 16;

  return (
    <div style={{width:"100%",height:"100%",background:BG,fontFamily:F,position:"relative",overflow:"hidden",boxSizing:"border-box"}}>
      {/* ── Background image ── */}
      <img src={bgUrl||"/neon_bg.png"} alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none"}} crossOrigin="anonymous"/>

      <div style={{position:"relative",zIndex:1,display:"flex",flexDirection:"column",height:"100%",padding:PAD,boxSizing:"border-box"}}>

        {/* ── HEADER — brand left, avatar right ── */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:GAP*3}}>
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <img src="/app-icon.png" alt="" width={64} height={64} style={{width:64,height:64,borderRadius:16,display:"block"}}/>
            <div>
              <div style={{fontSize:20,fontWeight:500,color:DIM,lineHeight:1.2}}>Token Tracker</div>
              <div style={{fontSize:36,fontWeight:700,lineHeight:1.15,color:WHITE}}>Token Report</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:48,height:48,borderRadius:"50%",background:"linear-gradient(135deg,#4c1d95,#7c3aed)",display:"flex",alignItems:"center",justifyContent:"center",border:"2px solid rgba(255,255,255,0.15)",overflow:"hidden",flexShrink:0}}>
              {url?<img src={url} alt="" width={48} height={48} style={{width:48,height:48,objectFit:"cover",display:"block"}} crossOrigin="anonymous" referrerPolicy="no-referrer"/>
                  :<span style={{fontSize:20,fontWeight:700,color:WHITE}}>{ini}</span>}
            </div>
            <div style={{fontSize:32,fontWeight:700,color:WHITE}}>{data.handle}</div>
          </div>
        </div>

        {/* ── HEATMAP ── */}
        <div style={{...GLASS,borderRadius:22,padding:CP,marginBottom:GAP}}>
          {/* Top row: ghost title left, legend right */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:6,fontSize:14,color:DIM}}>
              <span>Less</span>
              {PAL.map((c,i)=><div key={i} style={{width:16,height:16,borderRadius:3,background:c}}/>)}
              <span>More</span>
            </div>
            <div style={{fontSize:16,fontWeight:700,letterSpacing:"0.14em",color:"rgba(255,255,255,0.22)",textTransform:"uppercase"}}>TOKEN USAGE HEATMAP</div>
          </div>
          {/* Grid */}
          <div style={{display:"grid",gridTemplateColumns:`repeat(3,${CW}px)`,gap:`8px ${MG}px`,justifyContent:"center"}}>
            {months.map(m=><Month key={m.month} data={m}/>)}
          </div>
        </div>

        {/* ── STATS: 2 big cards ── */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:GAP,marginBottom:GAP}}>
          <div style={{...GLASS_SM,borderRadius:22,padding:"28px 16px",textAlign:"center"}}>
            <div style={{fontFamily:F_NUM,fontSize:52,fontWeight:700,color:WHITE,letterSpacing:"-0.02em",lineHeight:1}}>{formatTokens(data.totalTokens)}</div>
            <div style={{fontSize:22,color:DIM,marginTop:12}}>Total Tokens</div>
          </div>
          <div style={{...GLASS_SM,borderRadius:22,padding:"28px 16px",textAlign:"center"}}>
            <div style={{fontFamily:F_NUM,fontSize:52,fontWeight:700,color:WHITE,letterSpacing:"-0.02em",lineHeight:1}}>{formatCost(data.totalCost)}</div>
            <div style={{fontSize:22,color:DIM,marginTop:12}}>Estimated Cost</div>
          </div>
        </div>

        {/* ── FACTS: 2 horizontal bars ── */}
        <div style={{display:"flex",flexDirection:"column",gap:GAP}}>
          <div style={{...GLASS_SM,borderRadius:22,padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83"/><circle cx="12" cy="12" r="4"/></svg>
              <span style={{fontSize:20,color:DIM}}>Longest Streak</span>
            </div>
            <span style={{fontFamily:F_NUM,fontSize:28,fontWeight:700,color:WHITE}}>{str} days</span>
          </div>
          <div style={{...GLASS_SM,borderRadius:22,padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><circle cx="12" cy="12" r="4"/></svg>
              <span style={{fontSize:20,color:DIM}}>Top Model</span>
            </div>
            <span style={{fontFamily:F,fontSize:28,fontWeight:700,color:WHITE}}>{top?top.name:"—"}</span>
          </div>
        </div>

        {/* ── FOOTER ── */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:"auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <img src="/app-icon.png" alt="" width={44} height={44} style={{width:44,height:44,borderRadius:8,display:"block"}}/>
            <span style={{fontSize:22,fontWeight:600,color:WHITE}}>Token Tracker</span>
          </div>
          <span style={{fontSize:22,fontWeight:600,color:ACCENT}}>token.rynn.me</span>
        </div>

      </div>
    </div>
  );
}
