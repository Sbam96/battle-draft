// HTTP + real-time server. Holds every room in memory (one Render instance).

import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Room, GameError } from './room.js';
import { roomId } from './ids.js';
import { GRACE_MS, EMPTY_ROOM_TTL_MS, maxPlayersFor, PLACEMENT_TIMER_OPTIONS } from './config.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ graceMs = GRACE_MS, emptyRoomTtlMs = EMPTY_ROOM_TTL_MS } = {}) {
  const app = express();
  const http = createServer(app);
  const io = new Server(http, { cors: { origin: false } });

  const rooms = new Map();
  const reports = []; // read by the admin page in phase 6
  const graceTimers = new Map(); // `${roomId}:${playerId}` -> timeout
  const emptyTimers = new Map(); // roomId -> timeout

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  app.get('/config', (req, res) => res.json({ maxPlayers: { 5: maxPlayersFor(5), 10: maxPlayersFor(10) }, timerOptions: PLACEMENT_TIMER_OPTIONS }));
  app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
  app.get('/r/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // ---------- helpers ----------
  const publicList = () => [...rooms.values()]
    .filter((r) => r.settings.visibility === 'public' && r.phase === 'lobby' && !r.isEmpty())
    .map((r) => r.publicSummary());

  function broadcast(room) {
    for (const p of room.players) io.to(`p:${room.id}:${p.id}`).emit('room', room.viewFor(p.id));
    io.to(`req:${room.id}`).emit('requestStatus', { pending: true }); // keeps waiting screens alive
    io.to('browse').emit('publicRooms', publicList());
  }

  function scheduleEmptyCheck(room) {
    clearTimeout(emptyTimers.get(room.id));
    if (!room.isEmpty()) return;
    emptyTimers.set(room.id, setTimeout(() => {
      if (room.isEmpty()) { rooms.delete(room.id); io.to('browse').emit('publicRooms', publicList()); }
    }, emptyRoomTtlMs));
  }

  function attach(socket, room, player) {
    clearTimeout(graceTimers.get(`${room.id}:${player.id}`));
    socket.data.roomId = room.id;
    socket.data.playerId = player.id;
    socket.join(`p:${room.id}:${player.id}`);
    socket.leave(`req:${room.id}`);
  }

  function startGrace(room, playerId) {
    const key = `${room.id}:${playerId}`;
    clearTimeout(graceTimers.get(key));
    graceTimers.set(key, setTimeout(() => {
      graceTimers.delete(key);
      if (room.expireGrace(playerId)) { broadcast(room); scheduleEmptyCheck(room); }
    }, graceMs));
  }

  // Simple per-connection rate limit: 40 actions per 10 seconds (NF5).
  function limiter(socket) {
    let count = 0;
    let windowStart = Date.now();
    return () => {
      const now = Date.now();
      if (now - windowStart > 10_000) { windowStart = now; count = 0; }
      count += 1;
      return count <= 40;
    };
  }

  // ---------- sockets ----------
  io.on('connection', (socket) => {
    const allow = limiter(socket);

    // Wraps a handler: rate limit, error reporting, and an acknowledgement callback.
    const on = (event, fn) => socket.on(event, (payload = {}, ack = () => {}) => {
      if (typeof ack !== 'function') ack = () => {};
      if (!allow()) return ack({ ok: false, code: 'SLOW_DOWN', message: 'Too many actions at once. Wait a moment.' });
      try {
        const result = fn(payload || {}) ?? {};
        ack({ ok: true, ...result });
      } catch (err) {
        if (err instanceof GameError) ack({ ok: false, code: err.code, message: err.message });
        else { console.error(err); ack({ ok: false, code: 'SERVER', message: 'Something went wrong on our side. Try again.' }); }
      }
    });

    const currentRoom = () => {
      const room = rooms.get(socket.data.roomId);
      if (!room || !room.player(socket.data.playerId)) throw new GameError('NOT_IN_ROOM', 'You’re not in a game.');
      return room;
    };
    const getRoom = (id) => {
      const room = rooms.get(String(id || ''));
      if (!room) throw new GameError('ROOM_NOT_FOUND', 'Game not found. The link may be wrong or the game has ended.');
      return room;
    };

    on('browse', () => { socket.join('browse'); return { rooms: publicList() }; });
    on('unbrowse', () => { socket.leave('browse'); });

    on('peek', ({ roomId: id, token }) => {
      const room = getRoom(id);
      const existing = room.playerByToken(token);
      return {
        room: { ...room.publicSummary(), visibility: room.settings.visibility, phase: room.phase },
        member: Boolean(existing),
        banned: room.banned.has(token),
      };
    });

    on('create', ({ settings, name, token }) => {
      const id = roomId();
      const room = new Room({ id, settings, hostName: name, hostToken: String(token || '') });
      rooms.set(id, room);
      attach(socket, room, room.host);
      broadcast(room);
      return { roomId: id };
    });

    on('join', ({ roomId: id, name, token }) => {
      const room = getRoom(id);
      const { player } = room.join(String(token || ''), name);
      attach(socket, room, player);
      clearTimeout(emptyTimers.get(room.id));
      broadcast(room);
      return { roomId: room.id };
    });

    on('requestJoin', ({ roomId: id, name, token }) => {
      const room = getRoom(id);
      const req = room.requestJoin(String(token || ''), name);
      socket.data.requestRoomId = room.id;
      socket.data.requestToken = req.token;
      socket.join(`req:${room.id}`);
      socket.join(`tok:${room.id}:${req.token}`);
      broadcast(room);
      return { requestId: req.id };
    });

    on('cancelRequest', () => {
      const room = rooms.get(socket.data.requestRoomId);
      if (!room) return;
      room.cancelRequest(socket.data.requestToken);
      socket.leave(`req:${room.id}`);
      broadcast(room);
    });

    on('admit', ({ requestId }) => {
      const room = currentRoom();
      const { player, token } = room.admit(socket.data.playerId, requestId);
      io.to(`tok:${room.id}:${token}`).emit('admitted', { roomId: room.id, playerId: player.id });
      broadcast(room);
    });

    on('decline', ({ requestId }) => {
      const room = currentRoom();
      const req = room.decline(socket.data.playerId, requestId);
      io.to(`tok:${room.id}:${req.token}`).emit('declined', { roomName: room.settings.roomName });
      broadcast(room);
    });

    on('kick', ({ playerId }) => {
      const room = currentRoom();
      const target = room.kick(socket.data.playerId, playerId);
      const targetRoom = `p:${room.id}:${target.id}`;
      io.to(targetRoom).emit('kicked', { roomName: room.settings.roomName });
      io.in(targetRoom).socketsLeave(targetRoom);
      broadcast(room);
    });

    on('report', ({ playerId, reason }) => {
      const room = currentRoom();
      reports.push(room.report(socket.data.playerId, playerId, reason));
    });

    on('leave', () => {
      const room = currentRoom();
      const pid = socket.data.playerId;
      socket.leave(`p:${room.id}:${pid}`);
      socket.data.roomId = socket.data.playerId = undefined;
      room.leave(pid);
      broadcast(room);
      scheduleEmptyCheck(room);
    });

    on('start', () => {
      const room = currentRoom();
      room.start(socket.data.playerId);
      broadcast(room);
    });

    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.roomId);
      const pid = socket.data.playerId;
      if (room && pid) {
        // Another tab for the same player may still be open.
        const stillHere = io.sockets.adapter.rooms.get(`p:${room.id}:${pid}`)?.size;
        if (!stillHere && room.disconnect(pid)) {
          startGrace(room, pid);
          broadcast(room);
          scheduleEmptyCheck(room);
        }
      }
      const reqRoom = rooms.get(socket.data.requestRoomId);
      if (reqRoom && socket.data.requestToken && !reqRoom.playerByToken(socket.data.requestToken)) {
        reqRoom.cancelRequest(socket.data.requestToken);
        broadcast(reqRoom);
      }
    });
  });

  return { app, http, io, rooms, reports };
}

// Run directly: `node src/server.js`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { http } = createApp();
  const port = Number(process.env.PORT) || 3000;
  http.listen(port, () => console.log(`Battle Draft listening on http://localhost:${port}`));
}
