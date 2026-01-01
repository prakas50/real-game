const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

// Routes
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- DATABASE CONNECT ---
const DB_URI = "mongodb+srv://prakashnangalbani_db_user:Pkdiit%40123@cluster0.5465gly.mongodb.net/?appName=Cluster0";
mongoose.connect(DB_URI).then(() => console.log("✅ DATABASE CONNECTED!")).catch(err => console.log("❌ DB Error:", err));

// --- MODELS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true }, // PASSWORD FIELD ADDED
    balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const historySchema = new mongoose.Schema({ multiplier: Number, time: { type: Date, default: Date.now } });
const History = mongoose.model('History', historySchema);

const depositSchema = new mongoose.Schema({
    username: String, amount: Number, utr: String, status: { type: String, default: "PENDING" }, date: { type: Date, default: Date.now }
});
const Deposit = mongoose.model('Deposit', depositSchema);

// --- VARIABLES ---
let gameHistory = [];
let gameState = "IDLE";
let multiplier = 1.00;
let crashPoint = 0;
let countdown = 8;

// History Load
async function loadHistory() {
    const old = await History.find().sort({ time: -1 }).limit(20);
    gameHistory = old.map(d => d.multiplier);
}
loadHistory();

function startGameLoop() {
    gameState = "IDLE"; countdown = 8; multiplier = 1.00;
    io.emit("state-change", { state: "IDLE", countdown: countdown });
    let timer = setInterval(() => {
        countdown--; io.emit("timer-update", countdown);
        if (countdown <= 0) { clearInterval(timer); startFlight(); }
    }, 1000);
}

function startFlight() {
    gameState = "FLYING";
    if (Math.random() < 0.15) crashPoint = 1.00;
    else {
        crashPoint = (100 / (100 * Math.random() + 1)).toFixed(2);
        if (crashPoint < 1.1) crashPoint = 1.10;
    }
    io.emit("state-change", { state: "FLYING" });
    let flyInterval = setInterval(() => {
        if (gameState === "CRASHED") { clearInterval(flyInterval); return; }
        multiplier += (multiplier * 0.006) + 0.002;
        if (multiplier >= crashPoint) { handleCrash(crashPoint); clearInterval(flyInterval); }
        else { io.emit("tick", multiplier); }
    }, 50);
}

async function handleCrash(val) {
    gameState = "CRASHED";
    io.emit("crash", { multiplier: val });
    const rec = new History({ multiplier: val }); await rec.save();
    gameHistory.unshift(val); if (gameHistory.length > 20) gameHistory.pop();
    io.emit("history-update", gameHistory);
    setTimeout(startGameLoop, 4000);
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    socket.emit('history-update', gameHistory);
    socket.emit("welcome", { gameState, multiplier, countdown });

    // --- NEW: AUTHENTICATION SYSTEM ---
    
    // 1. REGISTER
    socket.on('register', async (data) => {
        const { username, password } = data;
        const exists = await User.findOne({ username });
        if(exists) {
            socket.emit('auth-error', "Username already taken!");
        } else {
            const newUser = new User({ username, password, balance: 50 }); // 50 Bonus
            await newUser.save();
            socket.emit('login-success', { username: newUser.username, balance: newUser.balance });
        }
    });

    // 2. LOGIN
    socket.on('login', async (data) => {
        const { username, password } = data;
        const user = await User.findOne({ username, password }); // Check ID & Pass
        if(user) {
            socket.emit('login-success', { username: user.username, balance: user.balance });
        } else {
            socket.emit('auth-error', "Wrong Username or Password!");
        }
    });

    // --- GAME ACTIONS ---
    socket.on('place-bet', async (data) => {
        if (gameState !== "IDLE") return;
        let player = await User.findOne({ username: data.username });
        if (player && player.balance >= data.amount) {
            player.balance -= data.amount; await player.save();
            socket.emit('balance-update', player.balance);
        }
    });

    socket.on('cash-out', async (data) => {
        if (gameState !== "FLYING") return;
        let player = await User.findOne({ username: data.username });
        if (player) {
            player.balance += data.winAmount; await player.save();
            socket.emit('balance-update', player.balance);
        }
    });

    // --- MONEY SYSTEM ---
    socket.on('deposit-request', async (data) => {
        try { const newDep = new Deposit(data); await newDep.save(); } catch(e){}
    });
    
    // Admin Calls
    socket.on('admin-get-deposits', async () => { socket.emit('admin-deposit-list', await Deposit.find({ status: "PENDING" })); });
    socket.on('admin-approve-deposit', async (id) => {
        const dep = await Deposit.findById(id);
        if (dep && dep.status === "PENDING") {
            dep.status = "APPROVED"; await dep.save();
            const user = await User.findOne({ username: dep.username });
            if(user) { user.balance += dep.amount; await user.save(); io.emit('force-balance-update', { username: user.username, balance: user.balance }); }
        }
    });
    socket.on('admin-reject-deposit', async (id) => { 
        const dep = await Deposit.findById(id); if (dep) { dep.status = "REJECTED"; await dep.save(); } 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`SERVER RUNNING ON PORT ${PORT}`); startGameLoop(); });