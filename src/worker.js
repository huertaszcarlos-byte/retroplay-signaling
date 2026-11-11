export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "retroplay-signaling" });
    }

    if (url.pathname === "/api/room/create" && request.method === "POST") {
      const code = makeCode();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      const res = await stub.fetch("https://room.internal/init", { method: "POST" });
      if (!res.ok) return new Response("No se pudo crear la sala", { status: 500 });
      return Response.json({ code, role: "host" });
    }

    const match = url.pathname.match(/^\/api\/room\/([A-Z0-9]{6})\/ws$/);
    if (match && request.headers.get("Upgrade") === "websocket") {
      const code = match[1];
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }

    return new Response("RetroPlay signaling API", { status: 200 });
  }
};

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

export class Room {
  constructor(state) {
    this.state = state;
    this.sockets = new Set();
    this.roles = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      await this.state.storage.put("createdAt", Date.now());
      return new Response("ok");
    }

    // Evita que un código inventado cree una sala nueva al intentar entrar.
    const createdAt = await this.state.storage.get("createdAt");
    if (!createdAt) {
      return new Response("Sala no encontrada", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket requerido", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const connected = [...this.sockets].length;
    if (connected >= 2) {
      server.send(JSON.stringify({ type: "room-full" }));
      server.close(1008, "Sala llena");
      return new Response(null, { status: 101, webSocket: client });
    }

    const role = connected === 0 ? "host" : "guest";
    this.sockets.add(server);
    this.roles.set(server, role);
    server.send(JSON.stringify({ type: "joined", role }));

    for (const socket of this.sockets) {
      if (socket !== server) {
        try { socket.send(JSON.stringify({ type: "peer-joined", role })); } catch {}
      }
    }

    server.addEventListener("message", event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      const allowed = new Set(["offer", "answer", "ice-candidate", "ready", "leave"]);
      if (!data || !allowed.has(data.type)) return;
      for (const socket of this.sockets) {
        if (socket !== server) {
          try { socket.send(JSON.stringify({ ...data, from: role })); } catch {}
        }
      }
      if (data.type === "leave") this.remove(server);
    });

    const cleanup = () => this.remove(server);
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  remove(socket) {
    this.sockets.delete(socket);
    this.roles.delete(socket);
    for (const peer of this.sockets) {
      try { peer.send(JSON.stringify({ type: "peer-left" })); } catch {}
    }
  }
}
