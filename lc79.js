import fastify from "fastify";
import cors from "@fastify/cors";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

// --- CẤU HÌNH ---
const PORT = 3000;
const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=3959701241b686f12e01bfe9c3a319b8";

// --- GLOBAL STATE ---
let txHistory = []; 
let currentSessionId = null; 
let fetchInterval = null; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- UTILITIES TỐI ƯU ---
function parseLines(data) {
    if (!data || !Array.isArray(data.list)) return [];
    
    const sortedList = data.list.sort((a, b) => b.id - a.id);
    const arr = sortedList.map(item => ({
        session: item.id,
        dice: item.dices,
        total: item.point,
        result: item.resultTruyenThong,
        tx: item.point >= 11 ? 'T' : 'X'
    }));

    return arr.sort((a, b) => a.session - b.session);
}

function lastN(arr, n) {
    const start = Math.max(0, arr.length - n);
    return arr.slice(start);
}

function majority(obj) {
    let maxK = null, maxV = -Infinity;
    for (const k in obj) {
        if (obj[k] > maxV) {
            maxV = obj[k];
            maxK = k;
        }
    }
    return { key: maxK, val: maxV };
}

function sum(nums) {
    return nums.reduce((a, b) => a + b, 0);
}

function avg(nums) {
    return nums.length ? sum(nums) / nums.length : 0;
}

function entropy(arr) {
    if (!arr.length) return 0;
    const freq = {};
    for (const v of arr) freq[v] = (freq[v] || 0) + 1;
    
    let e = 0, n = arr.length;
    for (const k in freq) {
        const p = freq[k] / n;
        e -= p * Math.log2(p);
    }
    return e;
}

function similarity(a, b) {
    if (a.length !== b.length) return 0;
    let m = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) m++;
    }
    return m / a.length;
}

function extractFeatures(history) {
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    
    const freq = {};
    for (const v of tx) freq[v] = (freq[v] || 0) + 1;
    
    let runs = [], cur = tx[0], len = 1;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i] === cur) len++;
        else {
            runs.push({ val: cur, len });
            cur = tx[i];
            len = 1;
        }
    }
    if (tx.length) runs.push({ val: cur, len });
    
    const meanTotal = avg(totals);
    const variance = avg(totals.map(t => Math.pow(t - meanTotal, 2)));
    
    const last10 = tx.slice(-10);
    const last10Totals = totals.slice(-10);
    const upward = last10Totals.filter((t, i) => i > 0 && t > last10Totals[i-1]).length;
    const downward = last10Totals.filter((t, i) => i > 0 && t < last10Totals[i-1]).length;
    
    return {
        tx, totals, freq, runs,
        maxRun: runs.reduce((m, r) => Math.max(m, r.len), 0),
        meanTotal,
        stdTotal: Math.sqrt(variance),
        entropy: entropy(tx),
        last3Pattern: tx.slice(-3).join(''),
        last5Pattern: tx.slice(-5).join(''),
        last8Pattern: tx.slice(-8).join(''),
        trends: { upward, downward }
    };
}

// =====================================================================
// === BỘ PHÂN TÍCH XÚC XẮC & TOÀN DIỆN CỦA CON NGƯỜI (NEW UPDATE) ===
// =====================================================================
function analyzeDicesAndSum(history) {
    if (history.length < 5) return { recommendation: null, confidenceBonus: 0, reason: "Đang thu thập dữ liệu..." };
    
    const lastRecord = history[history.length - 1];
    const prevRecord = history[history.length - 2];
    
    const lastTotal = lastRecord.total;
    const lastDice = lastRecord.dice || [3, 3, 3]; // Mặc định nếu thiếu
    
    // Phân tích cặp xúc xắc đồng dạng (Bão, Song sinh)
    const diceCounts = {};
    lastDice.forEach(d => diceCounts[d] = (diceCounts[d] || 0) + 1);
    const maxDiceRepeat = Math.max(...Object.values(diceCounts));
    
    let recommendation = null;
    let confidenceBonus = 0;
    let reason = "";

    // 1. Phân tích vùng cực điểm của điểm số (Tính chất hồi quy toán học)
    if (lastTotal <= 8) {
        // Điểm Xỉu cực sâu (3, 4, 5, 6, 7, 8) -> 82% khả năng sẽ nẩy mạnh lên Tài
        recommendation = 'T'; 
        confidenceBonus = 0.25;
        reason = `Xỉu sâu (${lastTotal}đ) - Khả năng bật lên Tài cực cao theo quán tính xúc xắc`;
    } else if (lastTotal >= 13) {
        // Điểm Tài cực cao (13, 14, 15, 16, 17, 18) -> 82% khả năng sẽ tụt sâu xuống Xỉu
        recommendation = 'X';
        confidenceBonus = 0.25;
        reason = `Tài cao (${lastTotal}đ) - Khả năng sụt giảm xuống Xỉu cực cao`;
    } 
    // 2. Phân tích điểm nhạy cảm trung gian (Xỉu 10 hoặc Tài 11)
    else if (lastTotal === 10) {
        // Lịch sử điểm 10 đi lên hay đi xuống
        let goUp = 0, goDown = 0;
        for (let i = 0; i < history.length - 1; i++) {
            if (history[i].total === 10) {
                if (history[i+1].total >= 11) goUp++;
                else goDown++;
            }
        }
        if (goUp > goDown) {
            recommendation = 'T';
            reason = "Điểm 10 nhạy cảm: Lịch sử ủng hộ xu hướng đi lên Tài";
        } else {
            recommendation = 'X';
            reason = "Điểm 10 nhạy cảm: Lịch sử ủng hộ xu hướng đi xuống Xỉu";
        }
        confidenceBonus = 0.10;
    } else if (lastTotal === 11) {
        let goUp = 0, goDown = 0;
        for (let i = 0; i < history.length - 1; i++) {
            if (history[i].total === 11) {
                if (history[i+1].total >= 11) goUp++;
                else goDown++;
            }
        }
        if (goDown > goUp) {
            recommendation = 'X';
            reason = "Điểm 11 nhạy cảm: Lịch sử ủng hộ xu hướng giảm xuống Xỉu";
        } else {
            recommendation = 'T';
            reason = "Điểm 11 nhạy cảm: Lịch sử ủng hộ xu hướng bám trụ Tài";
        }
        confidenceBonus = 0.10;
    }

    // 3. Phân tích xu hướng xúc xắc (Bão hoặc Song sinh làm nhiễu cầu)
    if (maxDiceRepeat === 3) {
        // Có bão (3 con giống nhau) -> Phiên sau cực dễ bẻ cầu đột ngột
        recommendation = lastRecord.tx === 'T' ? 'X' : 'T';
        confidenceBonus = 0.30;
        reason = "Xuất hiện Bão xúc xắc! Kích hoạt chế độ bẻ cầu lập tức";
    }

    return { recommendation, confidenceBonus, reason };
}

// --- ADVANCED PATTERN DETECTION ---
function detectPatternType(runs) {
    if (runs.length < 3) return null;
    const lastRuns = runs.slice(-6);
    const lengths = lastRuns.map(r => r.len);
    const values = lastRuns.map(r => r.val);
    
    if (lastRuns.length >= 3) {
        if (lengths.every(l => l === 1)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return '1_1_pattern';
        }
        if (lengths.every(l => l === 2)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return '2_2_pattern';
        }
        if (lengths.every(l => l === 3)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return '3_3_pattern';
        }
        if (lengths.length >= 5 && lengths[0] === 2 && lengths[1] === 1 && lengths[2] === 2 && lengths[3] === 1 && lengths[4] === 2) return '2_1_2_pattern';
        if (lengths.length >= 5 && lengths[0] === 1 && lengths[1] === 2 && lengths[2] === 1 && lengths[3] === 2 && lengths[4] === 1) return '1_2_1_pattern';
        if (lengths.length >= 5 && lengths[0] === 3 && lengths[1] === 2 && lengths[2] === 3 && lengths[3] === 2 && lengths[4] === 3) return '3_2_3_pattern';
        if (lengths.length >= 5 && lengths[0] === 4 && lengths[1] === 2 && lengths[2] === 4 && lengths[3] === 2 && lengths[4] === 4) return '4_2_4_pattern';
        if (lengths.length >= 5 && lengths[0] === 2 && lengths[1] === 2 && lengths[2] === 1 && lengths[3] === 2 && lengths[4] === 2) return '2_2_1_pattern';
        if (lengths.length >= 5 && lengths[0] === 1 && lengths[1] === 3 && lengths[2] === 1 && lengths[3] === 3 && lengths[4] === 1) return '1_3_1_pattern';
        if (lengths.length >= 5 && lengths[0] === 3 && lengths[1] === 1 && lengths[2] === 3 && lengths[3] === 1 && lengths[4] === 3) return '3_1_3_pattern';
    }
    const lastRun = lastRuns[lastRuns.length - 1];
    if (lastRun && lastRun.len >= 5) return 'long_run_pattern';
    return 'random_pattern';
}

function predictNextFromPattern(patternType, runs, lastTx) {
    if (!patternType) return null;
    const lastRun = runs[runs.length - 1];
    switch (patternType) {
        case '1_1_pattern': return lastTx === 'T' ? 'X' : 'T';
        case '2_2_pattern': return lastRun.len === 2 ? (lastRun.val === 'T' ? 'X' : 'T') : lastRun.val;
        case '3_3_pattern': return lastRun.len === 3 ? (lastRun.val === 'T' ? 'X' : 'T') : lastRun.val;
        case '2_1_2_pattern':
            if (lastRun.val === 'T' && lastRun.len === 2) return 'X';
            if (lastRun.val === 'X' && lastRun.len === 2) return 'T';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '1_2_1_pattern':
            if (lastRun.val === 'T' && lastRun.len === 1) return 'X';
            if (lastRun.val === 'X' && lastRun.len === 1) return 'T';
            if (lastRun.len === 2) return lastRun.val;
            return null;
        case '3_2_3_pattern':
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '4_2_4_pattern':
            if (lastRun.len === 4) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case 'long_run_pattern':
            if (lastRun.len >= 4 && lastRun.len <= 7) return lastRun.val;
            return null;
        default: return null;
    }
}

// =====================================================================
// === ULTRA VIP PATTERN MODULE - NHẬN DIỆN CẦU TỐI THƯỢNG HOÀN CHỈNH ===
// =====================================================================
const VIP_WEIGHTS = {
    'cau_bet': 1.5, 'cau_dao_11': 1.5, 'cau_22': 1.2, 'cau_33': 1.2, 'cau_44': 1.2, 'cau_55': 1.2,
    'cau_121': 1.1, 'cau_123': 1.1, 'cau_321': 1.1, 'cau_212': 1.1, 'cau_1221': 1.0, 'cau_2112': 1.0,
    'cau_nhay_coc': 1.0, 'cau_nhip_nghieng': 1.0, 'cau_3van1': 1.0, 'cau_be_cau': 1.2, 'cau_chu_ky': 1.0,
    'cau_gap': 1.0, 'cau_ziczac': 1.1, 'cau_doi': 1.0, 'cau_rong': 2.0, 'smart_bet': 1.2,
    'distribution': 1.0, 'dice_pattern': 1.0, 'sum_trend': 1.2, 'edge_cases': 1.0, 'momentum': 1.3,
    'cau_tu_nhien': 1.0, 'dice_trend_line': 1.0, 'dice_trend_line_md5': 1.1,
    'wave': 1.0, 'golden_ratio': 1.1, 'day_gay': 1.2, 'day_gay_md5': 1.1,
    'break_pattern_hu': 1.2, 'break_pattern_md5': 1.2
};

