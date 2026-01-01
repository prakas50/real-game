const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(__dirname)); // HTML files serve karne ke liye

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- DATABASE CONNECTION ---
// Aapka DB URL
const DB_URI = "mongodb+srv://prakashnangalbani_db_user:Pkdiit%40123@cluster0.5465gly.mongodb.net/?appName=Cluster0";

mongoose.connect(DB_URI)
    .then(() => console.log("✅ DATABASE CONNECTED!"))
    .catch((err) => console.log("❌ DB Error:", err));

const userSchema = new mongoose.Schema({ username: String, balance: { type: Number, default: 1000 } });
const User = mongoose.model('User', userSchema);

// --- GAME VARIABLES ---
let gameHistory = []; // History yahan save hogi (RAM mein)
let gameState = "IDLE";
let multiplier = 1.00;
let crashPoint = 0;
let countdown = 10; // 10 second ka gap betting ke liye

function startGameLoop() {
    gameState = "IDLE";
    countdown = 8; // Next round wait time
    multiplier = 1.00;
    
    // Sabko batao ki betting shuru karo
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
    
    // Crash Point Decide karo
    if (Math.random() < 0.15) crashPoint = 1.00; // Instant crash chance
    else {
        crashPoint = (100 / (100 * Math.random() + 1)).toFixed(2);
        if (crashPoint < 1.1) crashPoint = 1.10;
    }
    
    io.emit("state-change", { state: "FLYING" });

    let flyInterval = setInterval(() => {
        if (gameState === "CRASHED") { clearInterval(flyInterval); return; }
        
        multiplier += (multiplier * 0.006) + 0.002; // Speed badhao
        
        if (multiplier >= crashPoint) {
            handleCrash(crashPoint);
            clearInterval(flyInterval);
        } else {
            io.emit("tick", multiplier);
        }
    }, 50); // Har 50ms mein update
}

function handleCrash(val) {
    gameState = "CRASHED";
    io.emit("crash", { multiplier: val });

    // --- HISTORY UPDATE ---
    gameHistory.unshift(val); // List ke start mein jodo
    if (gameHistory.length > 25) gameHistory.pop(); // Sirf last 25 rakho
    io.emit("history-update", gameHistory); // Mobile ko bhejo

    setTimeout(startGameLoop, 4000); // 4 second baad naya round
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    // Jaise hi koi connect ho, use History aur current State bhejo
    socket.emit('history-update', gameHistory);
    socket.emit("welcome", { gameState, multiplier, countdown });

    socket.on('login', async (username) => {
        let player = await User.findOne({ username });
        if (!player) { player = new User({ username, balance: 1000 }); await player.save(); }
        socket.emit('login-success', { username: player.username, balance: player.balance });
    });

    socket.on('place-bet', async (data) => {
        if(gameState !== "IDLE") return; // Sirf IDLE time mein bet lagegi
        
        let player = await User.findOne({ username: data.username });
        if (player && player.balance >= data.amount) {
            player.balance -= data.amount;
            await player.save();
            socket.emit('balance-update', player.balance);
        }
    });

    socket.on('cash-out', async (data) => {
        if(gameState !== "FLYING") return; // Sirf udte hue cashout hoga
        
        let player = await User.findOne({ username: data.username });
        if (player) {
            player.balance += data.winAmount;
            await player.save();
            socket.emit('balance-update', player.balance);
        }
    });
});

// Server Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
    startGameLoop(); // Game shuru karo
});