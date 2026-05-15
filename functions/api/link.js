// /functions/api/link.js
//
// POST /api/link
// Body: { myToken, theirCode }
//
// "code" is the first 8 chars of a token (shown in the UI).
// Finds the account matching theirCode, merges both accounts into
// the one with the higher streak, then returns the canonical token
// so the calling device can adopt it.

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { myToken, theirCode } = body;

  if (!myToken || !theirCode) {
    return Response.json({ success: false, error: "Missing myToken or theirCode" }, { status: 400 });
  }

  if (myToken.startsWith(theirCode)) {
    return Response.json({ success: false, error: "That's your own code" }, { status: 400 });
  }

  // Look up the account whose token starts with theirCode
  const theirUser = await env.DB.prepare(
    `SELECT token, streak, last_completed FROM users WHERE token LIKE ?`
  ).bind(`${theirCode}%`).first();

  if (!theirUser) {
    return Response.json({ success: false, error: "Code not found" }, { status: 404 });
  }

  const theirToken = theirUser.token;

  if (theirToken === myToken) {
    return Response.json({ success: false, error: "That's your own code" }, { status: 400 });
  }

  // Load both users
  const myUser = await env.DB.prepare(
    `SELECT token, streak, last_completed FROM users WHERE token = ?`
  ).bind(myToken).first();

  // Decide which token becomes canonical (higher streak wins; ties go to theirs
  // since they initiated the share by giving out their code)
  const myStreak    = myUser?.streak    || 0;
  const theirStreak = theirUser.streak  || 0;
  const canonical   = myStreak > theirStreak ? myToken : theirToken;
  const retiring    = canonical === myToken   ? theirToken : myToken;

  // Best streak/lastCompleted across both
  const bestStreak = Math.max(myStreak, theirStreak);
  const bestLast   = myStreak >= theirStreak
    ? (myUser?.last_completed || theirUser.last_completed)
    : theirUser.last_completed;

  // Merge puzzle progress: for each date, keep the row with more found words.
  // Re-insert all under the canonical token.
  const { results: myPuzzles }    = await env.DB.prepare(
    `SELECT date, found_words, complete FROM puzzles WHERE token = ?`
  ).bind(myToken).all();

  const { results: theirPuzzles } = await env.DB.prepare(
    `SELECT date, found_words, complete FROM puzzles WHERE token = ?`
  ).bind(theirToken).all();

  // Build merged map: date → best row
  const merged = new Map();

  for (const row of [...myPuzzles, ...theirPuzzles]) {
    let words;
    try { words = JSON.parse(row.found_words); } catch { words = []; }

    const existing = merged.get(row.date);
    if (!existing || words.length > existing.count) {
      merged.set(row.date, {
        foundWords: row.found_words,
        complete:   row.complete,
        count:      words.length,
      });
    }
  }

  // Write everything under the canonical token in one batch
  const stmts = [];

  // Update canonical user streak
  stmts.push(
    env.DB.prepare(`
      INSERT INTO users (token, streak, last_completed)
      VALUES (?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        streak         = excluded.streak,
        last_completed = excluded.last_completed
    `).bind(canonical, bestStreak, bestLast)
  );

  // Delete retiring user (puzzles cascade via the loop below)
  stmts.push(
    env.DB.prepare(`DELETE FROM users   WHERE token = ?`).bind(retiring)
  );
  stmts.push(
    env.DB.prepare(`DELETE FROM puzzles WHERE token = ?`).bind(retiring)
  );

  // Upsert merged puzzle rows under canonical token
  for (const [date, { foundWords, complete }] of merged.entries()) {
    stmts.push(
      env.DB.prepare(`
        INSERT INTO puzzles (token, date, found_words, complete)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(token, date) DO UPDATE SET
          found_words = excluded.found_words,
          complete    = excluded.complete
      `).bind(canonical, date, foundWords, complete)
    );
  }

  await env.DB.batch(stmts);

  return Response.json({
    success:       true,
    canonicalToken: canonical,
    streak:        bestStreak,
    lastCompleted: bestLast,
  });
}