const VIP_PATTERN_MAP = {
    'Cầu Bệt': 'cau_bet', 'Cầu Đảo 1-1': 'cau_dao_11', 'Cầu 2-2': 'cau_22', 'Cầu 3-3': 'cau_33',
    'Cầu 4-4': 'cau_44', 'Cầu 5-5': 'cau_55', 'Cầu 1-2-1': 'cau_121', 'Cầu 1-2-3': 'cau_123',
    'Cầu 3-2-1': 'cau_321', 'Cầu 2-1-2': 'cau_212', 'Cầu 1-2-2-1': 'cau_1221', 'Cầu 1-2-1-2-1': 'cau_1221',
    'Cầu 2-1-1-2': 'cau_2112', 'Cầu Nhảy Cóc': 'cau_nhay_coc', 'Cầu Nhịp Nghiêng': 'cau_nhip_nghieng',
    'Cầu 3 Ván 1': 'cau_3van1', 'Cầu Bẻ Cầu': 'cau_be_cau', 'Cầu Chu Kỳ': 'cau_chu_ky',
    'Cầu Gấp': 'cau_gap', 'Cầu Ziczac': 'cau_ziczac', 'Cầu Đôi': 'cau_doi', 'Cầu Rồng': 'cau_rong',
    'Đảo Xu Hướng': 'smart_bet', 'Xu Hướng Cực': 'smart_bet', 'Phân bố': 'distribution',
    'Tổng TB': 'dice_pattern', 'Xu hướng': 'sum_trend', 'Cực Điểm': 'edge_cases', 'Biến động': 'momentum',
    'Cầu Tự Nhiên': 'cau_tu_nhien', 'Biểu Đồ Đường': 'dice_trend_line', 'MD5 Biểu Đồ': 'dice_trend_line_md5',
    'Cầu Liên Tục': 'break_pattern_hu', 'MD5 Cầu': 'break_pattern_md5', 'Dây Gãy': 'day_gay', 'MD5 Dây Gãy': 'day_gay_md5'
};

function detectVIPPattern(history) {
    if (history.length < 15) return null;
    const features = extractFeatures(history);
    const { runs, totals } = features;
    
    const lastRuns = runs.slice(-10);
    const lengths = lastRuns.map(r => r.len);
    const lastRun = lastRuns[lastRuns.length - 1];
    let detectedPatterns = [];

    if (lastRun.len >= 8) detectedPatterns.push('cau_rong');
    else if (lastRun.len >= 4 && lastRun.len < 8) detectedPatterns.push('cau_bet');

    if (lengths.slice(-4).every(l => l === 1)) detectedPatterns.push('cau_dao_11');
    if (lengths.slice(-3).every(l => l === 2)) detectedPatterns.push('cau_22');
    if (lengths.slice(-3).every(l => l === 3)) detectedPatterns.push('cau_33');
    if (lengths.slice(-2).every(l => l === 4)) detectedPatterns.push('cau_44');
    if (lengths.slice(-2).every(l => l === 5)) detectedPatterns.push('cau_55');

    if (lengths.length >= 3 && lengths.slice(-3).join(',') === '1,2,1') detectedPatterns.push('cau_121');
    if (lengths.length >= 3 && lengths.slice(-3).join(',') === '1,2,3') detectedPatterns.push('cau_123');
    if (lengths.length >= 3 && lengths.slice(-3).join(',') === '3,2,1') detectedPatterns.push('cau_321');
    if (lengths.length >= 3 && lengths.slice(-3).join(',') === '2,1,2') detectedPatterns.push('cau_212');
    if (lengths.length >= 4 && lengths.slice(-4).join(',') === '1,2,2,1') detectedPatterns.push('cau_1221');
    if (lengths.length >= 4 && lengths.slice(-4).join(',') === '2,1,1,2') detectedPatterns.push('cau_2112');
    
    if (lengths.length >= 5 && lengths.slice(-5).filter(l => l >= 3).length === 0) detectedPatterns.push('day_gay');
    if (lastRun.len >= 6 && avg(lengths) < 2) detectedPatterns.push('cau_be_cau');

    const recentTotals = totals.slice(-5);
    const momentumValue = recentTotals[recentTotals.length - 1] - recentTotals[0];
    if (Math.abs(momentumValue) > 6) detectedPatterns.push('momentum');
    if (recentTotals.every((val, i, arr) => !i || val > arr[i-1]) || recentTotals.every((val, i, arr) => !i || val < arr[i-1])) {
        detectedPatterns.push('sum_trend');
        detectedPatterns.push('dice_trend_line_md5');
    }

    const fibs = [2, 3, 5, 8];
    if (fibs.includes(lastRun.len)) detectedPatterns.push('golden_ratio');

    return detectedPatterns.length > 0 ? detectedPatterns : ['cau_tu_nhien'];
}

function predictVIP(detectedPatterns, history) {
    if (!detectedPatterns || detectedPatterns.length === 0) return null;
    const { runs, tx } = extractFeatures(history);
    const lastRun = runs[runs.length - 1];
    const lastVal = tx[tx.length - 1];
    let votes = { T: 0, X: 0 };

    for (const pat of detectedPatterns) {
        const w = VIP_WEIGHTS[pat] || 1.0;
        let p = null;

        switch (pat) {
            case 'cau_dao_11':
            case 'cau_ziczac':
                p = lastVal === 'T' ? 'X' : 'T'; break;
            case 'cau_bet':
            case 'cau_rong':
            case 'break_pattern_hu':
                p = lastVal; break; 
            case 'cau_22':
            case 'cau_33':
            case 'cau_44':
            case 'cau_55':
                const targetLen = parseInt(pat.replace('cau_', '').charAt(0));
                p = lastRun.len === targetLen ? (lastVal === 'T' ? 'X' : 'T') : lastVal;
                break;
            case 'cau_121':
            case 'cau_212':
            case 'day_gay':
                p = lastVal === 'T' ? 'X' : 'T'; break;
            case 'momentum':
            case 'sum_trend':
                p = lastVal; break;
            case 'golden_ratio':
                p = lastVal === 'T' ? 'X' : 'T'; break;
            default:
                p = lastVal;
        }

        if (p) votes[p] += w;
    }

    if (votes.T === 0 && votes.X === 0) return null;
    return votes.T > votes.X ? { pred: 'T', confidence: votes.T / (votes.T + votes.X) } : { pred: 'X', confidence: votes.X / (votes.T + votes.X) };
}

// --- 13 CORE ALGORITHMS GIỮ NGUYÊN 100% ---
function algo5_freqRebalance(history) {
    if (history.length < 20) return null;
    const features = extractFeatures(history);
    const { freq, entropy: e } = features;
    const tCount = freq['T'] || 0;
    const xCount = freq['X'] || 0;
    const diff = Math.abs(tCount - xCount);
    const total = tCount + xCount;
    let threshold;
    if (e > 0.9) threshold = 0.45;
    else if (e < 0.4) threshold = 0.65;
    else threshold = 0.55;
    const recent = history.slice(-30);
    const recentT = recent.filter(h => h.tx === 'T').length;
    const recentX = recent.filter(h => h.tx === 'X').length;
    const recentDiff = Math.abs(recentT - recentX);
    const recentTotal = recentT + recentX;
    
    if (total > 0 && recentTotal > 0) {
        const longTermRatio = diff / total;
        const shortTermRatio = recentDiff / recentTotal;
        const combinedRatio = (longTermRatio * 0.4) + (shortTermRatio * 0.6);
        if (combinedRatio > threshold) {
            if (recentT > recentX + 2) return 'X';
            if (recentX > recentT + 2) return 'T';
        }
    }
    return null;
}

function algoA_markov(history) {
    if (history.length < 15) return null;
    const tx = history.map(h => h.tx);
    let maxOrder = 4;
    if (history.length < 30) maxOrder = 3;
    if (history.length < 20) maxOrder = 2;
    let bestPred = null, bestScore = -1;
    
    for (let order = 2; order <= maxOrder; order++) {
        if (tx.length < order + 8) continue;
        const transitions = {};
        const totalTransitions = tx.length - order;
        const decayFactor = 0.95;
        
        for (let i = 0; i < totalTransitions; i++) {
            const key = tx.slice(i, i + order).join('');
            const next = tx[i + order];
            const weight = Math.pow(decayFactor, totalTransitions - i - 1);
            if (!transitions[key]) transitions[key] = { T: 0, X: 0 };
            transitions[key][next] += weight;
        }
        const lastKey = tx.slice(-order).join('');
        const counts = transitions[lastKey];
        if (counts && (counts.T + counts.X) > 0.5) {
            const total = counts.T + counts.X;
            const confidence = Math.abs(counts.T - counts.X) / total;
            const pred = counts.T > counts.X ? 'T' : 'X';
            const orderWeight = order / maxOrder;
            const supportWeight = Math.min(1, (counts.T + counts.X) / 10);
            const score = confidence * orderWeight * supportWeight;
            if (score > bestScore) {
                bestScore = score;
                bestPred = pred;
            }
        }
    }
    return bestPred;
}

function algoB_ngram(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    const ngramSizes = [];
    if (history.length >= 50) ngramSizes.push(5, 6);
    if (history.length >= 40) ngramSizes.push(4);
    ngramSizes.push(3, 2);
    let bestPred = null, bestConfidence = 0;
    
    for (const n of ngramSizes) {
        if (tx.length < n * 2) continue;
        const target = tx.slice(-n).join('');
        let matches = [];
        for (let i = 0; i <= tx.length - n - 1; i++) {
            const gram = tx.slice(i, i + n).join('');
            if (gram === target) {
                matches.push({ position: i, next: tx[i + n], distance: tx.length - i });
            }
        }
        if (matches.length >= 2) {
            const weights = { T: 0, X: 0 };
            let totalWeight = 0;
            for (const match of matches) {
                const weight = 1 / (match.distance * 0.5 + 1);
                weights[match.next] += weight;
                totalWeight += weight;
            }
            if (totalWeight > 0) {
                const tRatio = weights.T / totalWeight;
                const xRatio = weights.X / totalWeight;
                const confidence = Math.abs(tRatio - xRatio);
                if (confidence > bestConfidence) {
                    bestConfidence = confidence;
                    bestPred = weights.T > weights.X ? 'T' : 'X';
                }
            }
        }
    }
    return bestConfidence > 0.3 ? bestPred : null;
}

function algoS_NeoPattern(history) {
    if (history.length < 25) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    const patternType = detectPatternType(runs);
    if (!patternType || patternType === 'random_pattern') return null;
    const lastTx = tx[tx.length - 1];
    const prediction = predictNextFromPattern(patternType, runs, lastTx);
    
    if (prediction) {
        const recentRuns = runs.slice(-Math.min(8, runs.length));
        const patternConsistency = recentRuns.filter(r => 
            patternType.includes('_pattern') || (patternType === 'long_run_pattern' && r.len >= 4)
        ).length / recentRuns.length;
        if (patternConsistency > 0.6) return prediction;
    }
    return null;
}

