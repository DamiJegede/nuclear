export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.nclr.app") {
      url.hostname = "nclr.app";
      return Response.redirect(url.toString(), 301);
    }

    if (/\.(webm|mp4)$/.test(url.pathname)) {
      const range = request.headers.get("Range");
      if (range) return rangeResponse(request, env, range);

      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set("Accept-Ranges", "bytes");
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};

// Safari won't play <video> unless Range requests are answered with 206,
// and the assets binding returns the full file with 200.
async function rangeResponse(request, env, range) {
  const full = await env.ASSETS.fetch(new Request(request.url, { method: "GET" }));
  if (!full.ok) return full;

  const buf = await full.arrayBuffer();
  const size = buf.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (m[1] === "" && m[2] === "")) return full;

  let start, end;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": full.headers.get("Content-Type"),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
