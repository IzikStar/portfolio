// One live room per community chat (a Durable Object, SQLite-backed so it runs
// on the free plan). It only holds the open sockets: messages are written to
// D1 by the worker (src/chat.js), which then posts them to /broadcast here.
// Sockets use the hibernation API, so an idle room costs nothing.
//
// To a socket the room sends JSON:
//   { type: 'message', message }        a new or changed message
//   { type: 'members', members }        who is in the chat, who may write
//   { type: 'presence', people }        who has the chat open [{ id, name }]
//   { type: 'typing', id, name }        someone is typing
// and it takes { type: 'typing' } from a socket. "ping" gets "pong".
//
// The worker checked who connects. Since someone may be taken out of the
// community while the chat is open, the room asks D1 again about each member
// at most once a minute, and closes the socket of anyone no longer in it.
const RECHECK_MS = 60_000;

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    if (typeof WebSocketRequestResponsePair === 'function') {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      // `to`: a message for some members only goes to them (and the owner).
      const { to, ...payload } = await request.json();
      await this.send(JSON.stringify(payload), null, Array.isArray(to) ? new Set(to) : null);
      return new Response('ok');
    }
    // Who has the chat open (the worker skips their notifications).
    if (url.pathname === '/present') {
      const ids = new Set(this.open().map((ws) => ws.deserializeAttachment()?.id).filter(Boolean));
      return Response.json({ ids: [...ids] });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    const who = {
      id: request.headers.get('X-Chat-User'),
      name: decodeURIComponent(request.headers.get('X-Chat-Name') ?? ''),
      room: request.headers.get('X-Chat-Room'),
      checked: Date.now(),
    };
    if (!who.id || !who.room) return new Response('Missing user.', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment(who);
    await this.presence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    if (msg?.type !== 'typing' || !(await this.allowed(ws))) return;
    const who = ws.deserializeAttachment();
    await this.send(JSON.stringify({ type: 'typing', id: who.id, name: who.name }), ws);
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {
      // already closed
    }
    await this.presence(ws);
  }

  async webSocketError(ws) {
    await this.presence(ws);
  }

  // Sockets that are still open, minus one that is leaving.
  open(except) {
    return this.state.getWebSockets().filter((ws) => ws !== except && ws.readyState !== 2 && ws.readyState !== 3);
  }

  async send(text, except, only = null) {
    for (const ws of this.open(except)) {
      const who = ws.deserializeAttachment();
      if (only && who?.id !== 'owner' && !only.has(who?.id)) continue;
      if (!(await this.allowed(ws))) continue;
      try {
        ws.send(text);
      } catch {
        // the socket went away; webSocketClose tidies up
      }
    }
  }

  async presence(leaving) {
    const people = new Map();
    for (const ws of this.open(leaving)) {
      const who = ws.deserializeAttachment();
      if (who?.id) people.set(who.id, { id: who.id, name: who.name });
    }
    await this.send(JSON.stringify({ type: 'presence', people: [...people.values()] }), leaving);
  }

  // Is this socket's person still in the community? (The owner always is.)
  async allowed(ws) {
    const who = ws.deserializeAttachment();
    if (!who) return false;
    if (who.id === 'owner' || Date.now() - who.checked < RECHECK_MS) return true;
    let ok = true;
    try {
      const row = await this.env.DB.prepare(
        `SELECT cm.status AS membership, u.status AS account FROM community_members cm
         JOIN users u ON u.id = cm.user_id WHERE cm.community_id = ? AND cm.user_id = ?`,
      )
        .bind(who.room, who.id)
        .first();
      ok = row?.membership === 'active' && row?.account === 'active';
    } catch (err) {
      // D1 had a hiccup: keep the socket, ask again next time.
      console.error('chat recheck', err);
      return true;
    }
    if (!ok) {
      try {
        ws.close(4003, 'No longer in this community');
      } catch {
        // already closed
      }
      return false;
    }
    ws.serializeAttachment({ ...who, checked: Date.now() });
    return true;
  }
}
