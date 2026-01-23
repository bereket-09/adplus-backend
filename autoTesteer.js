const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

/* ================= CONFIG ================= */

const BASE_URL = "http://127.0.0.1:3000/api/v1";

const TOTAL_MSISDNS = 100;
const CONCURRENCY = 50;

const WATCH_TIME_MS = {
    MIN: 15000,
    MAX: 45000
};

const TRAFFIC_PROFILE = {
    NORMAL: 0.75,
    FRAUD_FAST_COMPLETE: 0.10,
    FRAUD_REPLAY_IP: 0.10,
    FRAUD_META_MISMATCH: 0.05
};

/* ================= HTTP CLIENT ================= */

const api = axios.create({
    baseURL: BASE_URL,
    timeout: 8000,
    headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
});

/* ================= UTILS ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));

const rand = (min, max) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

const base64 = obj =>
    Buffer.from(JSON.stringify(obj)).toString("base64");

/* ================= MSISDN ================= */

function generateMsisdns(count) {
    const set = new Set();
    while (set.size < count) {
        set.add("2519" + rand(10000000, 99999999));
    }
    return [...set];
}

/* ================= META ================= */

function mobileMeta(msisdn, ip) {
    return base64({
        msisdn,
        ip,
        userAgent: "MobileExampleOS",
        device: {
            type: "mobile",
            model: "Smartphone",
            brand: "Generic",
            platform: "iOS/Android" // required by validator
        },
        screen: { width: 360, height: 740, pixelRatio: 3 },
        location: { lat: 8, lon: 34, country: "ET" }
    });
}

function desktopMeta(msisdn, ip) {
    return base64({
        msisdn,
        ip,
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/144",
        device: {
            type: "desktop",
            model: "Desktop",
            brand: "PC",
            platform: "Win32"
        },
        screen: { width: 1920, height: 1080, pixelRatio: 1 },
        location: { lat: 8, lon: 34, country: "ET" }
    });
}

/* ================= FRAUD ================= */

function pickProfile() {
    const r = Math.random();
    let acc = 0;

    for (const k in TRAFFIC_PROFILE) {
        acc += TRAFFIC_PROFILE[k];
        if (r <= acc) return k;
    }
    return "NORMAL";
}

const REPLAY_IP = "10.10.10.10";

/* ================= FLOW ================= */

async function simulate(msisdn) {
    const profile = pickProfile();

    const ip =
        profile === "FRAUD_REPLAY_IP"
            ? REPLAY_IP
            : `10.${rand(0, 255)}.${rand(0, 255)}.${rand(0, 255)}`;

    const metaFn = Math.random() > 0.5 ? mobileMeta : desktopMeta;

    /* ---- STEP 1: CREATE LINK ---- */
    const linkRes = await api.post("/link/create", { msisdn });
    const {
        token,
        secure_key: linkSecureKey,
        createdStatus
    } = linkRes.data;

    console.log(`[CREATE] ${msisdn}`, createdStatus);

    let secureKey = linkSecureKey;

    /* ---- STEP 2: GET VIDEO (ONLY IF NEEDED) ---- */
    if (!secureKey) {
        const videoMeta = metaFn(msisdn, ip);

        const videoRes = await api.get(`/video/${token}`, {
            headers: { meta_base64: videoMeta }
        });
        secureKey = videoRes.data.secure_key;
        console.log(`[VIDEO] ${msisdn} fetched secure_key`);
    } else {
        console.log(`[VIDEO] ${msisdn} skipped (existing link, secure_key available)`);
    }

    /* ---- STEP 3: START ---- */
    const startMeta = metaFn(msisdn, ip);

    const startRes = await api.post("/track/start", {
        token,
        meta: startMeta,
        secure_key: secureKey
    });

    secureKey = startRes.data.secure_key;

    /* ---- BEHAVIOR VARIANTS ---- */
    if (profile === "FRAUD_FAST_COMPLETE") {
        return api.post("/track/complete", { token, meta: startMeta, secure_key: secureKey });
    }

    if (profile === "FRAUD_META_MISMATCH") {
        await sleep(2000);
        const flippedMeta = metaFn === mobileMeta
            ? desktopMeta(msisdn, ip)
            : mobileMeta(msisdn, ip);
        return api.post("/track/complete", { token, meta: flippedMeta, secure_key: secureKey });
    }

    /* ---- NORMAL / REPLAY ---- */
    const watchTime = WATCH_TIME_MS.MIN + Math.random() * (WATCH_TIME_MS.MAX - WATCH_TIME_MS.MIN);
    await sleep(watchTime);

    return api.post("/track/complete", { token, meta: startMeta, secure_key: secureKey });
}

/* ================= RUNNER ================= */

async function run() {
    const msisdns = generateMsisdns(TOTAL_MSISDNS);
    const queue = [...msisdns];

    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length) {
            const msisdn = queue.shift();
            try {
                await simulate(msisdn);
                console.log("OK", msisdn);
            } catch (e) {
                console.error("FAIL", msisdn, e.message);
            }
        }
    });

    await Promise.all(workers);
    console.log("=== TRAFFIC SIMULATION COMPLETED ===");
}

/* ================= SCHEDULER ================= */

let isRunning = false;

async function scheduledRun() {
    if (isRunning) {
        console.log("Previous run still in progress. Skipping this interval.");
        return;
    }
    isRunning = true;
    try {
        console.log("=== Starting traffic simulation ===");
        await run();
    } finally {
        isRunning = false;
    }
}

// First run immediately
scheduledRun();

// Repeat every 30 minutes
setInterval(scheduledRun, 30 * 60 * 1000);