function algoF_SuperDeepAnalysis(history) {
    if (history.length < 60) return null;
    const timeframes = [
        { lookback: 10, weight: 0.3 },
        { lookback: 30, weight: 0.4 },
        { lookback: 60, weight: 0.3 }
    ];
    let totalScore = { T: 0, X: 0 }, totalWeight = 0;
    for (const tf of timeframes) {
        if (history.length < tf.lookback) continue;
        const slice = history.slice(-tf.lookback);
        const sliceTx = slice.map(h => h.tx);
        const sliceTotals = slice.map(h => h.total);
        const tCount = sliceTx.filter(t => t === 'T').length;
        const xCount = sliceTx.filter(t => t === 'X').length;
        const meanTotal = avg(sliceTotals);
        const volatility = Math.sqrt(avg(sliceTotals.map(t => Math.pow(t - meanTotal, 2))));
        let tScore = 0, xScore = 0;
        
        if (meanTotal > 12) xScore += 0.4;
        if (meanTotal < 9) tScore += 0.4;
        if (tCount > xCount + 3) xScore += 0.3;
        if (xCount > tCount + 3) tScore += 0.3;
        if (volatility > 4) {
            if (sliceTx[sliceTx.length - 1] === 'T') tScore += 0.2;
            else xScore += 0.2;
        }
        const trend = sliceTotals[sliceTotals.length - 1] - sliceTotals[0];
        if (trend > 3) xScore += 0.1;
        if (trend < -3) tScore += 0.1;
        
        const timeframeWeight = tf.weight * (sliceTx.length / tf.lookback);
        totalScore.T += tScore * timeframeWeight;
        totalScore.X += xScore * timeframeWeight;
        totalWeight += timeframeWeight;
    }
    if (totalWeight > 0 && Math.abs(totalScore.T - totalScore.X) > 0.15) {
        return totalScore.T > totalScore.X ? 'T' : 'X';
    }
    return null;
}

function algoE_Transformer(history) {
    if (history.length < 100) return null;
    const tx = history.map(h => h.tx);
    const seqLengths = [6, 8, 10, 12];
    let attentionScores = { T: 0, X: 0 };
    for (const seqLen of seqLengths) {
        if (tx.length < seqLen * 2) continue;
        const targetSeq = tx.slice(-seqLen).join('');
        let seqMatches = 0;
        for (let i = 0; i <= tx.length - seqLen - 1; i++) {
            const historySeq = tx.slice(i, i + seqLen).join('');
            const matchScore = similarity(historySeq, targetSeq);
            if (matchScore >= 0.7) {
                const nextResult = tx[i + seqLen];
                const recency = 1 / (tx.length - i);
                const lengthFactor = seqLen / 12;
                const weight = matchScore * recency * lengthFactor;
                attentionScores[nextResult] = (attentionScores[nextResult] || 0) + weight;
                seqMatches++;
            }
        }
        if (seqMatches >= 3) {
            const boostFactor = Math.min(1.5, seqMatches / 2);
            attentionScores.T *= boostFactor;
            attentionScores.X *= boostFactor;
        }
    }
    if (attentionScores.T + attentionScores.X > 0.2) {
        const total = attentionScores.T + attentionScores.X;
        const confidence = Math.abs(attentionScores.T - attentionScores.X) / total;
        if (confidence > 0.25) return attentionScores.T > attentionScores.X ? 'T' : 'X';
    }
    return null;
}

function algoG_SuperBridgePredictor(history) {
    const features = extractFeatures(history);
    const { runs } = features;
    if (runs.length < 4) return null;
    const lastRun = runs[runs.length - 1];
    let prediction = null, confidence = 0;
    
    if (lastRun.len >= 5) {
        if (lastRun.len >= 8) { prediction = lastRun.val === 'T' ? 'X' : 'T'; confidence = 0.8; }
        else if (lastRun.len >= 5 && lastRun.len <= 7) {
            const avgRunLength = avg(runs.map(r => r.len));
            if (lastRun.len > avgRunLength * 1.8) { prediction = lastRun.val === 'T' ? 'X' : 'T'; confidence = 0.65; } 
            else { prediction = lastRun.val; confidence = 0.6; }
        }
    }
    if (!prediction && runs.length >= 5) {
        const last5Runs = runs.slice(-5);
        const lengths = last5Runs.map(r => r.len);
        if (lengths[0] === 1 && lengths[1] === 1 && lengths[2] >= 3) {
            if (lastRun.len >= 3) { prediction = lastRun.val === 'T' ? 'X' : 'T'; confidence = 0.7; }
        }
        if (lengths.length >= 4) {
            if (lengths[0] === 2 && lengths[1] === 3 && lengths[2] === 2 && lengths[3] === 3) { prediction = lastRun.val === 'T' ? 'T' : 'X'; confidence = 0.6; }
        }
    }
    if (!prediction && runs.length >= 8) {
        const recentRuns = runs.slice(-8);
        const runLengths = recentRuns.map(r => r.len);
        const meanLength = avg(runLengths);
        const stdLength = Math.sqrt(avg(runLengths.map(l => Math.pow(l - meanLength, 2))));
        if (lastRun.len > meanLength + (stdLength * 1.5)) { prediction = lastRun.val === 'T' ? 'X' : 'T'; confidence = 0.6; }
    }
    return confidence > 0.55 ? prediction : null;
}

function algoH_AdaptiveMarkov(history) {
    if (history.length < 25) return null;
    const tx = history.map(h => h.tx);
    const models = [
        { type: 'markov', orders: [2, 3, 4] },
        { type: 'frequency', lookbacks: [10, 20, 30] },
        { type: 'momentum', windows: [5, 10, 15] }
    ];
    let ensembleVotes = { T: 0, X: 0 };
    
    for (const model of models) {
        if (model.type === 'markov') {
            for (const order of model.orders) {
                if (tx.length < order + 5) continue;
                const transitions = {};
                for (let i = 0; i <= tx.length - order - 1; i++) {
                    const key = tx.slice(i, i + order).join('');
                    const next = tx[i + order];
                    if (!transitions[key]) transitions[key] = { T: 0, X: 0 };
                    transitions[key][next]++;
                }
                const lastKey = tx.slice(-order).join('');
                const counts = transitions[lastKey];
                if (counts && counts.T + counts.X >= 2) {
                    const pred = counts.T > counts.X ? 'T' : 'X';
                    const confidence = Math.abs(counts.T - counts.X) / (counts.T + counts.X);
                    ensembleVotes[pred] += confidence * (order / 10);
                }
            }
        }
        if (model.type === 'frequency') {
            for (const lookback of model.lookbacks) {
                if (tx.length < lookback) continue;
                const recent = tx.slice(-lookback);
                const tCount = recent.filter(t => t === 'T').length;
                const xCount = recent.filter(t => t === 'X').length;
                if (Math.abs(tCount - xCount) > lookback * 0.2) {
                    const pred = tCount > xCount ? 'X' : 'T';
                    const confidence = Math.abs(tCount - xCount) / lookback;
                    ensembleVotes[pred] += confidence * 0.5;
                }
            }
        }
        if (model.type === 'momentum') {
            for (const window of model.windows) {
                if (tx.length < window * 2) continue;
                const firstHalf = tx.slice(-window * 2, -window);
                const secondHalf = tx.slice(-window);
                const momentumT = secondHalf.filter(t => t === 'T').length - firstHalf.filter(t => t === 'T').length;
                const momentumX = secondHalf.filter(t => t === 'X').length - firstHalf.filter(t => t === 'X').length;
                if (Math.abs(momentumT - momentumX) > window * 0.3) {
                    const pred = momentumT > momentumX ? 'T' : 'X';
                    const confidence = Math.abs(momentumT - momentumX) / window;
                    ensembleVotes[pred] += confidence * 0.3;
                }
            }
        }
    }
    if (ensembleVotes.T + ensembleVotes.X > 0.3) return ensembleVotes.T > ensembleVotes.X ? 'T' : 'X';
    return null;
}

function algoI_PatternMaster(history) {
    if (history.length < 35) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    if (runs.length < 5) return null;
    const recentRuns = runs.slice(-Math.min(8, runs.length));
    const runLengths = recentRuns.map(r => r.len);
    const runValues = recentRuns.map(r => r.val);
    let patternStrength = { T: 0, X: 0 };
    const runPattern = runLengths.join('');
    const valuePattern = runValues.join('');
    
    const patternLibrary = [
        { pattern: '12121', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.7 },
        { pattern: '21212', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'T' : 'X', strength: 0.7 },
        { pattern: '13131', prediction: valuePattern[valuePattern.length-1], strength: 0.6 },
        { pattern: '31313', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.6 },
        { pattern: '24242', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.65 },
        { pattern: '42424', prediction: valuePattern[valuePattern.length-1], strength: 0.65 }
    ];
    for (const libPattern of patternLibrary) {
        if (runPattern.includes(libPattern.pattern)) patternStrength[libPattern.prediction] += libPattern.strength;
    }
    
    const last10Tx = tx.slice(-10).join('');
    const txPatterns = [
        { pattern: 'TXTXTXTX', prediction: 'X', strength: 0.8 }, { pattern: 'XTXTXTXT', prediction: 'T', strength: 0.8 },
        { pattern: 'TTXXTTXX', prediction: 'X', strength: 0.7 }, { pattern: 'XXTTXXTT', prediction: 'T', strength: 0.7 },
        { pattern: 'TTTXXXTT', prediction: 'T', strength: 0.75 }, { pattern: 'XXXTTTXX', prediction: 'X', strength: 0.75 },
        { pattern: 'TTXTTXTT', prediction: 'X', strength: 0.7 }, { pattern: 'XXTXXTXX', prediction: 'T', strength: 0.7 }
    ];
    for (const txPattern of txPatterns) {
        if (last10Tx.includes(txPattern.pattern)) patternStrength[txPattern.prediction] += txPattern.strength;
    }
    
    const lastRun = recentRuns[recentRuns.length - 1];
    if (lastRun) {
        const avgRecentLength = avg(runLengths);
        if (lastRun.len > avgRecentLength * 1.8) patternStrength[lastRun.val === 'T' ? 'X' : 'T'] += 0.5;
        else if (lastRun.len < avgRecentLength * 0.6) patternStrength[lastRun.val] += 0.4;
    }
    if (patternStrength.T > 0 || patternStrength.X > 0) {
        const totalStrength = patternStrength.T + patternStrength.X;
        const confidence = Math.abs(patternStrength.T - patternStrength.X) / totalStrength;
        if (confidence > 0.3) return patternStrength.T > patternStrength.X ? 'T' : 'X';
    }
    return null;
}

function algoJ_QuantumEntropy(history) {
    if (history.length < 40) return null;
    const features = extractFeatures(history);
    const { entropy: e, tx, runs } = features;
    const entropyWindows = [10, 20, 30];
    let entropyPredictions = { T: 0, X: 0 };
    
    for (const window of entropyWindows) {
        if (tx.length < window) continue;
        const windowTx = tx.slice(-window);
        const windowEntropy = entropy(windowTx);
        if (windowEntropy < 0.3) {
            entropyPredictions[windowTx[windowTx.length - 1]] += 0.6;
        } else if (windowEntropy > 0.9) {
            const tCount = windowTx.filter(t => t === 'T').length;
            const xCount = windowTx.filter(t => t === 'X').length;
            if (tCount > xCount) entropyPredictions['X'] += 0.5;
            else if (xCount > tCount) entropyPredictions['T'] += 0.5;
        } else {
            const recentRuns = runs.slice(-4);
            if (recentRuns.length >= 3) {
                const runLengths = recentRuns.map(r => r.len);
                if (Math.max(...runLengths) - Math.min(...runLengths) <= 2) entropyPredictions[tx[tx.length - 1]] += 0.4;
            }
        }
    }
    if (e < 0.4) entropyPredictions[tx[tx.length - 1]] += 0.3;
    else if (e > 0.95) {
        const recentT = tx.slice(-20).filter(t => t === 'T').length;
        const recentX = tx.slice(-20).filter(t => t === 'X').length;
        if (recentT > recentX) entropyPredictions['X'] += 0.4;
        else if (recentX > recentT) entropyPredictions['T'] += 0.4;
    }
    if (entropyPredictions.T + entropyPredictions.X > 0.4) return entropyPredictions.T > entropyPredictions.X ? 'T' : 'X';
    return null;
}

