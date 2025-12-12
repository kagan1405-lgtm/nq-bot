class DateTime {
    constructor(d, t) {
        const p = d.trim().split(/[-/]/);
        let Y, M, D;
        if (p[0].length === 4) { [Y, M, D] = p; } else { [D, M, Y] = p; }
        const [h, m, s] = t.trim().split(':');
        this.date = new Date(+Y, M - 1, +D, +h, +m, parseFloat(s));
        this.ts = this.date.getTime();
    }
    getDateStr() { return this.date.toISOString().split('T')[0]; }
    getTimeStr() { return this.date.toLocaleTimeString(); }
}

function parseFile(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => {
            const lines = e.target.result.trim().split('\n');
            let hIdx = 0;
            for (let i = 0; i < Math.min(lines.length, 50); i++)
                if (lines[i].toLowerCase().includes('date') && lines[i].toLowerCase().includes('time')) { hIdx = i; break; }

            const head = lines[hIdx].split(',').map(s => s.trim().toLowerCase());
            const map = {}; head.forEach((c, i) => map[c] = i);
            const col = (ns) => { for (let n of ns) if (map[n] !== undefined) return map[n]; return -1; };
            const C = { d: col(['date']), t: col(['time']), h: col(['high']), l: col(['low']), o: col(['open']), c: col(['close', 'last']), v: col(['vwap', 'volume weighted average price']) };

            if (C.d < 0) return rej("Invalid Format");
            const data = [];
            for (let i = hIdx + 1; i < lines.length; i++) {
                const row = lines[i].split(',');
                if (row.length < head.length) continue;
                try {
                    data.push({
                        dt: new DateTime(row[C.d], row[C.t]),
                        o: +row[C.o], h: +row[C.h], l: +row[C.l], c: +row[C.c], v: C.v > -1 ? +row[C.v] : null
                    });
                } catch (x) { }
            }
            res(data);
        };
        r.readAsText(file);
    });
}

