// Room state and rules. Pure logic: no sockets or timers here, so it can be unit-tested.
// The server calls these methods and schedules timers (grace periods) around them.

import {
  ROLE_COUNTS, MIN_PLAYERS, NAME_MAX, ROLE_NAME_MAX, ROOM_NAME_MAX,
  PLACEMENT_TIMER_OPTIONS, maxPlayersFor,
} from './config.js';
import { isProfane } from './profanity.js';
import { shortId } from './ids.js';

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fold = (s) => clean(s).toLowerCase();

export function validateName(raw) {
  const name = clean(raw);
  if (!name) throw new GameError('NAME_EMPTY', 'Enter a gaming name.');
  if (name.length > NAME_MAX) throw new GameError('NAME_LONG', `Gaming names can be up to ${NAME_MAX} characters.`);
  if (isProfane(name)) throw new GameError('NAME_PROFANE', 'That name isn’t allowed. Pick another.');
  return name;
}

export function validateSettings(input = {}) {
  const roomName = clean(input.roomName);
  if (!roomName) throw new GameError('ROOM_NAME_EMPTY', 'Give the room a name.');
  if (roomName.length > ROOM_NAME_MAX) throw new GameError('ROOM_NAME_LONG', `Room names can be up to ${ROOM_NAME_MAX} characters.`);
  if (isProfane(roomName)) throw new GameError('ROOM_NAME_PROFANE', 'That room name isn’t allowed.');

  const visibility = input.visibility === 'public' ? 'public' : input.visibility === 'private' ? 'private' : null;
  if (!visibility) throw new GameError('VISIBILITY', 'Choose public or private.');

  const roleCount = Number(input.roleCount);
  if (!ROLE_COUNTS.includes(roleCount)) throw new GameError('ROLE_COUNT', 'Games have 5 or 10 roles.');

  const roles = Array.isArray(input.roles) ? input.roles.map(clean) : [];
  if (roles.length !== roleCount) throw new GameError('ROLES_MISSING', `Name all ${roleCount} roles.`);
  roles.forEach((r, i) => {
    if (!r) throw new GameError('ROLE_EMPTY', `Role ${i + 1} needs a name.`);
    if (r.length > ROLE_NAME_MAX) throw new GameError('ROLE_LONG', `Role ${i + 1} is too long (max ${ROLE_NAME_MAX} characters).`);
    if (isProfane(r)) throw new GameError('ROLE_PROFANE', `Role ${i + 1} isn’t allowed. Pick another name.`);
  });

  const cap = Number(input.cap);
  const maxCap = maxPlayersFor(roleCount);
  if (!Number.isInteger(cap) || cap < MIN_PLAYERS) throw new GameError('CAP_LOW', `The player cap must be at least ${MIN_PLAYERS}.`);
  if (cap > maxCap) throw new GameError('CAP_HIGH', `With ${roleCount} roles the cap can be up to ${maxCap} players.`);

  const turnOrder = input.turnOrder === 'shuffle' ? 'shuffle' : 'join';
  const releasedHoldToBin = Boolean(input.releasedHoldToBin);
  const timerEnabled = Boolean(input.timerEnabled);
  const timerSeconds = Number(input.timerSeconds) || 30;
  if (timerEnabled && !PLACEMENT_TIMER_OPTIONS.includes(timerSeconds)) {
    throw new GameError('TIMER', 'Pick a placement timer from the list.');
  }

  return { roomName, visibility, roleCount, roles, cap, turnOrder, releasedHoldToBin, timerEnabled, timerSeconds };
}

export class Room {
  constructor({ id, settings, hostName, hostToken, now = Date.now() }) {
    this.id = id;
    this.settings = validateSettings(settings);
    this.createdAt = now;
    this.phase = 'lobby';
    this.players = []; // ordered by join
    this.requests = []; // pending public join requests
    this.banned = new Set(); // tokens of kicked players
    this.reports = [];
    this.turnOrder = [];
    this.nextJoinIndex = 0;
    this.version = 0; // bumps on every change, handy for clients and tests
    const host = this.#addPlayer(hostToken, validateName(hostName), now);
    this.hostId = host.id;
  }

