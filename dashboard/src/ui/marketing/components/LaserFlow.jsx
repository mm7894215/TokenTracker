import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

// ─── Vertex Shader ────────────────────────────────────────────────────────────
const VERT = /* glsl */`
precision highp float;
attribute vec3 position;
void main(){
  gl_Position = vec4(position, 1.0);
}
`;

// ─── Fragment Shader ──────────────────────────────────────────────────────────
const FRAG = /* glsl */`
#ifdef GL_ES
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
precision mediump int;

uniform float iTime;
uniform vec3  iResolution;
uniform vec4  iMouse;
uniform float uWispDensity;
uniform float uTiltScale;
uniform float uFlowTime;
uniform float uFogTime;
uniform float uBeamXFrac;
uniform float uBeamYFrac;
uniform float uFlowSpeed;
uniform float uVLenFactor;
uniform float uHLenFactor;
uniform float uFogIntensity;
uniform float uFogScale;
uniform float uWSpeed;
uniform float uWIntensity;
uniform float uFlowStrength;
uniform float uDecay;
uniform float uFalloffStart;
uniform float uFogFallSpeed;
uniform vec3  uColor;
uniform float uFade;

#define PI            3.14159265359
#define TWO_PI        6.28318530718
#define EPS           1e-6
#define DT_LOCAL      0.0038
#define EDGE_SOFT     (DT_LOCAL*4.0)
#define TAP_RADIUS    6
#define R_H           150.0
#define R_V           150.0
#define FLARE_HEIGHT  16.0
#define FLARE_AMOUNT  8.0
#define FLARE_EXP     2.0
#define TOP_FADE_START 0.1
#define TOP_FADE_EXP   1.0
#define FLOW_PERIOD    0.5
#define FLOW_SHARPNESS 1.5

#define W_BASE_X      1.5
#define W_LAYER_GAP   0.25
#define W_LANES       10
#define W_SIDE_DECAY  0.5
#define W_HALF        0.01
#define W_AA          0.15
#define W_CELL        20.0
#define W_SEG_MIN     0.01
#define W_SEG_MAX     0.55
#define W_CURVE_AMOUNT 15.0
#define W_CURVE_RANGE  (FLARE_HEIGHT-3.0)
#define W_BOTTOM_EXP  10.0

#define FOG_CONTRAST      1.2
#define FOG_OCTAVES       5
#define FOG_BOTTOM_BIAS   0.8
#define FOG_TILT_SHAPE    1.5
#define FOG_TILT_MAX_X    0.35
#define FOG_BEAM_MIN      0.0
#define FOG_BEAM_MAX      0.75
#define FOG_MASK_GAMMA    0.5
#define FOG_EXPAND_SHAPE  12.2
#define FOG_EDGE_MIX      0.5

#define HFOG_EDGE_START   0.20
#define HFOG_EDGE_END     0.98
#define HFOG_EDGE_GAMMA   1.4
#define HFOG_Y_RADIUS     25.0
#define HFOG_Y_SOFT       60.0

#define EDGE_X0       0.22
#define EDGE_X1       0.995
#define EDGE_X_GAMMA  1.25
#define EDGE_LUMA_T0  0.0
#define EDGE_LUMA_T1  2.0
#define DITHER_STRENGTH 1.0

float srgb(float x){return x<=0.00031308?12.92*x:1.055*pow(x,1.0/2.4)-0.055;}
float bspot(vec2 p,vec2 q,float pw){float d=distance(p,q),f=pw*uFalloffStart,r=(f*f)/(d*d+EPS);return pw*min(1.0,r);}
float bspotA(vec2 p,vec2 q,float pw,vec2 s){vec2 d=p-q;float dd=(d.x*d.x)/(s.x*s.x)+(d.y*d.y)/(s.y*s.y),f=pw*uFalloffStart,r=(f*f)/(dd+EPS);return pw*min(1.0,r);}
float tri01(float x){float f=fract(x);return 1.0-abs(f*2.0-1.0);}
float tauW(float t,float lo,float hi){float a=smoothstep(lo,lo+EDGE_SOFT,t),b=1.0-smoothstep(hi-EDGE_SOFT,hi,t);return max(0.0,a*b);}
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+34.123);return fract(p.x*p.y);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);float a=h21(i),b=h21(i+vec2(1,0)),c=h21(i+vec2(0,1)),d=h21(i+vec2(1,1));vec2 u=f*f*(3.0-2.0*f);return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}
float fbm(vec2 p){float v=0.0,amp=0.6;mat2 m=mat2(0.86,0.5,-0.5,0.86);for(int i=0;i<FOG_OCTAVES;++i){v+=amp*vnoise(p);p=m*p*2.03+17.1;amp*=0.52;}return v;}
float rGate(float x,float l){float a=smoothstep(0.0,W_AA,x),b=1.0-smoothstep(l,l+W_AA,x);return max(0.0,a*b);}
float flareY(float y){float t=clamp(1.0-(clamp(y,0.0,FLARE_HEIGHT)/max(FLARE_HEIGHT,EPS)),0.0,1.0);return pow(t,FLARE_EXP);}

float vWisps(vec2 uv,float topF){
  float y=uv.y,yf=(y+uFlowTime*uWSpeed)/W_CELL;
  float dRaw=clamp(uWispDensity,0.0,2.0),d=dRaw<=0.0?1.0:dRaw;
  float lanesF=floor(float(W_LANES)*min(d,1.0)+0.5);
  int lanes=int(max(1.0,lanesF));
  float sp=min(d,1.0),ep=max(d-1.0,0.0);
  float fm=flareY(max(y,0.0)),rm=clamp(1.0-(y/max(W_CURVE_RANGE,EPS)),0.0,1.0),cm=fm*rm;
  const float G=0.05;float xS=1.0+(FLARE_AMOUNT*W_CURVE_AMOUNT*G)*cm;
  float sPix=clamp(y/R_V,0.0,1.0),bGain=pow(1.0-sPix,W_BOTTOM_EXP),sum=0.0;
  for(int s=0;s<2;++s){
    float sgn=s==0?-1.0:1.0;
    for(int i=0;i<W_LANES;++i){
      if(i>=lanes) break;
      float off=W_BASE_X+float(i)*W_LAYER_GAP,xc=sgn*(off*xS);
      float dx=abs(uv.x-xc),lat=1.0-smoothstep(W_HALF,W_HALF+W_AA,dx),amp=exp(-off*W_SIDE_DECAY);
      float seed=h21(vec2(off,sgn*17.0)),yf2=yf+seed*7.0,ci=floor(yf2),fy=fract(yf2);
      float seg=mix(W_SEG_MIN,W_SEG_MAX,h21(vec2(ci,off*2.3)));
      float spR=h21(vec2(ci,off+sgn*31.0)),seg1=rGate(fy,seg)*step(spR,sp);
      if(ep>0.0){float spR2=h21(vec2(ci*3.1+7.0,off*5.3+sgn*13.0));float f2=fract(fy+0.5);seg1+=rGate(f2,seg*0.9)*step(spR2,ep);}
      sum+=amp*lat*seg1;
    }
  }
  float span=smoothstep(-3.0,0.0,y)*(1.0-smoothstep(R_V-6.0,R_V,y));
  return uWIntensity*sum*topF*bGain*span;
}

void main(){
  vec2 frag=gl_FragCoord.xy;
  vec2 C=iResolution.xy*0.5;
  float invW=1.0/max(C.x,1.0);
  vec2 sc=(512.0/iResolution.xy)*0.4;
  vec2 uv=(frag-C)*sc;
  vec2 off=vec2(uBeamXFrac*iResolution.x*sc.x,uBeamYFrac*iResolution.y*sc.y);
  vec2 uvc=uv-off;

  float a=0.0,b=0.0;
  float basePhase=1.5*PI+uDecay*0.5,tauMin=basePhase-uDecay,tauMax=basePhase;

  float cx=clamp(uvc.x/(R_H*uHLenFactor),-1.0,1.0),tH=clamp(TWO_PI-acos(cx),tauMin,tauMax);
  for(int k=-TAP_RADIUS;k<=TAP_RADIUS;++k){
    float tu=tH+float(k)*DT_LOCAL,wt=tauW(tu,tauMin,tauMax);if(wt<=0.0)continue;
    float spd=max(abs(sin(tu)),0.02),u=clamp((basePhase-tu)/max(uDecay,EPS),0.0,1.0),env=pow(1.0-abs(u*2.0-1.0),0.8);
    vec2 p=vec2((R_H*uHLenFactor)*cos(tu),0.0);
    a+=wt*bspot(uvc,p,env*spd);
  }

  float yPix=uvc.y,cy=clamp(-yPix/(R_V*uVLenFactor),-1.0,1.0),tV=clamp(TWO_PI-acos(cy),tauMin,tauMax);
  for(int k=-TAP_RADIUS;k<=TAP_RADIUS;++k){
    float tu=tV+float(k)*DT_LOCAL,wt=tauW(tu,tauMin,tauMax);if(wt<=0.0)continue;
    float yb=(-R_V)*cos(tu),s=clamp(yb/R_V,0.0,1.0),spd=max(abs(sin(tu)),0.02);
    float env=pow(1.0-s,0.6)*spd;
    float cap=pow(1.0-smoothstep(TOP_FADE_START,1.0,s),TOP_FADE_EXP);env*=cap;
    float ph=s/max(FLOW_PERIOD,EPS)+uFlowTime*uFlowSpeed;
    float fl=pow(tri01(ph),FLOW_SHARPNESS);
    env*=mix(1.0-uFlowStrength,1.0,fl);
    float yp=(-R_V*uVLenFactor)*cos(tu),m=pow(smoothstep(FLARE_HEIGHT,0.0,yp),FLARE_EXP),wx=1.0+FLARE_AMOUNT*m;
    vec2 sig=vec2(wx,1.0),p=vec2(0.0,yp);
    b+=wt*bspotA(uvc,p,step(0.0,yp)*env,sig);
  }

  float sPix=clamp(yPix/R_V,0.0,1.0),topA=pow(1.0-smoothstep(TOP_FADE_START,1.0,sPix),TOP_FADE_EXP);
  float L=a+b*topA;
  float w=vWisps(vec2(uvc.x,yPix),topA);

  // volumetric fog
  vec2 fuv=uvc*uFogScale;
  float mAct=step(1.0,length(iMouse.xy)),nx=((iMouse.x-C.x)*invW)*mAct;
  float ax=abs(nx),stMag=mix(ax,pow(ax,FOG_TILT_SHAPE),0.35),st=clamp(sign(nx)*stMag*uTiltScale,-FOG_TILT_MAX_X,FOG_TILT_MAX_X);
  vec2 dir=normalize(vec2(st,1.0));
  fuv+=uFogTime*uFogFallSpeed*dir;
  vec2 prp=vec2(-dir.y,dir.x);
  fuv+=prp*(0.08*sin(dot(uvc,prp)*0.08+uFogTime*0.9));
  float n=fbm(fuv+vec2(fbm(fuv+vec2(7.3,2.1)),fbm(fuv+vec2(-3.7,5.9)))*0.6);
  n=pow(clamp(n,0.0,1.0),FOG_CONTRAST);
  float pixW=1.0/max(iResolution.y,1.0);
  #ifdef GL_OES_standard_derivatives
    float wL=max(fwidth(L),pixW);
  #else
    float wL=pixW;
  #endif
  float m0=pow(smoothstep(FOG_BEAM_MIN-wL,FOG_BEAM_MAX+wL,L),FOG_MASK_GAMMA);
  float bm=1.0-pow(1.0-m0,FOG_EXPAND_SHAPE);bm=mix(bm*m0,bm,FOG_EDGE_MIX);
  float yP=1.0-smoothstep(HFOG_Y_RADIUS,HFOG_Y_RADIUS+HFOG_Y_SOFT,abs(yPix));
  float nxF=abs((frag.x-C.x)*invW),hE=pow(clamp(1.0-smoothstep(HFOG_EDGE_START,HFOG_EDGE_END,nxF),0.0,1.0),HFOG_EDGE_GAMMA);
  float hW=mix(1.0,hE,clamp(yP,0.0,1.0));
  float bBias=mix(1.0,1.0-sPix,FOG_BOTTOM_BIAS);
  float radialFade=1.0-smoothstep(0.0,0.7,length(uvc)/120.0);
  float fog=n*uFogIntensity*1.8*bBias*bm*hW*radialFade;

  float LF=L+fog;
  float dith=(h21(frag)-0.5)*(DITHER_STRENGTH/255.0);
  float tone=srgb(LF+w);
  vec3 col=tone*uColor+dith;
  float alpha=clamp(srgb(L+w*0.6)+dith*0.6,0.0,1.0);
  float nxE=abs((frag.x-C.x)*invW),xF=pow(clamp(1.0-smoothstep(EDGE_X0,EDGE_X1,nxE),0.0,1.0),EDGE_X_GAMMA);
  float scene=LF+max(0.0,w)*0.5,hi=smoothstep(EDGE_LUMA_T0,EDGE_LUMA_T1,scene);
  float eM=mix(xF,1.0,hi);
  col*=eM;alpha*=eM;
  col*=uFade;alpha*=uFade;

  // straight (non-premultiplied) alpha output
  gl_FragColor=vec4(col,alpha);
}
`;

