import { useState, useEffect, useRef, useCallback } from "react";
import AdBanner from "./components/AdBanner";
import "./App.css";

// ── date helpers ──────────────────────────────────────────────────────────────
// Always build ISO strings from LOCAL date parts — avoids UTC-offset day-shift bugs.
const toISO = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Parse YYYY-MM-DD into a local-time Date (no UTC shift)
const fromISO = (s) => {
  const [y, mo, d] = s.split("-").map(Number);
  return new Date(y, mo - 1, d);
};

const today = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function fmtDate(d) {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ── localStorage helpers (used as fast local cache while DB syncs) ────────────
const STORAGE_PREFIX = "wordsearch:";

function loadProgress(iso) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + iso);
    if (!raw) return { found: [], complete: false };
    return JSON.parse(raw);
  } catch {
    return { found: [], complete: false };
  }
}

function saveProgress(iso, foundSet, complete) {
  try {
    localStorage.setItem(
      STORAGE_PREFIX + iso,
      JSON.stringify({ found: [...foundSet], complete })
    );
  } catch {}
}

function clearProgress(iso) {
  try { localStorage.removeItem(STORAGE_PREFIX + iso); } catch {}
}

// ── token helpers ─────────────────────────────────────────────────────────────
const STREAK_KEY = "wordsearch:streak";
const TOKEN_KEY  = "wordsearch:userToken";

function getUserToken() {
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(TOKEN_KEY, token);
  }
  return token;
}

function loadStreak() {
  try {
    return JSON.parse(localStorage.getItem(STREAK_KEY)) || { lastCompleted: null, streak: 0 };
  } catch {
    return { lastCompleted: null, streak: 0 };
  }
}

function saveStreak(data) {
  try { localStorage.setItem(STREAK_KEY, JSON.stringify(data)); } catch {}
}

function isYesterday(todayISO, lastISO) {
  const d = fromISO(lastISO);
  d.setDate(d.getDate() + 1);
  return toISO(d) === todayISO;
}

// ── DB API helpers ────────────────────────────────────────────────────────────
// Push puzzle progress to the DB (fire-and-forget, local cache is source of truth for UX)
function pushPuzzleProgress(token, iso, foundSet, complete) {
  fetch("/api/streak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      date:       iso,
      foundWords: [...foundSet],
      complete,
    }),
  }).catch(() => {}); // silent — local cache keeps things working offline
}

function pushStreak(token, streak, lastCompleted) {
  fetch("/api/streak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, streak, lastCompleted }),
  }).catch(() => {});
}

// ── word-search logic ──────────────────────────────────────────────────────────
function getWordCells({ startRow, startCol, word, direction }) {
  return Array.from({ length: word.length }, (_, i) => {
    if (direction === "horizontal") return [startRow, startCol + i];
    if (direction === "vertical")   return [startRow + i, startCol];
    if (direction === "diagonal")   return [startRow + i, startCol + i];
    if (direction === "diagonalUp") return [startRow - i, startCol + i];
    return [startRow, startCol + i];
  });
}

function interpolateCells(start, end) {
  if (!start || !end) return start ? [start] : [];
  const [r1, c1] = start;
  const [r2, c2] = end;
  const dr = r2 - r1, dc = c2 - c1;
  if (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc)) return [start];
  const steps = Math.max(Math.abs(dr), Math.abs(dc));
  if (steps === 0) return [start];
  const sr = Math.sign(dr), sc = Math.sign(dc);
  return Array.from({ length: steps + 1 }, (_, i) => [r1 + sr * i, c1 + sc * i]);
}

function cellsMatch(selected, answer) {
  const norm = (arr) => arr.map(([r, c]) => `${r},${c}`).join("|");
  const s = norm(selected);
  return s === norm(answer) || s === norm([...answer].reverse());
}