  // ---------- lookups ----------
  player(id) { return this.players.find((p) => p.id === id); }
  playerByToken(token) { return this.players.find((p) => p.token === token); }
  get host() { return this.player(this.hostId); }
  get connectedPlayers() { return this.players.filter((p) => p.connected); }
  isFull() { return this.players.length >= this.settings.cap; }

  #nameTaken(name, exceptToken) {
    const f = fold(name);
    return this.players.some((p) => p.token !== exceptToken && fold(p.name) === f)
      || this.requests.some((r) => r.token !== exceptToken && fold(r.name) === f);
  }

  #requireHost(byId) {
    if (byId !== this.hostId) throw new GameError('NOT_HOST', 'Only the host can do that.');
  }

  #requireLobby() {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', 'This game has already started.');
  }

  #addPlayer(token, name, now) {
    const p = { id: shortId(), token, name, joinIndex: this.nextJoinIndex++, connected: true, disconnectedAt: null, joinedAt: now };
    this.players.push(p);
    this.#touch();
    return p;
  }

  #touch() { this.version += 1; }

  // ---------- joining ----------
  // Returns { player, reconnected }. Existing tokens always reattach, even mid-game (NF2).
  join(token, rawName, now = Date.now()) {
    if (!token) throw new GameError('NO_TOKEN', 'Something went wrong. Refresh and try again.');
    if (this.banned.has(token)) throw new GameError('KICKED', 'You were removed from this game by the host.');
    const existing = this.playerByToken(token);
    if (existing) {
      existing.connected = true;
      existing.disconnectedAt = null;
      this.#touch();
      return { player: existing, reconnected: true };
    }
    this.#requireLobby();
    if (this.settings.visibility === 'public') {
      throw new GameError('NEEDS_ADMISSION', 'This is a public game. Ask the host to let you in.');
    }
    if (this.isFull()) throw new GameError('ROOM_FULL', 'This room is full.');
    const name = validateName(rawName);
    if (this.#nameTaken(name, token)) throw new GameError('NAME_TAKEN', `“${name}” is already taken in this room. Pick another name.`);
    return { player: this.#addPlayer(token, name, now), reconnected: false };
  }

  // Public games: ask the host to be let in (R6.2).
  requestJoin(token, rawName, now = Date.now()) {
    if (!token) throw new GameError('NO_TOKEN', 'Something went wrong. Refresh and try again.');
    if (this.banned.has(token)) throw new GameError('KICKED', 'You were removed from this game by the host.');
    this.#requireLobby();
    if (this.isFull()) throw new GameError('ROOM_FULL', 'This room is full.');
    const name = validateName(rawName);
    if (this.#nameTaken(name, token)) throw new GameError('NAME_TAKEN', `“${name}” is already taken in this room. Pick another name.`);
    this.requests = this.requests.filter((r) => r.token !== token);
    const req = { id: shortId(), token, name, at: now };
    this.requests.push(req);
    this.#touch();
    return req;
  }

  cancelRequest(token) {
    const before = this.requests.length;
    this.requests = this.requests.filter((r) => r.token !== token);
    if (this.requests.length !== before) this.#touch();
  }

  admit(byId, requestId, now = Date.now()) {
    this.#requireHost(byId);
    this.#requireLobby();
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new GameError('NO_REQUEST', 'That request is no longer waiting.');
    if (this.isFull()) throw new GameError('ROOM_FULL', 'The room is full. Raise the cap or remove someone first.');
    this.requests = this.requests.filter((r) => r.id !== requestId);
    const player = this.#addPlayer(req.token, req.name, now);
    return { player, token: req.token };
  }

  decline(byId, requestId) {
    this.#requireHost(byId);
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new GameError('NO_REQUEST', 'That request is no longer waiting.');
    this.requests = this.requests.filter((r) => r.id !== requestId);
    this.#touch();
    return req;
  }

  // ---------- host moderation ----------
  kick(byId, targetId) {
    this.#requireHost(byId);
    if (targetId === byId) throw new GameError('KICK_SELF', 'You can’t remove yourself.');
    const target = this.player(targetId);
    if (!target) throw new GameError('NO_PLAYER', 'That player has already left.');
    this.banned.add(target.token);
    this.#removePlayer(targetId);
    return target;
  }

  report(byId, targetId, reason, now = Date.now()) {
    this.#requireHost(byId);
    const target = this.player(targetId);
    if (!target) throw new GameError('NO_PLAYER', 'That player has already left.');
    const text = clean(reason).slice(0, 300);
    if (!text) throw new GameError('REPORT_EMPTY', 'Say briefly what happened.');
    const report = { id: shortId(), roomId: this.id, roomName: this.settings.roomName, reporter: this.host.name, target: target.name, reason: text, at: now };
    this.reports.push(report);
    return report;
  }

  // ---------- leaving, disconnects and host handover ----------
  leave(playerId) {
    const p = this.player(playerId);
    if (!p) return;
    if (this.phase === 'lobby') this.#removePlayer(playerId);
    else { p.connected = false; p.disconnectedAt = Date.now(); this.#touch(); }
    if (playerId === this.hostId) this.#handOverHost(playerId);
  }

  disconnect(playerId, now = Date.now()) {
    const p = this.player(playerId);
    if (!p || !p.connected) return false;
    p.connected = false;
    p.disconnectedAt = now;
    this.#touch();
    return true;
  }

  // Called by the server when a player's 30-second grace period ends (R6.7, R6.8).
  expireGrace(playerId) {
    const p = this.player(playerId);
    if (!p || p.connected) return false; // came back in time: nothing happens
    const wasHost = playerId === this.hostId;
    if (this.phase === 'lobby') this.#removePlayer(playerId);
    if (wasHost) this.#handOverHost(playerId);
    this.#touch();
    return true;
  }

  // Host passes to the most senior connected player by join order.
  #handOverHost(oldHostId) {
    const next = this.players
      .filter((p) => p.id !== oldHostId && p.connected)
      .sort((a, b) => a.joinIndex - b.joinIndex)[0];
    if (next) this.hostId = next.id;
    this.#touch();
  }

  #removePlayer(id) {
    this.players = this.players.filter((p) => p.id !== id);
    this.turnOrder = this.turnOrder.filter((t) => t !== id);
    this.#touch();
  }

  isEmpty() { return this.connectedPlayers.length === 0; }

  // ---------- starting ----------
  startBlockers() {
    const reasons = [];
    const n = this.connectedPlayers.length;
    if (n < MIN_PLAYERS) reasons.push(`Waiting for players: ${n} of at least ${MIN_PLAYERS}.`);
    return reasons;
  }

  start(byId, rng = Math.random) {
    this.#requireHost(byId);
    this.#requireLobby();
    const blockers = this.startBlockers();
    if (blockers.length) throw new GameError('CANT_START', blockers[0]);
    const order = this.connectedPlayers.sort((a, b) => a.joinIndex - b.joinIndex).map((p) => p.id);
    if (this.settings.turnOrder === 'shuffle') {
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    this.turnOrder = order;
    this.requests = [];
    this.phase = 'draft';
    this.#touch();
  }

  // ---------- what each person is allowed to see ----------
  viewFor(playerId) {
    const isHost = playerId === this.hostId;
    return {
      id: this.id,
      version: this.version,
      phase: this.phase,
      settings: this.settings,
      hostId: this.hostId,
      you: playerId,
      isHost,
      players: this.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, isHost: p.id === this.hostId })),
      requests: isHost ? this.requests.map((r) => ({ id: r.id, name: r.name, at: r.at })) : [],
      turnOrder: this.turnOrder,
      startBlockers: this.startBlockers(),
    };
  }

  publicSummary() {
    return {
      id: this.id,
      roomName: this.settings.roomName,
      host: this.host?.name ?? '',
      players: this.players.length,
      cap: this.settings.cap,
      roleCount: this.settings.roleCount,
      full: this.isFull(),
    };
  }
}
