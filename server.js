const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- 1. DATABASE CONNECTION ---
const DB_URI = "mongodb+srv://prakashnangalbani_db_user:Pkdiit%40123@cluster0.5465gly.mongodb.net/?appName=Cluster0";

mongoose.connect(DB_URI)
    .then(() => {
        console.log("✅ DATABASE CONNECTED!");
        loadHistoryFromDB(); // Server start hote hi purani history lao
    })
    .catch((err) => console.log("❌ DB Error:", err));

// --- 2. SCHEMAS (Models) ---
const userSchema = new mongoose.Schema({ username: String, balance: { type: Number, default: 1000 } });
const User = mongoose.model('User', userSchema);

const historySchema = new mongoose.Schema({ 
    multiplier: Number, 
    time: { type: Date, default: Date.now } 
});
const History = mongoose.model('History', historySchema);

// --- 3. GAME VARIABLES ---
let gameHistory = []; 
let gameState = "IDLE";
let multiplier = 1.00;
let crashPoint = 0;
let countdown = 8;

// Function: Database se History load karo
async function loadHistoryFromDB() {
    try {
        // Pichle 20 results nikalo (Newest first)
        const oldData = await History.find().sort({ time: -1 }).limit(20);
        gameHistory = oldData.map(d => d.multiplier); // Sirf number extract karo
        console.log("📂 Loaded History:", gameHistory);
    } catch (e) {
        console.log("History Load Error:", e);
    }
}

function startGameLoop() {
    gameState = "IDLE";
    countdown = 8;
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
    
    // Crash Logic
    if (Math.random() < 0.15) crashPoint = 1.00;
    else {
        crashPoint = (100 / (100 * Math.random() + 1)).toFixed(2);
        if (crashPoint < 1.1) crashPoint = 1.10;
    }
    
    console.log(`🚀 Flight Started! Target: ${crashPoint}x`);
    io.emit("state-change", { state: "FLYING" });

    let flyInterval = setInterval(() => {
        if (gameState === "CRASHED") { clearInterval(flyInterval); return; }
        
        multiplier += (multiplier * 0.006) + 0.002;
        
        if (multiplier >= crashPoint) {
            handleCrash(crashPoint);
            clearInterval(flyInterval);
        } else {
            io.emit("tick", multiplier);
        }
    }, 50);
}

async function handleCrash(val) {
    gameState = "CRASHED";
    console.log(`💥 Crashed at ${val}x`);
    io.emit("crash", { multiplier: val });

    // --- SAVE TO DATABASE ---
    try {
        const newRecord = new History({ multiplier: val });
        await newRecord.save(); // DB mein permanent save
        
        // RAM update
        gameHistory.unshift(val);
        if (gameHistory.length > 20) gameHistory.pop();
        
        io.emit("history-update", gameHistory);
    } catch (e) {
        console.log("❌ Error saving history:", e);
    }

    setTimeout(startGameLoop, 4000);
}

// --- SOCKET LOGIC (DEBUGGING ADDED) ---
io.on('connection', (socket) => {
    // Connect hote hi History bhejo
    socket.emit('history-update', gameHistory);
    socket.emit("welcome", { gameState, multiplier, countdown });

    socket.on('login', async (username) => {
        console.log(`👤 Login: ${username}`);
        let player = await User.findOne({ username });
        if (!player) { player = new User({ username, balance: 1000 }); await player.save(); }
        socket.emit('login-success', { username: player.username, balance: player.balance });
    });

    socket.on('place-bet', async (data) => {
        // Logging taaki pata chale bet kyun fail hui
        if(gameState !== "IDLE") {
            console.log(`⚠️ Bet Rejected for ${data.username}: Game is ${gameState} (Not IDLE)`);
            return; 
        }
        
        let player = await User.findOne({ username: data.username });
        if (player && player.balance >= data.amount) {
            player.balance -= data.amount;
            await player.save();
            console.log(`💰 Bet Accepted: ${data.username} - ₹${data.amount}`);
            socket.emit('balance-update', player.balance);
        }
    });

    socket.on('cash-out', async (data) => {
        if(gameState !== "FLYING") {
            console.log(`⚠️ Cashout Failed for ${data.username}: Plane Crashed or Not Flying`);
            return;
        }
        
        let player = await User.findOne({ username: data.username });
        if (player) {
            player.balance += data.winAmount;
            await player.save();
            console.log(`🏆 Won: ${data.username} - ₹${data.winAmount}`);
            socket.emit('balance-update', player.balance);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
    startGameLoop();
});