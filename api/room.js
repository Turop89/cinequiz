import Pusher from "pusher";

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});

const rooms = {};

const BASE_PTS  = { 0: 10, 1: 20, 2: 30 };
const FACTOR    = { 0: 1,  1: 2,  2: 3  };

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { action, roomCode, playerId, playerName, data } = req.body;

  switch (action) {

    case "create": {
      const code = Math.random().toString(36).substr(2, 6).toUpperCase();
      rooms[code] = {
        status: "lobby",
        host: playerId,
        players: [{ id: playerId, name: playerName, isHost: true, avatarId: data?.avatarId || 0 }],
        questions: [],       // one per round, fetched on demand
        currentQ: 0,
        turnIndex: 0,        // whose turn it is (index into players array)
        scores: {},          // { playerId: number }
        answers: {},         // { qIdx: { playerId: answerObj } }
        settings: { cat: "mix", diff: 1, count: 10 },
        roundDiff: 0,        // difficulty chosen for current round
        roundCat: "mix",     // category chosen for current round
        createdAt: Date.now(),
      };
      return res.status(200).json({ roomCode: code, room: rooms[code] });
    }

    case "join": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      if (room.status !== "lobby") return res.status(400).json({ error: "Spiel läuft bereits!" });
      if (room.players.length >= 8) return res.status(400).json({ error: "Raum ist voll!" });
      room.players.push({ id: playerId, name: playerName, isHost: false, avatarId: data?.avatarId || 0 });
      await pusher.trigger(`room-${roomCode}`, "player-joined", { players: room.players });
      return res.status(200).json({ room });
    }

    case "update-settings": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      room.settings = { ...room.settings, ...data };
      return res.status(200).json({ ok: true });
    }

    // Host starts the game – no questions yet, just signal turn-picker
    case "start": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      room.status = "pick";
      room.turnIndex = 0;
      room.currentQ = 0;
      room.answers = {};
      room.scores = {};
      room.players.forEach(p => { room.scores[p.id] = 0; });
      room.totalRounds = data.totalRounds;
      // send "pick" event so everyone shows the picker screen
      const picker = room.players[0];
      await pusher.trigger(`room-${roomCode}`, "round-pick", {
        pickerName: picker.name,
        pickerId: picker.id,
        roundNum: 1,
        totalRounds: room.totalRounds,
        players: room.players,
      });
      return res.status(200).json({ ok: true });
    }

    // Active player picks category + difficulty → host fetches question
    case "picked": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      room.roundCat  = data.cat;
      room.roundDiff = data.diff;
      // store the single question for this round
      room.currentQuestion = data.question;
      room.status = "playing";
      await pusher.trigger(`room-${roomCode}`, "round-start", {
        question: data.question,
        cat: data.cat,
        diff: data.diff,
        pickerId: data.pickerId,
        pickerName: data.pickerName,
        roundNum: room.currentQ + 1,
        totalRounds: room.totalRounds,
      });
      return res.status(200).json({ ok: true });
    }

    case "answer": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      const qIdx = room.currentQ;
      if (!room.answers[qIdx]) room.answers[qIdx] = {};
      room.answers[qIdx][playerId] = {
        id: playerId,
        name: playerName,
        chosen: data.chosen,
        correct: data.correct,
        pts: data.pts,
      };
      const answered = Object.keys(room.answers[qIdx]).length;
      const total    = room.players.length;
      await pusher.trigger(`room-${roomCode}`, "answer-update", {
        answered, total, qIdx,
        answeredIds: Object.keys(room.answers[qIdx]),
      });
      if (answered >= total) {
        await triggerReveal(room, roomCode);
      }
      return res.status(200).json({ ok: true });
    }

    case "reveal": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      await triggerReveal(room, roomCode);
      return res.status(200).json({ ok: true });
    }

    case "next": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      room.currentQ++;
      const isLast = room.currentQ >= room.totalRounds;
      if (isLast) {
        room.status = "final";
        const scores = buildScores(room);
        await pusher.trigger(`room-${roomCode}`, "game-final", { scores });
      } else {
        room.status = "pick";
        room.turnIndex = room.currentQ % room.players.length;
        const picker = room.players[room.turnIndex];
        await pusher.trigger(`room-${roomCode}`, "round-pick", {
          pickerName: picker.name,
          pickerId: picker.id,
          roundNum: room.currentQ + 1,
          totalRounds: room.totalRounds,
          players: room.players,
        });
      }
      return res.status(200).json({ ok: true });
    }

    case "final": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      room.status = "final";
      const scores = buildScores(room);
      await pusher.trigger(`room-${roomCode}`, "game-final", { scores });
      return res.status(200).json({ ok: true });
    }

    case "get":
      return res.status(200).json({ room: rooms[roomCode] || null });

    default:
      return res.status(400).json({ error: "Unknown action" });
  }
}

async function triggerReveal(room, roomCode) {
  const qIdx = room.currentQ;
  const answers = room.answers[qIdx] || {};
  const diff    = room.roundDiff;
  const base    = BASE_PTS[diff];
  const factor  = FACTOR[diff];

  // apply scores
  Object.values(answers).forEach(a => {
    const isPicker = a.id === room.players[room.turnIndex]?.id;
    let delta = 0;
    if (a.chosen === a.correct) {
      delta = base + (isPicker ? base * factor : 0);
    } else if (isPicker) {
      delta = -(base * factor);
    }
    room.scores[a.id] = Math.max(0, (room.scores[a.id] || 0) + delta);
    a.pts = delta; // overwrite with actual delta for display
  });

  const scores = buildScores(room);
  room.status = "reveal";

  await pusher.trigger(`room-${roomCode}`, "reveal", {
    qIdx,
    question: room.currentQuestion,
    answers,
    scores,
    diff,
    pickerId: room.players[room.turnIndex]?.id,
    isLast: room.currentQ >= room.totalRounds - 1,
  });
}

function buildScores(room) {
  return room.players
    .map(p => ({
      id: p.id,
      name: p.name,
      avatarId: p.avatarId || 0,
      total: room.scores[p.id] || 0,
      correct: Object.values(room.answers)
        .filter(qa => qa[p.id]?.chosen === qa[p.id]?.correct).length,
    }))
    .sort((a, b) => b.total - a.total);
}