function selectionString(cells, grid) {
  const fwd = cells.map(([r, c]) => grid[r]?.[c] ?? "").join("");
  const bwd = [...cells].reverse().map(([r, c]) => grid[r]?.[c] ?? "").join("");
  return { fwd, bwd };
}

function buildFoundCellMap(wordCache, foundSet) {
  const map = new Map();
  wordCache.forEach((w) => {
    if (foundSet.has(w.word)) w.cells.forEach(([r, c]) => map.set(`${r},${c}`, true));
  });
  return map;
}

// ── main component ─────────────────────────────────────────────────────────────
export default function App() {
  // availableDates: sorted ISO string array fetched from manifest.json,
  // filtered to today-or-earlier so future puzzles are never reachable.
  const [availableDates, setAvailableDates] = useState(null); // null = not yet loaded
  const [activeDate,     setActiveDate]     = useState(today());

  const [puzzle,      setPuzzle]      = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);

  const [foundWords,  setFoundWords]  = useState(new Set());
  const [selecting,   setSelecting]   = useState(false);
  const [startCell,   setStartCell]   = useState(null);
  const [currentCell, setCurrentCell] = useState(null);
  const [wrongCells,  setWrongCells]  = useState([]);
  const [toast,       setToast]       = useState({ msg: "", show: false });
  const [complete,    setComplete]    = useState(false);
  const [streak,      setStreak]      = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [pairCode,     setPairCode]     = useState("");
  const [pairStatus,   setPairStatus]   = useState(null); // null | "linking" | "success" | "error"
  const [pairMessage,  setPairMessage]  = useState("");

  const toastTimer    = useRef(null);
  const wordCellCache = useRef([]);
  const foundCellMap  = useRef(new Map());
  const gridPanelRef  = useRef(null);

  // ── init: token, manifest, DB sync — all in one effect ───────────────────────
  useEffect(() => {
    const token = getUserToken(); // creates token in localStorage if missing

    // Run manifest fetch and DB fetch in parallel
    Promise.all([
      fetch("/puzzles/manifest.json").then((r) => r.json()),
      fetch(`/api/streak?token=${token}`).then((r) => r.json()).catch(() => null),
    ]).then(([allDates, dbData]) => {
      // ── 1. Manifest → available dates ──────────────────────────────────────
      const todayISO = toISO(today());
      const past = allDates.filter((d) => d <= todayISO).sort();
      setAvailableDates(past);

      // ── 2. Streak — validate expiry first, then take best valid value ─────────
      const todayISO2 = todayISO; // same value, just aliased for clarity below
      const local = loadStreak();

      // Helper: is a streak still alive? Only valid if lastCompleted is today or yesterday.
      const isStreakAlive = (lastCompleted) => {
        if (!lastCompleted) return false;
        if (lastCompleted === todayISO2) return true;
        const d = fromISO(lastCompleted);
        d.setDate(d.getDate() + 1);
        return toISO(d) === todayISO2; // was yesterday
      };

      if (dbData?.success) {
        const dbStreak    = dbData.streak       || 0;
        const dbLast      = dbData.lastCompleted || null;
        const localStreak = local.streak        || 0;
        const localLast   = local.lastCompleted  || null;

        const dbAlive    = isStreakAlive(dbLast);
        const localAlive = isStreakAlive(localLast);

        let best;
        if (!dbAlive && !localAlive) {
          // Both expired — reset to 0 and write back to DB
          best = { streak: 0, lastCompleted: null };
          pushStreak(token, 0, null);
        } else if (dbAlive && !localAlive) {
          best = { streak: dbStreak, lastCompleted: dbLast };
        } else if (!dbAlive && localAlive) {
          best = { streak: localStreak, lastCompleted: localLast };
          pushStreak(token, localStreak, localLast);
        } else {
          // Both alive — take the higher streak
          if (dbStreak >= localStreak) {
            best = { streak: dbStreak, lastCompleted: dbLast };
          } else {
            best = { streak: localStreak, lastCompleted: localLast };
            pushStreak(token, localStreak, localLast);
          }
        }

        saveStreak(best);
        setStreak(best.streak);

        // ── 3. Puzzle progress — merge DB rows into localStorage ──────────────
        const dbPuzzles = dbData.puzzles || {};
        for (const [date, dbProg] of Object.entries(dbPuzzles)) {
          const localProg  = loadProgress(date);
          const localFound = localProg.found || [];
          const dbFound    = dbProg.found    || [];
          if (dbFound.length > localFound.length) {
            saveProgress(date, new Set(dbFound), dbProg.complete);
          }
        }
      } else {
        // DB unavailable — fall back to local streak
        setStreak(local.streak || 0);
      }
    }).catch(() => {
      // Entire init failed — fall back gracefully
      setAvailableDates([toISO(today())]);
      const local = loadStreak();
      setStreak(local.streak || 0);
    });
  }, []);

  // ── load puzzle + restore progress ──────────────────────────────────────────
  useEffect(() => {
    if (availableDates === null) return; // wait for manifest first

    //setLoading(true);
    setError(null);
    //setPuzzle(null);
    setFoundWords(new Set());
    foundCellMap.current = new Map();
    wordCellCache.current = [];
    setComplete(false);
    setSelecting(false);
    setStartCell(null);
    setCurrentCell(null);

    const iso = toISO(activeDate);
    fetch(`/puzzles/${iso}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`No puzzle found for ${fmtDate(activeDate)}`);
        return r.json();
      })
      .then((data) => {
        const cache = data.words.map((w) => ({ ...w, cells: getWordCells(w) }));
        wordCellCache.current = cache;
        setPuzzle(data);

        const saved = loadProgress(iso);
        if (saved.found.length > 0) {
          const restoredSet = new Set(saved.found);
          setFoundWords(restoredSet);
          foundCellMap.current = buildFoundCellMap(cache, restoredSet);
        }
        if (saved.complete) setComplete(true);

        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [activeDate, availableDates]);

  // ── toast helper ──────────────────────────────────────────────────────────────
  const showToast = useCallback((msg) => {
    setToast({ msg, show: true });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, show: false })), 1700);
  }, []);

  // ── selection refs (keep latest values synchronously for touch handlers) ──────
  const selectingRef    = useRef(false);
  const startCellRef    = useRef(null);
  const currentCellRef  = useRef(null);
  const commitRef       = useRef(null); // stable ref so touch effect never needs to re-run

  // ── shared commit function (called on pointerup and touchend) ─────────────────
  const commitSelection = useCallback(() => {
    if (!selectingRef.current || !startCellRef.current || !currentCellRef.current) {
      selectingRef.current = false;
      setSelecting(false);
      return;
    }

    const sc  = startCellRef.current;
    const cc  = currentCellRef.current;
    const puz = puzzle;

    selectingRef.current  = false;
    startCellRef.current  = null;
    currentCellRef.current = null;
    setSelecting(false);
    setStartCell(null);
    setCurrentCell(null);

    const selected = interpolateCells(sc, cc);
    if (selected.length < 2 || !puz) return;

    const { fwd, bwd } = selectionString(selected, puz.grid);
    const match = wordCellCache.current.find(
      (w) => !foundWords.has(w.word) && (w.word === fwd || w.word === bwd) && cellsMatch(selected, w.cells)
    );

    if (match) {
      const updated = new Set(foundWords);
      updated.add(match.word);
      setFoundWords(updated);
      foundCellMap.current = buildFoundCellMap(wordCellCache.current, updated);
      showToast(`✓ ${match.word}`);

      const isFinished = updated.size === puz.words.length;
      saveProgress(toISO(activeDate), updated, isFinished);
      // Push progress to DB on every word found (so switching devices is seamless)
      pushPuzzleProgress(getUserToken(), toISO(activeDate), updated, isFinished);

      if (isFinished) {
        const todayISO   = toISO(today());
        const currentISO = toISO(activeDate);
        if (currentISO === todayISO) {
          const data = loadStreak();
          let newStreak = 1;
          if (data.lastCompleted === todayISO) {
            newStreak = data.streak;
          } else if (data.lastCompleted && isYesterday(todayISO, data.lastCompleted)) {
            newStreak = data.streak + 1;
          }
          const streakData = { lastCompleted: todayISO, streak: newStreak };
          saveStreak(streakData);
          setStreak(newStreak);
          pushStreak(getUserToken(), newStreak, todayISO);
        }
        setTimeout(() => setComplete(true), 500);
      }
    } else {
      setWrongCells(selected.map(([r, c]) => `${r},${c}`));
      setTimeout(() => setWrongCells([]), 550);
    }
  }, [puzzle, foundWords, activeDate, showToast]);

  // Keep the stable ref pointing at the latest version
  commitRef.current = commitSelection;

  // ── desktop pointer handlers ──────────────────────────────────────────────────
  const onCellDown = (r, c) => {
    selectingRef.current   = true;
    startCellRef.current   = [r, c];
    currentCellRef.current = [r, c];
    setSelecting(true);
    setStartCell([r, c]);
    setCurrentCell([r, c]);
  };

  const onCellEnter = (r, c) => {
    if (!selectingRef.current) return;
    currentCellRef.current = [r, c];
    setCurrentCell([r, c]);
  };

  useEffect(() => {
    window.addEventListener("pointerup", commitSelection);
    return () => window.removeEventListener("pointerup", commitSelection);
  }, [commitSelection]);

  // ── mobile touch handlers ────────────────────────────────────────────────────
  // Runs once per puzzle load. Uses commitRef so it always calls the latest
  // commitSelection without needing to re-attach listeners on every render.
  useEffect(() => {
    const panel = gridPanelRef.current;
    if (!panel) return;

    const cellFromPoint = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const cell = el.closest("[data-row]");
      if (!cell) return null;
      return [parseInt(cell.dataset.row, 10), parseInt(cell.dataset.col, 10)];
    };

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const rc = cellFromPoint(e.touches[0].clientX, e.touches[0].clientY);
      if (!rc) return;
      selectingRef.current   = true;
      startCellRef.current   = rc;
      currentCellRef.current = rc;
      setSelecting(true);
      setStartCell(rc);
      setCurrentCell(rc);
    };

    const onTouchMove = (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const rc = cellFromPoint(e.touches[0].clientX, e.touches[0].clientY);
      if (!rc) return;
      currentCellRef.current = rc;
      setCurrentCell(rc);
    };

    const onTouchEnd = (e) => {
      e.preventDefault();
      commitRef.current();
    };

    const opts = { passive: false };
    panel.addEventListener("touchstart", onTouchStart, opts);
    panel.addEventListener("touchmove",  onTouchMove,  opts);
    panel.addEventListener("touchend",   onTouchEnd,   opts);
    return () => {
      panel.removeEventListener("touchstart", onTouchStart, opts);
      panel.removeEventListener("touchmove",  onTouchMove,  opts);
      panel.removeEventListener("touchend",   onTouchEnd,   opts);
    };
  }, [puzzle]); // only re-attach when puzzle changes (panel enters/leaves DOM)

  // ── replay ────────────────────────────────────────────────────────────────────
  const handleReplay = () => {
    const iso = toISO(activeDate);
    clearProgress(iso);
    pushPuzzleProgress(getUserToken(), iso, new Set(), false);
    setFoundWords(new Set());
    foundCellMap.current = new Map();
    setComplete(false);
  };

  // ── device pairing ────────────────────────────────────────────────────────────
  const handlePair = async () => {
    const code = pairCode.trim().toLowerCase();
    if (code.length < 8) {
      setPairStatus("error");
      setPairMessage("Code must be at least 8 characters.");
      return;
    }

    setPairStatus("linking");
    setPairMessage("");

    try {
      const res  = await fetch("/api/link", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ myToken: getUserToken(), theirCode: code }),
      });
      const data = await res.json();

      if (!data.success) {
        setPairStatus("error");
        setPairMessage(data.error || "Something went wrong.");
        return;
      }

      // Adopt the canonical token — overwrites our local token
      localStorage.setItem(TOKEN_KEY, data.canonicalToken);

      // Sync streak locally
      const streakData = { streak: data.streak, lastCompleted: data.lastCompleted };
      saveStreak(streakData);
      setStreak(data.streak);

      // Re-fetch all puzzle progress under the new token and merge into localStorage
      const syncRes  = await fetch(`/api/streak?token=${data.canonicalToken}`);
      const syncData = await syncRes.json();
      if (syncData.success) {
        const dbPuzzles = syncData.puzzles || {};
        for (const [date, dbProg] of Object.entries(dbPuzzles)) {
          const localProg  = loadProgress(date);
          const localFound = localProg.found || [];
          const dbFound    = dbProg.found    || [];
          if (dbFound.length > localFound.length) {
            saveProgress(date, new Set(dbFound), dbProg.complete);
          }
        }
      }

      setPairStatus("success");
      setPairMessage("Devices linked! Your progress has been merged.");
      setPairCode("");
    } catch {
      setPairStatus("error");
      setPairMessage("Network error — please try again.");
    }
  };

  // ── date nav — index-based, driven entirely by the manifest array ─────────────
  const activeISO  = toISO(activeDate);
  const currentIdx = availableDates ? availableDates.indexOf(activeISO) : -1;
  const canGoBack  = currentIdx > 0;
  const canGoFwd   = availableDates ? currentIdx < availableDates.length - 1 : false;
  const isToday    = activeISO === toISO(today());

  const go = (delta) => {
    if (!availableDates) return;
    const nextIdx = currentIdx + delta;
    if (nextIdx < 0 || nextIdx >= availableDates.length) return;
    setComplete(false);
    setActiveDate(fromISO(availableDates[nextIdx]));
  };

  const jumpToToday = () => {
    if (!availableDates) return;
    const todayISO = toISO(today());
    if (availableDates.includes(todayISO)) {
      setComplete(false);
      setActiveDate(fromISO(todayISO));
    }
  };

  // ── derived cell classes ──────────────────────────────────────────────────────
  const dragCells = selecting && startCell && currentCell
    ? interpolateCells(startCell, currentCell)
    : startCell ? [startCell] : [];
  const dragSet  = new Set(dragCells.map(([r, c]) => `${r},${c}`));
  const wrongSet = new Set(wrongCells);

  const cellClass = (r, c) => {
    const k = `${r},${c}`;
    const cls = ["cell"];
    if (foundCellMap.current.has(k)) cls.push("found");
    if (dragSet.has(k))  cls.push("selecting");
    if (wrongSet.has(k)) cls.push("wrong");
    return cls.join(" ");
  };

  const pct = puzzle ? Math.round((foundWords.size / puzzle.words.length) * 100) : 0;

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <title>Daily WordSearch</title>

      {/* ── Header ── */}
      <header className="header">
        <div className="header-brand">
          <span className="brand-pill">Daily</span>
          <span className="brand-title">Word Search</span>
        </div>

        <div className="header-right">
          <div className="streak" altText={`${streak} day streak`}>
            {streak} 🔥
          </div>
          <div className="date-nav">
            <button className="date-nav-btn" onClick={() => go(-1)} disabled={!canGoBack} title="Previous day">‹</button>
            <span
              className={`date-display${isToday ? " is-today" : ""}`}
              onClick={jumpToToday}
              title="Jump to today"
            >
              {fmtDate(activeDate)}
            </span>
            <button className="date-nav-btn" onClick={() => go(1)} disabled={!canGoFwd} title="Next day">›</button>
          </div>

          {puzzle && (
            <div className="progress-wrap">
              <div className="progress-count">
                <span>{foundWords.size}</span>/{puzzle.words.length}
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          <button
            className="settings-btn"
            onClick={() => { setShowSettings((s) => !s); setPairStatus(null); setPairCode(""); }}
            title="Sync devices"
          >
            <span className="settings-btn-icon">⚙</span>
            <span className="settings-btn-label">Sync devices</span>
          </button>
        </div>
      </header>

      {/* ── Settings / pairing panel ── */}
      {showSettings && (
        <div className="settings-panel">
          <div className="settings-section">
            <div className="settings-label">Your device code</div>
            <div className="settings-code">{getUserToken().slice(0, 8)}</div>
            <div className="settings-hint">Share this code with another device to link your progress.</div>
          </div>

          <div className="settings-section">
            <div className="settings-label">Link another device</div>
            <div className="settings-row">
              <input
                className="settings-input"
                type="text"
                placeholder="Enter their 8-char code"
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value.toLowerCase())}
                maxLength={36}
                spellCheck={false}
                autoCapitalize="none"
              />
              <button
                className="overlay-btn"
                onClick={handlePair}
                disabled={pairStatus === "linking"}
              >
                {pairStatus === "linking" ? "Linking…" : "Link"}
              </button>
            </div>
            {pairStatus === "success" && <div className="settings-msg settings-msg--ok">{pairMessage}</div>}
            {pairStatus === "error"   && <div className="settings-msg settings-msg--err">{pairMessage}</div>}
          </div>
        </div>
      )}

      {/* ── Body ── */}
      {(loading || availableDates === null) && <div className="state-msg">Loading puzzle…</div>}
      {error && <div className="state-msg">{error}</div>}

      {puzzle && !loading && (
        <div className="layout">

          {/* Grid — solved card overlays in-place when complete */}
          <div className="grid-wrap" style={{ position: "relative" }}>
            <div
              ref={gridPanelRef}
              className="grid-panel"
              onContextMenu={(e) => e.preventDefault()}
              onDragStart={(e) => e.preventDefault()}
            >
              <div className="grid">
                {puzzle.grid.map((row, ri) => (
                  <div className="grid-row" key={ri}>
                    {row.map((letter, ci) => (
                      <div
                        key={ci}
                        data-row={ri}
                        data-col={ci}
                        className={cellClass(ri, ci)}
                        onPointerDown={complete ? undefined : () => onCellDown(ri, ci)}
                        onPointerEnter={complete ? undefined : () => onCellEnter(ri, ci)}
                      >
                        {letter}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {complete && (
              <div className="solved-card">
                <div className="solved-icon">✓</div>
                <h2>Solved!</h2>
                <p>You found all {puzzle.words.length} words in this puzzle.</p>
                <div className="solved-actions">
                  {/* <button className="overlay-btn overlay-btn--ghost" onClick={handleReplay}>
                    ↺ Replay
                  </button> */}
                  {canGoBack && (
                    <button className="overlay-btn" onClick={() => go(-1)}>
                      ← Previous
                    </button>
                  )}
                  {canGoFwd && (
                    <button className="overlay-btn" onClick={() => go(1)}>
                      Next →
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Clues */}
          <aside className="clue-panel">
            <div className="clue-header">Clues</div>
            <div className="clue-list">
              {puzzle.words.map((w, i) => {
                const found = foundWords.has(w.word);
                return (
                  <div key={w.word} className={`clue-item${found ? " found" : ""}`}>
                    <span className="clue-n">{i + 1}.</span>
                    <span className="clue-text">
                      {w.clue}
                      <span className="clue-length"> ({w.word.length})</span>
                    </span>
                    {found && <span className="clue-tick">✓</span>}
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
      )}

      {/* Toast */}
      <div className={`toast${toast.show ? " show" : ""}`}>{toast.msg}</div>
        <div className="footer-ad">
          <AdBanner />
        </div>
    </div>
  );
}