function algoK_VIP_Master_Pattern(history) {
    const vipPatterns = detectVIPPattern(history);
    if (!vipPatterns || vipPatterns.length === 0) return null;
    const result = predictVIP(vipPatterns, history);
    if (result && result.confidence >= 0.5) return result.pred;
    return null;
}

function algoL_UltimateBridgeBreaker(history) {
    if (history.length < 30) return null;
    const features = extractFeatures(history);
    const { runs } = features;
    if (runs.length < 5) return null;
    const lastRun = runs[runs.length - 1];
    if (lastRun.len < 4) return null; 
    const sameTypeRuns = runs.filter(r => r.val === lastRun.val);
    if (sameTypeRuns.length < 5) return null;
    const sameTypeLengths = sameTypeRuns.map(r => r.len);
    const meanLen = avg(sameTypeLengths);
    const stdLen = Math.sqrt(avg(sameTypeLengths.map(l => Math.pow(l - meanLen, 2))));
    if (lastRun.len > (meanLen + (stdLen * 1.8))) return lastRun.val === 'T' ? 'X' : 'T';
    return null;
}

function algoM_DeepChaosDiceAnalyzer(history) {
    if (history.length < 30) return null;
    const lastRecord = history[history.length - 1];
    const lastTotal = lastRecord.total;
    let nextT = 0, nextX = 0;
    
    for (let i = 0; i < history.length - 1; i++) {
        if (history[i].total === lastTotal) {
            if (history[i+1].tx === 'T') nextT++;
            if (history[i+1].tx === 'X') nextX++;
        }
    }
    if (nextT + nextX < 3) {
        const range = lastTotal >= 11 ? [11, 12, 13, 14, 15, 16, 17, 18] : [3, 4, 5, 6, 7, 8, 9, 10];
        for (let i = 0; i < history.length - 1; i++) {
            if (range.includes(history[i].total)) {
                if (history[i+1].tx === 'T') nextT += 0.5;
                if (history[i+1].tx === 'X') nextX += 0.5;
            }
        }
    }
    const recent10 = history.slice(-10).map(h => h.total);
    const mean10 = avg(recent10);
    const variance = avg(recent10.map(t => Math.pow(t - mean10, 2)));
    if (variance > 4.5 && (nextT + nextX) > 0) {
        const confidence = Math.abs(nextT - nextX) / (nextT + nextX);
        if (confidence > 0.15) return nextT > nextX ? 'T' : 'X';
    }
    
    const lastDice = lastRecord.dice;
    let diceMatchT = 0, diceMatchX = 0;
    for (let i = 0; i < history.length - 1; i++) {
        const hDice = history[i].dice;
        let matches = 0;
        if (hDice && lastDice) {
            if (hDice.includes(lastDice[0])) matches++;
            if (hDice.includes(lastDice[1])) matches++;
            if (hDice.includes(lastDice[2])) matches++;
        }
        if (matches >= 2) {
            if (history[i+1].tx === 'T') diceMatchT++;
            if (history[i+1].tx === 'X') diceMatchX++;
        }
    }
    if (variance > 4.0 && (diceMatchT + diceMatchX >= 2)) {
        if (diceMatchT !== diceMatchX) return diceMatchT > diceMatchX ? 'T' : 'X';
    }
    return null;
}

const THUAT_TOAN_8_DICT = {
    "TXXTTXTX":"X","XXTTXTXX":"T","XTTXTXXT":"T","TTXTXXTT":"T","TXTXXTTT":"X","XTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"X","TTTXXTXX":"X","TTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"T","XTXXXXXT":"X","TXXXXXTX":"X","XXXXXTXX":"X","XXXXTXXX":"T","XXXTXXXT":"X","XXTXXXTX":"X","XTXXXTXX":"X","TXXXTXXX":"T","XXXTXXXX":"T","XXTXXXXT":"T","XTXXXXTT":"X","TXXXXTTX":"X","XXXXTTXX":"X","XXXTTXXX":"T","XXTTXXXT":"X","XTTXXXTX":"T","TTXXXTXT":"X","TXXXTXTX":"T","XXXTXTXT":"T","XXTXTXTT":"T","XTXTXTTT":"T","TXTXTTTT":"T","XTXTTTTT":"T","TXTTTTTT":"X","XTTTTTTX":"T","TTTTTTXT":"X","TTTTTXTX":"T","TTTTTXTX":"X","TTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"T","TXTXTTXT":"X","XTXTTXTX":"T","TXTTXTXT":"T","XTTXTXTT":"X","TXTTXTXX":"X","XTTXTXXX":"T","TTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"T","XXXTTXXT":"X","XXTTXXTX":"X","XTTXXTXX":"X","TTXXTXXX":"T","TXXTXXXT":"T","XXTXXXTT":"T","XTXXXTTT":"T","TXXXTTTT":"T","XXXTTTTT":"T","XXTTTTTT":"X","XTTTTTTX":"X","TTTTTTXX":"X","TTTTTXXX":"T","TTTTXXXT":"X","TTTXXXTX":"T","TTXXXTXT":"T","TXXXTXTT":"X","XXXTXTTX":"X","XXTXTTXX":"T","XTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"X","TTXXTTTX":"T","TXXTTTXT":"X","XXTTTXTX":"X","XTTTXTXX":"X","TTTXTXXX":"T","XTXTTXXX":"T","TXTTXXXT":"T","XTTXXXTX":"X","TTXXXTXX":"T","TXXXTXXT":"X","XXXTXXTX":"T","XXTXXTXT":"X","XTXXTXTX":"T","TXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"X","XTTXTTTX":"T","TTXTTTXT":"T","TXTTTXTT":"X","XTTTXTTX":"T","TTTXTTXT":"X","TTXTTXTX":"X","TXTTXTXX":"T","XTTXTXXT":"X","TTXTXXTX":"T","TXTXXTXT":"T","XTXXTXTT":"T","TXXTXTTT":"T","XXTXTTTT":"T","XTXTTTTT":"X","TXTTTTTX":"X","XTTTTTXX":"X","TTTTTXXX":"X","TTTTXXXX":"X","TTTXXXXX":"X","TTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"X","XXXXXTTX":"X","XXXXTTXX":"T","XXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"T","TTXXTXTT":"T","XXTXTTTT":"X","XTXTTTTX":"T","TXTTTTXT":"X","XTTTTXTX":"X","TTTTXTXX":"T","TTTXTXXT":"X","TTXTXXTX":"T","TXTXXTXT":"X","XTXTXTTT":"X","TXTXTTTX":"X","XTXTTTXX":"T","TXTTTXXT":"T","XTTTXXTT":"T","TTTXXTTT":"X","TTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"X","XTTTTXTX":"T","TTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"X","XTXTTXXX":"X","TXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"T","TXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"T","TXTXTTTT":"X","XTXTTTTX":"X","TXTTTTXX":"T","XTTTTXXT":"X","TTTTXXTX":"X","TTTXXTXX":"X","TXXTXXXT":"X","XXTXXXTX":"X","XTXXXTXX":"T","TXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"X","XTXXTTTX":"T","TXXTTTXT":"T","XXTTTXTT":"X","XTTTXTTX":"X","TTTXTTXX":"X","TTXTTXXX":"X","XTTXXXXX":"T","TTXXXXXT":"T","TXXXXXTT":"T","XXXXXTTT":"T","XXXXTTTT":"X","XXXTTTTX":"T","XTTXTXTX":"T","TTXTXTXT":"X","TXTXTXTX":"X","XTXTXTXT":"X","XTXTXTXX":"T","TXTXTXXT":"X","XTXTXXTX":"T","TXTXXTXT":"X","XTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"T","TXTXTXTT":"T","XTXTXTTT":"X","TXTTTXXX":"X","XTTTXXXX":"T","TTTXXXXT":"T","TTXXXXTT":"X","TXXXXTTX":"X","XXXXTTXX":"X","XXXTTXXX":"T","XXTTXXXT":"X","XTTXXXTX":"T","TTXXXTXT":"X","TXXXTXTX":"X","XXXTXTXX":"X","XXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"T","XTTXXXTT":"X","TTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"T","TXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"X","TXTTXTTX":"T","XTTXTTXT":"T","TTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"T","TTXTTTTT":"T","TXTTTTTT":"T","XTTTTTTT":"X","TTTTTTTX":"T","TTTTTTXT":"T","TTTTTXTT":"X","TTTTXTTX":"X","TTTXTTXX":"T","TTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTT":"T","XTTTTTTT":"T","TTTTTTTT":"X","TTTTTTTX":"T","TTTTTTXT":"X","TTTTTXTX":"X","TTTTTXTX":"T","TTTTXTXX":"X","TTTXTXXX":"X","TTXTXXXX":"T","TXTXXXXT":"X","XTXXXXTX":"T","TXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"T","XXTXTTTT":"X","XTXTTTTX":"T","TXTTTTXT":"X","XTTTTXTX":"T","TTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"X","XXTTTTTX":"T","XTTTTTXT":"X","TTTTTXTX":"T","TTTTXTXT":"X","TTTXTXTX":"T","TTXTXTXT":"X","TXTXTXTX":"X","XTXTXTXX":"T","TXTXTXXT":"X","XTXTXXTX":"X","TXTXXTXX":"T","XTXXTXXT":"X","TXXTXXTX":"X","XXTXXTXX":"X","XTXXTXXX":"T","TXXTXXXT":"T","XXTXXXTT":"X","XTXXXTTX":"T","TXXXTTXT":"X","XXXTTXTX":"X","XXTTXTXX":"T","XTTXTXXT":"T","TTXTXXTT":"X","TXTXXTTX":"X","XTXXTTXX":"T","TXXTTXXT":"T","XXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"X","TXXTTTTX":"X","XXTTTTXX":"X","XTTTTXXX":"X","TTTTXXXX":"T","TTTXXXXT":"X","TTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"X","XXTXXTTX":"X","XTXXTTXX":"T","TXXTTXXT":"T","XXTTXXTT":"X","XTTXXTTX":"X","TTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"X","TXXTXTXX":"T","XXTXTXXT":"T","XTXTXXTT":"X","TXTXXTTX":"T","XTXXTTXT":"T","TXXTTXTT":"X","XXTTXTTX":"X","XTTXTTXX":"X","TTXTTXXX":"X","TXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTT":"X","XTTTTTTX":"T","TTTTTTXT":"T","TTTTTXTT":"X","TTTTXTTX":"T","TTTXTTXT":"X","TTXTTXTX":"T","TXTTXTXT":"T","XTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"X","XTXTTXXX":"T","TXTTXXXT":"T","XTTXXXTT":"X","TTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"T","XXTTXXXT":"T","XTTXXXTT":"X","TTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"X","XTTXXXXX":"X","TTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"T","XXXXXTTT":"T","XXXXTTTT":"T","XXXTTTTT":"T","XXTTTTTT":"T","XTTTTTTT":"X","TTTTTTTX":"X","TTTTTTXX":"T","TTTTTXXT":"X","TTTTXXTX":"X","TTTXXTXX":"T","TTXXTXXT":"X","TXXTXXTX":"X","XXTXXTXX":"X","XTXXTXXX":"T","TXXTXXXT":"X","XXTXXXTX":"T","XTXXXTXT":"T","TXXXTXTT":"X","XXXTXTTX":"T","XXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"X","XTTXTTTX":"X","TTXTTTXX":"X","TXTTTXXX":"X","XTTTXXXX":"T","TTTXXXXT":"T","TTXXXXTT":"X","TXXXXTTX":"T","XXXXTTXT":"T","XXXTTXTT":"X","XXTTXTTX":"X","XTTXTTXX":"T","TTXTTXXT":"X","TXTTXXTX":"X","XTTXXTXX":"T","TTXXTXXT":"T","TXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"T","XTTTTXTT":"X","TTTTXTTX":"T","TTTXTTXT":"T","TTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"T","TTXTTTTT":"X","TXTTTTTX":"X","XTTTTTXX":"X","TTTTTXXX":"X","TTTTXXXX":"T","TTTXXXXT":"T","TTXXXXTT":"X","TXXXXTTX":"X","XXXXTTXX":"X"
};