class Strategy {
    constructor(data, cfg) { this.d = data; this.c = cfg; this.T = []; this.debugLogs = []; }
    run() {
        const days = [...new Set(this.d.map(x => x.dt.getDateStr()))].sort();
        let pH = null, pL = null, pClose = 0, prevClosePrice = null; // pClose is TS, prevClosePrice is Price
        this.spRepo = []; // Persistence for Single Prints
        this.gapRepo = []; // Persistence for Unfilled Gaps

        days.forEach(day => {
            const bars = this.d.filter(b => b.dt.getDateStr() === day);
            const rth = bars.filter(b => { const h = b.dt.date.getHours(), m = b.dt.date.getMinutes(); return (h * 60 + m) >= 570 && (h * 60 + m) < 1020; }); // 09:30-17:00

            if (!rth.length) return;
            let lvls = [];

            if (pH !== null) {
                const openTs = rth[0].dt.ts;

                // --- NIGHT SESSION ANALYSIS ---
                const night = this.d.filter(b => b.dt.ts > pClose && b.dt.ts < openTs);

                // Gap Detection
                if (this.c.gap && night.length > 0) {
                    // 1. Check existing Gaps - Did night session fill them?
                    // "Filled" means price touched the Gap's TARGET (the original pClose of that gap).
                    // Gap Object: { p: OpenPrice, target: OriginalClose, d: Dir, date: DateStr }

                    const nightH = Math.max(...night.map(b => b.h));
                    const nightL = Math.min(...night.map(b => b.l));

                    // Filter OUT filled gaps
                    this.gapRepo = this.gapRepo.filter(g => {
                        let filled = false;
                        if (g.d === 'LONG') { // Gap Up, Target is Below
                            if (nightL <= g.target) filled = true;
                        } else { // Gap Down, Target is Above
                            if (nightH >= g.target) filled = true;
                        }
                        return !filled;
                    });

                    // 2. Detect NEW Gap (Today's Night Open vs Yesterday's Close)
                    const nightOpenBar = night[0];
                    const nightOpen = nightOpenBar.o;
                    // Gap Up: Open > pClose
                    // Gap Down: Open < pClose
                    let newGap = null;
                    if (prevClosePrice !== null) {
                        if (nightOpen > prevClosePrice) {
                            newGap = { p: nightOpen, target: prevClosePrice, d: 'LONG', date: day, n: 'GAP' }; // Support
                        } else if (nightOpen < prevClosePrice) {
                            newGap = { p: nightOpen, target: prevClosePrice, d: 'SHORT', date: day, n: 'GAP' }; // Resistance
                        }
                    }

                    // 3. Check if NEW Gap was immediately filled in Night Session
                    if (newGap) {
                        let filledNow = false;
                        if (newGap.d === 'LONG') {
                            if (nightL <= newGap.target) filledNow = true;
                        } else {
                            if (nightH >= newGap.target) filledNow = true;
                        }

                        if (!filledNow) {
                            this.gapRepo.push(newGap);
                        }
                    }
                }

                if (night.length) {
                    const hN = Math.max(...night.map(b => b.h));
                    const lN = Math.min(...night.map(b => b.l));

                    // --- TPO HELPER ---
                    const calcTPO = (bars) => {
                        const counts = {};
                        bars.forEach(b => {
                            for (let p = Math.floor(b.l * 4); p <= Math.floor(b.h * 4); p++)
                                counts[p] = (counts[p] || 0) + 1;
                        });
                        const sortedPrices = Object.keys(counts).map(Number).sort((a, b) => a - b);
                        const totalTPO = Object.values(counts).reduce((a, b) => a + b, 0);
                        let maxC = -1, pocTick = 0;
                        for (const p of sortedPrices) { if (counts[p] > maxC) { maxC = counts[p]; pocTick = p; } }

                        const target = totalTPO * 0.7;
                        let current = maxC, upIdx = sortedPrices.indexOf(pocTick) + 1, dnIdx = sortedPrices.indexOf(pocTick) - 1;

                        while (current < target) {
                            const upVol = (upIdx < sortedPrices.length) ? counts[sortedPrices[upIdx]] : 0;
                            const dnVol = (dnIdx >= 0) ? counts[sortedPrices[dnIdx]] : 0;
                            if (upVol === 0 && dnVol === 0) break;
                            if (upVol >= dnVol) { current += upVol; upIdx++; if (dnVol > 0 && current < target) { current += dnVol; dnIdx--; } }
                            else { current += dnVol; dnIdx--; }
                        }
                        return {
                            hva: sortedPrices[Math.min(upIdx - 1, sortedPrices.length - 1)] / 4,
                            lva: sortedPrices[Math.max(dnIdx + 1, 0)] / 4,
                            poc: pocTick / 4
                        };
                    };

                    // 1. Standard
                    const tpoStandard = calcTPO(night);

                    // 2. Debug Loop: Globez (18:00 Start approx) -> pClose is 17:00
                    const nightGlobez = night.filter(b => b.dt.ts >= (pClose + 3600000));
                    const tpoGlobez = nightGlobez.length ? calcTPO(nightGlobez) : tpoStandard;

                    // USE STANDARD FOR NOW
                    const { hva, lva, poc } = tpoStandard;

                    if (this.c.npoc) lvls.push({ n: 'nPOC', p: poc, a: 1, d: 'BOTH' });
                    if (this.c.hnln) {
                        lvls.push({ n: 'HN', p: hN, a: 1, d: 'SHORT' });
                        lvls.push({ n: 'LN', p: lN, a: 1, d: 'LONG' });
                    }
                    if (this.c.hva) {
                        lvls.push({ n: 'HVA', p: hva, a: 1, d: 'SHORT' });
                        lvls.push({ n: 'LVA', p: lva, a: 1, d: 'LONG' });
                    }
                }

                // --- PREVIOUS DAY LEVELS (Static) ---
                if (this.c.pday) {
                    lvls.push({ n: 'P-HD', p: pH, a: 1, d: 'SHORT' });
                    lvls.push({ n: 'P-LD', p: pL, a: 1, d: 'LONG' });
                }

                // --- SINGLE PRINTS (SP) LOGIC ---
                if (this.c.sp && night.length > 0) {
                    const spMap = {}; // Price -> Set(PeriodIndex)
                    // Group Night Session into 30m Buckets
                    const startTs = night[0].dt.ts;
                    night.forEach(b => {
                        const diffMs = b.dt.ts - startTs;
                        const pIdx = Math.floor(diffMs / (30 * 60 * 1000)); // 0, 1, 2...
                        for (let p = Math.floor(b.l * 4); p <= Math.floor(b.h * 4); p++) {
                            if (!spMap[p]) spMap[p] = new Set();
                            spMap[p].add(pIdx);
                        }
                    });

                    // Identify Single Prints (Count === 1)
                    const singles = [];
                    Object.keys(spMap).forEach(k => {
                        if (spMap[k].size === 1) singles.push(Number(k));
                    });
                    singles.sort((a, b) => a - b);

                    // Cluster them into Zones
                    // Increase min size to 8 ticks (2 points) to reduce noise
                    if (singles.length > 0) {
                        let clusters = [];
                        let currentCluster = [singles[0]];

                        for (let i = 1; i < singles.length; i++) {
                            if (singles[i] === singles[i - 1] + 1) {
                                currentCluster.push(singles[i]);
                            } else {
                                if (currentCluster.length >= 8) clusters.push(currentCluster);
                                currentCluster = [singles[i]];
                            }
                        }
                        if (currentCluster.length >= 8) clusters.push(currentCluster);

                        // Create Levels from Clusters
                        clusters.forEach(c => {
                            const botP = c[0] / 4;
                            const topP = c[c.length - 1] / 4;
                            // Unified Name 'SP'
                            // Front-run 5 pts, Fixed SL 10, TP 50
                            // We define specific props for this level type
                            lvls.push({ n: 'SP', p: topP, a: 1, d: 'LONG', props: { off: 5, sl: 10, tp: 50 } });
                            lvls.push({ n: 'SP', p: botP, a: 1, d: 'SHORT', props: { off: 5, sl: 10, tp: 50 } });
                        });
                    }
                } // End SP Logic

                // --- ADD ACTIVE GAPS TO LEVELS ---
                if (this.c.gap && this.gapRepo.length > 0) {
                    this.gapRepo.forEach(g => {
                        // Inherit global Offset unless specific logic needed
                        // User mentioned "Cancel the 2 pts... maybe 25530" which is +5. 
                        // We will rely on global offset or default props if we want.
                        // For now use standard level struct.
                        lvls.push({ n: 'GAP', p: g.p, a: 1, d: g.d, gapTarget: g.target });
                    });
                }

            }


            this.sim(rth, lvls);
            pH = Math.max(...rth.map(b => b.h)); pL = Math.min(...rth.map(b => b.l));
            pClose = rth[rth.length - 1].dt.ts;
            // Note: pClose is TS here? No, in sim() we pushed ex. Waiting.
            // Original code: pClose = rth[rth.length - 1].dt.ts; 
            // WAIT, pClose should be PRICE for Gap Detection!
            // Line 189 in original: pClose = rth[rth.length - 1].dt.ts; <- This looks like a BUG in original or I misread.
            // Let's check constructor/usage. 
            // Usage: const night = this.d.filter(b => b.dt.ts > pClose ... 
            // Yes, pClose IS TIMESTAMP in the original code logic for filtering time.
            // BUT for GAP Price we need the PRICE.
            // I need to track pClosePrice separately or extract it.

            // Re-reading original line 50: let pH = null, pL = null, pClose = 0; (Initialized to 0)
            // Re-reading original line 189: pClose = rth[rth.length - 1].dt.ts; (Updated to TS)

            // I need to capture the CLOSE PRICE of the last bar.
            if (rth.length) {
                this.prevClosePrice = rth[rth.length - 1].c;
                pClose = rth[rth.length - 1].dt.ts;
            } else {
                // First loop day, pClose is 0.
            }

            // --- POST-SESSION SP UPDATE ---
            if (this.c.sp) {
                // Remove burned
                this.spRepo = this.spRepo.filter(l => l.a === 1);
                // Add Today's RTH SPs (for tomorrow)
                if (rth.length > 0) {
                    const rthSPs = this.getSPs(rth);
                    rthSPs.forEach(l => {
                        this.spRepo.push({ ...l, props: { off: 5, sl: 10, tp: 50 }, a: 1 });
                    });
                }
            }

            // --- POST-SESSION GAP CLEANUP (Day Session Update) ---
            if (this.c.gap && this.gapRepo.length > 0) {
                // Check if Day Session filled any gaps
                const dayH = Math.max(...rth.map(b => b.h));
                const dayL = Math.min(...rth.map(b => b.l));

                this.gapRepo = this.gapRepo.filter(g => {
                    let filled = false;
                    if (g.d === 'LONG') { // Support Level
                        // Gap Filled if price went DOWN to target (pClose)
                        if (dayL <= g.target) filled = true;
                    } else { // Resistance
                        if (dayH >= g.target) filled = true;
                    }
                    return !filled;
                });
            }

        });
        return this.T;
    }



