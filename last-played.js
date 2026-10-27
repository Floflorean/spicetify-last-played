/* Last Played for Spicetify — standalone, local-only, no external dependencies.
 * Install: spicetify config extensions last-played.js && spicetify apply
 * Profile menu > Last Played: import Spotify Extended Streaming History JSON/ZIP.
 * Records a configurable duration of observed playback; never treats seeking as listening.
 * Data lives in an account-specific IndexedDB database. Export backups before
 * clearing Spotify's application data. No playlists or ratings are modified.
 */
(function () {
    "use strict";
    const THRESHOLD = 30000;
    const FORMAT = "spicetify-last-played";
    const TRACK = /^spotify:track:[A-Za-z0-9]+$/;
    const MAX_JSON = 256 * 1024 * 1024;
    const MAX_EXPANDED = 512 * 1024 * 1024;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const isTrack = uri => typeof uri === "string" && TRACK.test(uri);

    class ListenTracker {
        constructor(threshold = THRESHOLD) { this.threshold = threshold; this.reset(); }
        reset() { this.previous = null; this.heard = 0; this.qualified = false; this.savedAt = 0; this.lastHeardAt = 0; }
        finish() {
            if (!this.previous || !this.qualified || this.lastHeardAt <= this.savedAt) return null;
            this.savedAt = this.lastHeardAt;
            return { uri:this.previous.uri, at:this.lastHeardAt };
        }
        sample(current) {
            const writes = [];
            const valid = isTrack(current.uri) && Number.isFinite(current.position) && Number.isFinite(current.now);
            const previous = this.previous;
            const wrapped = previous && previous.uri === current.uri && previous.duration > 0 &&
                previous.position >= previous.duration - 2500 && current.position < 2000 &&
                current.position < previous.position - 2500;
            if (!valid || !previous || previous.uri !== current.uri || wrapped) {
                const last = this.finish();
                if (last) writes.push(last);
                this.reset();
                if (valid) this.previous = current;
                return writes;
            }
            const elapsed = current.now - previous.now;
            const advanced = current.position - previous.position;
            // Reject seeks, clock discontinuities, and sleep/background gaps.
            if (current.playing && previous.playing && elapsed > 0 && elapsed <= 10000 &&
                advanced > 0 && advanced <= elapsed + 1500) {
                this.heard += Math.min(advanced, elapsed);
                this.lastHeardAt = current.now;
                if (this.heard >= this.threshold) {
                    this.qualified = true;
                    if (!this.savedAt || current.now - this.savedAt >= 15000) {
                        writes.push({ uri:current.uri, at:current.now });
                        this.savedAt = current.now;
                    }
                }
            }
            if (previous.playing && !current.playing) {
                const last = this.finish();
                if (last) writes.push(last);
            }
            this.previous = current;
            return writes;
        }
    }

    function parseTime(value) {
        if (typeof value === "number") return value;
        if (typeof value !== "string") return NaN;
        const utc = /^\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?$/.test(value)
            ? value.replace(" ", "T") + "Z" : value;
        return Date.parse(utc);
    }

    async function parseHistory(text, now = Date.now(), yieldTask = async () => {}, threshold = THRESHOLD) {
        const data = JSON.parse(text.replace(/^\uFEFF/, ""));
        const backup = data?.format === FORMAT;
        if (backup && data.version !== 1) throw new Error("Unsupported Last Played backup version.");
        const records = backup ? data.tracks : Array.isArray(data) ? data : null;
        if (!Array.isArray(records)) throw new Error("Expected Spotify Extended Streaming History JSON or a Last Played backup.");
        const latest = new Map();
        const stats = { rows:records.length, qualifying:0, noTrack:0, short:0, invalid:0, backup };
        for (let index = 0; index < records.length; index++) {
            const row = records[index];
            if (!row || typeof row !== "object") { stats.invalid++; continue; }
            const uri = backup ? row.uri : row.spotify_track_uri;
            if (!isTrack(uri)) { stats.noTrack++; continue; }
            if (!backup && (!Number.isFinite(row.ms_played) || row.ms_played < threshold)) { stats.short++; continue; }
            const at = parseTime(backup ? row.at : row.ts);
            if (!Number.isFinite(at) || at < 0 || at > now + 300000) { stats.invalid++; continue; }
            stats.qualifying++;
            latest.set(uri, Math.max(latest.get(uri) || 0, at));
            if (index > 0 && index % 5000 === 0) await yieldTask();
        }
        return { latest, stats };
    }

    function zipDirectory(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let end = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
            if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
        }
        if (end < 0) throw new Error("Not a supported ZIP. Extract it and select the history JSON files instead.");
        const count = view.getUint16(end + 10, true);
        const start = view.getUint32(end + 16, true);
        const size = view.getUint32(end + 12, true);
        if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) ||
            count === 65535 || start === 0xffffffff || count > 10000 || start + size > end)
            throw new Error("Split/ZIP64 archives are not supported. Extract the ZIP and import the JSON files.");
        let offset = start;
        let expanded = 0;
        const entries = [];
        for (let i = 0; i < count; i++) {
            if (offset + 46 > start + size || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Damaged ZIP directory.");
            const nameLength = view.getUint16(offset + 28, true);
            const extra = view.getUint16(offset + 30, true);
            const comment = view.getUint16(offset + 32, true);
            const next = offset + 46 + nameLength + extra + comment;
            if (next > start + size) throw new Error("Damaged ZIP filename.");
            const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            if (/\.json$/i.test(name) && !name.startsWith("__MACOSX/")) {
                const entry = { name, flags:view.getUint16(offset + 8, true), method:view.getUint16(offset + 10, true),
                    compressed:view.getUint32(offset + 20, true), size:view.getUint32(offset + 24, true),
                    crc:view.getUint32(offset + 16, true), offset:view.getUint32(offset + 42, true) };
                expanded += entry.size;
                if (entry.size > MAX_JSON || expanded > MAX_EXPANDED) throw new Error("This ZIP is too large to import at once. Extract it and import the JSON files in smaller groups.");
                entries.push(entry);
            }
            offset = next;
        }
        return entries;
    }

    const crcTable = Uint32Array.from({ length:256 }, (_, value) => {
        for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
        return value >>> 0;
    });
    function crc32(bytes, previous = 0) {
        let crc = previous ^ 0xffffffff;
        for (const byte of bytes) crc = crc >>> 8 ^ crcTable[(crc ^ byte) & 255];
        return (crc ^ 0xffffffff) >>> 0;
    }
    async function checksum(bytes) {
        let crc = 0;
        for (let offset = 0; offset < bytes.length; offset += 1048576) {
            crc = crc32(bytes.subarray(offset, offset + 1048576), crc);
            await sleep(0);
        }
        return crc;
    }

    async function unzipEntry(bytes, entry) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const offset = entry.offset;
        if (entry.flags & 1) throw new Error("Password-protected ZIPs are not supported.");
        if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) throw new Error("Damaged ZIP entry.");
        const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
        if (start + entry.compressed > bytes.length) throw new Error("Truncated ZIP entry.");
        const compressed = bytes.subarray(start, start + entry.compressed);
        let result;
        if (entry.method === 0) result = compressed;
        else if (entry.method === 8) {
            let decoder;
            try { decoder = new DecompressionStream("deflate-raw"); }
            catch { throw new Error("This Spotify version cannot decompress this ZIP. Extract it and select the JSON files instead."); }
            const reader = new Blob([compressed]).stream().pipeThrough(decoder).getReader();
            const chunks = [];
            let size = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > entry.size || size > MAX_JSON) throw new Error("ZIP entry exceeds its declared size.");
                    chunks.push(value);
                }
            } catch (error) { await reader.cancel().catch(() => {}); throw error; }
            result = new Uint8Array(size);
            let cursor = 0;
            for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
        } else throw new Error("Unsupported ZIP compression. Extract it and import the JSON files.");
        if (result.length !== entry.size || await checksum(result) !== entry.crc) throw new Error("ZIP integrity check failed for " + entry.name);
        return new TextDecoder("utf-8", { fatal:true }).decode(result);
    }

    function relativeTime(at, now = Date.now()) {
        if (!at) return "Not recorded yet";
        const age = Math.max(0, now - at);
        if (age < 60000) return "Just now";
        const [unit, size] = age < 3600000 ? ["minute", 60000] : age < 86400000 ? ["hour", 3600000]
            : age < 2592000000 ? ["day", 86400000] : age < 31536000000 ? ["month", 2592000000] : ["year", 31536000000];
        const amount = Math.floor(age / size);
        return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
    }

    function sortByLastPlayed(items, timestamps, direction) {
        return items.map((item, index) => ({ item, index })).sort((a, b) => {
            const uri = item => item.track?.uri || item.uri || item.link;
            const x = timestamps.get(uri(a.item)) || 0, y = timestamps.get(uri(b.item)) || 0;
            if (!x || !y) return x ? -1 : y ? 1 : a.index - b.index;
            return (direction === "newest" ? y - x : x - y) || a.index - b.index;
        }).map(entry => entry.item);
    }

    async function readFullPlaylist(readPage, ensureCurrent = () => {}) {
        const items = []; let template = null, total = null;
        for (let offset = 0; ; ) {
            ensureCurrent();
            const page = await readPage(offset, 200);
            ensureCurrent();
            if (!Array.isArray(page?.items)) throw new Error("Unsupported Spotify playlist response.");
            if (!template) template = page;
            const length = page.totalLength ?? page.total;
            if (length !== undefined && Number.isFinite(Number(length))) {
                if (total !== null && total !== Number(length)) throw new Error("Playlist changed while loading. Click Last played to try again.");
                total = Number(length);
            }
            if (total !== null && total < 0) throw new Error("Invalid playlist length.");
            if (total !== null && items.length + page.items.length > total) throw new Error("Inconsistent Spotify playlist pagination.");
            items.push(...page.items); offset += page.items.length;
            if (total !== null && offset === total) break;
            if (!page.items.length) {
                if (total !== null && offset < total) throw new Error("Spotify returned an incomplete playlist.");
                break;
            }
            if (total === null && page.items.length < 200) break;
            if (offset > 100000) throw new Error("Spotify did not finish paging this playlist.");
        }
        return { template, items };
    }

    // The same file can be tested with Node without starting Spotify-specific code.
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { ListenTracker, parseHistory, zipDirectory, unzipEntry, relativeTime, crc32, THRESHOLD, sortByLastPlayed, readFullPlaylist };
        return;
    }

    function accountName() {
        const api = window.Spicetify?.Platform;
        const name = api?.LocalStorageAPI?.namespace || api?.username || window.Spicetify?.User?.getUsername?.();
        return typeof name === "string" && name ? name : null;
    }
    function openDatabase(account) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("spicetify-last-played-v1:" + encodeURIComponent(account), 1);
            request.onupgradeneeded = () => request.result.createObjectStore("tracks", { keyPath:"uri" });
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("Close other Spotify windows and try again."));
            request.onsuccess = () => resolve(request.result);
        });
    }
    function allRecords(db) {
        return new Promise((resolve, reject) => {
            const request = db.transaction("tracks").objectStore("tracks").getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    function putRecords(db, records) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction("tracks", "readwrite");
            for (const record of records) tx.objectStore("tracks").put(record);
            tx.oncomplete = resolve;
            tx.onabort = tx.onerror = () => reject(tx.error || new Error("Could not save listening history."));
        });
    }

    function propsUri(props, depth = 0) {
        if (!props || depth > 5) return null;
        if (isTrack(props.uri)) return props.uri;
        if (isTrack(props.item?.uri)) return props.item.uri;
        for (const child of Array.isArray(props.children) ? props.children : [props.children]) {
            const uri = propsUri(child?.props, depth + 1);
            if (uri) return uri;
        }
        return null;
    }
    function rowUri(host) {
        for (const node of [host, ...host.querySelectorAll('[role="gridcell"], [data-encore-id="text"], a')]) {
            for (const key of Object.keys(node)) {
                const props = key.startsWith("__reactProps$") ? node[key]
                    : key.startsWith("__reactFiber$") ? node[key]?.memoizedProps : null;
                const uri = propsUri(props);
                if (uri) return uri;
            }
        }
        const id = host.querySelector('a[href*="/track/"]')?.getAttribute("href")?.match(/\/track\/([A-Za-z0-9]+)/)?.[1];
        return id ? "spotify:track:" + id : null;
    }
    const nativeCells = host => [...host.children].filter(el =>
        el.getAttribute("role")?.match(/^(gridcell|columnheader)$/) && !el.classList.contains("lp-column"));
    function rowHost(row) { return row.querySelector(':scope > [role="presentation"]') || row; }
    const dateLabel = text => /^(date added|added on|adicionado em|data de adi[cç][aã]o|fecha de incorporaci[oó]n|date d'ajout)$/i.test(text.trim());

    async function start() {
        while (!window.Spicetify?.Player?.addEventListener || !window.Spicetify?.Menu?.Item || !accountName()) await sleep(250);
        const account = String(accountName());
        const S = window.Spicetify;
        const notify = message => S.showNotification("Last Played: " + message);
        const db = await openDatabase(account);
        const cache = new Map((await allRecords(db)).filter(r => isTrack(r.uri) && Number.isFinite(r.at)).map(r => [r.uri, r.at]));
        const rows = new WeakMap();
        const trackedHosts = new Set();
        const readThreshold = Number(S.Platform.LocalStorageAPI?.getItem("lastPlayed:thresholdSeconds"));
        let threshold = Number.isFinite(readThreshold) && readThreshold >= 1 && readThreshold <= 240 ? Math.round(readThreshold) * 1000 : THRESHOLD;
        const tracker = new ListenTracker(threshold);
        const dirty = new Map();
        const disposers = [];
        let frame = 0, alive = true, importBusy = false, flushPromise = null, main = null, observer = null, saveError = "";
        let format = S.Platform.LocalStorageAPI?.getItem("lastPlayed:displayFormat") || "relative";
        const ensureAccount = () => { if (!alive || String(accountName()) !== account) throw new Error("Spotify account changed. Reopen Last Played settings."); };
        const exact = at => new Date(at).toLocaleString(undefined, { dateStyle:"full", timeStyle:"long" });

        function flush() {
            if (flushPromise) return flushPromise;
            if (!dirty.size || !alive) return Promise.resolve();
            const pending = [...dirty].map(([uri, at]) => ({ uri, at }));
            flushPromise = (async () => {
            try {
                await putRecords(db, pending);
                for (const record of pending) if (dirty.get(record.uri) === record.at) dirty.delete(record.uri);
                saveError = "";
            } catch (error) {
                if (!saveError) notify("Could not save history. Export a backup from Last Played settings. " + error.message);
                saveError = error.message; console.error("[Last Played] Save failed", error);
            } finally { flushPromise = null; }
            })();
            return flushPromise;
        }
        function record({ uri, at }) {
            if (at <= (cache.get(uri) || 0)) return;
            cache.set(uri, at); dirty.set(uri, at);
            schedule(); void flush();
        }
        function tick() {
            if (!alive || String(accountName()) !== account) return;
            try {
                const writes = tracker.sample({ uri:S.Player.data?.item?.uri, position:S.Player.getProgress(),
                    duration:S.Player.getDuration(), playing:S.Player.isPlaying(), now:Date.now() });
                writes.forEach(record);
            } catch (error) { console.debug("[Last Played] Player not ready", error); }
        }
        function disposeRow(host) {
            const state = rows.get(host);
            if (!state) return;
            state.cell.remove();
            host.removeAttribute("data-lp-grid");
            host.style.removeProperty("--lp-columns");
            if (state.position) host.style.position = state.position;
            else host.style.removeProperty("position");
            for (const [cell, index] of state.indices) {
                if (cell.isConnected) index === null ? cell.removeAttribute("aria-colindex") : cell.setAttribute("aria-colindex", index);
            }
            rows.delete(host); trackedHosts.delete(host);
        }
        function render() {
            if (!alive || String(accountName()) !== account) return;
            const path = S.Platform.History.location?.pathname || "";
            if (nativeSort && routePlaylist() !== nativeSort.uri) clearNativeSort();
            if (!/^\/(playlist\/|collection\/tracks)/.test(path)) {
                for (const host of trackedHosts) disposeRow(host);
                return;
            }
            for (const host of trackedHosts) if (!host.isConnected) disposeRow(host);
            const visible = [...document.querySelectorAll('main [role="row"]')].map(rowHost);
            const headers = [];
            for (const host of visible) {
                const cells = nativeCells(host);
                if (cells.length < 4 || !cells.every(el => el.getAttribute("role") === "columnheader")) continue;
                const date = cells.findIndex(el => dateLabel(el.textContent));
                if (date >= 0) headers.push({ host, cells, date });
            }
            if (!headers.length) { for (const host of trackedHosts) disposeRow(host); return; }
            let layoutChanged = false;
            for (const host of visible) {
                const cells = nativeCells(host);
                if (cells.length < 4) continue;
                const artwork = cells[0]?.querySelector("img");
                if (artwork && Number(artwork.getAttribute("width") || artwork.width) > 20) continue;
                const ownHeader = headers.find(h => h.host === host);
                const table = host.closest('[role="grid"], [role="table"], [data-testid="tracklist"]');
                const header = ownHeader || headers.find(h => table && h.host.closest('[role="grid"], [role="table"], [data-testid="tracklist"]') === table)
                    || headers.filter(h => h.host.getBoundingClientRect().top <= host.getBoundingClientRect().top).at(-1);
                if (!header || cells.length !== header.cells.length) continue;
                const uri = ownHeader ? null : rowUri(host);
                if (!ownHeader && !uri) continue;
                let state = rows.get(host);
                if (state && (state.cell.parentNode !== host || state.date !== cells[header.date] || state.header !== !!ownHeader)) {
                    disposeRow(host); state = null;
                }
                if (!state) {
                    const cell = document.createElement("div");
                    // Star Ratings excludes .sr-column cells from its native-column
                    // count. This class lets the extensions share a row safely.
                    cell.className = "lp-column sr-column";
                    cell.setAttribute("role", ownHeader ? "columnheader" : "gridcell");
                    state = { cell, header:!!ownHeader, date:cells[header.date], uri, indices:new Map(), position:host.style.position, offset:0 };
                    if (ownHeader) { cell.textContent = "Last played"; cell.title = "Click to sort this playlist: newest first, oldest first, then normal Spotify sorting.";
                        const button = document.createElement("button");
                        button.type = "button"; button.className = "lp-sort-header";
                        button.textContent = "Last played ↕";
                        button.onclick = event => { event.stopPropagation(); void sortInPlaylist(host); };
                        cell.replaceChildren(button); }
                    rows.set(host, state); trackedHosts.add(host);
                    host.setAttribute("data-lp-grid", "");
                    if (getComputedStyle(host).position === "static") host.style.position = "relative";
                    layoutChanged = true;
                }
                if (ownHeader) {
                    const active = nativeSort && nativeSort.uri === routePlaylist();
                    const button = state.cell.querySelector("button");
                    const text = "Last played" + (active ? nativeSortBusy ? " …" : nativeSort.direction === "newest" ? " ↓" : " ↑" : " ↕");
                    if (button && button.textContent !== text) button.textContent = text;
                    if (button) button.disabled = nativeSortBusy;
                    state.cell.setAttribute("aria-sort", active ? nativeSort.direction === "newest" ? "descending" : "ascending" : "none");
                }
                state.uri = uri;
                const before = cells[header.date + 1];
                if (state.cell.nextElementSibling !== before) { host.insertBefore(state.cell, before || null); layoutChanged = true; }
                const ordered = [...cells]; ordered.splice(header.date + 1, 0, state.cell);
                const columns = ordered.map((el, index) => {
                    if (el === state.cell) return "minmax(130px,1.5fr)";
                    if (el.classList.contains("starRatings") || el.classList.contains("starRatingsHeader")) return "104px";
                    if (index === 0) return "16px";
                    if (index === 1) return "minmax(100px,4fr)";
                    if (el === state.date) return "minmax(100px,1.4fr)";
                    if (index === ordered.length - 1) return "minmax(100px,1fr)";
                    return "minmax(60px,2fr)";
                }).join(" ");
                if (host.style.getPropertyValue("--lp-columns") !== columns) { host.style.setProperty("--lp-columns", columns); layoutChanged = true; }
                ordered.forEach((el, i) => {
                    if (el === state.cell) { if (el.getAttribute("aria-colindex") !== String(i + 1)) el.setAttribute("aria-colindex", String(i + 1)); return; }
                    if (!state.indices.has(el)) state.indices.set(el, el.getAttribute("aria-colindex"));
                    if (el.getAttribute("aria-colindex") !== String(i + 1)) el.setAttribute("aria-colindex", String(i + 1));
                });
                if (!ownHeader) {
                    const at = cache.get(uri);
                    const text = at ? format === "date" ? new Date(at).toLocaleDateString() : relativeTime(at) : "Not recorded yet";
                    const title = at ? exact(at) : "No qualifying listen recorded for this exact track ID. Import Extended Streaming History to add older plays.";
                    if (state.cell.textContent !== text) state.cell.textContent = text;
                    if (state.cell.title !== title) state.cell.title = title;
                }
                const headerCell = rows.get(header.host)?.cell;
                if (!ownHeader && headerCell) {
                    const target = headerCell.getBoundingClientRect(), current = state.cell.getBoundingClientRect();
                    if (target.width && current.width) {
                        const offset = Math.round(((target.left + target.right - current.left - current.right) / 2 + state.offset) * 100) / 100;
                        if (offset !== state.offset) { state.cell.style.transform = `translateX(${offset}px)`; state.offset = offset; }
                    }
                }
            }
            // Notify layout-sensitive extensions only when the column structure
            // changes. No resize events are generated for timestamp refreshes.
            if (layoutChanged) window.dispatchEvent(new Event("resize"));
        }
        function schedule() {
            if (!frame && alive) frame = requestAnimationFrame(() => { frame = 0; render(); });
        }
        function observeMain() {
            const next = document.querySelector("main");
            if (next !== main) {
                observer?.disconnect(); main = next;
                if (main) {
                    observer = new MutationObserver(records => {
                        if (records.some(r => !r.target.parentElement?.closest(".lp-column") &&
                            !(r.target instanceof Element && r.target.closest(".lp-column")))) schedule();
                    });
                    observer.observe(main, { childList:true, subtree:true, attributes:true, attributeFilter:["aria-rowindex", "href"] });
                }
                schedule();
            }
        }
        function downloadBackup() {
            const tracks = [...cache].map(([uri, at]) => ({ uri, at }));
            const blob = new Blob([JSON.stringify({ format:FORMAT, version:1, exportedAt:new Date().toISOString(), thresholdMs:threshold, tracks })], { type:"application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = "last-played-backup.json"; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
        async function mergeHistory(parsed) {
            const entries = [...parsed.latest];
            let changed = 0;
            for (let i = 0; i < entries.length; i += 500) {
                ensureAccount();
                // Recheck against live recording immediately before each batch;
                // older imported timestamps must never replace newer listens.
                const batch = entries.slice(i, i + 500).filter(([uri, at]) => at > (cache.get(uri) || 0));
                if (batch.length) {
                    await putRecords(db, batch.map(([uri, at]) => ({ uri, at })));
                    for (const [uri, at] of batch) {
                        if (at > (cache.get(uri) || 0)) { cache.set(uri, at); changed++; }
                    }
                }
                await sleep(0);
            }
            schedule(); return changed;
        }
        async function importFiles(files, status) {
            if (importBusy) return;
            importBusy = true;
            const importThreshold = threshold;
            let changed = 0, qualifying = 0, jsonFiles = 0, noTrack = 0, short = 0, invalid = 0;
            const errors = [];
            async function consume(text, name) {
                status.textContent = "Reading " + name + "…"; await sleep(0);
                try {
                    const parsed = await parseHistory(text, Date.now(), () => sleep(0), importThreshold);
                    changed += await mergeHistory(parsed);
                    qualifying += parsed.stats.qualifying; noTrack += parsed.stats.noTrack;
                    short += parsed.stats.short; invalid += parsed.stats.invalid; jsonFiles++;
                } catch (error) { errors.push(name + ": " + error.message); }
            }
            try {
                for (const file of files) {
                    ensureAccount();
                    if (/\.zip$/i.test(file.name)) {
                        if (file.size > 1024 * 1024 * 1024) throw new Error("Extract ZIPs larger than 1 GB and import the JSON files.");
                        status.textContent = "Opening " + file.name + "…"; await sleep(0);
                        const bytes = new Uint8Array(await file.arrayBuffer());
                        const entries = zipDirectory(bytes);
                        if (!entries.length) errors.push(file.name + ": No JSON files found.");
                        for (const entry of entries) {
                            try { await consume(await unzipEntry(bytes, entry), entry.name); }
                            catch (error) { errors.push(entry.name + ": " + error.message); }
                        }
                    } else {
                        if (file.size > MAX_JSON) throw new Error(file.name + " is too large to import at once.");
                        await consume(await file.text(), file.name);
                    }
                }
                status.textContent = `Imported ${jsonFiles} JSON files; ${qualifying} qualifying records; ${changed} newer track timestamps saved. Skipped: ${short} short plays, ${noTrack} records without a track URI, ${invalid} invalid records.`;
                if (!qualifying) status.textContent += " Select Extended streaming history, not the smaller Account data export. Re-importing a backup never erases newer timestamps.";
                if (errors.length) status.textContent += "\n" + errors.join("\n");
            } catch (error) { status.textContent = `Saved ${changed} updates before stopping: ${error.message}`; }
            finally { importBusy = false; }
        }
        // Native sorting adapter: supply the full sorted order to Spotify's own
        // virtualized tracklist. No playlist write or queue mutations are used.
        let nativeSort = null, nativeSortBusy = false, nativeSortSerial = 0;
        const playlistAPI = S.Platform.PlaylistAPI;
        const originalReads = new Map();
        const proxyHeaders = new Set();
        const routePlaylist = () => {
            const id = (S.Platform.History.location?.pathname || "").match(/^\/playlist\/([A-Za-z0-9]+)/)?.[1];
            return id ? "spotify:playlist:" + id : null;
        };
        function clearNativeSort() {
            nativeSort = null; nativeSortBusy = false;
            for (const header of proxyHeaders) header.removeAttribute("data-lp-proxy-sort");
            proxyHeaders.clear(); schedule();
        }
        function currentSort(state) {
            ensureAccount();
            if (nativeSort !== state || routePlaylist() !== state.uri) throw new Error("Last Played sort cancelled.");
        }
        function sortedContents(state, options) {
            // Preserve native search/filter options, but fetch from the start
            // and sort the entire matching result before taking a page.
            const baseOptions = { ...options, offset:undefined, limit:undefined, sort:undefined };
            const key = JSON.stringify(baseOptions);
            state.promises ||= new Map();
            if (!state.promises.has(key)) state.promises.set(key, (async () => {
                const result = await readFullPlaylist((offset, limit) => originalReads.get("getContents").call(playlistAPI,
                    state.uri, { ...baseOptions, offset, limit }), () => currentSort(state));
                return { ...result, items:sortByLastPlayed(result.items, state.timestamps, state.direction) };
            })());
            return state.promises.get(key);
        }
        function pageOfSorted(result, options, fallback) {
            const offset = Math.max(0, Number(options?.offset) || 0);
            const requested = Number(options?.limit ?? fallback?.limit ?? 100);
            const limit = Number.isFinite(requested) && requested > 0 ? requested : 100;
            const items = result.items.slice(offset, offset + limit);
            return { ...result.template, ...fallback, items, offset, limit:items.length, totalLength:result.items.length };
        }
        function installNativeSort() {
            if (!playlistAPI || typeof playlistAPI.getContents !== "function") return false;
            const wrappers = new Map();
            for (const name of ["getContents", "getPlaylist"]) {
                const original = playlistAPI[name];
                if (typeof original !== "function") continue;
                originalReads.set(name, original);
                const wrapped = async function (...args) {
                    const state = nativeSort;
                    if (!alive || !state || args[0] !== state.uri || routePlaylist() !== state.uri)
                        return original.apply(this, args);
                    const optionIndex = name === "getPlaylist" && args.length > 2 ? 2 : 1;
                    const options = args[optionIndex];
                    // A normal Spotify sort selection takes priority.
                    if (options?.sort?.field && options.sort.field !== "ADDED_AT") {
                        clearNativeSort(); return original.apply(this, args);
                    }
                    state.reads++;
                    try {
                        const result = await sortedContents(state, options);
                        currentSort(state);
                        if (name === "getContents") {
                            state.served = true; nativeSortBusy = false; schedule();
                            return pageOfSorted(result, options, result.template);
                        }
                        // Keep Spotify's native playlist metadata and permissions.
                        const baseArgs = [...args];
                        baseArgs[optionIndex] = { ...options, sort:undefined };
                        const playlist = await original.apply(this, baseArgs);
                        currentSort(state);
                        if (!playlist?.contents || !Array.isArray(playlist.contents.items))
                            throw new Error("Unsupported Spotify playlist metadata response.");
                        state.served = true; nativeSortBusy = false; schedule();
                        return { ...playlist, contents:pageOfSorted(result, options, playlist.contents) };
                    } catch (error) {
                        if (nativeSort === state) {
                            clearNativeSort(); notify("Inline sort could not be applied: " + error.message);
                        }
                        // Return the actual native result on failure, never a
                        // partially sorted page or a fabricated list of tracks.
                        return original.apply(this, args);
                    }
                };
                try { playlistAPI[name] = wrapped; }
                catch { /* A read-only API is reported when the header is clicked. */ }
                if (playlistAPI[name] === wrapped) wrappers.set(name, wrapped);
            }
            disposers.push(() => {
                clearNativeSort();
                for (const [name, wrapper] of wrappers) if (playlistAPI[name] === wrapper) playlistAPI[name] = originalReads.get(name);
            });
            return wrappers.has("getContents");
        }
        const nativeSortAvailable = installNativeSort();
        async function sortInPlaylist(header) {
            if (nativeSortBusy) return;
            const uri = routePlaylist();
            if (!uri) { notify("Inline sorting currently supports playlist pages."); return; }
            if (!nativeSortAvailable) { notify("This Spotify version does not expose the native playlist sorting API."); return; }
            const date = rows.get(header)?.date;
            const trigger = date?.matches("button") ? date : date?.querySelector("button") || date;
            if (!trigger || typeof trigger.click !== "function") { notify("Could not find Spotify's Date added sort control."); return; }
            const direction = nativeSort?.uri !== uri ? "newest" : nativeSort.direction === "newest" ? "oldest" : null;
            if (!direction) clearNativeSort();
            else {
                nativeSort = { uri, direction, serial:++nativeSortSerial, timestamps:new Map(cache), reads:0, served:false, promise:null };
                nativeSortBusy = true;
            }
            const state = nativeSort;
            // Ask Spotify to refresh its real sort query, using the native
            // Date added header as the refresh control. Its API response is
            // replaced above before Spotify renders any pages of rows.
            trigger.click();
            if (state) { date.setAttribute("data-lp-proxy-sort", ""); proxyHeaders.add(date); }
            schedule();
            if (!state) return;
            const began = Date.now();
            while (nativeSort === state && !state.served && Date.now() - began < 15000) await sleep(200);
            if (nativeSort !== state) return;
            if (!state.served) {
                clearNativeSort();
                notify("Spotify did not refresh the native playlist data. Inline sorting needs a compatibility adjustment for this client.");
                return;
            }
            const headerCell = rows.get(header)?.cell;
            headerCell?.setAttribute("aria-sort", direction === "newest" ? "descending" : "ascending");
            // Keep native menus and click actions attached to the native rows.
            // The timestamps are a snapshot until the next header click, so
            // listening to a song does not make it jump under the mouse.
        }
        const onNativeHeaderClick = event => {
            if (!event.isTrusted || !nativeSort || !(event.target instanceof Element)) return;
            if (event.target.closest('[role="columnheader"]') && !event.target.closest(".lp-column")) clearNativeSort();
        };
        document.addEventListener("click", onNativeHeaderClick, true);
        disposers.push(() => document.removeEventListener("click", onNativeHeaderClick, true));
        function settings() {
            const root = document.createElement("div"); root.className = "lp-settings";
            const intro = document.createElement("p");
            intro.textContent = "Records songs after the selected duration of observed listening. Seeking and paused time do not count. Recording works while this Spotify client is open; phone-only plays need a later history import. Only exact track IDs are matched.";
            const privacy = document.createElement("p"); privacy.textContent = "History is stored locally for this Spotify account. It is not uploaded or synced. Export a backup before clearing Spotify data or moving to another computer.";
            const count = document.createElement("p"); count.textContent = `${cache.size.toLocaleString()} tracks recorded.` + (saveError ? " Unsaved changes: " + saveError : "");
            const label = document.createElement("label"); label.textContent = "Column display: ";
            const select = document.createElement("select");
            for (const [value, text] of [["relative", "Relative time"], ["date", "Calendar date"]]) {
                const option = document.createElement("option"); option.value = value; option.textContent = text; select.appendChild(option);
            }
            select.value = format;
            select.onchange = () => { format = select.value; S.Platform.LocalStorageAPI?.setItem("lastPlayed:displayFormat", format); schedule(); };
            label.appendChild(select);
            const heading = document.createElement("h3"); heading.textContent = "Import older listening history";
            const steps = document.createElement("p"); steps.textContent = "Open Spotify Account → Privacy settings → Download your data. Request Extended streaming history. When ready, download it, then select its ZIP or all Streaming_History_Audio_*.json / endsong_*.json files below. Imports merge by track ID and keep the newest timestamp.";
            const link = document.createElement("a"); link.href = "https://www.spotify.com/account/privacy/"; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Open Spotify privacy settings";
            const picker = document.createElement("input"); picker.type = "file"; picker.multiple = true; picker.accept = ".json,.zip,application/json,application/zip";
            picker.setAttribute("aria-label", "Import Spotify extended history or Last Played backup");
            const status = document.createElement("p"); status.className = "lp-import-status"; status.setAttribute("aria-live", "polite");
            picker.onchange = async () => {
                const files = [...picker.files]; if (!files.length) return;
                picker.disabled = true;
                try { await importFiles(files, status); count.textContent = `${cache.size.toLocaleString()} tracks recorded.`; }
                finally { picker.disabled = false; picker.value = ""; }
            };
            const exportButton = document.createElement("button"); exportButton.textContent = "Export Last Played backup";
            exportButton.onclick = downloadBackup;
            const thresholdLabel = document.createElement("label");
            thresholdLabel.className = "lp-threshold";
            const slider = document.createElement("input"); slider.type = "range";
            slider.min = "1"; slider.max = "240"; slider.step = "1"; slider.value = String(threshold / 1000);
            slider.setAttribute("aria-label", "Seconds required to count as listened");
            const value = document.createElement("span");
            const updateValue = () => { value.textContent = `Count as listened after ${slider.value} seconds`; };
            updateValue(); slider.oninput = updateValue;
            slider.onchange = () => {
                tick(); const last = tracker.finish(); if (last) record(last);
                threshold = Number(slider.value) * 1000; tracker.threshold = threshold;
                tracker.reset(); // Apply prospectively, never retroactively qualify the current sample.
                S.Platform.LocalStorageAPI?.setItem("lastPlayed:thresholdSeconds", String(slider.value)); tick();
            };
            thresholdLabel.append(value, slider);
            const note = document.createElement("p"); note.textContent = "1–240 seconds. Changes start a fresh listening timer and apply to future listening and new Spotify history imports. Existing timestamps and backup imports are preserved. Increasing this value cannot undo older records.";
            root.append(intro, thresholdLabel, note, privacy, count, label, heading, steps, link, picker, status, exportButton);
            S.PopupModal.display({ title:"Last Played", content:root, isLarge:true });
        }
        const style = document.createElement("style"); style.id = "last-played-style";
        style.textContent = `
          [data-lp-grid] { display:grid!important;grid-template-columns:var(--lp-columns)!important;column-gap:16px!important;padding-inline:16px!important;box-sizing:border-box!important; }
          .lp-column { display:flex!important;align-items:center;justify-content:center!important;min-width:0;white-space:nowrap;color:var(--text-subdued,#b3b3b3);font-size:13px; }
          .lp-column[role="columnheader"] { font-size:14px; }
          [data-lp-proxy-sort] svg { visibility:hidden; }
          [data-lp-proxy-sort] { color:var(--text-subdued,#b3b3b3)!important; }
          .lp-sort-header { background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:8px 0; }
          .lp-sort-header:hover { color:var(--text-base,#fff); }
          .lp-threshold { display:block;margin:16px 0; }
          .lp-threshold input { display:block;width:100%;margin-top:12px; }
          .lp-settings p { margin:0 0 16px;line-height:1.5; }
          .lp-settings h3 { margin:24px 0 12px; }
          .lp-settings input[type=file] { display:block;margin:16px 0;max-width:100%; }
          .lp-settings a { text-decoration:underline; }
          .lp-settings .lp-import-status { white-space:pre-wrap;max-height:180px;overflow:auto; }
          .lp-settings button { border:1px solid #727272;border-radius:500px;padding:10px 18px;background:transparent;color:inherit;cursor:pointer; }
        `;
        document.head.appendChild(style);
        const menu = new S.Menu.Item("Last Played", false, settings); menu.register();
        const onChange = () => { tick(); schedule(); };
        S.Player.addEventListener("songchange", onChange); S.Player.addEventListener("onplaypause", onChange);
        const unlisten = S.Platform.History.listen(() => { if (nativeSort && routePlaylist() !== nativeSort.uri) clearNativeSort(); observeMain(); schedule(); });
        window.addEventListener("resize", schedule);
        const onHide = () => { tick(); const last = tracker.finish(); if (last) record(last); void flush(); };
        window.addEventListener("pagehide", onHide);
        const timers = [setInterval(tick, 1000), setInterval(() => { observeMain(); void flush(); }, 3000), setInterval(schedule, 60000)];
        disposers.push(() => S.Player.removeEventListener("songchange", onChange), () => S.Player.removeEventListener("onplaypause", onChange),
            () => unlisten?.(), () => window.removeEventListener("resize", schedule), () => window.removeEventListener("pagehide", onHide),
            () => menu.deregister(), () => style.remove());
        const runtime = {
            account,
            async stop() {
                const last = tracker.finish(); if (last) record(last);
                await flush(); if (dirty.size) await flush(); alive = false;
                timers.forEach(clearInterval); observer?.disconnect(); if (frame) cancelAnimationFrame(frame);
                for (const host of trackedHosts) disposeRow(host);
                disposers.forEach(fn => { try { fn(); } catch {} }); db.close();
            }
        };
        window.__lastPlayedExtension = runtime;
        tick(); observeMain(); schedule();
        notify("Ready. Import older history from profile menu → Last Played.");
    }
    if (window.__lastPlayedExtension) return;
    start().catch(error => { console.error("[Last Played] Startup failed", error); window.Spicetify?.showNotification("Last Played could not start: " + error.message); });
    // If Spotify changes accounts without reloading, never write into the old
    // account's database or show the old account's timestamps.
    setInterval(async () => {
        const runtime = window.__lastPlayedExtension;
        const current = accountName();
        if (runtime && current && String(current) !== runtime.account && !runtime.switching) {
            runtime.switching = true;
            await runtime.stop(); delete window.__lastPlayedExtension;
            start().catch(error => console.error("[Last Played] Account switch failed", error));
        }
    }, 3000);
})();
