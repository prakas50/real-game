const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path'); // Path module add kiya

const app = express();
app.use(cors());

// --- 1. SERVE HTML FILES (Zaroori for Online) ---
app.use(express.static(__dirname)); // Current folder ki files dikhao

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- 2. DATABASE CONNECTION ---
const DB_URI = "mongodb+srv://prakashnangalbani_db_user:Pkdiit%40123@cluster0.5465gly.mongodb.net/?appName=Cluster0";

mongoose.connect(DB_URI)
    .then(() => console.log("✅ DATABASE CONNECTED!"))
    .catch((err) => console.log("❌ DB Connection Error:", err));

const userSchema = new mongoose.Schema({
    username: String,
    balance: { type: Number, default: 1000 },
    history: [String]
});
const User = mongoose.model('User', userSchema);

// --- 3. GAME VARIABLES ---
let gameState = "IDLE";
let multiplier = 1.00;
let crashPoint = 0;
let countdown = 5;
let FIXED_RESULT = null;

// --- 4. GAME LOOP ---
function startGameLoop() {
    gameState = "IDLE";
    countdown = 5;
    multiplier = 1.00;
    io.emit("state-change", { state: "IDLE", countdown: countdown });

    let timer = setInterval(() => {
        countdown--;
        io.emit("timer-update", countdown);
        if (countdown <= 0) {
            clearInterval(timer);
            startFlight();
        }
    }, 1000);
}

function startFlight() {
    gameState = "FLYING";
    if (FIXED_RESULT !== null) {
        crashPoint = FIXED_RESULT;
        FIXED_RESULT = null;
    } else {
        if (Math.random() < 0.15) crashPoint = 1.00;
        else {
            crashPoint = (100 / (100 * Math.random() + 1)).toFixed(2);
            if (crashPoint < 1.1) crashPoint = 1.10;
        }
    }
    io.emit("state-change", { state: "FLYING" });

    let flyInterval = setInterval(() => {
        if (gameState === "CRASHED") { clearInterval(flyInterval); return; }
        multiplier += (multiplier * 0.006) + 0.002;
        if (multiplier >= crashPoint) {
            gameState = "CRASHED";
            io.emit("crash", { multiplier: crashPoint });
            clearInterval(flyInterval);
            setTimeout(startGameLoop, 3000);
        } else {
            io.emit("tick", multiplier);
        }
    }, 50);
}

// --- 5. SOCKET LOGIC ---
io.on('connection', (socket) => {
    socket.on('login', async (username) => {
        let player = await User.findOne({ username });
        if (!player) { player = new User({ username, balance: 1000 }); await player.save(); }
        socket.emit('login-success', { username: player.username, balance: player.balance, history: player.history });
    });
    socket.on('place-bet', async (data) => {
        let player = await User.findOne({ username: data.username });
        if (player && player.balance >= data.amount) {
            player.balance -= data.amount;
            await player.save();
            socket.emit('balance-update', player.balance);
        }
    });
    socket.on('cash-out', async (data) => {
        let player = await User.findOne({ username: data.username });
        if (player) {
            player.balance += data.winAmount;
            await player.save();
            socket.emit('balance-update', player.balance);
        }
    });
    // Admin
    socket.on('admin-set-crash', (val) => { FIXED_RESULT = val; });
    socket.on('admin-get-users', async () => { const users = await User.find({}); socket.emit('admin-users-data', users); });
    socket.on('admin-add-money', async (data) => {
        let player = await User.findOne({ username: data.username });
        if(player) { player.balance += data.amount; await player.save(); }
    });

    socket.emit("welcome", { gameState, multiplier, countdown });
});

startGameLoop();

// --- 6. DYNAMIC PORT (Zaroori for Render) ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
});