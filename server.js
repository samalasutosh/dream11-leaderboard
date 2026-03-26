require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const ADMIN_PIN = process.env.ADMIN_PIN || '13579';

const JSONBIN_BIN_ID  = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_URL     = JSONBIN_BIN_ID ? `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}` : null;
const MATCHES_FILE    = path.join(DATA_DIR, 'matches.json');
const USE_JSONBIN     = !!(JSONBIN_URL && JSONBIN_API_KEY);

// ==========================================
// HELPERS — players from local file, matches from JSONBin (or local fallback)
// ==========================================
function readPlayers() {
  return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf-8'));
}

async function readMatches() {
  if (!USE_JSONBIN) {
    // Local fallback for development
    return JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf-8'));
  }
  const res = await fetch(`${JSONBIN_URL}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_API_KEY }
  });
  if (!res.ok) throw new Error(`JSONBin read failed: ${res.status}`);
  const json = await res.json();
  return json.record.matches || [];
}

async function writeMatches(matches) {
  if (!USE_JSONBIN) {
    // Local fallback for development
    fs.writeFileSync(MATCHES_FILE, JSON.stringify(matches, null, 2), 'utf-8');
    return;
  }
  const res = await fetch(JSONBIN_URL, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': JSONBIN_API_KEY
    },
    body: JSON.stringify({ matches })
  });
  if (!res.ok) throw new Error(`JSONBin write failed: ${res.status}`);
}

// ==========================================
// LEADERBOARD ENGINE (ported from code.gs)
// ==========================================
async function computeLeaderboard() {
  const players = readPlayers();
  const matches = await readMatches();

  const winCounts = {};
  const playerLogs = {};
  const rankHistory = {};
  const missStreaks = {};
  const totalFines = {};
  const fineAlert = {}; // true ONLY when fine triggered on the latest match

  players.forEach(p => {
    winCounts[p] = 0;
    playerLogs[p] = [];
    rankHistory[p] = [];
    missStreaks[p] = 0;
    totalFines[p] = 0;
    fineAlert[p] = false;
  });

  function getRanksAtCurrentState(currentWins) {
    const lb = Object.entries(currentWins)
      .map(([player, wins]) => ({ player, wins }))
      .sort((a, b) => b.wins - a.wins);
    const ranks = {};
    let currentRank = 1;
    let prevWins = null;
    lb.forEach((entry, index) => {
      if (prevWins !== null && entry.wins < prevWins) {
        currentRank = index + 1;
      }
      ranks[entry.player] = currentRank;
      prevWins = entry.wins;
    });
    return ranks;
  }

  matches.forEach((match) => {
    const dateStr = match.date;
    const matchName = match.matchName;
    const winner = match.winner;
    const absenteesStr = match.absentees || '';
    const absenteesList = absenteesStr.split(',').map(s => s.trim()).filter(Boolean);

    // 1. Process Winner
    if (winCounts.hasOwnProperty(winner)) {
      winCounts[winner]++;
      playerLogs[winner].unshift(matchName + ' (' + dateStr + ')');
    }

    // 2. Process Absences & Fines
    players.forEach(p => {
      fineAlert[p] = false; // reset each match — only the last match matters
      if (absenteesList.includes(p)) {
        missStreaks[p]++;
        if (missStreaks[p] >= 3) {
          totalFines[p]++;
          fineAlert[p] = true; // fine just triggered on THIS match
          missStreaks[p] = 0;  // reset streak after fine
        }
      } else {
        missStreaks[p] = 0;
      }
    });

    // 3. Store History
    const ranksAfterMatch = getRanksAtCurrentState(winCounts);
    players.forEach(p => {
      rankHistory[p].push(ranksAfterMatch[p]);
    });
  });

  const finalRanks = getRanksAtCurrentState(winCounts);
  const last3Matches = matches.slice(-3).map(m => m.winner);

  const leaderboardData = players.map(curr => {
    const rHistory = rankHistory[curr] || [];
    const finalRank = finalRanks[curr];
    const prevRank = rHistory.length > 1 ? rHistory[rHistory.length - 2] : finalRank;
    const trend = prevRank - finalRank;
    const form = last3Matches.map(winner => (winner === curr ? 'W' : 'L'));

    return {
      player: curr,
      wins: winCounts[curr],
      rank: finalRank,
      trend: trend,
      form: form,
      log: playerLogs[curr].slice(0, 5),
      rankHistory: rHistory,
      missStreak: missStreaks[curr],
      fines: totalFines[curr],
      fineAlert: fineAlert[curr], // true only when 3rd miss was the latest match
    };
  }).sort((a, b) => a.rank - b.rank);

  return leaderboardData;
}

// ==========================================
// API ROUTES
// ==========================================

// GET  /api/leaderboard
app.get('/api/leaderboard', async (_req, res) => {
  try {
    res.json(await computeLeaderboard());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/match — add a match record
app.post('/api/match', async (req, res) => {
  const { date, matchName, winner, pin, absentees } = req.body;

  if (pin !== ADMIN_PIN) {
    return res.json({ success: false, message: 'Incorrect Admin PIN.' });
  }
  if (!date || !matchName || !winner) {
    return res.json({ success: false, message: 'Date, Match Name, and Winner are required.' });
  }

  try {
    const matches = await readMatches();
    matches.push({ date, matchName, winner, absentees: absentees || '' });
    await writeMatches(matches);
    return res.json({ success: true, message: 'Match logged!', data: await computeLeaderboard() });
  } catch (err) {
    return res.json({ success: false, message: 'Error: ' + err.message });
  }
});

// POST /api/undo — revert last match
app.post('/api/undo', async (req, res) => {
  const { pin } = req.body;

  if (pin !== ADMIN_PIN) {
    return res.json({ success: false, message: 'Incorrect Admin PIN.' });
  }

  try {
    const matches = await readMatches();
    if (matches.length === 0) {
      return res.json({ success: false, message: 'No matches left to delete.' });
    }
    matches.pop();
    await writeMatches(matches);
    return res.json({ success: true, message: 'Last match reverted!', data: await computeLeaderboard() });
  } catch (err) {
    return res.json({ success: false, message: 'Error: ' + err.message });
  }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dream11 Leaderboard running on http://localhost:${PORT}`);
});
