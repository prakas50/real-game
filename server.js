// =========================================================
// AVIATOR ULTRA PRO MAX SERVER
// =========================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

// --- SETUP ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- ROUTES ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

// --- DATABASE CONNECTION (Aapka URL) ---
const DB_URI = "mongodb+srv://prakashnangalbani_db_user:Pkdiit%40123@cluster0.5465gly.mongodb.net/?appName=Cluster0";

mongoose.connect(DB_URI)
    .then(() => console.log("✅ MONGODB CONNECTED - SERVER READY"))
    .catch((err) => console.log("❌ DB CONNECTION ERROR:", err));

// --- MONGOOSE SCHEMAS ---

// 1. User Schema (ID, Pass, Balance)
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    created_at: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 2. Transaction Schema (Deposit/Withdraw Requests)
const transSchema = new mongoose.Schema({
    username: String,
    type: String, // 'DEPOSIT' or 'WITHDRAW'
    amount: Number,
    method_details: String, // UTR or UPI ID
    status: { type: String, default: "PENDING" }, // PENDING, APPROVED, REJECTED
    date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transSchema);

// 3. Game History Schema
const historySchema = new mongoose.Schema({ 
    multiplier: Number, 
    crashTime: String,
    date: { type: Date, default: Date.now } 
});
const History = mongoose.model('History', historySchema);

// --- GAME VARIABLES ---
let gameHistory = [];
let gameState = "IDLE"; // IDLE, FLYING, CRASHED
let multiplier = 1.00;
let crashPoint = 0;
let countdown = 10;
let nextCrashOverride = null; // Admin rigging variable

// Init History
async function init() {
    const oldDocs = await History.find().sort({ date: -1 }).limit(20);
    gameHistory = oldDocs.map(d => d.multiplier);
}
init();

// --- GAME LOOP ENGINE ---
function startGameLoop() {
    gameState = "IDLE";
    countdown = 8; // 8 Seconds waiting time
    multiplier = 1.00;

    // Notify clients
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
    
    // Determine Crash Point (Rigged or Random)
    if (nextCrashOverride) {
        crashPoint = nextCrashOverride;
        nextCrashOverride = null; // Reset rigging
        console.log(`⚠️ RIGGED ROUND: Will crash at ${crashPoint}x`);
    } else {
        // Fair Logic (Random)
        if (Math.random() < 0.20) crashPoint = 1.00; // 20% Instant loss
        else {
            crashPoint = (100 / (100 * Math.random() + 1)).toFixed(2);
            if (crashPoint < 1.1) crashPoint = 1.10;
        }
    }

    io.emit("state-change", { state: "FLYING" });

    let flyInterval = setInterval(() => {
        if (gameState === "CRASHED") { clearInterval(flyInterval); return; }

        // Increase Speed logic
        multiplier += (multiplier * 0.006) + 0.002;
        
        if (multiplier >= crashPoint) {
            handleCrash(crashPoint);
            clearInterval(flyInterval);
        } else {
            io.emit("tick", multiplier);
        }
    }, 50); // 50ms Update rate
}

async function handleCrash(val) {
    gameState = "CRASHED";
    io.emit("crash", { multiplier: val });
    
    // Save to DB
    const rec = new History({ multiplier: val, crashTime: new Date().toLocaleTimeString() });
    await rec.save();

    // Update RAM History
    gameHistory.unshift(val);
    if (gameHistory.length > 25) gameHistory.pop();
    io.emit("history-update", gameHistory);

    setTimeout(startGameLoop, 4000); // Restart after 4s
}

// --- SOCKET IO EVENTS (Communication) ---
io.on('connection', (socket) => {
    
    // 1. Initial Data
    socket.emit('history-update', gameHistory);
    socket.emit("welcome", { gameState, multiplier, countdown });

    // 2. AUTHENTICATION (Register/Login)
    socket.on('auth-register', async (data) => {
        try {
            const exists = await User.findOne({ username: data.username });
            if (exists) {
                socket.emit('auth-failed', "Username already exists!");
            } else {
                const u = new User({ username: data.username, password: data.password, balance: 50 }); // 50 Bonus
                await u.save();
                socket.emit('auth-success', { username: u.username, balance: u.balance });
            }
        } catch (e) { socket.emit('auth-failed', "Server Error"); }
    });

    socket.on('auth-login', async (data) => {
        try {
            const u = await User.findOne({ username: data.username, password: data.password });
            if (u) socket.emit('auth-success', { username: u.username, balance: u.balance });
            else socket.emit('auth-failed', "Invalid Credentials!");
        } catch (e) { socket.emit('auth-failed', "Server Error"); }
    });

    // 3. GAMEPLAY (Bet & Cashout)
    socket.on('place-bet', async (data) => {
        if (gameState !== "IDLE") return;
        const u = await User.findOne({ username: data.username });
        if (u && u.balance >= data.amount) {
            u.balance -= data.amount;
            await u.save();
            socket.emit('balance-update', u.balance); // Send new balance
        }
    });

    socket.on('cash-out', async (data) => {
        if (gameState !== "FLYING") return;
        const u = await User.findOne({ username: data.username });
        if (u) {
            u.balance += data.winAmount;
            await u.save();
            socket.emit('balance-update', u.balance);
        }
    });

    // 4. WALLET TRANSACTIONS (Deposit/Withdraw)
    socket.on('req-deposit', async (data) => {
        const t = new Transaction({ 
            username: data.username, type: "DEPOSIT", amount: data.amount, method_details: data.utr 
        });
        await t.save();
    });

    socket.on('req-withdraw', async (data) => {
        const u = await User.findOne({ username: data.username });
        if(u && u.balance >= data.amount) {
            u.balance -= data.amount; // Deduct immediately
            await u.save();
            socket.emit('balance-update', u.balance);
            
            const t = new Transaction({ 
                username: data.username, type: "WITHDRAW", amount: data.amount, method_details: data.upi 
            });
            await t.save();
            socket.emit('msg', "Withdraw Request Pending!");
        } else {
            socket.emit('msg', "Insufficient Balance!");
        }
    });

    socket.on('get-my-history', async (username) => {
        const list = await Transaction.find({ username }).sort({ date: -1 }).limit(15);
        socket.emit('user-history-data', list);
    });

    // 5. ADMIN ACTIONS
    socket.on('admin-data-req', async () => {
        const pending = await Transaction.find({ status: "PENDING" });
        socket.emit('admin-pending-res', pending);
    });

    socket.on('admin-transact', async (data) => {
        // data: { id, action: 'APPROVE'/'REJECT' }
        const t = await Transaction.findById(data.id);
        if(!t || t.status !== "PENDING") return;

        t.status = data.action;
        await t.save();

        const u = await User.findOne({ username: t.username });
        if (u) {
            if (t.type === "DEPOSIT" && data.action === "APPROVE") {
                u.balance += t.amount;
                await u.save();
            } else if (t.type === "WITHDRAW" && data.action === "REJECT") {
                u.balance += t.amount; // Refund
                await u.save();
            }
            // Notify user if online
            io.emit('force-balance', { username: u.username, balance: u.balance });
        }
    });

    socket.on('admin-rig-game', (val) => {
        nextCrashOverride = parseFloat(val);
        console.log("Next Round Fixed By Admin:", val);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
    startGameLoop();
});