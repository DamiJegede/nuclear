import { createEffect, createSignal, lazy, onCleanup, Suspense } from 'solid-js';
import Home from './Home.jsx';
const Merchant = lazy(() => import('./Merchant.jsx'));
export default function App() {
 const currentPath=()=>window.location.pathname.replace(/\/$/,'') || '/';
 const [path,setPath]=createSignal(currentPath());
 const sync=()=>setPath(currentPath());
 window.addEventListener('popstate',sync);
 onCleanup(()=>window.removeEventListener('popstate',sync));
 createEffect(()=>{
  const merchant=path()==='/merchant';
  const title=merchant?'Nuclear — Zero transaction fees. Goodbye chargebacks.':'Nuclear';
  const description=merchant?'Zero transaction fees. Zero chargebacks. Same-day settlements. Meet Nuclear: payments and free business tools built for independent businesses.':'We’re blowing up the entire payment rails for the AI age.';
  const url=merchant?'https://nclr.app/merchant':'https://nclr.app/';
  document.title=title;
  document.querySelector('link[rel=canonical]').href=url;
  for (const [selector,value] of [
   ['meta[name=description]',description],['meta[property="og:title"]',title],
   ['meta[property="og:description"]',description],['meta[property="og:url"]',url],
   ['meta[name="twitter:title"]',title],['meta[name="twitter:description"]',description],
  ]) document.querySelector(selector)?.setAttribute('content',value);
 });
 return <Suspense>{path()==='/merchant' ? <Merchant/> : path()==='/' ? <Home/> : <main><h1>Nothing here.</h1><a href="/">Back to Nuclear</a></main>}</Suspense>;
}
