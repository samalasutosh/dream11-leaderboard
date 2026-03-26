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
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');
const ADMIN_PIN = process.env.ADMIN_PIN || '13579';

// ==========================================
// HELPERS — read/write JSON
// ==========================================
function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ==========================================
// LEADERBOARD ENGINE (ported from code.gs)
// ==========================================
let leaderboardCache = null;

function computeLeaderboard() {
  const players = readJSON(PLAYERS_FILE);
  const matches = readJSON(MATCHES_FILE);

  const winCounts = {};
  const playerLogs = {};
  const rankHistory = {};
  const missStreaks = {};
  const totalFines = {};

  players.forEach(p => {
    winCounts[p] = 0;
    playerLogs[p] = [];
    rankHistory[p] = [];
    missStreaks[p] = 0;
    totalFines[p] = 0;
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
      if (absenteesList.includes(p)) {
        missStreaks[p]++;
        if (missStreaks[p] >= 3) {
          totalFines[p]++;
          missStreaks[p] = 0;
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
    };
  }).sort((a, b) => a.rank - b.rank);

  leaderboardCache = leaderboardData;
  return leaderboardData;
}

function getLeaderboard() {
  return leaderboardCache || computeLeaderboard();
}

// ==========================================
// API ROUTES
// ==========================================

// GET  /api/leaderboard
app.get('/api/leaderboard', (_req, res) => {
  try {
    res.json(getLeaderboard());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/match — add a match record
app.post('/api/match', (req, res) => {
  const { date, matchName, winner, pin, absentees } = req.body;

  if (pin !== ADMIN_PIN) {
    return res.json({ success: false, message: 'Incorrect Admin PIN.' });
  }
  if (!date || !matchName || !winner) {
    return res.json({ success: false, message: 'Date, Match Name, and Winner are required.' });
  }

  try {
    const matches = readJSON(MATCHES_FILE);
    matches.push({ date, matchName, winner, absentees: absentees || '' });
    writeJSON(MATCHES_FILE, matches);
    leaderboardCache = null; // bust cache
    return res.json({ success: true, message: 'Match logged!', data: computeLeaderboard() });
  } catch (err) {
    return res.json({ success: false, message: 'Error: ' + err.message });
  }
});

// POST /api/undo — revert last match
app.post('/api/undo', (req, res) => {
  const { pin } = req.body;

  if (pin !== ADMIN_PIN) {
    return res.json({ success: false, message: 'Incorrect Admin PIN.' });
  }

  try {
    const matches = readJSON(MATCHES_FILE);
    if (matches.length === 0) {
      return res.json({ success: false, message: 'No matches left to delete.' });
    }
    matches.pop();
    writeJSON(MATCHES_FILE, matches);
    leaderboardCache = null;
    return res.json({ success: true, message: 'Last match reverted!', data: computeLeaderboard() });
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