    sim(bars, lvls) {
        let pos = null;
        let sessH = -Infinity, sessL = Infinity;

        for (let b of bars) {
            const tMin = b.dt.date.getHours() * 60 + b.dt.date.getMinutes();

            // 0. Force Close at 16:55 (1015 min)
            if (pos && tMin >= 1015) {
                const ex = b.o;
                const st = 'C';
                const rawPnlPts = pos.d === 'LONG' ? ex - pos.en : pos.en - ex;
                const ticksSlip = this.c.slip * 0.25;
                const slipCostPts = ticksSlip; // Slip on Market Close
                const netPnlPts = rawPnlPts - slipCostPts;
                const grossUsd = rawPnlPts * 20;
                const totalComm = this.c.comm * 2;
                const slipUsd = slipCostPts * 20;
                const netUsd = grossUsd - totalComm - slipUsd;

                this.T.push({
                    date: b.dt.getDateStr(), entryTime: pos.tStr, dir: pos.d, level: pos.ln,
                    trigPrice: pos.tpP, entry: pos.en, exitTime: b.dt.getTimeStr(), exit: ex,
                    pnl: netPnlPts, pnlUsd: netUsd, status: st,
                    mfe: pos.maxFav,
                    details: { gross: grossUsd, comm: totalComm, slip: slipUsd }
                });
                pos = null;
            }

            // 1. Construct Path
            let path = [];
            path.push({ p: b.o, t: b.dt.getTimeStr() });
            if (b.c >= b.o) {
                path.push({ p: b.l, t: b.dt.getTimeStr() });
                path.push({ p: b.h, t: b.dt.getTimeStr() });
            } else {
                path.push({ p: b.h, t: b.dt.getTimeStr() });
                path.push({ p: b.l, t: b.dt.getTimeStr() });
            }
            path.push({ p: b.c, t: b.dt.getTimeStr() });

            // 2. Process Segments
            for (let i = 0; i < path.length - 1; i++) {
                let p1 = path[i].p;
                const p2 = path[i + 1].p;
                let tStr = path[i + 1].t;

                // --- DYNAMIC HD/LD UPDATES (Intra-Bar) ---
                if (this.c.tpo_day) {
                    if (path[i].p > sessH) {
                        sessH = path[i].p;
                        // Use separate D-HD for Dynamic Day High
                        let hd = lvls.find(x => x.n === 'D-HD');
                        if (this.c.dday) {
                            if (!hd) { hd = { n: 'D-HD', p: sessH, a: 1, d: 'SHORT' }; lvls.push(hd); }
                            else { hd.p = sessH; hd.a = 1; }
                        }
                    }
                    if (path[i].p < sessL) {
                        sessL = path[i].p;
                        let ld = lvls.find(x => x.n === 'D-LD');
                        if (this.c.dday) {
                            if (!ld) { ld = { n: 'D-LD', p: sessL, a: 1, d: 'LONG' }; lvls.push(ld); }
                            else { ld.p = sessL; ld.a = 1; }
                        }
                    }
                }

                // --- OPENING RANGE LOGIC (09:30 - 10:00) ---
                // RTH Starts 09:30 (570 min). OR Ends 10:00 (600 min).
                let orH = null, orL = null;
                const minTime = b.dt.date.getHours() * 60 + b.dt.date.getMinutes();

                // We need to calculate OR High/Low dynamically if we are past 10:00
                // For simplicity, we can do this just once per day or check efficiently.
                // Since this loop is bar-by-bar, let's just calc if needed.
                if (this.c.orFilter && minTime >= 600) {
                    // Find 09:30-10:00 bars for this day.
                    // Optimization: We can compute this outside the loop once per day, but 'path' is granular.
                    // Let's assume 'rth' contains all bars for the day.
                    const orBars = bars.filter(x => {
                        const t = x.dt.date.getHours() * 60 + x.dt.date.getMinutes();
                        return t >= 570 && t < 600;
                    });
                    if (orBars.length) {
                        orH = Math.max(...orBars.map(x => x.h));
                        orL = Math.min(...orBars.map(x => x.l));
                    }
                }

                // --- DISTANCE RESET LOGIC (Unlocking) ---
                if (this.c.useDistReset) {
                    lvls.forEach(l => {
                        if (l.locked) {
                            const dist = Math.abs(p1 - l.p); // Use current path price
                            if (dist >= this.c.distReset) {
                                l.locked = false;
                                // console.log(`Unlocked ${l.n} at ${tStr} (Dist: ${dist.toFixed(2)})`);
                            }
                        }
                    });
                }

                // INTRA-BAR RESCAN LOOP
                let segmentDone = false;
                while (!segmentDone) {
                    segmentDone = true;

                    // A. Check Exits
                    if (pos) {
                        const segMax = Math.max(p1, p2);
                        const segMin = Math.min(p1, p2);

                        if (pos.d === 'LONG') {
                            pos.maxFav = Math.max(pos.maxFav, segMax - pos.en);
                        } else {
                            pos.maxFav = Math.max(pos.maxFav, pos.en - segMin);
                        }

                        let ex = null, st = null;
                        if (pos.d === 'LONG') {
                            if (p1 <= pos.sl) { ex = p1; st = 'L'; }
                            else if (p1 >= pos.tp) { ex = p1; st = 'W'; }
                            else {
                                const hitSL = (pos.sl >= segMin && pos.sl <= segMax);
                                const hitTP = (pos.tp >= segMin && pos.tp <= segMax);
                                if (hitSL) { ex = pos.sl; st = 'L'; }
                                else if (hitTP) { ex = pos.tp; st = 'W'; }
                            }
                        } else {
                            if (p1 >= pos.sl) { ex = p1; st = 'L'; }
                            else if (p1 <= pos.tp) { ex = p1; st = 'W'; }
                            else {
                                const hitSL = (pos.sl >= segMin && pos.sl <= segMax);
                                const hitTP = (pos.tp >= segMin && pos.tp <= segMax);
                                if (hitSL) { ex = pos.sl; st = 'L'; }
                                else if (hitTP) { ex = pos.tp; st = 'W'; }
                            }
                        }

                        if (ex !== null) {
                            const rawPnlPts = pos.d === 'LONG' ? ex - pos.en : pos.en - ex;
                            const ticksSlip = this.c.slip * 0.25;
                            let slipCostPts = 0;
                            if (st === 'L') slipCostPts = ticksSlip;
                            const netPnlPts = rawPnlPts - slipCostPts;
                            const grossUsd = rawPnlPts * 20;
                            const totalComm = this.c.comm * 2;
                            const slipUsd = slipCostPts * 20;
                            const netUsd = grossUsd - totalComm - slipUsd;

                            this.T.push({
                                date: b.dt.getDateStr(), entryTime: pos.tStr, dir: pos.d, level: pos.ln,
                                trigPrice: pos.tpP, entry: pos.en, exitTime: tStr, exit: ex,
                                pnl: netPnlPts, pnlUsd: netUsd, status: st,
                                mfe: pos.maxFav,
                                details: { gross: grossUsd, comm: totalComm, slip: slipUsd }
                            });

                            // --- DISTANCE RESET LOGIC (Locking) ---
                            // If SL Hit and Feature Enabled for specific levels
                            if (st === 'L' && this.c.useDistReset) {
                                const targetTypes = ['VWAP', 'nPOC', 'mPOC', 'RN'];
                                const levelObj = lvls.find(l => l.n === pos.ln || (l.n.startsWith('RN') && pos.ln.startsWith('RN')));

                                if (levelObj && (targetTypes.includes(levelObj.n) || levelObj.n.startsWith('RN'))) {
                                    levelObj.locked = true;
                                    // console.log(`Locked ${levelObj.n} at ${b.dt.getTimeStr()}`);
                                }
                            }

                            // Burn Logic for Static Levels
                            const l = lvls.find(x => x.n === pos.ln);
                            if (l && st === 'L') {
                                const burnList = ['P-HD', 'P-LD', 'HN', 'LN'];
                                if (burnList.includes(l.n)) {
                                    l.a = 0; // Disable level
                                }
                            }
                            pos = null;

                            // RESCAN LOGIC
                            if (Math.abs(ex - p2) > 0.01) {
                                p1 = ex;
                                segmentDone = false;
                                continue;
                            }
                        }
                    }

                    // B. Check Entries
                    if (!pos && (b.dt.date.getHours() * 60 + b.dt.date.getMinutes()) < 960) {
                        let active = lvls.filter(x => x.a);
                        // VWAP/Round Logic
                        if (this.c.vwap && b.v) {
                            let v = active.find(x => x.n === 'VWAP');
                            if (!v && lvls.find(x => x.n === 'VWAP')) v = lvls.find(x => x.n === 'VWAP');
                            if (!v) { v = { n: 'VWAP', p: b.v, a: 1, d: 'BOTH' }; lvls.push(v); active.push(v); }
                            else { v.p = b.v; if (!active.includes(v)) active.push(v); }
                        }
                        const minP = Math.min(p1, p2), maxP = Math.max(p1, p2);
                        if (this.c.rnd) {
                            const startR = Math.ceil(minP / 100) * 100;
                            for (let r = startR; r <= maxP; r += 100) {
                                active.push({ n: 'Round', p: r, a: 1, d: 'BOTH' });
                            }
                        }

                        let potentials = [];
                        for (let l of active) {
                            // Determine effective offset for this level
                            const effectiveOffset = (l.props && l.props.off !== undefined) ? l.props.off : this.c.off;

                            const sT = l.p - effectiveOffset;
                            const lT = l.p + effectiveOffset;

                            // Standard Logic: Fade the Level
                            // If coming from BELOW (Up Move) -> SHORT
                            // If coming from ABOVE (Down Move) -> LONG

                            if (l.d === 'BOTH') {
                                // BOTH means we treat sT and lT as active lines for BOTH directions

                                // Check Lower Band (sT)
                                if (p1 < sT && p2 >= sT) potentials.push({ t: sT, type: 'SHORT', lvl: l }); // Fade Up
                                if (p1 > sT && p2 <= sT) potentials.push({ t: sT, type: 'LONG', lvl: l });  // Fade Down (Support)

                                // Check Upper Band (lT)
                                if (p1 < lT && p2 >= lT) potentials.push({ t: lT, type: 'SHORT', lvl: l }); // Fade Up (Resistance)
                                if (p1 > lT && p2 <= lT) potentials.push({ t: lT, type: 'LONG', lvl: l });  // Fade Down
                            } else {
                                // Directional Levels (Strict)
                                if (l.d === 'SHORT' && p1 < sT && p2 >= sT) {
                                    potentials.push({ t: sT, type: 'SHORT', lvl: l });
                                }
                                if (l.d === 'LONG' && p1 > lT && p2 <= lT) {
                                    potentials.push({ t: lT, type: 'LONG', lvl: l });
                                }
                            }
                        }
                        potentials.sort((a, b) => (p1 < p2) ? (a.t - b.t) : (b.t - a.t));

                        if (potentials.length) {
                            if (this.c.debug) {
                                this.debugLogs.push({
                                    d: b.dt.getDateStr(), t: b.dt.getTimeStr(), e: 'Check',
                                    m: `Potentials: ${potentials.map(x => `${x.type} @ ${x.t} (Lvl: ${x.lvl.n})`).join(', ')}`
                                });
                            }
                            const hit = potentials[0];
                            // Check if Locked
                            if (hit.lvl.locked) {
                                // console.log(`Skipped Locked Level ${hit.lvl.n} at ${Math.max(p1,p2)}`);
                            } else {
                                // --- OR FILTER CHECK ---
                                let allowed = true;
                                if (this.c.orFilter && orH !== null && orL !== null) {
                                    if (hit.type === 'SHORT' && hit.t > orH) { allowed = false; if (this.c.debug) console.log(`  -> Filtered by OR (Short > ${orH})`); }
                                    if (hit.type === 'LONG' && hit.t < orL) { allowed = false; if (this.c.debug) console.log(`  -> Filtered by OR (Long < ${orL})`); }
                                }

                                if (allowed) {
                                    if (this.c.debug) console.log(`  -> TRADE TAKEN: ${hit.type} @ ${hit.t} (Lvl: ${hit.lvl.n})`);
                                    let calcTp = this.c.tp;
                                    let calcSl = this.c.sl;

                                    // --- DYNAMIC TP LOGIC ---
                                    if (this.c.dynamicTP) {
                                        let bestDist = Infinity;
                                        for (let l of active) {
                                            if (l.n === hit.lvl.n) continue;
                                            let dist = Infinity;
                                            if (hit.type === 'LONG' && l.p > hit.t) dist = l.p - hit.t;
                                            else if (hit.type === 'SHORT' && l.p < hit.t) dist = hit.t - l.p;

                                            if (dist > 0 && dist < bestDist) bestDist = dist;
                                        }
                                        if (bestDist !== Infinity) calcTp = bestDist;
                                    }

                                    // --- CUSTOM PROPS OVERRIDE (SP) ---
                                    if (hit.lvl.props) {
                                        if (hit.lvl.props.sl !== undefined) calcSl = hit.lvl.props.sl;
                                        if (hit.lvl.props.tp !== undefined) calcTp = hit.lvl.props.tp; // Fixed TP overrides Dynamic
                                    }
                                    pos = {
                                        d: hit.type,
                                        en: hit.t,
                                        sl: hit.type === 'LONG' ? hit.t - calcSl : hit.t + calcSl,
                                        tp: hit.type === 'LONG' ? hit.t + calcTp : hit.t - calcTp,
                                        ln: hit.lvl.n,
                                        tpP: hit.lvl.p,
                                        tStr: tStr,
                                        maxFav: 0
                                    };

                                    // STRICT BURN LOGIC FOR SP
                                    if (hit.lvl.n === 'SP') {
                                        hit.lvl.a = 0;
                                    }

                                    p1 = pos.en;
                                    segmentDone = false;

                                }
                            }
                        }
                    } // end while
                } // end segment
            }
        }
    }
    getSPs(bars) {
        if (!bars || !bars.length) return [];
        const spMap = {};
        const startTs = bars[0].dt.ts;
        bars.forEach(b => {
            const diffMs = b.dt.ts - startTs;
            const pIdx = Math.floor(diffMs / (30 * 60 * 1000));
            for (let p = Math.floor(b.l * 4); p <= Math.floor(b.h * 4); p++) {
                if (!spMap[p]) spMap[p] = new Set();
                spMap[p].add(pIdx);
            }
        });

        const singles = [];
        Object.keys(spMap).forEach(k => { if (spMap[k].size === 1) singles.push(Number(k)); });
        singles.sort((a, b) => a - b);

        let clusters = [];
        if (singles.length > 0) {
            let currentCluster = [singles[0]];
            for (let i = 1; i < singles.length; i++) {
                if (singles[i] === singles[i - 1] + 1) currentCluster.push(singles[i]);
                else {
                    if (currentCluster.length >= 8) clusters.push(currentCluster);
                    currentCluster = [singles[i]];
                }
            }
            if (currentCluster.length >= 8) clusters.push(currentCluster);
        }

        const res = [];
        clusters.forEach(c => {
            const botP = c[0] / 4;
            const topP = c[c.length - 1] / 4;
            res.push({ n: 'SP', p: topP, a: 1, d: 'LONG' });
            res.push({ n: 'SP', p: botP, a: 1, d: 'SHORT' });
        });
        return res;
    }
}

