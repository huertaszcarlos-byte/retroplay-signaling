
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "retroplay-signaling"
      });
    }

    if (
      url.pathname === "/api/room/create" &&
      request.method === "POST"
    ) {
      const code = makeCode();
      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);

      const response = await room.fetch(
        "https://room.internal/init",
        { method: "POST" }
      );

      if (!response.ok) {
        return new Response("Error creando sala", {
          status: 500
        });
      }

      return Response.json({
        code,
        role: "host"
      });
    }

    const match = url.pathname.match(
      /^\/api\/room\/([A-Z0-9]{6})\/ws$/
    );

    if (
      match &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      const id = env.ROOMS.idFromName(match[1]);
      return env.ROOMS.get(id).fetch(request);
    }

    return new Response("RetroPlay signaling API");
  }
};

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);

  crypto.getRandomValues(bytes);

  return Array.from(
    bytes,
    byte => chars[byte % chars.length]
  ).join("");
}

export class Room {
  constructor(state) {
    this.state = state;
    this.sockets = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      await this.state.storage.put(
        "createdAt",
        Date.now()
      );
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket requerido", {
        status: 426
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    if (this.sockets.size >= 2) {
      server.send(JSON.stringify({
        type: "room-full"
      }));
      server.close(1008, "Sala llena");

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    const role = this.sockets.size === 0
      ? "host"
      : "guest";

    this.sockets.add(server);

    server.send(JSON.stringify({
      type: "joined",
      role
    }));

    for (const socket of this.sockets) {
      if (socket !== server) {
        socket.send(JSON.stringify({
          type: "peer-joined",
          role
        }));
      }
    }

    server.addEventListener("message", event => {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      const allowed = [
        "offer",
        "answer",
        "ice-candidate",
        "ready",
        "leave"
      ];

      if (!data || !allowed.includes(data.type)) {
        return;
      }

      for (const socket of this.sockets) {
        if (socket !== server) {
          socket.send(JSON.stringify({
            ...data,
            from: role
          }));
        }
      }

      if (data.type === "leave") {
        this.remove(server);
      }
    });

    const cleanup = () => this.remove(server);

    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  remove(socket) {
    this.sockets.delete(socket);

    for (const peer of this.sockets) {
      peer.send(JSON.stringify({
        type: "peer-left"
      }));
    }
  }
}