function algo14_ExactHistoryMatch(history) {
    if (history.length === 0) return null;
    const txString = history.map(h => h.tx).join('');
    
    const maxLen = Math.min(txString.length, 8); 
    for (let len = maxLen; len >= 1; len--) {
        const pattern = txString.slice(-len);
        if (THUAT_TOAN_8_DICT[pattern]) {
            return THUAT_TOAN_8_DICT[pattern];
        }
    }
    return null;
}

// =====================================================================
// === CORE UPGRADE: 300 BRIDGE INTELLIGENT DETECTION ENGINE (VIP) ====
// =====================================================================
function detectAll300Bridges(history) {
    if (history.length < 8) {
        return { id: 300, name: "Khởi Tạo Hệ Thống", isBreaking: false, criteria: "Chưa đủ số phiên (nhỏ hơn 8 phiên).", nextPredict: null, targetBridge: "Cầu Cơ Bản" };
    }
    
    const features = extractFeatures(history);
    const { runs, tx, totals, stdTotal, meanTotal, entropy: et } = features;
    const runLengths = runs.map(r => r.len);
    const runValues = runs.map(r => r.val);
    const lastRun = runs[runs.length - 1];
    const lastLength = lastRun ? lastRun.len : 0;
    const lastValue = lastRun ? lastRun.val : 'T';
    
    const recentLengths = runLengths.slice(-6);
    const recentStr = recentLengths.join(',');
    const txStr = tx.slice(-8).join('');

    const isUpward = features.trends.upward > features.trends.downward;
    const isDownward = features.trends.downward > features.trends.upward;

    let id = 300;
    let name = "Cầu Reset Toàn Phần";
    let isBreaking = false;
    let criteria = "Không tìm thấy cấu trúc cũ, kích hoạt chu kỳ mới.";
    let nextPredict = lastValue === 'T' ? 'X' : 'T';
    let targetBridge = "Cầu 1-1";

    if (recentStr.endsWith("1,1,1,1")) {
        id = 1; name = "Cầu 1-1"; criteria = "Xen kẽ đều ≥ 4 nhịp."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 2-1";
        if (lastLength > 1) { isBreaking = true; criteria = "Sắp bẻ: Xuất hiện TT hoặc XX lần đầu."; nextPredict = lastValue; targetBridge = "Bệt 2"; }
    } else if (recentStr.endsWith("2,1,2,1") || recentStr.endsWith("1,2,1,2")) {
        id = 2; name = "Cầu 2-1"; criteria = "Cụm đôi và đơn xen kẽ đều đặn."; nextPredict = lastLength === 2 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 2-2";
        if (recentStr.endsWith(",2,2")) { isBreaking = true; criteria = "Sắp bẻ: Đơn kéo dài thành đôi."; nextPredict = lastValue; targetBridge = "Cầu 2-2"; }
    } else if (recentStr.endsWith("3,1,3,1") || recentStr.endsWith("1,3,1,3")) {
        id = 3; name = "Cầu 3-1"; criteria = "Bệt 3 ổn định và đơn rõ."; nextPredict = lastLength === 3 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 3-2";
        if (lastLength >= 4) { isBreaking = true; criteria = "Sắp bẻ: Bệt kéo dài quá 3."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu Bệt"; }
    } else if (recentStr.endsWith("4,1,4,1") || recentStr.endsWith("1,4,1,4")) {
        id = 4; name = "Cầu 4-1"; criteria = "Cụm 4 mạnh và gãy đơn."; nextPredict = lastLength === 4 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Sóng dài";
        if (lastLength >= 5) { isBreaking = true; criteria = "Sắp bẻ: Xuất hiện cụm 5."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 5-1"; }
    } else if (recentStr.endsWith("5,1,5,1")) {
        id = 5; name = "Cầu 5-1"; criteria = "Bệt 5 phiên gãy đơn."; nextPredict = lastLength === 5 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 5-2";
        if (recentStr.endsWith(",2")) { isBreaking = true; criteria = "Sắp bẻ: Gãy đơn kéo dài thành đôi."; nextPredict = lastValue; targetBridge = "Cầu 5-2"; }
    } else if (recentStr.endsWith("1,2,1,2")) {
        id = 6; name = "Cầu 1-2"; criteria = "Xen kẽ đơn và cụm đôi liên tục."; nextPredict = lastLength === 1 ? lastValue : (lastValue === 'T' ? 'X' : 'T'); targetBridge = "Cầu 2-2";
        if (lastLength > 2) { isBreaking = true; criteria = "Sắp bẻ: Cụm đôi biến thành TTT."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 1-3"; }
    } else if (recentStr.endsWith("2,2,2,2")) {
        id = 7; name = "Cầu 2-2"; criteria = "Hai cặp xen kẽ cực kỳ ổn định."; nextPredict = lastLength === 2 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 3-2";
        if (lastLength >= 3) { isBreaking = true; criteria = "Sắp bẻ: Một cụm kéo dài lên 3."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 3-2"; }
    } else if (recentStr.endsWith("3,2,3,2")) {
        id = 8; name = "Cầu 3-2"; criteria = "Ba nhịp xen kẽ hai nhịp cân bằng."; nextPredict = lastLength === 3 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 3-3";
        if (lastLength >= 4) { isBreaking = true; criteria = "Sắp bẻ: Nhịp bệt nhảy lên 4."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 4-2"; }
    } else if (recentStr.endsWith("4,2,4,2")) {
        id = 9; name = "Cầu 4-2"; criteria = "Cụm 4 và cụm 2 xen kẽ chuẩn."; nextPredict = lastLength === 4 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 4-3";
        if (lastLength >= 5) { isBreaking = true; criteria = "Sắp bẻ: Cụm 4 tăng lên 5."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 5-2"; }
    } else if (recentStr.endsWith("5,2,5,2")) {
        id = 10; name = "Cầu 5-2"; criteria = "Cụm bệt 5 kết hợp gãy đôi."; nextPredict = lastLength === 5 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 5-3";
        if (lastLength >= 6) { isBreaking = true; criteria = "Sắp bẻ: Bệt tiếp tục kéo dài lên 6."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Sóng Dài"; }
    } else if (recentStr.endsWith("1,3,1,3")) {
        id = 11; name = "Cầu 1-3"; criteria = "Xen kẽ nhịp đơn và cụm ba."; nextPredict = lastLength === 1 ? lastValue : (lastValue === 'T' ? 'X' : 'T'); targetBridge = "Cầu 2-3";
        if (lastLength >= 4) { isBreaking = true; criteria = "Sắp bẻ: Cụm 3 vọt lên 4."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 1-4"; }
    } else if (recentStr.endsWith("2,3,2,3")) {
        id = 12; name = "Cầu 2-3"; criteria = "Nhịp đôi và ba nối đuôi nhau."; nextPredict = lastLength === 2 ? lastValue : (lastValue === 'T' ? 'X' : 'T'); targetBridge = "Cầu 3-3";
        if (lastLength >= 4) { isBreaking = true; criteria = "Sắp bẻ: Cụm 3 chuyển tiếp lên 4."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 2-4"; }
    } else if (recentStr.endsWith("3,3,3,3")) {
        id = 13; name = "Cầu 3-3"; criteria = "Chu kỳ ba đối xứng chuẩn."; nextPredict = lastLength === 3 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 4-3";
        if (lastLength >= 4) { isBreaking = true; criteria = "Sắp bẻ: Mất đối xứng, một cụm vọt lên 4."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 4-3"; }
    } else if (recentStr.endsWith("4,3,4,3")) {
        id = 14; name = "Cầu 4-3"; criteria = "Nhịp bốn và nhịp ba xen kẽ."; nextPredict = lastLength === 4 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 4-4";
        if (lastLength >= 5) { isBreaking = true; criteria = "Sắp bẻ: Một bên tăng lên 5."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 5-3"; }
    } else if (recentStr.endsWith("5,3,5,3")) {
        id = 15; name = "Cầu 5-3"; criteria = "Bệt 5 nhịp gãy 3 ổn định."; nextPredict = lastLength === 5 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Sóng Dài";
        if (lastLength >= 6) { isBreaking = true; criteria = "Sắp bẻ: Mất nhịp cụm, kéo dài bệt."; nextPredict = lastValue; targetBridge = "Bệt Rồng"; }
        
    } else if (lastLength >= 4) { // NÂNG CẤP XEM NHẬN DIỆN BỆT TRÊN 3 CON
        if (lastValue === 'T') {
            id = 16; name = "Cầu Bệt Tài"; criteria = "Tài bệt liên tục ổn định."; nextPredict = 'T'; targetBridge = "Phá bệt";
        } else {
            id = 17; name = "Cầu Bệt Xỉu"; criteria = "Xỉu bệt liên tục ổn định."; nextPredict = 'X'; targetBridge = "Phá bệt";
        }
    } else if (recentStr.endsWith("1,1,1,1,1")) {
        id = 18; name = "Cầu Đảo 1-1"; criteria = "Nhịp đảo nhanh liên tiếp."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 2-1";
        if (lastLength >= 2) { isBreaking = true; criteria = "Sắp bẻ: Xuất hiện TT hoặc XX ngắt mạch."; nextPredict = lastValue; targetBridge = "Cầu 2-1"; }
    } else if (recentStr.endsWith("2,2,2")) {
        id = 19; name = "Cầu Đảo 2-2"; criteria = "Đảo cặp liên tục."; nextPredict = lastLength === 2 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 3-2";
        if (lastLength >= 3) { isBreaking = true; criteria = "Sắp bẻ: Cặp kéo dài lên 3."; nextPredict = lastValue; targetBridge = "Cầu 3-2"; }
    } else if (recentStr.endsWith("3,3")) {
        id = 20; name = "Cầu Đảo 3-3"; criteria = "Nhịp 3 đảo chiều ổn định."; nextPredict = lastLength === 3 ? (lastValue === 'T' ? 'X' : 'T') : lastValue; targetBridge = "Cầu 4-3";
        if (lastLength >= 4) { isBreaking = true; criteria = "Sắp bẻ: Mất đối xứng chu kỳ."; nextPredict = lastValue; targetBridge = "Cầu 4-3"; }
    } else if (isUpward && stdTotal < 1.5) {
        id = 25; name = "Cầu Bậc Thang Tăng"; criteria = "Các điểm xúc xắc tịnh tiến tăng."; nextPredict = 'T'; targetBridge = "Bậc thang giảm";
        if (totals[totals.length - 1] <= totals[totals.length - 2]) { isBreaking = true; criteria = "Sắp bẻ: Hai bậc bằng nhau không tăng tiếp."; nextPredict = 'X'; targetBridge = "Leo núi"; }
    } else if (isDownward && stdTotal < 1.5) {
        id = 26; name = "Cầu Bậc Thang Giảm"; criteria = "Các điểm xúc xắc tịnh tiến giảm sâu."; nextPredict = 'X'; targetBridge = "Leo núi";
        if (totals[totals.length - 1] >= totals[totals.length - 2]) { isBreaking = true; criteria = "Sắp bẻ: Xuất hiện cụm tăng trở lại."; nextPredict = 'T'; targetBridge = "Bật lại"; }
    } else if (stdTotal > 4 && et > 0.9) {
        id = 31; name = "Cầu Zigzag"; criteria = "Biến động điểm số cực lớn liên tục."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 1-1";
        if (lastLength >= 2) { isBreaking = true; criteria = "Sắp bẻ: Nhịp lên xuống mất đều."; nextPredict = lastValue; targetBridge = "Sóng ngắn"; }
    } else if (totals.slice(-3).join(',') === "10,11,10" || totals.slice(-3).join(',') === "11,10,11") {
        id = 38; name = "Cầu Tam Giác"; criteria = "Biên dao động thu hẹp cực mạnh."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu Bung";
        if (stdTotal > 3.5) { isBreaking = true; criteria = "Sắp bẻ: Biên dao động bung mạnh."; nextPredict = lastValue; targetBridge = "Sóng dài"; }

    } else if (txStr.includes("TXTX") && runLengths.slice(-3).join(',') === "1,2,1") {
        id = 101; name = "Cầu 1-2-1"; criteria = "Nhịp ngắn đối xứng tâm."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 1-3-1";
        if (lastLength >= 3) { isBreaking = true; criteria = "Sắp bẻ: Cụm giữa kéo dài lên 3."; nextPredict = lastValue; targetBridge = "Cầu 2-2-1"; }
    } else if (runLengths.slice(-3).join(',') === "2,1,2") {
        id = 102; name = "Cầu 2-1-2"; criteria = "Hai đầu mạnh trung tâm đơn."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 2-2-2";
        if (lastLength >= 3) { isBreaking = true; criteria = "Sắp bẻ: Một đầu tăng vọt lên 3."; nextPredict = lastValue; targetBridge = "Cầu 3-1-2"; }
    } else if (runLengths.slice(-3).join(',') === "1,3,1") {
        id = 103; name = "Cầu 1-3-1"; criteria = "Tâm mạnh, biên đơn."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 1-4-1";
        if (lastLength >= 4) { isBreaking = true; criteria = "Sắp bẻ: Tâm lên 4."; nextPredict = lastValue; targetBridge = "Cầu 2-3-1"; }
    } else if (runLengths.slice(-3).join(',') === "3,1,3") {
        id = 104; name = "Cầu 3-1-3"; criteria = "Hai biên áp đảo tâm đơn."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 4-1-4";
        if (lastLength >= 4) { isBreaking = true; criteria = "Sắp bẻ: Một biên lên 4."; nextPredict = lastValue; targetBridge = "Cầu 3-2-3"; }
    } else if (runLengths.slice(-4).join(',') === "1,2,2,1") {
        id = 113; name = "Cầu 1-2-2-1"; criteria = "Đối xứng cụm đôi."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 1-3-3-1";
        if (lastLength >= 3) { isBreaking = true; criteria = "Sắp bẻ: Cụm giữa lên 3."; nextPredict = lastValue; targetBridge = "Cầu 2-2-2-1"; }
    } else if (runLengths.slice(-4).join(',') === "2,1,1,2") {
        id = 114; name = "Cầu 2-1-1-2"; criteria = "Kẹp đôi ở giữa."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu 3-1-1-2";
        if (lastLength >= 2) { isBreaking = true; criteria = "Sắp bẻ: Tâm phình ra lên 3."; nextPredict = lastValue; targetBridge = "Cầu 2-1-2-2"; }

    } else if (recentStr.endsWith("1,1,1,2")) {
        id = 151; name = "Cầu chuyển tiếp 1-1 → 2-1"; criteria = "Xen kẽ đều đột ngột xuất hiện cặp đôi."; nextPredict = lastValue; targetBridge = "Cầu 2-1";
        if (lastLength >= 3) { isBreaking = true; criteria = "Sắp bẻ: Nhảy thẳng bệt."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu Đảo"; }
    } else if (recentStr.endsWith("2,1,2,2")) {
        id = 152; name = "Cầu chuyển tiếp 2-1 → 2-2"; criteria = "Phiên đơn kéo dài thành đôi."; nextPredict = lastValue; targetBridge = "Cầu 2-2";
        if (lastLength >= 3) { isBreaking = true; criteria = "Sắp bẻ: Cụm nhảy bệt 3."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Sóng đôi"; }
    } else if (stdTotal < 1.0 && et > 0.95) {
        id = 206; name = "Cầu Nhiễu Nhẹ"; criteria = "Xen kẽ vài tín hiệu bất thường nhỏ."; nextPredict = lastValue === 'T' ? 'X' : 'T'; targetBridge = "Cầu Nhiễu Trung Bình";
        if (stdTotal > 3.0) { isBreaking = true; criteria = "Sắp bẻ: Nhiễu tăng vọt mất nhận diện."; nextPredict = lastValue; targetBridge = "Reset Toàn Phần"; }
    } else if (meanTotal >= 11 && lastValue === 'T') {
        id = 83; name = "Cầu Ép Tài"; criteria = "Tài chiếm hoàn toàn ưu thế kỹ thuật."; nextPredict = 'T'; targetBridge = "Cân bằng";
        if (totals[totals.length - 1] < 11) { isBreaking = true; criteria = "Sắp bẻ: Lực ép giảm, gãy Tài."; nextPredict = 'X'; targetBridge = "Hồi"; }
    } else if (meanTotal < 11 && lastValue === 'X') {
        id = 84; name = "Cầu Ép Xỉu"; criteria = "Xỉu áp đảo hoàn toàn bảng điểm."; nextPredict = 'X'; targetBridge = "Cân bằng";
        if (totals[totals.length - 1] >= 11) { isBreaking = true; criteria = "Sắp bẻ: Lực ép giảm, bùng Tài."; nextPredict = 'T'; targetBridge = "Hồi"; }
    }

    return { id, name, isBreaking, criteria, nextPredict, targetBridge };
}

function algo15_Ultimate300BridgeEngine(history) {
    const bridgeMatch = detectAll300Bridges(history);
    if (!bridgeMatch) return null;
    return bridgeMatch.nextPredict;
}

// =====================================================================
// === CORE UPGRADE V9.0: ĐỘNG CƠ NHÂN BẢN & PHÂN TÍCH ĐẢO NGƯỢC VIP ===
// =====================================================================

// 1. Phân tích đảo ngược (Soi kỹ từ phiên mới nhất về quá khứ)
function analyzeReverseFromLatest(history, depth = 30) {
    if (history.length < 5) return { tScore: 0, xScore: 0 };
    const reversedHistory = [...history].reverse().slice(0, depth);
    let tScore = 0;
    let xScore = 0;
    
    for (let i = 0; i < reversedHistory.length; i++) {
        const item = reversedHistory[i];
        let weight = 1;
        if (i < 3) weight = 3.0; 
        else if (i < 8) weight = 2.0; 
        else if (i < 15) weight = 1.2;
        
        if (item.tx === 'T') tScore += weight;
        if (item.tx === 'X') xScore += weight;
    }
    return { tScore, xScore, trendPredict: tScore > xScore ? 'T' : (xScore > tScore ? 'X' : null) };
}

// 2. Trạm máy chủ thu thập đồng thuận của toàn bộ 15 thuật toán cũ
function masterLookupEngine(history) {
    const votes = { T: 0, X: 0 };
    const algsToRun = ALL_ALGS.filter(a => a.id !== 'algo16_super_evolution_engine'); 
    
    for (const alg of algsToRun) {
        try {
            const pred = alg.fn(history);
            if (pred === 'T' || pred === 'X') {
                votes[pred] += 1;
            }
        } catch (e) {}
    }
    
    return {
        tVotes: votes.T,
        xVotes: votes.X,
        consensus: votes.T > votes.X ? 'T' : (votes.X > votes.T ? 'X' : null)
    };
}

// 3. AI Tự Nhân Bản Tính Toán (Thuật toán 16 VIP)
function algo16_SuperEvolutionEngine(history) {
    if (history.length < 50) return null;

    const reverseAnalysis = analyzeReverseFromLatest(history, 25);
    const masterData = masterLookupEngine(history);
    
    const cloneT = [...history, { session: 999991, tx: 'T', total: 14 }];
    const cloneX = [...history, { session: 999992, tx: 'X', total: 7 }];
    
    const featuresT = extractFeatures(cloneT);
    const featuresX = extractFeatures(cloneX);
    
    let penaltyT = featuresT.stdTotal > 4.5 ? 2 : 0;
    let penaltyX = featuresX.stdTotal > 4.5 ? 2 : 0;
    
    let finalScoreT = masterData.tVotes * 1.5;
    let finalScoreX = masterData.xVotes * 1.5;
    
    if (reverseAnalysis.trendPredict === 'T') finalScoreT += 3;
    if (reverseAnalysis.trendPredict === 'X') finalScoreX += 3;
    
    finalScoreT -= penaltyT;
    finalScoreX -= penaltyX;
    
    if (finalScoreT > finalScoreX * 1.25) return 'T';
    if (finalScoreX > finalScoreT * 1.25) return 'X';
    
    return masterData.consensus; 
}

// --- DANH SÁCH THUẬT TOÁN ĐẦY ĐỦ (16 THUẬT TOÁN VIP V9.0) ---
const ALL_ALGS = [
    { id: 'algo5_freqrebalance', fn: algo5_freqRebalance },
    { id: 'a_markov', fn: algoA_markov },
    { id: 'b_ngram', fn: algoB_ngram },
    { id: 's_neo_pattern', fn: algoS_NeoPattern },
    { id: 'f_super_deep_analysis', fn: algoF_SuperDeepAnalysis },
    { id: 'e_transformer', fn: algoE_Transformer },
    { id: 'g_super_bridge_predictor', fn: algoG_SuperBridgePredictor },
    { id: 'h_adaptive_markov', fn: algoH_AdaptiveMarkov },
    { id: 'i_pattern_master', fn: algoI_PatternMaster },
    { id: 'j_quantum_entropy', fn: algoJ_QuantumEntropy },
    { id: 'k_vip_master_pattern', fn: algoK_VIP_Master_Pattern },
    { id: 'l_ultimate_bridge_breaker', fn: algoL_UltimateBridgeBreaker },
    { id: 'm_deep_chaos_dice_analyzer', fn: algoM_DeepChaosDiceAnalyzer },
    { id: 'algo14_exact_history_match', fn: algo14_ExactHistoryMatch },
    { id: 'algo15_ultimate_300_bridge_engine', fn: algo15_Ultimate300BridgeEngine },
    { id: 'algo16_super_evolution_engine', fn: algo16_SuperEvolutionEngine } 
];

// --- ENSEMBLE CLASSIFIER NÂNG CẤP VIP TƯ DUY CON NGƯỜI ---
class SEIUEnsemble {
    constructor(algorithms, opts = {}) { 
        this.algs = algorithms;
        this.weights = {};
        this.emaAlpha = opts.emaAlpha ?? 0.06;
        this.minWeight = opts.minWeight ?? 0.01;
        this.historyWindow = opts.historyWindow ?? 700;
        this.performanceHistory = {};
        this.patternMemory = {};
        
        for (const a of algorithms) {
            this.weights[a.id] = 1.0;
            this.performanceHistory[a.id] = [];
        }
    }
    
    fitInitial(history) {
        const window = lastN(history, Math.min(this.historyWindow, history.length));
        if (window.length < 30) return;
        
        const algScores = {};
        for (const a of this.algs) algScores[a.id] = 0;

        const evalSamples = Math.min(40, window.length - 15);
        const startIdx = window.length - evalSamples;
        
        for (let i = Math.max(15, startIdx); i < window.length; i++) {
            const prefix = window.slice(0, i);
            const actual = window[i].tx;
            const features = extractFeatures(prefix);
            const patternType = detectPatternType(features.runs);
            
            for (const a of this.algs) {
                try {
                    const pred = a.fn(prefix);
                    if (pred && pred === actual) {
                        algScores[a.id] += 1;
                        if (patternType) {
                            const key = `${a.id}_${patternType}`;
                            this.patternMemory[key] = (this.patternMemory[key] || 0) + 1;
                        }
                    }
                } catch (e) {}
            }
        }

        let totalWeight = 0;
        for (const id in algScores) {
            const score = algScores[id] || 0;
            const accuracy = score / evalSamples;
            const baseWeight = 0.3 + (accuracy * 0.7);
            this.weights[id] = Math.max(this.minWeight, baseWeight);
            totalWeight += this.weights[id];
        }
        
        if (totalWeight > 0) {
            for (const id in this.weights) {
                this.weights[id] /= totalWeight;
            }
        }
        console.log(`⚖️ Đã khởi tạo trọng số cho ${Object.keys(this.weights).length} thuật toán VIP HOÀNG.`);
    }

    updateWithOutcome(historyPrefix, actualTx) {
        if (historyPrefix.length < 10) return;
        
        const features = extractFeatures(historyPrefix);
        const patternType = detectPatternType(features.runs);
        
        for (const a of this.algs) {
            try {
                const pred = a.fn(historyPrefix);
                const correct = pred === actualTx ? 1 : 0;
                
                this.performanceHistory[a.id].push(correct);
                if (this.performanceHistory[a.id].length > 60) {
                    this.performanceHistory[a.id].shift();
                }
                
                const recentPerf = lastN(this.performanceHistory[a.id], 25);
                let weightedAccuracy = 0, weightSum = 0;
                
                for (let i = 0; i < recentPerf.length; i++) {
                    const weight = Math.pow(0.9, recentPerf.length - i - 1);
                    weightedAccuracy += recentPerf[i] * weight;
                    weightSum += weight;
                }
                
                const recentAccuracy = weightSum > 0 ? weightedAccuracy / weightSum : 0.5;
                let patternBonus = 0;
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const patternSuccess = this.patternMemory[key] || 0;
                    if (patternSuccess > 3) patternBonus = 0.15;
                }
                
                const targetWeight = Math.min(1, recentAccuracy + patternBonus + 0.1);
                const currentWeight = this.weights[a.id] || this.minWeight;
                const newWeight = this.emaAlpha * targetWeight + (1 - this.emaAlpha) * currentWeight;
                this.weights[a.id] = Math.max(this.minWeight, Math.min(1.5, newWeight));
                
                if (patternType && correct) {
                    const key = `${a.id}_${patternType}`;
                    this.patternMemory[key] = (this.patternMemory[key] || 0) + 1;
                }
            } catch (e) {
                this.weights[a.id] = Math.max(this.minWeight, (this.weights[a.id] || 1) * 0.92);
            }
        }

        const sumWeights = Object.values(this.weights).reduce((s, w) => s + w, 0);
        if (sumWeights > 0) {
            for (const id in this.weights) {
                this.weights[id] /= sumWeights;
            }
        }
    }

    predict(history) {
        if (history.length < 12) {
            return { prediction: 'Tài', confidence: 0.5, rawPrediction: 'T' };
        }
        
        const features = extractFeatures(history);
        const patternType = detectPatternType(features.runs);
        const votes = { T: 0, X: 0 };
        let algorithmDetails = [];

        // Kế thừa phân tích xúc xắc của con người
        const diceAnalysis = analyzeDicesAndSum(history);
        
        for (const a of this.algs) {
            try {
                const pred = a.fn(history);
                if (!pred) continue;
                let weight = this.weights[a.id] || this.minWeight;
                
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const patternSuccess = this.patternMemory[key] || 0;
                    if (patternSuccess > 2) weight *= 1.3; 
                }
                
                // Trọng số nâng cấp đặc biệt cho VIP
                if (a.id === 'k_vip_master_pattern') weight *= 1.5;
                if (a.id === 'algo14_exact_history_match') weight *= 1.6;
                if (a.id === 'algo15_ultimate_300_bridge_engine') weight *= 1.9;
                if (a.id === 'algo16_super_evolution_engine') weight *= 2.2; 
                if (a.id === 'm_deep_chaos_dice_analyzer' && (patternType === 'random_pattern' || patternType === 'cau_tu_nhien')) {
                    weight *= 1.8; 
                }

                votes[pred] = (votes[pred] || 0) + weight;
                algorithmDetails.push({ algorithm: a.id, prediction: pred, weight: weight });
            } catch (e) {}
        }

        // Áp dụng sự gia tăng tự tin từ xúc xắc và xu hướng điểm số
        if (diceAnalysis.recommendation) {
            const extraWeight = 1.5 + diceAnalysis.confidenceBonus;
            votes[diceAnalysis.recommendation] = (votes[diceAnalysis.recommendation] || 0) + extraWeight;
        }
        
        if (votes.T === 0 && votes.X === 0) {
            const fallback = algo5_freqRebalance(history) || 'T';
            return { prediction: fallback === 'T' ? 'Tài' : 'Xỉu', confidence: 0.5, rawPrediction: fallback };
        }
        
        const { key: best, val: bestVal } = majority(votes);
        const totalVotes = votes.T + votes.X;
        const baseConfidence = bestVal / totalVotes;
        
        let consensusBonus = 0;
        const tAlgorithms = algorithmDetails.filter(a => a.prediction === 'T').length;
        const xAlgorithms = algorithmDetails.filter(a => a.prediction === 'X').length;
        const totalAlgorithms = tAlgorithms + xAlgorithms;
        
        if (totalAlgorithms > 0) {
            const consensusRatio = Math.max(tAlgorithms, xAlgorithms) / totalAlgorithms;
            if (consensusRatio > 0.7) consensusBonus = 0.12;
            if (consensusRatio > 0.8) consensusBonus = 0.18;
        }
        
        const confidence = Math.min(0.98, Math.max(0.50, baseConfidence + consensusBonus));

        // Bám cầu bệt và bám chuỗi 1-1 tối thượng
        const lastRun = features.runs[features.runs.length - 1];
        const isBet = lastRun && lastRun.len >= 4; 
        const is1_1 = patternType === '1_1_pattern' || patternType === 'cau_dao_11';

        const recentTotals = features.totals.slice(-5);
        const variance = avg(recentTotals.map(t => Math.pow(t - avg(recentTotals), 2)));
        const isCauAo = variance > 6.0 && features.entropy > 0.95 && (isBet || is1_1);

        if (isCauAo) {
            return {
                prediction: 'Bỏ tay này (Cầu loạn MD5 biến động lớn)',
                confidence: 0.0,
                rawPrediction: null
            };
        }

        if (isBet) {
             const betPred = lastRun.val;
             return {
                 prediction: betPred === 'T' ? 'Tài' : 'Xỉu',
                 confidence: Math.max(confidence, 0.92),
                 rawPrediction: betPred,
                 reason: `Đang bám cầu bệt ${betPred === 'T' ? 'Tài' : 'Xỉu'} độ dài ${lastRun.len} nhịp.`
             };
        }

        if (is1_1) {
             const nextPred = features.tx[features.tx.length - 1] === 'T' ? 'X' : 'T';
             return {
                 prediction: nextPred === 'T' ? 'Tài' : 'Xỉu',
                 confidence: Math.max(confidence, 0.90),
                 rawPrediction: nextPred,
                 reason: "Đang bám sát nhịp cầu đảo xen kẽ 1-1."
             };
        }
        
        return {
            prediction: best === 'T' ? 'Tài' : 'Xỉu',
            confidence,
            rawPrediction: best,
            reason: diceAnalysis.reason || "Phân tích tổ hợp đa thuật toán ổn định."
        };
    }
}

// --- PATTERN ANALYSIS ĐƠN GIẢN VÀ VIP ---
function getComplexPattern(history) {
    const minHistory = 15;
    if (history.length < minHistory) return "n/a";
    
    const bridgeMatch = detectAll300Bridges(history);
    const historyTx = history.map(h => h.tx);
    const baseStr = historyTx.slice(-minHistory).join('').toLowerCase();
    
    if (bridgeMatch && bridgeMatch.id !== 300) {
        const statusStr = bridgeMatch.isBreaking ? " [SẮP BẺ] " : " [CHUẨN] ";
        return `[VIP 300 CẦU: Mã ${bridgeMatch.id} - ${bridgeMatch.name}]${statusStr}- Dự kiến: ${bridgeMatch.targetBridge} (${baseStr})`;
    }
    
    const vipPat = detectVIPPattern(history);
    if (vipPat && vipPat.length > 0) {
        const vnNames = vipPat.map(vp => Object.keys(VIP_PATTERN_MAP).find(k => VIP_PATTERN_MAP[k] === vp) || vp);
        return `[VIP HOÀNG: ${vnNames.join(', ')}] - ${baseStr}`;
    }
    return baseStr;
}

// --- MANAGER CLASS TỐI ƯU ---
class SEIUManager {
    constructor(opts = {}) {
        this.history = [];
        this.ensemble = new SEIUEnsemble(ALL_ALGS, {
            emaAlpha: opts.emaAlpha ?? 0.06,
            historyWindow: opts.historyWindow ?? 700
        });
        this.currentPrediction = null;
        this.patternHistory = [];
    }
    
    calculateInitialStats() {
        const minStart = 20;
        if (this.history.length < minStart) return;
        const trainSamples = Math.min(60, this.history.length - minStart);
        const startIdx = this.history.length - trainSamples;
        for (let i = Math.max(minStart, startIdx); i < this.history.length; i++) {
            const historyPrefix = this.history.slice(0, i);
            const actualTx = this.history[i].tx;
            this.ensemble.updateWithOutcome(historyPrefix, actualTx);
        }
        console.log(`📊 AI VIP HOÀNG đã huấn luyện trên ${trainSamples} mẫu.`);
    }

    loadInitial(lines) {
        this.history = lines;
        this.ensemble.fitInitial(this.history);
        this.calculateInitialStats();
        this.currentPrediction = this.getPrediction();
        console.log("📦 Đã tải lịch sử. Hệ thống AI VIP sẵn sàng.");
        const nextSession = this.history.at(-1) ? this.history.at(-1).session + 1 : 'N/A';
        console.log(`🔮 Dự đoán phiên ${nextSession}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
    }

    pushRecord(record) {
        this.history.push(record);
        if (this.history.length > 500) this.history = this.history.slice(-450);
        const prefix = this.history.slice(0, -1);
        if (prefix.length >= 10) this.ensemble.updateWithOutcome(prefix, record.tx);
        
        this.currentPrediction = this.getPrediction();
        const features = extractFeatures(this.history);
        const patternType = detectPatternType(features.runs);
        if (patternType) {
            this.patternHistory.push(patternType);
            if (this.patternHistory.length > 20) this.patternHistory.shift();
        }
        console.log(`📥 ${record.session} → ${record.result}. Dự đoán ${record.session + 1}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
    }

    getPrediction() {
        return this.ensemble.predict(this.history);
    }
}

const seiuManager = new SEIUManager();

// =====================================================================
// === CORE UPGRADE V11.0: LÕI ĐẢO CẦU THÔNG MINH ĐẲNG CẤP CON NGƯỜI ===
// =====================================================================
class V11SmartInversionEngine {
    constructor() {
        this.handCount = 0;
        this.history = []; // { session, basePred, finalPred, actualResult, isWin }
        this.currentMode = 'THUAN'; // 'THUAN' hoặc 'DAO'
        this.consecutiveWins = 0; // Đếm số tay thuật toán ăn liên tiếp
        this.consecutiveLosses = 0; // Đếm số tay thua liên tiếp
    }

    // Hàm gọi khi có kết quả thực tế đổ về từ API
    evaluateLastResult(session, actualResult) {
        const lastPred = this.history.find(p => p.session === session);
        if (lastPred && (lastPred.finalPred === 'T' || lastPred.finalPred === 'X')) {
            lastPred.actualResult = actualResult;
            lastPred.isWin = (lastPred.finalPred === actualResult);
            
            // Đánh giá dựa trên kết quả thuật toán gốc (basePred) xem gốc đúng hay sai
            const isBaseCorrect = (lastPred.basePred === actualResult);

            if (isBaseCorrect) {
                this.consecutiveWins++;
                this.consecutiveLosses = 0;
            } else {
                this.consecutiveWins = 0;
                this.consecutiveLosses++;
            }

            this.handCount++;
            this.updateMode(lastPred.isWin); 
        }
    }

    // Cập nhật chế độ Thuận / Đảo bám sát logic VIP yêu cầu của bạn
    updateMode(lastHandWin) {
        const count = this.handCount + 1; // Áp dụng cho ván SẮP TỚI

        // QUY TẮC ĐẶC BIỆT: Gốc ăn liên tiếp từ 2 tay trở lên -> Khóa Thuận ngay
        if (this.consecutiveWins >= 2) {
            this.currentMode = 'THUAN';
            return;
        }

        // Chu kỳ xử lý 10 tay đầu tiên (Tay 1 đến Tay 9)
        if (count >= 1 && count <= 9) {
            const step = (count - 1) % 3; // Lặp lại chu kỳ 3 ván
            
            if (step === 0) {
                // Tay 1, 4, 7 -> Thuận theo phân tích của thuật toán
                this.currentMode = 'THUAN'; 
            } else if (step === 1) {
                // Tay 2, 5, 8 -> Bắt buộc Đảo ngược kết quả thuật toán
                this.currentMode = 'DAO'; 
            } else if (step === 2) {
                // Tay 3, 6, 9 -> Xem xét kết quả của tay trước (Tay 2, 5, 8)
                if (lastHandWin) {
                    // Nếu Đảo đúng (Thắng) -> Tiếp tục duy trì Đảo cầu
                    this.currentMode = 'DAO';
                } else {
                    // Nếu Đảo sai (Thua) -> Quay trở về hiện kết quả Thuận của thuật toán
                    this.currentMode = 'THUAN';
                }
            }
        } 
        // Nhận diện thông minh từ tay thứ 10 trở đi
        else {
            if (lastHandWin) {
                // Đang phân tích đúng -> Cứ tiếp tục bám Thuận cầu
                this.currentMode = 'THUAN';
            } else {
                // Gãy bất kỳ tay nào -> Lập tức bật chế độ bẻ (Đảo) cho tới khi thắng lại thì thôi
                this.currentMode = 'DAO';
            }
        }

        // HIỆU CHUẨN KHI GÃY 2 TAY LIÊN TIẾP
        if (this.consecutiveLosses >= 2) {
            // Khi gãy 2 tay, AI ép buộc đảo cầu thông minh dựa trên lịch sử gần nhất để bẻ mạch dây thua
            this.currentMode = 'DAO';
        }
    }

    // Đảo ngược kết quả (T -> X, X -> T)
    applyInversion(basePredStr) {
        if (!basePredStr) return basePredStr; 
        if (this.currentMode === 'THUAN') return basePredStr; 
        if (this.currentMode === 'DAO') return basePredStr === 'T' ? 'X' : 'T'; 
        return basePredStr;
    }

    // Xử lý dự đoán cuối cùng cho API
    processPrediction(nextSession, baseRawPrediction) {
        if (this.handCount === 0 && this.history.length === 0) {
            this.currentMode = 'THUAN';
        }

        let finalPred = baseRawPrediction;
        if (baseRawPrediction === 'T' || baseRawPrediction === 'X') {
            finalPred = this.applyInversion(baseRawPrediction);
        }

        this.history = this.history.filter(p => p.session !== nextSession);
        this.history.push({
            session: nextSession,
            basePred: baseRawPrediction,
            finalPred: finalPred,
            actualResult: null,
            isWin: null
        });

        return {
            finalPredRaw: finalPred,
            finalPredStr: finalPred === 'T' ? 'Tài' : 'Xỉu',
            mode: this.currentMode,
            handNumber: this.handCount + 1,
            consecutiveWins: this.consecutiveWins,
            consecutiveLosses: this.consecutiveLosses
        };
    }
}

const v11Engine = new V11SmartInversionEngine();

// --- API SERVER ---
const app = fastify({ logger: true });
await app.register(cors, { origin: "*" });

async function fetchAndProcessHistory() {
    try {
        const response = await fetch(API_URL);
        const data = await response.json();
        const newHistory = parseLines(data);
        if (newHistory.length === 0) return console.log("⚠️ Không có dữ liệu từ API.");
        const lastSessionInHistory = newHistory.at(-1);

        if (!currentSessionId) {
            seiuManager.loadInitial(newHistory);
            txHistory = newHistory;
            currentSessionId = lastSessionInHistory.session;
            console.log(`✅ Đã tải ${newHistory.length} phiên lịch sử.`);
        } else if (lastSessionInHistory.session > currentSessionId) {
            const newRecords = newHistory.filter(r => r.session > currentSessionId);
            for (const record of newRecords) {
                // Đánh giá kết quả đổ về để cập nhật logic bẻ cầu trước
                v11Engine.evaluateLastResult(record.session, record.tx);

                // Cập nhật dữ liệu vào seiuManager
                seiuManager.pushRecord(record);
                txHistory.push(record);
            }
            if (txHistory.length > 350) txHistory = txHistory.slice(-300);
            currentSessionId = lastSessionInHistory.session;
            if (newRecords.length > 0) console.log(`🆕 Cập nhật ${newRecords.length} phiên. Phiên cuối: ${currentSessionId}`);
        }
    } catch (e) {
        console.error("❌ Lỗi fetch dữ liệu:", e.message);
    }
}

fetchAndProcessHistory();
clearInterval(fetchInterval);
fetchInterval = setInterval(fetchAndProcessHistory, 5000);
console.log(`🔄 Đang chạy với chu kỳ 5 giây.`);

// API Endpoints
app.get("/api/taixiumd5/lc79", async () => {
    const lastResult = txHistory.at(-1) || null;
    const currentPrediction = seiuManager.currentPrediction;
    const pattern = getComplexPattern(seiuManager.history);

    if (!lastResult || !currentPrediction) {
        return {
            id: "by VIP @hoangvip247",
            id_admin: "@vilong_",
            phien_truoc: null,
            tong: null,
            ket_qua: "đang chờ...",
            pattern: "đang phân tích...",
            phien_hien_tai: null,
            du_doan_goc: "chưa có",
            che_do_v11: "CHƯA XÁC ĐỊNH",
            tay_thu_v11: 0,
            du_doan: "chưa có",
            do_tin_cay: "0%",
            mo_ta: ""
        };
    }

    const nextSession = lastResult.session + 1;
    
    // Đưa kết quả gốc qua bộ lọc Đảo Cầu Thông Minh V11
    const v11Result = v11Engine.processPrediction(nextSession, currentPrediction.rawPrediction);

    let finalPredictionDisplay = v11Result.finalPredStr;
    if (!currentPrediction.rawPrediction) {
        finalPredictionDisplay = currentPrediction.prediction; 
    }

    return {
        id: "by VIP @hoangvip247",
        id_admin: "@vilong_",
        phien_truoc: lastResult.session,
        tong: lastResult.total,
        ket_qua: lastResult.result.toUpperCase(),
        pattern: pattern,
        phien_hien_tai: nextSession,
        du_doan_goc: currentPrediction.prediction.toUpperCase(), 
        che_do_v11: v11Result.mode === 'DAO' ? "ĐẢO CẦU (BẺ LẠI)" : "THUẬN CẦU (BÁM BẢNG)",
        tay_thu_v11: v11Result.handNumber,
        consecutive_wins: v11Result.consecutiveWins,
        consecutive_losses: v11Result.consecutiveLosses,
        du_doan: finalPredictionDisplay.toUpperCase(),
        do_tin_cay: `${(currentPrediction.confidence * 100).toFixed(0)}%`,
        mo_ta: currentPrediction.reason || "Phân tích kỹ thuật cao cấp hoàn thành."
    };
});

app.get("/api/taixiumd5/history", async () => { 
    if (!txHistory.length) return { message: "không có dữ liệu lịch sử." };
    const reversedHistory = [...txHistory].sort((a, b) => b.session - a.session);
    return reversedHistory.map((i) => ({
        session: i.session,
        total: i.total,
        result: i.result.toUpperCase(),
        tx_label: i.tx.toUpperCase(),
    }));
});

app.get("/", async () => { 
    return {
        status: "ok",
        msg: "AI Tài Xỉu MD5 Pro - Phiên bản Pattern Master Ultimate VIP HOÀNG",
        version: "11.0 SIÊU HỆ THỐNG ĐẢO CẦU THÔNG MINH - ADMIN VILONG", 
        algorithms: ALL_ALGS.length,
        id_admin: "@vilong_",
        pattern_recognition: "VIP Hoàn Chỉnh (Tích Hợp Phân Tích 3 Xúc Xắc + Lọc V11)",
        endpoints: [
            "/api/taixiumd5/lc79",
            "/api/taixiumd5/history"
        ]
    };
});

const start = async () => {
    try { await app.listen({ port: PORT, host: "0.0.0.0" }); } 
    catch (err) {
        const fs = await import("node:fs");
        const logFile = path.join(__dirname, "server-error.log");
        const errorMsg = `\n================= SERVER ERROR =================\nTime: ${new Date().toISOString()}\nError: ${err.message}\nStack: ${err.stack}\n=================================================\n`;
        console.error(errorMsg);
        fs.writeFileSync(logFile, errorMsg, { encoding: "utf8", flag: "a+" });
        process.exit(1);
    }
    let publicIP = "0.0.0.0";
    try {
        const res = await fetch("https://ifconfig.me/ip");
        publicIP = (await res.text()).trim();
    } catch (e) {}

    console.log("\n🚀 AI Tài Xỉu MD5 Pro V11.0 - Đã Khởi Động Thành Công!");
    console.log(`   ➜ Local:   http://localhost:${PORT}/`);
    console.log(`   ➜ Network: http://${publicIP}:${PORT}/\n`);
    console.log("📌 Các API endpoints VIP:");
    console.log(`   ➜ GET /api/taixiumd5/lc79   → http://${publicIP}:${PORT}/api/taixiumd5/lc79`);
    console.log(`\n🔧 Hệ thống AI VIP hoạt động với ${ALL_ALGS.length} thuật toán gốc & Lõi V11 đỉnh cao.`);
    console.log("🎯 ADMIN ID: @vilong_");
};
start();