// UI Handlers
document.addEventListener('DOMContentLoaded', () => {
    let currentData = [];
    let currentSort = { key: 'date', dir: 'desc' }; // Default DESC

    const render = (res) => {
        // Initial Sort
        res.sort((a, b) => {
            if (a.date < b.date) return 1;
            if (a.date > b.date) return -1;
            return 0; // Secondary sort by time?
        });

        // Sync Header Arrows
        document.querySelectorAll('#sort-headers th').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
            if (th.dataset.key === currentSort.key) th.classList.add('sort-' + currentSort.dir);
        });

        currentData = res;
        updateTable(res);
        updateKPI(res);
        if (logs) renderDebugLog(logs);
    };

    const renderStats = (data) => {
        const container = document.getElementById('stats-container');
        const tbody = document.getElementById('stats-body');

        if (!container || !tbody) {
            console.error("Critical: Stats container/body missing from DOM");
            return;
        }

        // 1. Show Container
        container.style.display = 'flex';

        // 2. Aggregate Data
        const stats = {};
        data.forEach(t => {
            const k = String(t.level || 'Unknown');
            if (!stats[k]) stats[k] = { count: 0, wins: 0, pnl: 0 };
            stats[k].count++;
            stats[k].pnl += t.pnlUsd;
            if (t.pnl > 0) stats[k].wins++;
        });

        // 3. Render Rows
        tbody.innerHTML = '';
        Object.keys(stats).sort().forEach(lvl => {
            const s = stats[lvl];
            const winRate = ((s.wins / s.count) * 100).toFixed(0) + '%';
            const cls = s.pnl >= 0 ? 'text-green' : 'text-red';
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${lvl}</td><td>${s.count}</td><td>${winRate}</td><td class="${cls}">$${s.pnl.toFixed(2)}</td>`;
            tbody.appendChild(tr);
        });
    };

    // NEW Debug Log Render
    const renderDebugLog = (logs) => {
        const container = document.getElementById('debug-log-container');
        const tbody = document.getElementById('debug-body');
        if (!container || !tbody) return;

        if (!logs || !logs.length) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        tbody.innerHTML = '';
        // Show last 1000 events
        logs.slice(-1000).reverse().forEach(l => {
            const tr = document.createElement('tr');
            let color = '#bababa';
            if (l.e === 'Trade') color = '#00ff00';
            if (l.e === 'Filter') color = '#ff5555';

            tr.innerHTML = `
                <td style="padding: 4px; border-bottom: 1px solid #333;">${l.d}</td>
                <td style="padding: 4px; border-bottom: 1px solid #333;">${l.t}</td>
                <td style="padding: 4px; border-bottom: 1px solid #333; color: ${color}; font-weight: bold;">${l.e}</td>
                <td style="padding: 4px; border-bottom: 1px solid #333; word-break: break-all;">${l.m}</td>
            `;
            tbody.appendChild(tr);
        });
    };





    const updateKPI = (res) => {
        try {
            renderStats(res); // Delegate to new function

            // KPI Logic (existing)
            let net = 0, pts = 0, wins = 0;
            let dayPnl = {};
            let grossWin = 0, grossLoss = 0;
            let winCount = 0, lossCount = 0;

            res.forEach(t => {
                net += t.pnlUsd;
                pts += t.pnl;
                if (t.pnl > 0) { wins++; grossWin += t.pnlUsd; winCount++; }
                else { grossLoss += t.pnlUsd; lossCount++; }
                dayPnl[t.date] = (dayPnl[t.date] || 0) + t.pnlUsd;
            });

            // Basic KPIs
            const setVal = (id, txt, cls) => {
                const el = document.getElementById(id);
                if (el) { el.textContent = txt; if (cls) el.className = cls; }
            };

            setVal('kpi-pnl', '$' + net.toFixed(2), 'kpi-value ' + (net >= 0 ? 'text-green' : 'text-red'));
            setVal('kpi-pts', pts.toFixed(2), 'kpi-value ' + (pts >= 0 ? 'text-green' : 'text-red'));
            setVal('kpi-winrate', res.length ? ((wins / res.length) * 100).toFixed(1) + '%' : '0%');
            setVal('kpi-count', res.length);

            // PF & RR
            const pf = Math.abs(grossLoss) < 0.01 ? (grossWin > 0 ? 99.99 : 0) : (grossWin / Math.abs(grossLoss));
            setVal('kpi-pf', pf.toFixed(2), 'kpi-value ' + (pf >= 1.5 ? 'text-green' : (pf < 1 ? 'text-red' : '')));

            const avgWin = winCount > 0 ? grossWin / winCount : 0;
            const avgLoss = lossCount > 0 ? Math.abs(grossLoss) / lossCount : 0;
            const rr = avgLoss < 0.01 ? 0 : (avgWin / avgLoss);
            setVal('kpi-rr', rr.toFixed(2), 'kpi-value ' + (rr >= 2 ? 'text-green' : ''));

            // Worst Day
            let minVal = 0, minDate = '-';
            for (const [d, v] of Object.entries(dayPnl)) { if (v < minVal) { minVal = v; minDate = d; } }
            setVal('kpi-dd', `$${minVal.toFixed(2)} (${minDate})`, 'kpi-value ' + (minVal >= 0 ? 'text-green' : 'text-red'));

            // Best Level (Quick recalc)
            // ... (Skip complex best level logic for now to keep it safe, or reimplement simply)
            // Actually, we can just use the renderStats logic's byproduct if we wanted, but let's keep it simple.


            document.getElementById('results-panel').classList.remove('hidden');
            document.getElementById('dashboard').classList.remove('hidden');

        } catch (e) {
            console.error(e);
            alert("KPI Error: " + e.message);
        }
    };

    const updateTable = (data) => {
        const body = document.getElementById('trade-body');
        body.innerHTML = '';
        data.forEach(t => {
            const tr = document.createElement('tr');
            // Colors using text-green/text-red
            const dirClass = t.dir === 'LONG' ? 'text-green' : 'text-red';
            const pnlClass = t.pnl >= 0 ? 'text-green' : 'text-red';
            const usdClass = t.pnlUsd >= 0 ? 'text-green' : 'text-red';

            tr.innerHTML = `
                <td>${t.date}</td>
                <td>${t.entryTime}</td>
                <td class="${dirClass}">${t.dir}</td>
                <td>${t.level}</td>
                <td>${t.trigPrice.toFixed(2)}</td>
                <td>${t.entry.toFixed(2)}</td>
                <td>${t.exitTime}</td>
                <td>${t.exit.toFixed(2)}</td>
                <td>${t.mfe.toFixed(2)}</td>
                <td class="${pnlClass}">${t.pnl.toFixed(2)}</td>
                <td class="${usdClass}">$${t.pnlUsd.toFixed(2)}</td>
            `;
            body.appendChild(tr);
        });
    };

    // Sorting Logic
    document.getElementById('sort-headers').addEventListener('click', (e) => {
        if (e.target.tagName !== 'TH') return;
        const key = e.target.dataset.key;
        if (!key) return;

        // Toggle direction
        if (currentSort.key === key) {
            currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort.key = key;
            currentSort.dir = 'asc';
        }

        // Update Header Styles
        document.querySelectorAll('#sort-headers th').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
            if (th.dataset.key === key) th.classList.add('sort-' + currentSort.dir);
        });

        // Sort Data
        const sorted = [...currentData].sort((a, b) => {
            let valA = a[key], valB = b[key];
            // Handle numeric strings or dates if needed, but basic compare works for most here
            if (key === 'pnl' || key === 'pnlUsd' || key === 'entry' || key === 'exit' || key === 'trigPrice' || key === 'mfe') {
                valA = +valA; valB = +valB;
            }
            if (valA < valB) return currentSort.dir === 'asc' ? -1 : 1;
            if (valA > valB) return currentSort.dir === 'asc' ? 1 : -1;
            return 0;
        });

        updateTable(sorted);
    });

    document.getElementById('backtest-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = document.getElementById('data-file').files[0];
        if (!f) return alert("Select a file!");

        const btn = document.getElementById('run-btn');
        btn.disabled = true;
        btn.querySelector('.spinner').classList.remove('hidden');

        try {
            const raw = await parseFile(f);
            const data = new FormData(e.target);
            const cfg = {
                tp: +data.get('tp_points'),
                sl: +data.get('sl_points'),
                off: +data.get('offset_points'),
                hnln: document.getElementById('chk-hnln').checked,
                npoc: document.getElementById('chk-npoc').checked,
                hva: document.getElementById('chk-hva').checked,
                pday: document.getElementById('chk-pday').checked,
                dday: document.getElementById('chk-dday').checked,
                vwap: document.getElementById('chk-vwap').checked,
                rnd: document.getElementById('chk-rnd').checked,
                gap: document.getElementById('chk-gap').checked,
                useDistReset: document.getElementById('chk-dist-reset').checked,
                distReset: parseFloat(document.getElementById('inp-reset-dist').value) || 20,
                orFilter: document.getElementById('chk-or-filter').checked,
                dynamicTP: document.getElementById('chk-dynamic-tp').checked,
                sp: document.getElementById('chk-sp').checked,
                debug: document.getElementById('chk-debug').checked,
                slip: 0, comm: 0, tpo_day: true
            };

            const eng = new Strategy(raw, cfg);
            const res = eng.run();
            render(res, eng.debugLogs);
        } catch (x) {
            alert(x);
            console.error(x);
        } finally {
            btn.disabled = false;
            btn.querySelector('.spinner').classList.add('hidden');
        }
    });

    document.getElementById('data-file').addEventListener('change', (e) => {
        if (e.target.files[0]) document.getElementById('file-name').textContent = e.target.files[0].name;
    });
});
