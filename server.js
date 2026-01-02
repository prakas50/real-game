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
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- DATABASE ---
const DB_URI = "mongodb+srv://prakashnangalbani_db_user:Pkdiit%40123@cluster0.5465gly.mongodb.net/?appName=Cluster0";
mongoose.connect(DB_URI).then(() => console.log("✅ DATABASE CONNECTED!")).catch(err => console.log("❌ DB Error:", err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// Transaction Schema (Deposit & Withdraw dono ke liye)
const transSchema = new mongoose.Schema({
    username: String,
    type: String, // 'DEPOSIT' or 'WITHDRAW'
    amount: Number,
    details: String, // UTR or UPI ID
    status: { type: String, default: "PENDING" }, // PENDING, SUCCESS, REJECTED
    date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transSchema);

const historySchema = new mongoose.Schema({ multiplier: Number, time: { type: Date, default: Date.now } });
const History = mongoose.model('History', historySchema);

// Game Vars
let gameHistory = [];
let gameState = "IDLE";
let multiplier = 1.00;
let crashPoint = 0;
let countdown = 8;

// Load History
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

io.on('connection', (socket) => {
    socket.emit('history-update', gameHistory);
    socket.emit("welcome", { gameState, multiplier, countdown });

    // AUTH
    socket.on('register', async (data) => {
        const exists = await User.findOne({ username: data.username });
        if(exists) socket.emit('auth-error', "Username taken!");
        else {
            const newUser = new User({ username: data.username, password: data.password, balance: 20 }); // 20 Signup Bonus
            await newUser.save();
            socket.emit('login-success', { username: newUser.username, balance: newUser.balance });
        }
    });

    socket.on('login', async (data) => {
        const user = await User.findOne({ username: data.username, password: data.password });
        if(user) socket.emit('login-success', { username: user.username, balance: user.balance });
        else socket.emit('auth-error', "Wrong ID/Pass!");
    });

    // GAMEPLAY
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

    // --- WALLET SYSTEM ---

    // 1. User History Fetch
    socket.on('get-transactions', async (username) => {
        const list = await Transaction.find({ username }).sort({ date: -1 }).limit(20);
        socket.emit('transaction-history', list);
    });

    // 2. Deposit Request
    socket.on('deposit-request', async (data) => {
        const t = new Transaction({ username: data.username, type: "DEPOSIT", amount: data.amount, details: data.utr });
        await t.save();
    });

    // 3. Withdraw Request
    socket.on('withdraw-request', async (data) => {
        let player = await User.findOne({ username: data.username });
        if(player && player.balance >= data.amount) {
            // Cut Balance Immediately
            player.balance -= data.amount; 
            await player.save();
            socket.emit('balance-update', player.balance);

            const t = new Transaction({ username: data.username, type: "WITHDRAW", amount: data.amount, details: data.upi });
            await t.save();
            socket.emit('withdraw-success', "Withdrawal Pending!");
        } else {
            socket.emit('withdraw-error', "Insufficient Balance!");
        }
    });

    // --- ADMIN ACTIONS ---
    socket.on('admin-get-pending', async () => {
        const list = await Transaction.find({ status: "PENDING" });
        socket.emit('admin-pending-list', list);
    });

    socket.on('admin-action', async (data) => {
        // data = { id, action: 'APPROVE' or 'REJECT' }
        const t = await Transaction.findById(data.id);
        if(!t || t.status !== "PENDING") return;

        t.status = data.action === "APPROVE" ? "SUCCESS" : "REJECTED";
        await t.save();

        const player = await User.findOne({ username: t.username });
        if(player) {
            if(t.type === "DEPOSIT" && data.action === "APPROVE") {
                player.balance += t.amount;
                await player.save();
            }
            else if(t.type === "WITHDRAW" && data.action === "REJECT") {
                // Refund money if withdraw rejected
                player.balance += t.amount;
                await player.save();
            }
            // Notify User
            io.emit('force-balance-update', { username: player.username, balance: player.balance });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`SERVER RUNNING ON PORT ${PORT}`); startGameLoop(); });