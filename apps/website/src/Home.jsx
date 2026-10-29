import { onMount, onCleanup } from 'solid-js';
const homeStyles="\n    :root {\n      --bg-top: #2f1439;\n      --bg-bottom: #101626;\n      --text: #e3b0b5;\n    }\n\n    * { box-sizing: border-box; margin: 0; }\n\n    /* Gradient lives on <html>: a background on <body> would paint over the\n       negative z-index video and scrim */\n    html {\n      background: var(--bg-bottom) linear-gradient(to bottom, var(--bg-top), var(--bg-bottom)) fixed;\n    }\n\n    body {\n      min-height: 100vh;\n      min-height: 100dvh;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      padding: 48px 16px;\n      color: var(--text);\n      text-align: center;\n      -webkit-font-smoothing: antialiased;\n    }\n\n    .bg {\n      position: fixed;\n      inset: 0;\n      width: 100%;\n      height: 100%;\n      object-fit: cover;\n      z-index: -2;\n    }\n\n    /* Dark purple scrim keeps the pink text legible over the bright footage */\n    body::before {\n      content: \"\";\n      position: fixed;\n      inset: 0;\n      z-index: -1;\n      background: linear-gradient(to bottom, rgba(46, 20, 55, 0.35), rgba(16, 22, 38, 0.6));\n    }\n\n    @media (prefers-reduced-motion: reduce) {\n      .bg { display: none; }\n    }\n\n    main {\n      width: 100%;\n      max-width: 1100px;\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      gap: clamp(40px, 8vw, 96px);\n    }\n\n    .top {\n      font-family: \"Unbounded\", sans-serif;\n      font-weight: 900;\n      font-size: 24px;\n      line-height: 1.2;\n    }\n\n    .mid {\n      font-family: \"Faculty Glyphic\", serif;\n      font-weight: 400;\n      font-size: clamp(40px, 7vw, 80px);\n      line-height: 1.15;\n      text-wrap: balance;\n    }\n\n    .bottom {\n      font-family: \"Faculty Glyphic\", serif;\n      font-weight: 400;\n      font-size: clamp(18px, 2.5vw, 24px);\n      line-height: 1.3;\n    }\n  \n#root { display: contents; }\n";
export default function Home() {
let cleanup;
onMount(()=>{
 const video=document.querySelector('video.bg');
 if(!video)return;
 video.muted=true; video.defaultMuted=true;
 const controller=new AbortController();
 const timers=new Set(); let retries=0;
 const schedule=(fn,ms)=>{const id=setTimeout(fn,ms);timers.add(id);};
 const play=()=>{if(video.paused||video.ended)video.play()?.catch(()=>{});};
 const reload=()=>{if(retries++<3){video.load();play();}};
 const listen=(target,event,fn,options={})=>target.addEventListener(event,fn,{...options,signal:controller.signal});
 for(const event of ['loadedmetadata','loadeddata','canplay','canplaythrough'])listen(video,event,play);
 listen(video,'ended',()=>{video.currentTime=0;play();});
 listen(video,'pause',()=>{if(!document.hidden)play();});
 listen(video,'error',()=>schedule(reload,500));
 listen(video,'stalled',()=>schedule(()=>{if(video.readyState<3)reload();},2000));
 listen(document,'visibilitychange',()=>{if(!document.hidden)play();});
 listen(window,'pageshow',play);listen(window,'load',play);
 for(const event of ['touchstart','pointerdown','keydown','scroll'])listen(window,event,play,{once:true,passive:true});
 play();schedule(()=>{if(video.paused||video.readyState<2){play();if(video.readyState<2)reload();}},2500);
 cleanup=()=>{controller.abort();timers.forEach(clearTimeout);video.pause();};
});
onCleanup(()=>cleanup?.());
return <><style>{homeStyles}</style>
<video class="bg" autoplay muted loop playsinline preload="auto" aria-hidden="true"><source src="/nuclear.mp4" type="video/mp4"/><source src="/nuclear.webm" type="video/webm"/></video>
<main><p class="top">We’ve gone nuclear</p><h1 class="mid">We’re blowing up the entire payment rails for the AI age.</h1><p class="bottom">Web / In-store / Agentic Commerce</p></main>
</>;
}
