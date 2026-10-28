(() => {
  const PORTAL = "https://nuclear-merchant.a-space.workers.dev";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // Every "Sign up" button opens the merchant portal's sign-up form; "sign in" opens its sign-in.
  $$("[data-signup]").forEach((a) => { a.href = `${PORTAL}/?signup=1`; });
  $$("[data-signin]").forEach((a) => { a.href = PORTAL; });
  $("#yr").textContent = new Date().getFullYear();

  // Header border once scrolled.
  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true }); onScroll();

  // Reveal on scroll (content stays visible if IntersectionObserver is missing).
  if ("IntersectionObserver" in window && !reduce) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.15 });
    $$(".reveal").forEach((el) => io.observe(el));
  } else $$(".reveal").forEach((el) => el.classList.add("in"));

  // Cursor glow.
  const glow = $("#glow");
  if (!reduce && matchMedia("(pointer: fine)").matches) {
    let x = innerWidth / 2, y = innerHeight / 3, tx = x, ty = y;
    addEventListener("pointermove", (e) => { tx = e.clientX; ty = e.clientY; }, { passive: true });
    (function loop() { x += (tx - x) * 0.08; y += (ty - y) * 0.08; glow.style.left = x + "px"; glow.style.top = y + "px"; requestAnimationFrame(loop); })();
  }

  // Orbiting electrons behind the page.
  const cv = $("#atoms");
  if (cv && !reduce) {
    const c = cv.getContext("2d");
    let w, h, dpr, t = 0, running = true;
    const rings = [{ rx: 0.34, ry: 0.11, rot: 0.0, n: 3 }, { rx: 0.34, ry: 0.11, rot: 1.047, n: 3 }, { rx: 0.34, ry: 0.11, rot: 2.094, n: 3 }];
    const resize = () => { dpr = Math.min(devicePixelRatio || 1, 2); w = cv.width = innerWidth * dpr; h = cv.height = innerHeight * dpr; };
    resize(); addEventListener("resize", resize);
    document.addEventListener("visibilitychange", () => { running = !document.hidden; if (running) requestAnimationFrame(draw); });
    function draw() {
      if (!running) return;
      t += 0.006;
      c.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h * 0.36, base = Math.min(w, h * 1.6);
      c.lineWidth = 1.2 * dpr;
      rings.forEach((r, i) => {
        c.save(); c.translate(cx, cy); c.rotate(r.rot + t * 0.15 * (i % 2 ? 1 : -1));
        c.strokeStyle = "rgba(57,255,160,0.18)"; c.beginPath(); c.ellipse(0, 0, base * r.rx, base * r.ry, 0, 0, Math.PI * 2); c.stroke();
        for (let k = 0; k < r.n; k++) {
          const a = t * (1.1 + i * 0.25) + (k * Math.PI * 2) / r.n;
          const ex = Math.cos(a) * base * r.rx, ey = Math.sin(a) * base * r.ry;
          c.fillStyle = "rgba(57,255,160,0.9)"; c.shadowColor = "#39ffa0"; c.shadowBlur = 14 * dpr;
          c.beginPath(); c.arc(ex, ey, 3.2 * dpr, 0, Math.PI * 2); c.fill();
        }
        c.restore();
      });
      c.shadowBlur = 0; c.fillStyle = "rgba(57,255,160,0.5)"; c.beginPath(); c.arc(cx, cy, 6 * dpr, 0, Math.PI * 2); c.fill();
      requestAnimationFrame(draw);
    }
    draw();
  }

  // Count-up for the "0" stats (they animate from a few steps down to zero).
  $$("[data-count]").forEach((el) => {
    const prefix = el.dataset.prefix || "";
    if (reduce) { el.textContent = prefix + "0"; return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return; io.disconnect();
      let n = 9; el.textContent = prefix + n;
      const id = setInterval(() => { n--; el.textContent = prefix + n; if (n <= 0) clearInterval(id); }, 90);
    }), { threshold: 0.6 });
    io.observe(el);
  });

  // Tap-to-pay demo.
  const stage = $(".stage"), term = $("#terminal"), tapBtn = $("#tap"), st = $("#t-status");
  let busy = false;
  function sparks() {
    if (reduce) return;
    const box = stage.getBoundingClientRect(), tb = term.getBoundingClientRect();
    for (let i = 0; i < 26; i++) {
      const s = document.createElement("i"); s.className = "spark";
      s.style.left = tb.left - box.left + tb.width / 2 + "px"; s.style.top = tb.top - box.top + tb.height / 2 + "px";
      stage.appendChild(s);
      const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 150;
      s.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d}px) scale(0)`, opacity: 0 }], { duration: 800 + Math.random() * 500, easing: "cubic-bezier(.1,.8,.3,1)" }).onfinish = () => s.remove();
    }
  }
  tapBtn.addEventListener("click", () => {
    if (busy) return; busy = true; tapBtn.disabled = true;
    stage.classList.remove("done"); stage.classList.add("go"); st.textContent = "Reading…";
    setTimeout(() => { term.classList.add("paid"); st.textContent = "✓ Paid · $0.00 fees"; stage.classList.add("done"); sparks(); }, reduce ? 0 : 750);
    setTimeout(() => { stage.classList.remove("go"); }, 2600);
    setTimeout(() => { term.classList.remove("paid"); stage.classList.remove("done"); st.textContent = "Waiting for tap…"; busy = false; tapBtn.disabled = false; }, 4200);
  });

  // Savings calculator: an illustration at a typical 2.9% + 30 cents per card sale.
  const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const sales = $("#sales"), avg = $("#avg");
  function fill(el) { el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min)) * 100 + "%"); }
  function calc() {
    const s = +sales.value, a = +avg.value;
    const yearly = (s * 0.029 + (s / a) * 0.3) * 12;
    $("#o-sales").textContent = money(s); $("#o-avg").textContent = money(a);
    $("#r-fees").textContent = money(yearly); $("#r-keep").textContent = money(yearly);
    $("#bar-fees").style.width = Math.min(100, 8 + (yearly / (500000 * 12 * 0.045)) * 92) + "%";
    fill(sales); fill(avg);
  }
  sales.addEventListener("input", calc); avg.addEventListener("input", calc); calc();

  // Tabs (arrow keys move between them).
  const tabs = $$("[role=tab]");
  function select(tab) {
    tabs.forEach((t) => { const on = t === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; $("#" + t.getAttribute("aria-controls")).hidden = !on; });
  }
  tabs.forEach((t, i) => {
    t.tabIndex = i === 0 ? 0 : -1;
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      const j = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : -1;
      if (j >= 0) { e.preventDefault(); tabs[j].focus(); select(tabs[j]); }
    });
  });
})();