function hexToRGB(hex) {
  let c = hex.trim().replace('#','');
  if (c.length===3) c=c.split('').map(x=>x+x).join('');
  const n=parseInt(c,16)||0xffffff;
  return {r:((n>>16)&255)/255,g:((n>>8)&255)/255,b:(n&255)/255};
}

function LaserFlow({
  className,
  style,
  wispDensity       = 1,
  dpr,
  mouseSmoothTime   = 0.06,
  mouseTiltStrength = 0.01,
  horizontalBeamOffset = 0,
  verticalBeamOffset   = -0.5,
  flowSpeed         = 0.35,
  verticalSizing    = 2.0,
  horizontalSizing  = 0.5,
  fogIntensity      = 0.45,
  fogScale          = 0.3,
  wispSpeed         = 15.0,
  wispIntensity     = 5.0,
  flowStrength      = 0.25,
  decay             = 1.1,
  falloffStart      = 1.2,
  fogFallSpeed      = 0.6,
  color             = '#8a7aff',
}) {
  const mountRef    = useRef(null);
  const uniformsRef = useRef(null);
  const hasFaded    = useRef(false);
  const rectRef     = useRef(null);
  const inView      = useRef(true);
  const paused      = useRef(false);
  const smoothRef   = useRef(mouseSmoothTime);

  useEffect(() => { smoothRef.current = mouseSmoothTime; }, [mouseSmoothTime]);

  useEffect(() => {
    const mount = mountRef.current;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true,
        premultipliedAlpha: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
      });
    } catch (e) {
      console.warn("LaserFlow: WebGL not supported or context creation failed.", e);
      return;
    }

    const baseDpr  = Math.min(dpr ?? (window.devicePixelRatio || 1), 2);
    let   currDpr  = baseDpr;
    renderer.setPixelRatio(currDpr);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(0x000000, 0);

    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    mount.appendChild(canvas);

    const scene    = new THREE.Scene();
    const camera   = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    const geo      = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1,-1,0, 3,-1,0, -1,3,0]), 3
    ));

    const uniforms = {
      iTime:         {value: 0},
      iResolution:   {value: new THREE.Vector3(1,1,1)},
      iMouse:        {value: new THREE.Vector4(0,0,0,0)},
      uWispDensity:  {value: wispDensity},
      uTiltScale:    {value: mouseTiltStrength},
      uFlowTime:     {value: 0},
      uFogTime:      {value: 0},
      uBeamXFrac:    {value: horizontalBeamOffset},
      uBeamYFrac:    {value: verticalBeamOffset},
      uFlowSpeed:    {value: flowSpeed},
      uVLenFactor:   {value: verticalSizing},
      uHLenFactor:   {value: horizontalSizing},
      uFogIntensity: {value: fogIntensity},
      uFogScale:     {value: fogScale},
      uWSpeed:       {value: wispSpeed},
      uWIntensity:   {value: wispIntensity},
      uFlowStrength: {value: flowStrength},
      uDecay:        {value: decay},
      uFalloffStart: {value: falloffStart},
      uFogFallSpeed: {value: fogFallSpeed},
      uColor:        {value: new THREE.Vector3(1,1,1)},
      uFade:         {value: hasFaded.current ? 1 : 0},
    };
    uniformsRef.current = uniforms;

    // set initial color
    const {r,g,b} = hexToRGB(color);
    uniforms.uColor.value.set(r,g,b);

    const mat = new THREE.RawShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent:    true,
      depthTest:      false,
      depthWrite:     false,
      blending:       THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);

    // resize
    let lastW=0,lastH=0,lastDpr=0;
    function resize() {
      const w=mount.clientWidth||1, h=mount.clientHeight||1;
      if (Math.abs(w-lastW)<1 && Math.abs(h-lastH)<1 && Math.abs(currDpr-lastDpr)<0.01) return;
      lastW=w; lastH=h; lastDpr=currDpr;
      renderer.setPixelRatio(currDpr);
      renderer.setSize(w,h,false);
      uniforms.iResolution.value.set(w*currDpr,h*currDpr,currDpr);
      rectRef.current = canvas.getBoundingClientRect();
    }
    let rafResize=0;
    const ro=new ResizeObserver(()=>{ cancelAnimationFrame(rafResize); rafResize=requestAnimationFrame(resize); });
    ro.observe(mount);
    resize();

    // intersection observer to pause when off-screen
    const io=new IntersectionObserver(e=>{ inView.current=e[0]?.isIntersecting??true; },{threshold:0});
    io.observe(mount);
    document.addEventListener('visibilitychange',()=>{ paused.current=document.hidden; },{passive:true});

    // mouse
    const mTarget=new THREE.Vector2(0,0);
    const mSmooth=new THREE.Vector2(0,0);
    function onMove(e){
      const r=rectRef.current; if(!r) return;
      mTarget.set((e.clientX-r.left)*currDpr,(r.height-(e.clientY-r.top))*currDpr);
    }
    canvas.addEventListener('pointermove',onMove,{passive:true});
    canvas.addEventListener('pointerleave',()=>mTarget.set(0,0),{passive:true});

    // clock
    let prevT=0, fade=hasFaded.current?1:0;
    const clock = new THREE.Clock();

    let rafId=0;
    function animate(){
      rafId=requestAnimationFrame(animate);
      if (paused.current||!inView.current) return;

      const t   = clock.getElapsedTime();
      const dt  = Math.min(Math.max(t-prevT,0.001),0.033);
      prevT = t;

      uniforms.iTime.value  = t;
      uniforms.uFlowTime.value += dt;
      uniforms.uFogTime.value  += dt;

      if (!hasFaded.current) {
        fade = Math.min(1, fade+dt/1.0);
        uniforms.uFade.value = fade;
        if (fade>=1) hasFaded.current=true;
      }

      const tau = Math.max(1e-3, smoothRef.current);
      mSmooth.lerp(mTarget, 1-Math.exp(-dt/tau));
      uniforms.iMouse.value.set(mSmooth.x,mSmooth.y,0,0);

      renderer.render(scene,camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(rafResize);
      ro.disconnect();
      io.disconnect();
      scene.clear();
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (mount.contains(canvas)) mount.removeChild(canvas);
    };
  }, [dpr]); // eslint-disable-line react-hooks/exhaustive-deps

  // prop updates without remount
  useEffect(() => {
    const u = uniformsRef.current;
    if (!u) return;
    u.uWispDensity.value  = wispDensity;
    u.uTiltScale.value    = mouseTiltStrength;
    u.uBeamXFrac.value    = horizontalBeamOffset;
    u.uBeamYFrac.value    = verticalBeamOffset;
    u.uFlowSpeed.value    = flowSpeed;
    u.uVLenFactor.value   = verticalSizing;
    u.uHLenFactor.value   = horizontalSizing;
    u.uFogIntensity.value = fogIntensity;
    u.uFogScale.value     = fogScale;
    u.uWSpeed.value       = wispSpeed;
    u.uWIntensity.value   = wispIntensity;
    u.uFlowStrength.value = flowStrength;
    u.uDecay.value        = decay;
    u.uFalloffStart.value = falloffStart;
    u.uFogFallSpeed.value = fogFallSpeed;
    const {r,g,b} = hexToRGB(color);
    u.uColor.value.set(r,g,b);
  }, [wispDensity,mouseTiltStrength,horizontalBeamOffset,verticalBeamOffset,
      flowSpeed,verticalSizing,horizontalSizing,fogIntensity,fogScale,
      wispSpeed,wispIntensity,flowStrength,decay,falloffStart,fogFallSpeed,color]);

  return (
    <div
      ref={mountRef}
      className={className}
      style={{position:'relative', overflow:'hidden', ...style}}
    />
  );
}

export default LaserFlow;
