/** @type {import('next').NextConfig} */
// STATIC=1 produces a static export the relay can serve itself, so the app and
// the WebSocket share one origin — which is what makes phones work: getUserMedia
// requires HTTPS, and an https:// page cannot open a ws:// socket elsewhere.
//
// trailingSlash puts each route in its own directory (admin/index.html rather
// than admin.html), which is what StaticFiles(html=True) resolves.
export default {
  reactStrictMode: false, // the mesh holds live sockets; double-mounting churns them
  ...(process.env.STATIC ? { output: "export", trailingSlash: true } : {}),
};
