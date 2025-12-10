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
    constructor(data, cfg) { this.d = data; this.c = cfg; this.T = []; }
    run() {
        const days = [...new Set(this.d.map(x => x.dt.getDateStr()))].sort();
        let pH = null, pL = null, pClose = 0;

        days.forEach(day => {
            const bars = this.d.filter(b => b.dt.getDateStr() === day);
            const rth = bars.filter(b => { const h = b.dt.date.getHours(), m = b.dt.date.getMinutes(); return (h * 60 + m) >= 570 && (h * 60 + m) < 1020; }); // 09:30-17:00

            if (!rth.length) return;
            let lvls = [];

            if (pH !== null) {
                const openTs = rth[0].dt.ts;

                // --- NIGHT SESSION ANALYSIS ---
                const night = this.d.filter(b => b.dt.ts > pClose && b.dt.ts < openTs);
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

                    // LOGGING
                    if (day.includes('2025-12-05')) {
                        console.log(`DEBUG 12-05: 17:00 HVA=${tpoStandard.hva} | 18:00 HVA=${tpoGlobez.hva}`);
                        setTimeout(() => {
                            const dbg = document.getElementById('debug-info');
                            if (dbg) dbg.innerHTML = `<span style='color:orange'>DEBUG DEC 5:</span> 17:00 HVA=${tpoStandard.hva} | 18:00 HVA=${tpoGlobez.hva} | <span style='color:white'>Target: 25736.75</span>`;
                        }, 1000);
                    }

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
            }

            this.sim(rth, lvls);
            pH = Math.max(...rth.map(b => b.h)); pL = Math.min(...rth.map(b => b.l));
            pClose = rth[rth.length - 1].dt.ts;
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
                            const sT = l.p - this.c.off;
                            const lT = l.p + this.c.off;

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
                            const hit = potentials[0];
                            // Check if Locked
                            if (hit.lvl.locked) {
                                // console.log(`Skipped Locked Level ${hit.lvl.n} at ${Math.max(p1,p2)}`);
                            } else {
                                pos = {
                                    d: hit.type,
                                    en: hit.t,
                                    sl: hit.type === 'LONG' ? hit.t - this.c.sl : hit.t + this.c.sl,
                                    tp: hit.type === 'LONG' ? hit.t + this.c.tp : hit.t - this.c.tp,
                                    ln: hit.lvl.n,
                                    tpP: hit.lvl.p,
                                    tStr: tStr,
                                    maxFav: 0
                                };
                                p1 = pos.en;
                                segmentDone = false;
                            }
                        }
                    } // end while
                } // end segment
            }
        }
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
    };

    // NEW Single Responsibility Function for Stats
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
        tbody.innerHTML = ''; // Wipe clean
        const keys = Object.keys(stats).sort();

        if (keys.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="padding:10px; text-align:center; color:#666;">No Trades Yet</td></tr>';
            return;
        }

        keys.forEach(key => {
            const s = stats[key];
            const winRate = Math.round((s.wins / s.count) * 100);
            const tr = document.createElement('tr');

            // Simple inline styles to guarantee visibility
            const colorWin = winRate >= 50 ? '#10b981' : '#ef4444';
            const colorPnl = s.pnl >= 0 ? '#10b981' : '#ef4444';

            tr.innerHTML = `
                <td style="padding:6px; border-bottom:1px solid #333;">${key}</td>
                <td style="padding:6px; border-bottom:1px solid #333; text-align:center;">${s.count}</td>
                <td style="padding:6px; border-bottom:1px solid #333; color:${colorWin};">${winRate}%</td>
                <td style="padding:6px; border-bottom:1px solid #333; color:${colorPnl};">$${s.pnl.toFixed(0)}</td>
            `;
            tbody.appendChild(tr);
        });

        // Update Debug Info
        const dbg = document.getElementById('debug-info');
        if (dbg) dbg.textContent = `Status: Showing ${keys.length} Triggers (v1000)`;
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
            setVal('kpi-best', 'Check Table');

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
                useDistReset: document.getElementById('chk-dist-reset').checked,
                distReset: parseFloat(document.getElementById('inp-reset-dist').value) || 20,
                slip: 0, comm: 0, tpo_day: true
            };

            const eng = new Strategy(raw, cfg);
            const res = eng.run();
            render(res);
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
